// @vitest-environment jsdom
/**
 * AUTO BEWERB — CAPACITY CONSISTENCY (UI ↔ server) regression suite.
 *
 * THE PRODUCTION BUG (user-confirmed, screenshot): Step 2 displayed
 *   "0 / 100" + "100 places available"
 * while "Add company" was refused server-side with
 *   "Your global limit of 100 companies is reached."
 *
 * ROOT CAUSE: two different read paths with different failure semantics.
 * The create path runs a FRESH, error-checked count of the persisted
 * reserved rows (engine: createAutoBewerbCompany). The displayed counter
 * (engine: getAutoBewerbCapacity) could SILENTLY MASK A FAILED READ AS
 * "0 reserved": the RPC `.error` was ignored, the fallback count query's
 * `.error` was ignored (`(rows ?? []).length` → 0 on a failed query), and
 * the workspace loader's catch kept a `{reserved: 0, available: 100}`
 * default. The UI then rendered the false zero and — because a rejected
 * add never refreshed the workspace — the fake "0 / 100" sat right next
 * to the "limit reached" error.
 *
 * CONTRACT PINNED HERE (the fix):
 *   (1)  ONE definition of "reserved" everywhere — the persisted rows of
 *        the same user in reserved statuses (exactly what the limit check
 *        enforces). The row count is canonical; the ab_user_capacity RPC
 *        is a cross-check + fallback and can never silently disagree.
 *   (2)  A capacity read that cannot be completed is HONESTLY
 *        "unavailable" (workspace capacity: null → UI "—"), NEVER a fake
 *        "0 / 100 · 100 places available".
 *   (3)  The counter refreshes after mutations — including a REJECTED add
 *        (workflow_full), which proves the server sees state the UI lacks.
 *   (4)  The hard 100-company limit stays server-enforced and race-proof
 *        (no 101st reservation, ever).
 *
 * Real engine, in-memory Supabase-style DB (tests/helpers-studio) with the
 * OPT-IN slot-unique enforcement (the database arbiter) and the release
 * trigger backstop — same harness contract as auto-bewerb-global-capacity.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { useCallback, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StudioDb } from "./helpers-studio";
import type { AutoBewerbWorkspace } from "@/lib/auto-bewerb/schema";
import type { AutoBewerbContextValue } from "@/components/auto-bewerb/shared";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/email-providers", () => ({ createEmailProvider: vi.fn() }));
vi.mock("@/lib/auto-bewerb/sending-window", () => ({
  isSendingWindowOpen: () => true,
  nextWindowStartMs: () => null,
  windowLabel: () => "07:30–10:30 Europe/Berlin",
  isCampaignTimeInWindow: () => true,
  AUTO_BEWERB_SENDING_WINDOW: { timeZone: "Europe/Berlin", startHour: 7, startMinute: 30, endHour: 10, endMinute: 30 },
}));
vi.mock("@/app/auto-bewerb/actions", () => ({
  addCompanyAction: vi.fn(),
  deleteCompanyAction: vi.fn(),
  updateCompanyAction: vi.fn(),
}));

const { createAdminClient } = await import("@/lib/supabase/admin");
const { createEmailProvider } = await import("@/lib/email-providers");
const { addCompanyAction } = await import("@/app/auto-bewerb/actions");
const {
  createAutoBewerbBatch,
  createAutoBewerbCompany,
  deleteAutoBewerbCompany,
  getAutoBewerbCapacity,
  getAutoBewerbWorkspace,
} = await import("@/lib/auto-bewerb/engine");
const { createStudioDb } = await import("./helpers-studio");
const { cvEmpty } = await import("@/lib/templates/cv");
const { translate } = await import("@/lib/i18n/core");
const { I18nProvider } = await import("@/lib/i18n");
const { AutoBewerbContext } = await import("@/components/auto-bewerb/shared");
const { Step2Companies } = await import("@/components/auto-bewerb/step2-companies");

const USER = "11111111-1111-4111-8111-111111111111";
const ACCT = "33333333-3333-4333-8333-333333333333";
const TS = "2026-12-01T00:00:00.000Z";
const AD_RAW = "Ausbildung als Mechatroniker (m/w/d) in Hamburg — Bewerbung per E-Mail bis 31.12.2026.";
const RESERVED_SET = ["draft", "ready", "scheduled", "sending", "failed"];

let db: StudioDb;
let seq = 0;

type TCompany = Record<string, unknown> & { id: string; user_id: string; status: string; slot_no: number };
const tCompanies = () => db.tables.auto_bewerb_companies as unknown as TCompany[];

const reservedCount = (user: string) => tCompanies().filter((c) => c.user_id === user && RESERVED_SET.includes(c.status)).length;

function extractFor(company: string, email: string, job: string) {
  return {
    jobTitle: job,
    occupation: job,
    company,
    companyAddress: "",
    location: "Hamburg",
    startDate: "",
    applicationDeadline: "",
    requiredQualifications: [],
    preferredQualifications: [],
    technicalSkills: [],
    softSkills: [],
    languageRequirements: [],
    educationRequirement: "",
    responsibilities: [],
    requestedDocuments: [],
    applicationMethod: "E-Mail",
    contactPerson: "",
    applicationEmail: email,
    companyNotes: [],
    missingOrAmbiguous: [],
  };
}

function cvFor(company: string) {
  const cv = cvEmpty();
  cv.personal = { ...cv.personal, fullName: "Mustapha Drif" };
  cv.summary = `Maßgeschneiderte Zusammenfassung für ${company}.`;
  return cv;
}

const letterFor = (company: string) => ({
  text: `Sehr geehrte Damen und Herren,\n\nhiermit bewerbe ich mich bei ${company}.\n\nMit freundlichen Grüßen\nMustapha Drif`,
  tone: "professional" as const,
});

function seedCompany(user: string, company: string, status: string = "ready", opts: { slot?: number; approved?: boolean } = {}): TCompany {
  seq += 1;
  const id = `seed-${seq}`;
  const slot = opts.slot ?? (status === "sent" || status === "cancelled" ? 0 : seq);
  const email = `jobs@seed-${company.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.de`;
  const row: TCompany = {
    id,
    user_id: user,
    company,
    company_key: company.toLowerCase(),
    slot_no: slot,
    ad_raw: AD_RAW,
    ad_extracted: extractFor(company, email, `Ausbildung ${company}`),
    ad_analysis: null,
    profile_snapshot: null,
    status,
    recipient_email: null,
    email_subject: null,
    email_body: null,
    email_attach_cv: true,
    email_attach_letter: true,
    email_account_id: null,
    idempotency_key: null,
    approved: opts.approved ?? false,
    approved_at: (opts.approved ?? false) ? TS : null,
    scheduled_at: null,
    schedule_timezone: null,
    sent_at: null,
    provider_message_id: null,
    last_failure_code: null,
    ad_confirmed_at: TS,
    cv_reviewed_at: null,
    letter_reviewed_at: null,
    created_at: TS,
    updated_at: TS,
  };
  tCompanies().push(row);
  if (opts.approved) {
    (db.tables.auto_bewerb_documents as Array<Record<string, unknown>>).push(
      { id: `cv-${id}`, user_id: user, company_id: id, doc_type: "cv", version: 1, content: cvFor(company), created_at: TS, updated_at: TS },
      { id: `lt-${id}`, user_id: user, company_id: id, doc_type: "cover_letter", version: 1, content: letterFor(company), created_at: TS, updated_at: TS },
    );
  }
  return row;
}

const sendEmail = vi.fn();
const provider = { sendEmail };

function seedBase() {
  seq = 0;
  db = createStudioDb({
    auto_bewerb_profiles: [
      {
        user_id: USER,
        cv_file_name: "cv.pdf",
        cv_mime_type: "application/pdf",
        cv_size_bytes: 1024,
        cv_hash: "h",
        analyzed_at: TS,
        extracted: null,
      },
    ],
    auto_bewerb_companies: [],
    auto_bewerb_documents: [],
    auto_bewerb_attachments: [],
    auto_bewerb_company_attachments: [],
    auto_bewerb_email_templates: [
      {
        user_id: USER,
        body: "Sehr geehrte Damen und Herren,\n\nanbei meine Bewerbungsunterlagen.",
        recipient: "",
        subject: "Bewerbung",
        account_id: ACCT,
        attach_cv: true,
        attach_letter: true,
      },
    ],
    auto_bewerb_send_attempts: [],
    auto_bewerb_batches: [],
    email_accounts: [{ id: ACCT, user_id: USER, provider: "gmail", email: "mail@example.de", is_active: true, requires_reconnect: false }],
    activity_logs: [],
    profiles: [{ id: USER, full_name: "Mustapha Drif", email: "mail@example.de", phone: "", street: "", postal_code: "", city: "", country: "" }],
  });
  db.enableSlotUnique("auto_bewerb_companies");
  (createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(db.admin);
  sendEmail.mockReset();
  sendEmail.mockResolvedValue({ providerMessageId: "msg-ok" });
  (createEmailProvider as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(provider);
  // NO ab_user_capacity fake by default (pre-migration semantics): the
  // canonical row count must carry the reading. The other RPCs get their
  // faithful batch-engine semantics (same as auto-bewerb-global-capacity).
  db.setRpc((fn) => {
    switch (fn) {
      case "reserve_sender_slot":
        return { data: { reserved: true, wait_ms: 0 }, error: null };
      case "recover_stale_auto_bewerb_attempts":
        return { data: 0, error: null };
      case "recover_stale_auto_bewerb_batches":
        return { data: 0, error: null };
      default:
        return { data: null, error: null };
    }
  });
}

/** Unwrap the honest result contract (a failed read is ok:false, never 0). */
async function capacityOf(user: string) {
  const res = await getAutoBewerbCapacity(user);
  expect(res.ok).toBe(true);
  return (res as { ok: true; capacity: { reserved: number; capacity: number; available: number } }).capacity;
}

/** The console.error calls matching the capacity diagnostics. */
function capacityLogs(spy: ReturnType<typeof vi.spyOn>) {
  return spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("[auto-bewerb][capacity]"));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// (1) One definition — the UI counter and the server enforcement read the
//     SAME persisted truth
// ---------------------------------------------------------------------------

describe("capacity consistency — one definition, honest states", () => {
  it("(1) the workspace counter equals the capacity read AND what the server enforces", async () => {
    seedBase();
    for (let i = 1; i <= 20; i += 1) seedCompany(USER, `Mix ${i} GmbH`, "ready");
    for (let i = 1; i <= 8; i += 1) seedCompany(USER, `Sent ${i} GmbH`, "sent"); // released history
    for (let i = 1; i <= 4; i += 1) seedCompany(USER, `Cancelled ${i} GmbH`, "cancelled"); // released history
    const direct = await capacityOf(USER);
    expect(direct).toEqual({ reserved: 20, capacity: 100, available: 80 });
    // The WORKSPACE (what the UI renders) carries the identical numbers:
    const ws = await getAutoBewerbWorkspace(USER);
    expect(ws.capacity).toEqual({ reserved: 20, capacity: 100, available: 80 });
    // … and the enforcement agrees: exactly 80 more companies may be added.
    const add = await createAutoBewerbCompany(USER, {
      adRaw: AD_RAW,
      company: "Agree GmbH",
      extract: extractFor("Agree GmbH", "jobs@agree.de", "Ausbildung Agree"),
      analysis: null,
    });
    expect(add.ok).toBe(true);
    expect(await capacityOf(USER)).toEqual({ reserved: 21, capacity: 100, available: 79 });
  });

  it("the UI renders the persisted counter verbatim (not client state)", () => {
    renderStep2(wsFixture({ capacity: { reserved: 73, capacity: 100, available: 27 } }));
    expect(screen.getByText("73 / 100")).toBeInTheDocument();
    expect(screen.getByText(translate("de", "autoBewerb.capacityAvailable", { count: 27 }))).toBeInTheDocument();
    // … and the at-limit display for a full workflow:
    cleanup();
    renderStep2(wsFixture({ capacity: { reserved: 100, capacity: 100, available: 0 } }));
    expect(screen.getByText("100 / 100")).toBeInTheDocument();
    expect(screen.getByText(translate("de", "autoBewerb.capacityAvailable", { count: 0 }))).toBeInTheDocument();
  });

  it("(2) an UNREADABLE counter shows an honest '—' state — never a fake '0 / 100'", () => {
    renderStep2(wsFixture({ capacity: null }));
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.getByText(/nicht lesbar/i)).toBeInTheDocument();
    expect(screen.queryByText("0 / 100")).not.toBeInTheDocument();
    expect(screen.queryByText(/100 Plätze frei/i)).not.toBeInTheDocument();
  });

  it("(2b) a pre-feature workspace snapshot falls back to the active-list length (legacy behavior)", () => {
    renderStep2(
      wsFixture({
        capacity: undefined,
        companies: [
          { company: { id: "c1", status: "ready", company: "A", ad_raw: "", ad_extracted: null } },
          { company: { id: "c2", status: "ready", company: "B", ad_raw: "", ad_extracted: null } },
        ] as AutoBewerbWorkspace["companies"],
      }),
    );
    expect(screen.getByText("2 / 100")).toBeInTheDocument();
  });

  it("(3) a rejected add (workflow_full) RE-READS the workspace so the stale counter self-heals", async () => {
    (addCompanyAction as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      code: "workflow_full",
      message: "limit",
    });
    const refresh = vi.fn().mockResolvedValue(undefined);
    const ctx = step2Context(wsFixture({ capacity: { reserved: 0, capacity: 100, available: 100 } }), refresh);
    render(
      <I18nProvider>
        <AutoBewerbContext.Provider value={ctx}>
          <Step2Companies />
        </AutoBewerbContext.Provider>
      </I18nProvider>,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            extract: { company: "Limit GmbH", jobTitle: "Ausbildung Limit", occupation: "Ausbildung Limit", applicationEmail: "jobs@limit.de" },
            analysis: { matchScore: 50, matched: [], missing: [], questions: [] },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    const t = (key: string) => translate("de", key);
    // Fill the ad text (the Analyze button is disabled below 40 chars) and
    // run the preview analysis:
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    const setNativeValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
    setNativeValue.call(textarea, AD_RAW);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await userClick(await screen.findByRole("button", { name: t("autoBewerb.analyzeButton") }));
    await screen.findByText(t("autoBewerb.analysisPreviewTitle"));
    await userClick(screen.getByRole("button", { name: t("autoBewerb.addCompanyButton") }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1)); // the stale counter is re-read
    expect(await screen.findByText(new RegExp(t("autoBewerb.companyLimitNote").slice(0, 30)))).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// (4)–(6) The counter tracks the persisted rows at every boundary
// ---------------------------------------------------------------------------

describe("capacity boundaries — 0 / 99 / 100 reserved", () => {
  it("(4) 0 reserved → 100 available and the add succeeds", async () => {
    seedBase();
    expect(await capacityOf(USER)).toEqual({ reserved: 0, capacity: 100, available: 100 });
    const res = await createAutoBewerbCompany(USER, {
      adRaw: AD_RAW,
      company: "First GmbH",
      extract: extractFor("First GmbH", "jobs@first.de", "Ausbildung First"),
      analysis: null,
    });
    expect(res.ok).toBe(true);
    expect(await capacityOf(USER)).toEqual({ reserved: 1, capacity: 100, available: 99 });
  });

  it("(5) 99 reserved → 1 available and the 100th add succeeds", async () => {
    seedBase();
    for (let i = 1; i <= 99; i += 1) seedCompany(USER, `Base ${i} GmbH`, "ready");
    expect(await capacityOf(USER)).toEqual({ reserved: 99, capacity: 100, available: 1 });
    const last = await createAutoBewerbCompany(USER, {
      adRaw: AD_RAW,
      company: "Hundredth GmbH",
      extract: extractFor("Hundredth GmbH", "jobs@hundredth.de", "Ausbildung 100"),
      analysis: null,
    });
    expect(last.ok).toBe(true);
    expect(await capacityOf(USER)).toEqual({ reserved: 100, capacity: 100, available: 0 });
  });

  it("(6) 100 reserved → 0 available and the next add is rejected — with the persisted row proof in the diagnostics", async () => {
    seedBase();
    for (let i = 1; i <= 60; i += 1) seedCompany(USER, `Ready ${i} GmbH`, "ready");
    for (let i = 1; i <= 25; i += 1) seedCompany(USER, `Sending ${i} GmbH`, "sending");
    for (let i = 1; i <= 15; i += 1) seedCompany(USER, `Failed ${i} GmbH`, "failed");
    expect(await capacityOf(USER)).toEqual({ reserved: 100, capacity: 100, available: 0 });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const next = await createAutoBewerbCompany(USER, {
        adRaw: AD_RAW,
        company: "Overflow GmbH",
        extract: extractFor("Overflow GmbH", "jobs@overflow.de", "Ausbildung Overflow"),
        analysis: null,
      });
      expect(next).toMatchObject({ ok: false, code: "workflow_full" });
      // The diagnostic carries the SAFE row proof (per-status distribution,
      // no names/text) — "the user really has 100 reserved rows":
      const proof = capacityLogs(errSpy).find((l) => l.includes("workflow_full"));
      expect(proof).toBeTruthy();
      expect(proof).toContain("reserved=100");
      expect(proof).toContain("ready=60");
      expect(proof).toContain("sending=25");
      expect(proof).toContain("failed=15");
    } finally {
      errSpy.mockRestore();
    }
    expect(tCompanies()).toHaveLength(100); // no 101st row
  });

  it("(7) sent + cancelled rows do NOT reserve capacity (history is preserved, slots are released)", async () => {
    seedBase();
    for (let i = 1; i <= 50; i += 1) seedCompany(USER, `Active ${i} GmbH`, "ready");
    for (let i = 1; i <= 50; i += 1) seedCompany(USER, `Sent ${i} GmbH`, "sent", { slot: 0 });
    for (let i = 1; i <= 20; i += 1) seedCompany(USER, `Cancelled ${i} GmbH`, "cancelled", { slot: 0 });
    // 120 rows persisted, exactly 50 reserved:
    expect(tCompanies()).toHaveLength(120);
    expect(await capacityOf(USER)).toEqual({ reserved: 50, capacity: 100, available: 50 });
    // … and 50 more companies may still be added:
    let added = 0;
    for (let i = 1; i <= 51; i += 1) {
      const res = await createAutoBewerbCompany(USER, {
        adRaw: AD_RAW,
        company: `More ${i} GmbH`,
        extract: extractFor(`More ${i} GmbH`, `jobs@more-${i}.de`, `Ausbildung ${i}`),
        analysis: null,
      });
      if (res.ok) added += 1;
      else break;
    }
    expect(added).toBe(50);
    expect(await capacityOf(USER)).toEqual({ reserved: 100, capacity: 100, available: 0 });
  });

  it("(8) a deletion releases EXACTLY ONE slot (the freed slot is immediately reusable)", async () => {
    seedBase();
    for (let i = 1; i <= 100; i += 1) seedCompany(USER, `Full ${i} GmbH`, "ready");
    expect(await capacityOf(USER)).toEqual({ reserved: 100, capacity: 100, available: 0 });
    const victim = tCompanies()[0];
    expect((await deleteAutoBewerbCompany(USER, victim.id)).ok).toBe(true);
    expect(await capacityOf(USER)).toEqual({ reserved: 99, capacity: 100, available: 1 }); // exactly one freed
    const reuse = await createAutoBewerbCompany(USER, {
      adRaw: AD_RAW,
      company: "Refill GmbH",
      extract: extractFor("Refill GmbH", "jobs@refill.de", "Ausbildung Refill"),
      analysis: null,
    });
    expect(reuse.ok).toBe(true);
    expect(await capacityOf(USER)).toEqual({ reserved: 100, capacity: 100, available: 0 });
  });

  it("(9) a successful SEND releases exactly one slot (status transition → workspace re-read)", async () => {
    seedBase();
    const a = seedCompany(USER, "SendMe GmbH", "ready", { approved: true });
    seedCompany(USER, "KeepMe GmbH", "ready", { approved: true });
    expect(await getAutoBewerbWorkspace(USER).then((w) => w.capacity)).toEqual({ reserved: 2, capacity: 100, available: 98 });
    const res = await createAutoBewerbBatch(USER, { companyIds: [a.id], schedule: null });
    expect(res.ok).toBe(true);
    expect(tCompanies().find((c) => c.id === a.id)?.status).toBe("sent");
    expect(tCompanies().find((c) => c.id === a.id)?.slot_no).toBe(0); // token released
    // The workspace re-read (what the UI shows after the refresh) reflects it:
    expect(await getAutoBewerbWorkspace(USER).then((w) => w.capacity)).toEqual({ reserved: 1, capacity: 100, available: 99 });
  });

  it("(10) concurrent additions for the LAST slot cannot exceed 100 (row count + slot arbiter agree)", async () => {
    seedBase();
    for (let i = 1; i <= 99; i += 1) seedCompany(USER, `Base ${i} GmbH`, "ready");
    // Five simultaneous creates for the single free slot (100): the harness
    // models the database arbiter faithfully — every concurrent reader sees
    // the pre-insert state (slot 100 free), so the UNIQUE (user_id, slot_no)
    // index is what lets exactly ONE through. Never 101, never two winners.
    const results = await Promise.all(
      ["A", "B", "C", "D", "E"].map((s) =>
        createAutoBewerbCompany(USER, {
          adRaw: AD_RAW,
          company: `Race ${s} GmbH`,
          extract: extractFor(`Race ${s} GmbH`, `jobs@race-${s.toLowerCase()}.de`, "Ausbildung Race"),
          analysis: null,
        }),
      ),
    );
    expect(results.filter((r) => r.ok).length).toBe(1); // the lone slot 100
    expect(results.filter((r) => !r.ok && r.code === "workflow_full").length).toBe(4);
    expect(reservedCount(USER)).toBe(100); // never 101
    const slots = tCompanies().map((c) => c.slot_no).filter((s) => s > 0);
    expect(new Set(slots).size).toBe(100); // no slot is held twice
    expect(await capacityOf(USER)).toEqual({ reserved: 100, capacity: 100, available: 0 });
  });
});

// ---------------------------------------------------------------------------
// (11)–(13) Failed reads are honest — the production regression
// ---------------------------------------------------------------------------

describe("failed reads are honest (the production regression)", () => {
  it("(11) THE BUG: 100 persisted reserved rows + a broken capacity read → the counter says 'unavailable', the server still enforces the real 100", async () => {
    seedBase();
    for (let i = 1; i <= 100; i += 1) seedCompany(USER, `Real ${i} GmbH`, "ready");
    // The persisted rows prove 100 reserved companies:
    expect(reservedCount(USER)).toBe(100);
    // Break the capacity row query (transient outage) while the CREATE
    // query is healthy (the exact production asymmetry):
    db.failSelect("auto_bewerb_companies", "slot_no", "simulated transient outage");
    // The old code returned {reserved: 0} here → the UI showed
    // "0 / 100 · 100 places available". The new contract is HONEST:
    expect(await getAutoBewerbCapacity(USER)).toEqual({
      ok: false,
      code: "capacity_unavailable",
      failed: ["rpc", "query"],
    });
    const ws = await getAutoBewerbWorkspace(USER);
    expect(ws.capacity).toBeNull(); // → the UI renders "—", never a fake zero
    // … and the server-side limit still works on the REAL rows:
    db.clearSelectFail();
    const next = await createAutoBewerbCompany(USER, {
      adRaw: AD_RAW,
      company: "OneTooMany GmbH",
      extract: extractFor("OneTooMany GmbH", "jobs@onetoomany.de", "Ausbildung Overflow"),
      analysis: null,
    });
    expect(next).toMatchObject({ ok: false, code: "workflow_full" });
    expect(tCompanies()).toHaveLength(100);
    // Once the read works again, the counter shows the persisted truth:
    expect(await getAutoBewerbWorkspace(USER).then((w) => w.capacity)).toEqual({ reserved: 100, capacity: 100, available: 0 });
  });

  it("(12) RPC error + healthy rows → the canonical row count is served, rpc_error logged", async () => {
    seedBase();
    seedCompany(USER, "RowOne GmbH", "ready");
    seedCompany(USER, "RowTwo GmbH", "ready");
    db.setRpc((fn) => (fn === "ab_user_capacity" ? { data: null, error: { message: "500: internal sql error" } } : { data: null, error: null }));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await getAutoBewerbCapacity(USER);
      expect(res).toEqual({ ok: true, source: "query", capacity: { reserved: 2, capacity: 100, available: 98 } });
      expect(capacityLogs(errSpy).some((l) => l.includes("rpc_error"))).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("(13) healthy RPC + broken row query → the RPC is the fallback (source: rpc), query_error logged", async () => {
    seedBase();
    for (let i = 1; i <= 7; i += 1) seedCompany(USER, `RpcRow ${i} GmbH`, "ready");
    db.setRpc((fn) => (fn === "ab_user_capacity" ? { data: [{ reserved: 7, capacity: 100, available: 93 }], error: null } : { data: null, error: null }));
    db.failSelect("auto_bewerb_companies", "slot_no", "simulated transient outage");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await getAutoBewerbCapacity(USER);
      expect(res).toEqual({ ok: true, source: "rpc", capacity: { reserved: 7, capacity: 100, available: 93 } });
      expect(capacityLogs(errSpy).some((l) => l.includes("query_error"))).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("(14) RPC and rows disagree → the ROWS are served and the disagreement is logged (never silent)", async () => {
    seedBase();
    seedCompany(USER, "OnlyRow GmbH", "ready"); // 1 persisted row
    db.setRpc((fn) => (fn === "ab_user_capacity" ? { data: [{ reserved: 42, capacity: 100, available: 58 }], error: null } : { data: null, error: null }));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await getAutoBewerbCapacity(USER);
      expect(res).toEqual({ ok: true, source: "query", capacity: { reserved: 1, capacity: 100, available: 99 } });
      const dis = capacityLogs(errSpy).find((l) => l.includes("rpc_query_disagreement"));
      expect(dis).toBeTruthy();
      expect(dis).toContain("rpc=42");
      expect(dis).toContain("rows=1");
    } finally {
      errSpy.mockRestore();
    }
  });

  it("(15) a capacity failure is logged server-side (capacity_unavailable diagnostic)", async () => {
    seedBase();
    db.setRpc((fn) => (fn === "ab_user_capacity" ? { data: null, error: { message: "42501: permission denied" } } : { data: null, error: null }));
    db.failSelect("auto_bewerb_companies", "slot_no", "simulated transient outage");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await getAutoBewerbCapacity(USER)).toEqual({ ok: false, code: "capacity_unavailable", failed: ["rpc", "query"] });
      expect(capacityLogs(errSpy).some((l) => l.includes("capacity_unavailable"))).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// (15)–(19) THE RESPONSE → UI PATH (the post-merge validation the report
// requires): real engine workspace response → serialization round-trip →
// rendered Step 2 → enforcement. Not a mock-of-a-mock: the ws object is the
// actual getAutoBewerbWorkspace() result, JSON round-tripped exactly like
// the server-action response, rendered into the real Step2Companies.
// ---------------------------------------------------------------------------

describe("capacity — the actual response-to-UI path", () => {
  it("(15) server count = 100 → workspace response = 100 → Step 2 shows '100 / 100' → add remains rejected → no 101st row", async () => {
    seedBase();
    for (let i = 1; i <= 100; i += 1) seedCompany(USER, `Full ${i} GmbH`, "ready");
    expect(reservedCount(USER)).toBe(100); // server count = 100
    const ws = await getAutoBewerbWorkspace(USER);
    expect(ws.capacity).toEqual({ reserved: 100, capacity: 100, available: 0 }); // response = 100
    expect(ws.companies).toHaveLength(100);
    // The server-action serialization hop (plain-data round trip):
    const wire = JSON.parse(JSON.stringify(ws)) as AutoBewerbWorkspace;
    expect(wire.capacity).toEqual({ reserved: 100, capacity: 100, available: 0 });
    // … and the RENDERED Step 2 (the user-visible value):
    renderStep2(wire);
    expect(screen.getByText("100 / 100")).toBeInTheDocument();
    expect(screen.getByText(translate("de", "autoBewerb.capacityAvailable", { count: 0 }))).toBeInTheDocument();
    // Add company remains rejected — and no 101st company can be created:
    const next = await createAutoBewerbCompany(USER, {
      adRaw: AD_RAW,
      company: "OneTooMany GmbH",
      extract: extractFor("OneTooMany GmbH", "jobs@onetoomany.de", "Ausbildung Overflow"),
      analysis: null,
    });
    expect(next).toMatchObject({ ok: false, code: "workflow_full" });
    expect(tCompanies()).toHaveLength(100);
  });

  it("(16) THE PRODUCTION RESIDUAL: a degraded counter (0) shipped next to the full list (100) → the UI shows '100 / 100', never '0 / 100'", async () => {
    seedBase();
    for (let i = 1; i <= 100; i += 1) seedCompany(USER, `Real ${i} GmbH`, "ready");
    // The capacity row query is out while the LIST query (select "*") and the
    // create query stay healthy; a drifted RPC reports 0 — so ONE server
    // response carries a stale counter next to the full, server-confirmed
    // list (exactly the state behind "0 / 100" + "limit reached"):
    db.setRpc((fn) =>
      fn === "ab_user_capacity" ? { data: [{ reserved: 0, capacity: 100, available: 100 }], error: null } : { data: null, error: null },
    );
    db.failSelect("auto_bewerb_companies", "slot_no", "simulated transient outage");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let ws: AutoBewerbWorkspace;
    let logs: string[] = [];
    try {
      ws = await getAutoBewerbWorkspace(USER);
      logs = capacityLogs(errSpy); // capture BEFORE restore resets the calls
    } finally {
      errSpy.mockRestore();
    }
    expect(ws.companies).toHaveLength(100);
    expect(ws.capacity).toEqual({ reserved: 0, capacity: 100, available: 100 }); // the degraded counter
    // The SERVER saw the divergence (source named, build id present, counts only):
    const mismatch = logs.find((l) => l.includes("capacity_list_mismatch"));
    expect(mismatch).toBeTruthy();
    expect(mismatch).toContain("source=rpc");
    expect(mismatch).toContain("reserved=0");
    expect(mismatch).toContain("activeList=100");
    expect(mismatch).toContain("build=");
    expect(mismatch).toContain(`user=${USER.slice(0, 8)}`);
    db.clearSelectFail();
    // … but the RENDERED counter cannot be the fake zero — the list is the
    // server-confirmed truth (the invariant closes the residual):
    const wire = JSON.parse(JSON.stringify(ws)) as AutoBewerbWorkspace;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    let warned = false;
    try {
      renderStep2(wire);
      warned = warnSpy.mock.calls.some((c) => String(c[0]).includes("UI cross-check"));
    } finally {
      warnSpy.mockRestore();
    }
    expect(screen.queryByText("0 / 100")).not.toBeInTheDocument();
    expect(screen.getByText("100 / 100")).toBeInTheDocument();
    expect(warned).toBe(true);
    // … and enforcement is unchanged: the add is still refused on the real
    // rows — no 101st company:
    const next = await createAutoBewerbCompany(USER, {
      adRaw: AD_RAW,
      company: "OneTooMany GmbH",
      extract: extractFor("OneTooMany GmbH", "jobs@onetoomany.de", "Ausbildung Overflow"),
      analysis: null,
    });
    expect(next).toMatchObject({ ok: false, code: "workflow_full" });
    expect(tCompanies()).toHaveLength(100);
  });

  it("(17) a GENUINE zero renders '0 / 100 · 100 places available' (allowed) and the add succeeds", async () => {
    seedBase(); // 0 persisted rows
    const ws = await getAutoBewerbWorkspace(USER);
    expect(ws.capacity).toEqual({ reserved: 0, capacity: 100, available: 100 });
    expect(ws.companies).toHaveLength(0);
    const wire = JSON.parse(JSON.stringify(ws)) as AutoBewerbWorkspace;
    renderStep2(wire);
    expect(screen.getByText("0 / 100")).toBeInTheDocument();
    expect(screen.getByText(translate("de", "autoBewerb.capacityAvailable", { count: 100 }))).toBeInTheDocument();
    const add = await createAutoBewerbCompany(USER, {
      adRaw: AD_RAW,
      company: "First GmbH",
      extract: extractFor("First GmbH", "jobs@first.de", "Ausbildung First"),
      analysis: null,
    });
    expect(add.ok).toBe(true);
  });

  it("(18) an UNAVAILABLE counter renders '—' (never '0 / 100')", async () => {
    seedBase();
    db.setRpc((fn) => (fn === "ab_user_capacity" ? { data: null, error: { message: "500: error" } } : { data: null, error: null }));
    db.failSelect("auto_bewerb_companies", "slot_no", "outage");
    const ws = await getAutoBewerbWorkspace(USER);
    expect(ws.capacity).toBeNull();
    const wire = JSON.parse(JSON.stringify(ws)) as AutoBewerbWorkspace;
    expect(wire.capacity).toBeNull(); // the null survives serialization
    renderStep2(wire);
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.getByText(/nicht lesbar/i)).toBeInTheDocument();
    expect(screen.queryByText("0 / 100")).not.toBeInTheDocument();
  });

  it("(19) a rejected add refreshes from the SAME canonical server function and the refreshed truth reaches the render", async () => {
    seedBase();
    for (let i = 1; i <= 100; i += 1) seedCompany(USER, `Real ${i} GmbH`, "ready");
    (addCompanyAction as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      code: "workflow_full",
      message: "limit",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            extract: { company: "Limit GmbH", jobTitle: "Ausbildung Limit", occupation: "Ausbildung Limit", applicationEmail: "jobs@limit.de" },
            analysis: { matchScore: 50, matched: [], missing: [], questions: [] },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    // The tab's snapshot is STALE — the screenshot state (fake zero, empty
    // list). The host mirrors AutoBewerbClient.refresh(): the refresh calls
    // the SAME canonical server function the workspace uses (
    // refreshWorkspaceAction → getAutoBewerbWorkspace) and setWs(res.value).
    const stale = wsFixture({ capacity: { reserved: 0, capacity: 100, available: 100 } });
    render(
      <StatefulStep2Host initial={stale} load={() => getAutoBewerbWorkspace(USER)} />,
    );
    // The stale render is the exact reported symptom:
    expect(screen.getByText("0 / 100")).toBeInTheDocument();
    // … then: analyze → add → REJECTED → the failed-add refresh path:
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    const setNativeValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
    setNativeValue.call(textarea, AD_RAW);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await userClick(await screen.findByRole("button", { name: translate("de", "autoBewerb.analyzeButton") }));
    await screen.findByText(translate("de", "autoBewerb.analysisPreviewTitle"));
    await userClick(screen.getByRole("button", { name: translate("de", "autoBewerb.addCompanyButton") }));
    // The limit note appears (the add-error note — and, once the refresh has
    // landed, also the at-limit banner, which is correct: the counter IS full):
    const limitNotes = await screen.findAllByText(new RegExp(translate("de", "autoBewerb.companyLimitNote").slice(0, 30)));
    expect(limitNotes.length).toBeGreaterThanOrEqual(1);
    // The refreshed value (100) must REACH the rendered component:
    await screen.findByText("100 / 100");
    expect(screen.queryByText("0 / 100")).not.toBeInTheDocument();
    expect(tCompanies()).toHaveLength(100); // still no 101st row
  });
});

// ---------------------------------------------------------------------------
// Component render helpers
// ---------------------------------------------------------------------------

function wsFixture(over: Partial<AutoBewerbWorkspace>): AutoBewerbWorkspace {
  return {
    ready: true,
    setupIssue: null,
    profile: null,
    photoSupported: false,
    photo: null,
    companies: [],
    attachments: [],
    emailTemplate: "",
    emailSettings: null,
    emailSettingsSupported: false,
    emailAccounts: [],
    candidateName: "",
    batchesSupported: false,
    batches: [],
    sendStats: { sentToday: 0, scheduled: 0, processing: 0, totalToday: 0, failed: 0 },
    capacity: null,
    sendHistory: [],
    sendingWindow: { open: false, label: "07:30–10:30 Europe/Berlin", nextStartMs: null },
    ...over,
  };
}

function step2Context(ws: AutoBewerbWorkspace, refresh: () => Promise<void>): AutoBewerbContextValue {
  return {
    ws,
    refresh,
    step: 2,
    goToStep: vi.fn(),
    toast: null,
    notify: vi.fn(),
    dismissToast: vi.fn(),
    syncing: false,
    companyId: null,
    selectCompany: vi.fn(),
    drafts: { cv: {}, letter: {} },
    setDraft: vi.fn(),
  };
}

function renderStep2(ws: AutoBewerbWorkspace) {
  return render(
    <I18nProvider>
      <AutoBewerbContext.Provider value={step2Context(ws, vi.fn().mockResolvedValue(undefined))}>
        <Step2Companies />
      </AutoBewerbContext.Provider>
    </I18nProvider>,
  );
}

/** Mirrors AutoBewerbClient's refresh loop: refresh() = call the canonical
 *  server function (as refreshWorkspaceAction does) + setWs(res.value). */
function StatefulStep2Host({ initial, load }: { initial: AutoBewerbWorkspace; load: () => Promise<AutoBewerbWorkspace> }) {
  const [ws, setWs] = useState(initial);
  const refresh = useCallback(async () => {
    const next = await load();
    setWs(next);
  }, [load]);
  return (
    <I18nProvider>
      <AutoBewerbContext.Provider value={step2Context(ws, refresh)}>
        <Step2Companies />
      </AutoBewerbContext.Provider>
    </I18nProvider>
  );
}

async function userClick(el: Element) {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));
}
