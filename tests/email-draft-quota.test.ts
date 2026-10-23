import { beforeEach, describe, expect, it, vi } from "vitest";

// Quota-cycle tests for the `email_drafts` meter around createBlankDraft
// (promised by the comment in tests/application-drafts.test.ts):
//   atomic reserve -> insert -> complete (success) / release (failure).
// Denials fail CLOSED before any DB write; legacy `unmetered` users never
// touch the ledger at all (byte-identical to the pre-commercial flow).
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/billing/entitlement-service", () => ({
  reserveFeatureOp: vi.fn(),
  completeFeatureOp: vi.fn(),
  releaseFeatureOp: vi.fn(),
}));

const { createAdminClient } = await import("@/lib/supabase/admin");
const {
  reserveFeatureOp,
  completeFeatureOp,
  releaseFeatureOp,
} = await import("@/lib/billing/entitlement-service");
const { createBlankDraft, DraftQuotaError } = await import(
  "@/lib/application-drafts"
);

const adminClient = createAdminClient as unknown as ReturnType<typeof vi.fn>;
const reserve = reserveFeatureOp as unknown as ReturnType<typeof vi.fn>;
const complete = completeFeatureOp as unknown as ReturnType<typeof vi.fn>;
const release = releaseFeatureOp as unknown as ReturnType<typeof vi.fn>;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface InsertRecord {
  table: string;
  payload: Record<string, unknown>;
}
let inserts: InsertRecord[];
let insertResult: { data: unknown; error: unknown };

function mockAdmin(result: { data: unknown; error: unknown }) {
  insertResult = result;
  adminClient.mockReturnValue({
    from: (table: string) => ({
      insert: (payload: Record<string, unknown>) => ({
        select: () => ({
          single: async () => {
            inserts.push({ table, payload });
            return insertResult;
          },
        }),
      }),
    }),
  } as never);
}

function runId(): string {
  return String(reserve.mock.calls[0]?.[2] ?? "");
}

async function capturedError(): Promise<unknown> {
  try {
    await createBlankDraft("u1", "ausbildung", "a1");
  } catch (error) {
    return error;
  }
  throw new Error("createBlankDraft unexpectedly succeeded");
}

const SUCCESS_ROW = {
  id: "d1",
  user_id: "u1",
  goal: "ausbildung",
  sender_email_account_id: "a1",
};

beforeEach(() => {
  vi.clearAllMocks();
  inserts = [];
  mockAdmin({ data: SUCCESS_ROW, error: null });
  reserve.mockResolvedValue({ outcome: "reserved" });
  complete.mockResolvedValue({ outcome: "completed" });
  release.mockResolvedValue({ outcome: "released" });
});

describe("createBlankDraft — email_drafts quota cycle", () => {
  it("reserved → insert → complete: charged exactly once, same run id", async () => {
    const draft = await createBlankDraft("u1", "ausbildung", "a1");

    expect(reserve).toHaveBeenCalledTimes(1);
    expect(reserve).toHaveBeenCalledWith(
      "u1",
      "email_drafts",
      expect.any(String),
    );
    const id = runId();
    expect(id).toMatch(UUID_RE);

    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith("u1", "email_drafts", id);
    expect(release).not.toHaveBeenCalled();

    expect(inserts).toHaveLength(1);
    expect(inserts[0].table).toBe("application_drafts");
    expect(inserts[0].payload).toEqual({
      user_id: "u1",
      goal: "ausbildung",
      sender_email_account_id: "a1",
    });
    expect(draft).toEqual({
      ...SUCCESS_ROW,
      recipients: [],
      attachments: [],
    });
  });

  it("already_reserved (idempotent re-reserve) still settles with complete", async () => {
    reserve.mockResolvedValue({ outcome: "already_reserved" });
    const draft = await createBlankDraft("u1", "ausbildung", "a1");

    expect(reserve).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith("u1", "email_drafts", runId());
    expect(release).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(1);
    expect(draft.id).toBe("d1");
  });

  it("insert failure → release with the SAME run id, controlled message", async () => {
    mockAdmin({
      data: null,
      error: { message: "RAW_DB_DETAIL: constraint application_drafts_fkey" },
    });
    const error = await capturedError();

    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith("u1", "email_drafts", runId());
    expect(complete).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(DraftQuotaError);
    expect((error as Error).message).toBe(
      "Unable to create a new application.",
    );
    expect((error as Error).message).not.toContain("RAW_DB_DETAIL");
  });

  it("quota_exhausted → DraftQuotaError BEFORE any DB write", async () => {
    reserve.mockResolvedValue({ outcome: "quota_exhausted" });
    const error = await capturedError();

    expect(error).toBeInstanceOf(DraftQuotaError);
    expect(
      (error as InstanceType<typeof DraftQuotaError>).code,
    ).toBe("quota_exhausted");
    expect((error as Error).message).toBe(
      "You've reached the daily limit for new application emails. The limit resets daily (UTC).",
    );
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(inserts).toHaveLength(0);
    expect(complete).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it("feature_disabled → DraftQuotaError, no insert, no ledger writes", async () => {
    reserve.mockResolvedValue({ outcome: "feature_disabled" });
    const error = await capturedError();

    expect(error).toBeInstanceOf(DraftQuotaError);
    expect(
      (error as InstanceType<typeof DraftQuotaError>).code,
    ).toBe("feature_disabled");
    expect((error as Error).message).toBe(
      "Application emails are not available on your current plan.",
    );
    expect(inserts).toHaveLength(0);
    expect(complete).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it("error outcome → quota_unavailable, internal service detail never leaks", async () => {
    reserve.mockResolvedValue({
      outcome: "error",
      message: "SECRET_INTERNAL_QUOTA_DETAIL",
    });
    const error = await capturedError();

    expect(error).toBeInstanceOf(DraftQuotaError);
    expect(
      (error as InstanceType<typeof DraftQuotaError>).code,
    ).toBe("quota_unavailable");
    expect((error as Error).message).toBe(
      "The application email limit could not be verified. Please try again later.",
    );
    expect((error as Error).message).not.toContain(
      "SECRET_INTERNAL_QUOTA_DETAIL",
    );
    expect(inserts).toHaveLength(0);
    expect(complete).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it("unmetered (legacy) → insert succeeds with ZERO ledger settlement calls", async () => {
    reserve.mockResolvedValue({ outcome: "unmetered" });
    const draft = await createBlankDraft("u1", "ausbildung", "a1");

    expect(reserve).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(1);
    expect(draft.id).toBe("d1");
  });

  it("unmetered (legacy) + insert failure → controlled message, no ledger call at all", async () => {
    reserve.mockResolvedValue({ outcome: "unmetered" });
    mockAdmin({ data: null, error: { message: "raw" } });
    const error = await capturedError();

    expect(complete).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect((error as Error).message).toBe(
      "Unable to create a new application.",
    );
  });
});
