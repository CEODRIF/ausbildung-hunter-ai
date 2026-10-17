import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Service-contract + ISOLATION tests for the Bewerbung Automation server
 * actions.
 *
 * Contract: every action re-authenticates (identity never trusted from the
 * client), maps FormData → engine arguments 1:1, and returns stable,
 * JSON-safe payloads.
 *
 * Isolation (the hard requirement of this feature): the feature's engine and
 * actions must NOT reach into the protected standard-email machinery
 * (campaign creation, the protected worker, message finalization, or any
 * write to email_campaigns / email_messages / application drafts). They may
 * only use the shared SAFE primitives (quota RPCs, sender slot, the
 * ownership-scoped send provider, AI quota + provider).
 *
 * NOTE: the two File-carrying operations (document upload, PDF import) are
 * ROUTE HANDLERS (/api/bew/documents, /api/bew/companies-pdf), NOT server
 * actions — server actions cap the request body at 1 MB by default
 * (serverActions.bodySizeLimit) and would reject a multi-MB document before
 * the engine runs. A static guard below pins that invariant.
 */

const redirectMock = vi.fn(() => {
  throw new Error("NEXT_REDIRECT");
});
vi.mock("next/navigation", () => ({ redirect: redirectMock }));

const authState: {
  user: { id: string } | null;
  profile: Record<string, unknown> | null;
} = {
  user: null,
  profile: null,
};
vi.mock("@/lib/auth", () => ({
  getCurrentUserAndProfile: async () => ({
    user: authState.user,
    profile: authState.profile,
  }),
}));

const engineCalls: Array<{ fn: string; args: unknown[] }> = [];
const engineMockFactory = (name: string, impl?: (...a: unknown[]) => unknown) =>
  vi.fn(async (...args: unknown[]) => {
    engineCalls.push({ fn: name, args });
    if (impl) return impl(...args);
    return undefined;
  });

vi.mock("@/lib/bewerbung-engine", () => ({
  attachBewDocument: engineMockFactory("attachBewDocument", () => ({ ok: true })),
  cancelBewSend: engineMockFactory("cancelBewSend", () => ({ cancelled: 0 })),
  createBewCampaign: engineMockFactory("createBewCampaign", () => ({
    id: "camp-new",
    requested_count: 5,
  })),
  detachBewDocument: engineMockFactory("detachBewDocument"),
  excludeBewApplication: engineMockFactory("excludeBewApplication"),
  generateBewLetters: engineMockFactory("generateBewLetters", () => ({
    generated: 0,
    failed: 0,
    remaining: 0,
    aiQuotaHit: false,
  })),
  getBewCampaignView: engineMockFactory("getBewCampaignView", () => ({
    campaign: { id: "c" },
    applications: [],
    documents: [],
    usage: { remaining: 0, daily_limit: 50 },
    senderEmail: null,
  })),
  listBewDocuments: engineMockFactory("listBewDocuments", () => []),
  restoreBewApplication: engineMockFactory("restoreBewApplication"),
  saveBewCompanies: engineMockFactory("saveBewCompanies", () => ({
    campaign: { id: "c" },
    result: { rows: [], validCount: 0, duplicateEmails: [] },
  })),
  setCampaignSender: engineMockFactory("setCampaignSender"),
  startBewSend: engineMockFactory("startBewSend", () => ({ ok: true })),
  updateBewApplicationFields: engineMockFactory("updateBewApplicationFields"),
   updateBewLetter: engineMockFactory("updateBewLetter"),
 }));

const actions = await import("@/app/bewerbung-automation/actions");

const USER = { id: "user-1" };
const PROFILE = { id: "user-1", full_name: "Max", account_status: "active" };

function login(user: { id: string } | null = USER) {
  authState.user = user;
  authState.profile = user ? PROFILE : null;
}

beforeEach(() => {
  engineCalls.length = 0;
  redirectMock.mockClear();
  login();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("action authorization (identity is never trusted)", () => {
  it("redirects to /login when there is no authenticated user", async () => {
    login(null);
    await expect(actions.bewGetView("c1")).rejects.toThrow("NEXT_REDIRECT");
    expect(redirectMock).toHaveBeenCalledWith("/login");
    expect(engineCalls).toHaveLength(0); // engine never touched
  });

  it("redirects for a non-active account", async () => {
    authState.user = USER;
    authState.profile = { ...PROFILE, account_status: "suspended" };
    await expect(actions.bewGetView("c1")).rejects.toThrow("NEXT_REDIRECT");
    expect(engineCalls).toHaveLength(0);
  });
});

describe("action → engine argument mapping (service contract)", () => {
  it("bewCreateCampaign forwards count + purpose as numbers/strings", async () => {
    const fd = new FormData();
    fd.set("count", "42");
    fd.set("purpose", "arbeit");
    const result = await actions.bewCreateCampaign(fd);
    expect(result).toEqual({ campaignId: "camp-new", count: 5 });
    const call = engineCalls.find((c) => c.fn === "createBewCampaign")!;
    expect(call.args[0]).toEqual({ userId: "user-1", count: 42, purpose: "arbeit", positionTitle: "", positionBrief: "", employerFacts: "" });
  });

  it("bewStartSend parses the selected seqs and forwards them intact", async () => {
    const fd = new FormData();
    fd.set("campaignId", "c1");
    fd.set("selectedSeqs", JSON.stringify([1, 3, 7]));
    await actions.bewStartSend(fd);
    const call = engineCalls.find((c) => c.fn === "startBewSend")!;
    expect(call.args[0]).toBe("user-1");
    expect(call.args[1]).toBe("c1");
    expect(call.args[2]).toEqual({ selectedSeqs: [1, 3, 7] });
  });

  it("bewSaveCompanies forwards parsed records with null normalization", async () => {
    const fd = new FormData();
    fd.set("campaignId", "c1");
    fd.set(
      "records",
      JSON.stringify([{ companyName: "A", companyEmail: "a@b.de", contactName: "", companyAddress: "" }]),
    );
    await actions.bewSaveCompanies(fd);
    const call = engineCalls.find((c) => c.fn === "saveBewCompanies")!;
    expect(call.args[2]).toEqual([
      { companyName: "A", companyEmail: "a@b.de", contactName: null, companyAddress: null, positionTitle: "", positionBrief: "", employerFacts: "" },
    ]);
  });

  it("bewGetView passes (userId, campaignId) — never a client-chosen user", async () => {
    await actions.bewGetView("c9");
    const call = engineCalls.find((c) => c.fn === "getBewCampaignView")!;
    expect(call.args).toEqual(["user-1", "c9"]);
  });

});

describe("isolation from the protected e-mail machinery (static source guard)", () => {
  const read = (p: string) =>
    readFileSync(path.join(process.cwd(), p), "utf8");

  it("the engine only touches bew_* tables + the shared safe primitives", () => {
    const src = read("src/lib/bewerbung-engine.ts");
    // No writes to the protected tables.
    for (const forbidden of [
      'from("email_campaigns")',
      'from("email_messages")',
      'from("application_drafts")',
      'from("application_draft_attachments")',
      'from("email_campaign_attachments")',
      // protected engine internals
      "createCampaign(",
      "processCampaignBatch(",
      "finalize_email_message",
      "sendCampaign",
      // the campaign list UI is a protected surface
      "/applications",
    ])
      expect(src.includes(forbidden), `engine must not use: ${forbidden}`).toBe(false);
    // The allowed shared primitives are used (so the guard stays meaningful).
    for (const allowed of [
      'from("bew_campaigns")',
      'from("bew_applications")',
      'from("bew_documents")',
      'from("bew_campaign_documents")',
      "reserve_email_capacity",
      "release_email_capacity",
      "reserveSenderSlot",
      "createEmailProvider",
      "reserveAIUsage",
    ])
      expect(src.includes(allowed), `engine should use: ${allowed}`).toBe(true);
  });

  it("no server action carries a File body (1 MB action-body limit would 413 real uploads)", () => {
    // Regression guard for the second-document upload failure: documents and
    // PDFs go to /api/bew/documents + /api/bew/companies-pdf (route handlers,
    // no framework body cap). A File inside a server action breaks again the
    // moment the limit is raised or forgotten.
    const actionsSrc = read("src/app/bewerbung-automation/actions.ts");
    expect(
      actionsSrc.includes("instanceof File"),
      "server actions must not receive File payloads",
    ).toBe(false);
  });

  it("the actions import NOTHING from the protected e-mail modules", () => {
    const src = read("src/app/bewerbung-automation/actions.ts");
    for (const forbidden of [
      "@/lib/email-campaigns",
      "@/lib/email-providers",
      "@/lib/email-oauth",
      "applications/new/actions",
      "campaigns",
    ])
      expect(src.includes(forbidden), `actions must not import: ${forbidden}`).toBe(false);
    expect(src.includes("@/lib/bewerbung-engine")).toBe(true);
  });

  it("the cron/worker routes only drain the isolated engine", () => {
    const cron = read("src/app/api/cron/bew-scheduler/route.ts");
    const worker = read("src/app/api/internal/bew-worker/route.ts");
    for (const [name, src] of [
      ["cron", cron],
      ["worker", worker],
    ] as const) {
      expect(src.includes("@/lib/email-campaigns"), `${name} must not use the protected engine`).toBe(false);
      expect(src.includes("processBewSendBatch"), `${name} drains the isolated engine`).toBe(true);
    }
  });
});
