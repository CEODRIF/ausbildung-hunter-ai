import { describe, expect, it, vi } from "vitest";

// createBlankDraft runs inside the composer server action, so a raw Supabase
// insert error must never reach the client. Mock both Supabase client modules
// so the module imports hermetically (mirrors the other draft tests).
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

const { createAdminClient } = await import("@/lib/supabase/admin");
const { createBlankDraft } = await import("@/lib/application-drafts");

const adminClient = createAdminClient as unknown as ReturnType<typeof vi.fn>;

/** Minimal admin-client fake: `.from().insert().select().single()` resolves to
 *  the supplied PostgREST-style `{ data, error }`. */
function mockInsert(result: { data: unknown; error: unknown }) {
  adminClient.mockReturnValue({
    from: () => ({
      insert: () => ({
        select: () => ({
          single: async () => result,
        }),
      }),
    }),
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
