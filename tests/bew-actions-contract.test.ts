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

/** Injectable drain outcome for the bewRefreshSend tests. */
const drainBehavior: { reject?: Error } = {};

vi.mock("@/lib/bewerbung-engine", () => ({
  BEW_MAX_BATCH: 5,
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
  processBewSendBatch: engineMockFactory("processBewSendBatch", () => {
    if (drainBehavior.reject) throw drainBehavior.reject;
    return { processed: 0, sent: 0, failed: 0, remaining: 0 };
  }),
  rescheduleBewSend: engineMockFactory("rescheduleBewSend", () => ({ ok: true })),
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
  drainBehavior.reject = undefined;
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

  it("bewStartSend with schedule fields forwards a server-converted scheduling", async () => {
    const soon = new Date(Date.now() + 2 * 3600 * 1000);
    const fd = new FormData();
    fd.set("campaignId", "c1");
    fd.set("selectedSeqs", JSON.stringify([1, 3]));
    fd.set("scheduleYear", String(soon.getFullYear()));
    fd.set("scheduleMonth", String(soon.getMonth() + 1));
    fd.set("scheduleDay", String(soon.getDate()));
    fd.set("scheduleHour", String(soon.getHours()));
    fd.set("scheduleMinute", String(soon.getMinutes()));
    fd.set("scheduleTimezone", "Europe/Berlin");
    await actions.bewStartSend(fd);
    const call = engineCalls.find((c) => c.fn === "startBewSend")!;
    const opts = call.args[2] as { selectedSeqs: number[]; scheduling?: { utcIso: string; timeZone: string } };
    expect(opts.selectedSeqs).toEqual([1, 3]);
    expect(opts.scheduling).toBeTruthy();
    expect(opts.scheduling!.timeZone).toBe("Europe/Berlin");
    // The persisted instant is a canonical UTC ISO string (server-converted).
    expect(new Date(opts.scheduling!.utcIso).toISOString()).toBe(opts.scheduling!.utcIso);
  });

  it("bewRescheduleSend forwards (userId, campaignId, scheduling) and refuses without one", async () => {
    const soon = new Date(Date.now() + 2 * 3600 * 1000);
    const fd = new FormData();
    fd.set("campaignId", "c1");
    fd.set("scheduleYear", String(soon.getFullYear()));
    fd.set("scheduleMonth", String(soon.getMonth() + 1));
    fd.set("scheduleDay", String(soon.getDate()));
    fd.set("scheduleHour", String(soon.getHours()));
    fd.set("scheduleMinute", String(soon.getMinutes()));
    fd.set("scheduleTimezone", "Europe/Berlin");
    await actions.bewRescheduleSend(fd);
    const call = engineCalls.find((c) => c.fn === "rescheduleBewSend")!;
    expect(call.args[0]).toBe("user-1");
    expect(call.args[1]).toBe("c1");
    expect(call.args[2]).toMatchObject({ timeZone: "Europe/Berlin" });

    // No schedule fields → refuses BEFORE touching the engine.
    const before = engineCalls.filter((c) => c.fn === "rescheduleBewSend").length;
    const empty = new FormData();
    empty.set("campaignId", "c1");
    await expect(actions.bewRescheduleSend(empty)).rejects.toThrow("INVALID_SCHEDULE");
    expect(engineCalls.filter((c) => c.fn === "rescheduleBewSend").length).toBe(before);
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

describe("bewRefreshSend — status refresh + bounded drain", () => {
  it("redirects to /login when there is no authenticated user (engine never touched)", async () => {
    login(null);
    await expect(actions.bewRefreshSend("c1")).rejects.toThrow("NEXT_REDIRECT");
    expect(redirectMock).toHaveBeenCalledWith("/login");
    expect(engineCalls).toHaveLength(0);
  });

  it("drains THIS campaign (bounded) first, then returns the fresh owner view", async () => {
    const view = await actions.bewRefreshSend("c7");
    const drain = engineCalls.find((c) => c.fn === "processBewSendBatch")!;
    // The authenticated user id is used — never anything client-chosen — and
    // the batch is bounded by the engine's BEW_MAX_BATCH (5).
    expect(drain.args).toEqual(["user-1", "c7", 5]);
    const viewCall = engineCalls.find((c) => c.fn === "getBewCampaignView")!;
    expect(viewCall.args).toEqual(["user-1", "c7"]);
    // Drain BEFORE the view, so the returned view reflects the drain outcome.
    expect(engineCalls.indexOf(drain)).toBeLessThan(engineCalls.indexOf(viewCall));
    expect(view).toMatchObject({ campaign: { id: "c" } });
  });

  it("a drain failure is NON-FATAL: the action still resolves with the fresh view", async () => {
    drainBehavior.reject = new Error("injected drain failure");
    const view = await actions.bewRefreshSend("c7");
    expect(view).toMatchObject({ campaign: { id: "c" } });
    expect(engineCalls.find((c) => c.fn === "getBewCampaignView")).toBeTruthy();
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
