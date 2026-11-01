/**
 * AUTO BEWERB — batch queue pre-migration degradation (isolated module
 * registry: the engine's probe cache is module state, so this file MUST NOT
 * mix "table missing" and "table present" expectations).
 *
 * Production databases without the batches migration keep the FULL existing
 * workflow: the batch probe fails closed (schema_pending) and the workspace
 * reports batchesSupported = false (the UI hides queue + batch actions).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/email-providers", () => ({ createEmailProvider: vi.fn() }));
// The sending window is pinned OPEN for these engine tests so immediate-
// batch behavior never depends on the wall clock; the window GATE itself is
// covered by tests/auto-bewerb-sending-window-gate.test.ts (real logic + fake time).
vi.mock("@/lib/auto-bewerb/sending-window", () => ({
  isSendingWindowOpen: () => true,
  nextWindowStartMs: () => null,
  windowLabel: () => "07:30\u201310:30 Europe/Berlin",
  isCampaignTimeInWindow: () => true,
  AUTO_BEWERB_SENDING_WINDOW: { timeZone: "Europe/Berlin", startHour: 7, startMinute: 30, endHour: 10, endMinute: 30 },
}));

const { createAdminClient } = await import("@/lib/supabase/admin");
const { createStudioDb } = await import("./helpers-studio");

const USER = "11111111-1111-4111-8111-111111111111";
const TS = "2026-12-01T00:00:00.000Z";

function seedBase() {
  const db = createStudioDb({
    auto_bewerb_profiles: [],
    auto_bewerb_companies: [
      {
        id: `${USER.slice(0, 8)}-company-1`,
        user_id: USER,
        company: "Firma 1 GmbH",
        company_key: "firma 1 gmbh",
        slot_no: 1,
        ad_raw: "x".repeat(40),
        ad_extracted: { jobTitle: "Ausbildung 1", occupation: "Ausbildung 1", company: "Firma 1 GmbH", applicationEmail: "jobs@firma-1.de" },
        status: "ready",
        recipient_email: null,
        email_subject: null,
        email_body: null,
        email_attach_cv: true,
        email_attach_letter: true,
        email_account_id: null,
        idempotency_key: null,
        approved: true,
        approved_at: TS,
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
      },
    ],
    auto_bewerb_documents: [],
    auto_bewerb_attachments: [],
    auto_bewerb_company_attachments: [],
    auto_bewerb_email_templates: [],
    auto_bewerb_send_attempts: [],
    // NOTE: auto_bewerb_batches is intentionally ABSENT below (failTables).
    email_accounts: [],
    activity_logs: [],
    profiles: [],
  });
  (createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(db.admin);
  return db;
}

describe("batch queue pre-migration degradation", () => {
  it("createAutoBewerbBatch fails closed with schema_pending while the table is missing", async () => {
    const db = seedBase();
    db.failTables(["auto_bewerb_batches"]);
    const { createAutoBewerbBatch, getAutoBewerbBatchesProbe, getAutoBewerbBatches } = await import("@/lib/auto-bewerb/engine");
    expect((await getAutoBewerbBatchesProbe()).available).toBe(false);
    const res = await createAutoBewerbBatch(USER, { companyIds: [`${USER.slice(0, 8)}-company-1`], schedule: null });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("schema_pending");
    // The queue view is empty (no crash, no data):
    expect(await getAutoBewerbBatches(USER)).toHaveLength(0);
  });
});
