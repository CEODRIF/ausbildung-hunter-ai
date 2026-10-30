/**
 * AUTO BEWERB — GLOBAL supporting documents (Step 3 → every application).
 *
 * Contract: the user-level document library is the single source of truth.
 * Every owned document is attached to EVERY company's email — uploaded once,
 * attached to all, applied to companies added later, removed from all when
 * deleted. No per-company selection, no client-supplied document ids, and the
 * legacy auto_bewerb_company_attachments join table is never consulted.
 *
 * The database is the in-memory admin-client model (helpers-studio pattern);
 * sends are scheduled (future) so no dispatch and no real email ever runs.
 * CV/letter attachment is disabled to keep the test on the global-document
 * contract (those PDFs remain company-specific by existing behavior).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStudioDb, type StudioDb } from "./helpers-studio";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/email-providers", () => ({
  createEmailProvider: vi.fn(),
}));

import { createAdminClient } from "@/lib/supabase/admin";
import { prepareAutoBewerbSend } from "@/lib/auto-bewerb/engine";
import type { AutoBewerbSendPayload } from "@/lib/auto-bewerb/schema";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "99999999-9999-4999-8999-999999999999";
const ACCT_ID = "33333333-3333-4333-8333-333333333333";
const CO1 = "44444444-4444-4444-8444-444444444444";
const CO2 = "55555555-5555-4555-8555-555555555555";
const CO3 = "66666666-6666-4666-8666-666666666666";
const D1 = "77777777-7777-4777-8777-777777777777";
const D2 = "88888888-8888-4888-8888-888888888888";
const D3 = "aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DB_FOREIGN = "bbbbbbb2-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const AD_EXTRACT = {
  jobTitle: "Fachinformatiker",
  occupation: "Fachinformatiker",
  company: "Tech GmbH",
  companyAddress: "",
  location: "Berlin",
  startDate: "",
  applicationDeadline: null,
  requiredQualifications: [],
  preferredQualifications: [],
  technicalSkills: [],
  softSkills: [],
  languageRequirements: [],
  educationRequirement: "",
  responsibilities: [],
  requestedDocuments: [],
  applicationMethod: "",
  contactPerson: "",
  applicationEmail: "jobs@tech-gmbh.de",
  companyNotes: [],
  missingOrAmbiguous: [],
};

/** Far-future valid schedule (Europe/Berlin) → durable, never dispatched. */
const FUTURE = { timeZone: "Europe/Berlin", year: 2030, month: 6, day: 10, hour: 9, minute: 0 };

function companyRow(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    user_id: USER_A,
    company: "Tech GmbH",
    company_key: "tech gmbh",
    slot_no: 1,
    ad_raw: "x".repeat(40),
    ad_extracted: AD_EXTRACT,
    ad_analysis: null,
    profile_snapshot: null,
    status: "ready" as const,
    recipient_email: "jobs@tech-gmbh.de",
    email_subject: "Bewerbung als Fachinformatiker",
    email_body: null,
    email_attach_cv: false,
    email_attach_letter: false,
    email_account_id: ACCT_ID,
    idempotency_key: null,
    approved: true,
    approved_at: "2026-12-01T10:00:00.000Z",
    scheduled_at: null,
    schedule_timezone: null,
    sent_at: null,
    provider_message_id: null,
    last_failure_code: null,
    ad_confirmed_at: "2026-12-01T10:00:00.000Z",
    cv_reviewed_at: null,
    letter_reviewed_at: null,
    created_at: "2026-12-01T00:00:00.000Z",
    updated_at: "2026-12-01T00:00:00.000Z",
    ...over,
  };
}

function docRow(id: string, name: string, userId: string, createdAt: string) {
  return {
    id,
    user_id: userId,
    display_name: name,
    doc_category: "school_certificate",
    mime_type: "application/pdf",
    size_bytes: 1024,
    storage_path: `${userId}/auto-bewerb/docs/${id}-doc.pdf`,
    file_hash: id.replace(/-/g, ""),
    created_at: createdAt,
    updated_at: createdAt,
  };
}

let db: StudioDb;

function seed() {
  db = createStudioDb({
    auto_bewerb_profiles: [],
    auto_bewerb_companies: [companyRow(CO1), companyRow(CO2, { slot_no: 2 })],
    auto_bewerb_documents: [],
    auto_bewerb_attachments: [
      docRow(D1, "Zeugnis-A.pdf", USER_A, "2026-12-01T01:00:00.000Z"),
      docRow(D2, "Zertifikat-B.pdf", USER_A, "2026-12-01T02:00:00.000Z"),
      docRow(D3, "Referenz-C.pdf", USER_A, "2026-12-01T03:00:00.000Z"),
      // Another user's document — must NEVER leak into user-a's emails.
      docRow(DB_FOREIGN, "fremd.pdf", USER_B, "2026-12-01T00:00:00.000Z"),
    ],
    // Legacy per-company selection rows from BEFORE the global model —
    // inert now: the engine must not read or honor them.
    auto_bewerb_company_attachments: [{ company_id: CO1, attachment_id: D1, user_id: USER_A }],
    // LEGACY shape: no recipient/subject/account_id/attach_* columns →
    // the settings probe must classify the DB as unsupported (below).
    auto_bewerb_email_templates: [{ user_id: USER_A, body: "Sehr geehrte Damen und Herren," }],
    auto_bewerb_send_attempts: [],
    email_accounts: [
      { id: ACCT_ID, user_id: USER_A, provider: "gmail", email: "a@gmail.com", is_active: true, requires_reconnect: false },
    ],
    activity_logs: [],
    profiles: [],
  });
  (createAdminClient as ReturnType<typeof vi.fn>).mockReturnValue(db.admin);
  // LEGACY DB: the email-settings columns do not exist yet → the probe must
  // fall back to the per-company resolution (exactly like pre-migration).
  db.failSelect("auto_bewerb_email_templates", "recipient", '42703: column "recipient" does not exist');
}

function preparedPayload(companyId: string) {
  const attempt = db.tables.auto_bewerb_send_attempts.find((a) => a.company_id === companyId);
  return (attempt?.payload as AutoBewerbSendPayload | undefined)?.attachments ?? [];
}

/** This file simulates a LEGACY database (no email-settings migration):
 *  the settings column probe reports "column missing" → the send engine
 *  resolves everything from the stored per-company rows. The client passes
 *  ONLY the company id — no e-mail settings at all. */
async function prepare(companyId: string) {
  const res = await prepareAutoBewerbSend(USER_A, {
    companyId,
    schedule: FUTURE,
  });
  expect(res.ok).toBe(true);
  return res;
}

describe("AUTO BEWERB — global supporting documents", () => {
  beforeEach(() => {
    vi.resetModules();
    seed();
  });

  it("attaches ALL library documents to the application, in upload order, exactly once", async () => {
    await prepare(CO1);
    const attachments = preparedPayload(CO1);
    expect(attachments.map((a) => a.filename)).toEqual(["Zeugnis-A.pdf", "Zertifikat-B.pdf", "Referenz-C.pdf"]);
    // No duplicate storage object, no foreign document.
    expect(attachments).toHaveLength(new Set(attachments.map((a) => a.storagePath)).size);
    expect(attachments.map((a) => a.filename)).not.toContain("fremd.pdf");
  });

  it("a company added later gets the same global documents automatically", async () => {
    // Simulate a sixth company being added later (same user, no selection step).
    db.tables.auto_bewerb_companies.push(companyRow(CO3, { slot_no: 3 }));
    await prepare(CO3);
    expect(preparedPayload(CO3).map((a) => a.filename)).toEqual(["Zeugnis-A.pdf", "Zertifikat-B.pdf", "Referenz-C.pdf"]);
  });

  it("removing a shared document removes it from every future application", async () => {
    await prepare(CO1);
    // User deletes the middle document (library is the single source of truth).
    db.tables.auto_bewerb_attachments = db.tables.auto_bewerb_attachments.filter((a) => a.id !== D2);
    db.tables.auto_bewerb_companies.push(companyRow(CO3, { slot_no: 3 }));
    await prepare(CO3);
    expect(preparedPayload(CO3).map((a) => a.filename)).toEqual(["Zeugnis-A.pdf", "Referenz-C.pdf"]);
    // The earlier company's prepared payload is its own snapshot (unchanged).
    expect(preparedPayload(CO1).map((a) => a.filename)).toEqual(["Zeugnis-A.pdf", "Zertifikat-B.pdf", "Referenz-C.pdf"]);
  });

  it("never reads the legacy per-company selection table", async () => {
    await prepare(CO1);
    const joinQueries = db.calls.filter((c) => c.table === "auto_bewerb_company_attachments");
    expect(joinQueries).toHaveLength(0);
  });

  it("ignores a stale per-company selection (legacy row) in favor of the global library", async () => {
    // CO1 has a legacy join row selecting ONLY D1 — the global library wins.
    await prepare(CO1);
    expect(preparedPayload(CO1).map((a) => a.filename)).toEqual(["Zeugnis-A.pdf", "Zertifikat-B.pdf", "Referenz-C.pdf"]);
  });

  it("never attaches documents of another user (ownership verified server-side)", async () => {
    await prepare(CO1);
    const paths = preparedPayload(CO1).map((a) => a.storagePath);
    expect(paths.some((p) => p.startsWith(`${USER_B}/`))).toBe(false);
  });

  it("marks the company scheduled with the prepared payload persisted", async () => {
    const res = await prepare(CO1);
    expect(res.scheduledAt).toBeTruthy();
    const row = db.tables.auto_bewerb_companies.find((c) => c.id === CO1)!;
    expect(row.status).toBe("scheduled");
    expect(row.scheduled_at).toBeTruthy();
  });
});
