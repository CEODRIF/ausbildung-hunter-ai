import { describe, expect, it, vi } from "vitest";

// createBlankDraft runs inside the composer server action, so a raw Supabase
// insert error must never reach the client. Mock both Supabase client modules
// so the module imports hermetically (mirrors the other draft tests).
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

const { createAdminClient } = await import("@/lib/supabase/admin");
const { createBlankDraft } = await import("@/lib/application-drafts");
const { COMMERCIAL_SUB_ROW, COMMERCIAL_PLAN_ROW } = await import("./helpers");

const adminClient = createAdminClient as unknown as ReturnType<typeof vi.fn>;

/** Minimal admin-client fake: `.from().insert().select().single()` resolves to
 *  the supplied PostgREST-style `{ data, error }`. The entitlement lookups
 *  (subscriptions → billing_plans) resolve to a VERIFIED ACTIVE COMMERCIAL
 *  subscription, so the email_drafts reservation inside createBlankDraft
 *  takes its metered path and these error-collapse tests focus on the
 *  INSERT. Ledger RPCs answer "reserved / no_op / released". Plan-gating
 *  behavior itself is tested in tests/email-draft-quota.test.ts (mocked
 *  service) and tests/subscription-entitlement-boundary.test.ts (real
 *  service, denial paths). */
function mockInsert(result: { data: unknown; error: unknown }) {
  adminClient.mockReturnValue({
    from: (table: string) =>
      table === "subscriptions"
        ? {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: COMMERCIAL_SUB_ROW,
                  error: null,
                }),
              }),
            }),
          }
        : table === "billing_plans"
          ? {
              select: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: COMMERCIAL_PLAN_ROW,
                    error: null,
                  }),
                }),
              }),
            }
          : {
              insert: () => ({
                select: () => ({
                  single: async () => result,
                }),
              }),
            },
    rpc: async (fn: string) => {
      if (fn === "reserve_feature_op")
        return {
          data: [{ status: "reserved", used: 1, remaining: 119 }],
          error: null,
        };
      if (fn === "complete_feature_op")
        return { data: [{ status: "no_op" }], error: null };
      if (fn === "release_feature_op")
        return { data: [{ status: "released" }], error: null };
      return { data: null, error: null };
    },
  } as never);
}

describe("createBlankDraft — Phase 22 error-collapse (no DB detail leak)", () => {
  it("returns the created draft with empty recipients/attachments on success", async () => {
    mockInsert({
      data: {
        id: "d1",
        user_id: "u1",
        goal: "ausbildung",
        sender_email_account_id: "a1",
      },
      error: null,
    });
    const draft = await createBlankDraft("u1", "ausbildung", "a1");
    expect(draft.id).toBe("d1");
    expect(draft.recipients).toEqual([]);
    expect(draft.attachments).toEqual([]);
  });

  it("collapses a raw Supabase insert error to a controlled message", async () => {
    const raw =
      'new row violates foreign key constraint "application_drafts_sender_email_account_id_fkey" on table "public.application_drafts"';
    mockInsert({ data: null, error: { message: raw } });
    await expect(createBlankDraft("u1", "ausbildung", "a1")).rejects.toThrow(
      "Unable to create a new application.",
    );
  });

  it("never surfaces raw database/constraint text to the caller", async () => {
    const raw = "RAW_DB_DETAIL: insert into public.application_drafts (id) ...";
    mockInsert({ data: null, error: { message: raw } });
    let message = "";
    try {
      await createBlankDraft("u1", "ausbildung", "a1");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("Unable to create a new application.");
    expect(message).not.toContain("RAW_DB_DETAIL");
    expect(message).not.toContain("application_drafts");
  });
});
