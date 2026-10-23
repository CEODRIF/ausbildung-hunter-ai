import { beforeEach, describe, expect, it, vi } from "vitest";

// Scanner per-cycle quota (the `scanner` ledger meter inside runScan):
//   reserve(scanId) BEFORE any model call → complete on success, release on
//   every failure; quota denials fail closed before the AI reservation;
//   unexpected technical errors are mapped to the stable user-safe code.

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/billing/entitlement-service", () => ({
  reserveFeatureOp: vi.fn(),
  completeFeatureOp: vi.fn(),
  releaseFeatureOp: vi.fn(),
}));
vi.mock("@/lib/billing/entitlements", () => ({ getEntitlements: vi.fn() }));
vi.mock("@/lib/ai-provider", () => ({ createAIProvider: vi.fn() }));
vi.mock("@/lib/ai-file-context", () => ({ buildFileContext: vi.fn() }));
vi.mock("@/lib/bewerbung-scanner", () => ({
  activeUser: vi.fn(),
  // Same values as the real module (src/lib/bewerbung-scanner.ts L22/L25).
  SCAN_PROFILE_INCOMPLETE: "SCAN_PROFILE_INCOMPLETE",
  SCAN_UNEXPECTED_FAILED: "SCAN_UNEXPECTED_FAILED",
}));
vi.mock("@/lib/bewerbung-scanner-prompt", () => ({
  buildScannerPrompt: (goal: string) => `PROMPT:${goal}`,
  buildSparseRetryPrompt: () => "RETRY_PROMPT",
}));

const { createAdminClient } = await import("@/lib/supabase/admin");
const {
  reserveFeatureOp,
  completeFeatureOp,
  releaseFeatureOp,
} = await import("@/lib/billing/entitlement-service");
const { getEntitlements } = await import("@/lib/billing/entitlements");
const { createAIProvider } = await import("@/lib/ai-provider");
const { buildFileContext } = await import("@/lib/ai-file-context");
const { activeUser } = await import("@/lib/bewerbung-scanner");
const { runScan } = await import("@/lib/bewerbung-scan");
const { candidateProfileFixture } = await import("./helpers");
const { candidateProfileSchema } = await import("@/lib/bewerbung-schema");

const adminClient = createAdminClient as unknown as ReturnType<typeof vi.fn>;
const reserve = reserveFeatureOp as unknown as ReturnType<typeof vi.fn>;
const complete = completeFeatureOp as unknown as ReturnType<typeof vi.fn>;
const release = releaseFeatureOp as unknown as ReturnType<typeof vi.fn>;
const activeUserMock = activeUser as unknown as ReturnType<typeof vi.fn>;
const getEntitlementsMock = getEntitlements as unknown as ReturnType<
  typeof vi.fn
>;
const createAIProviderMock = createAIProvider as unknown as ReturnType<
  typeof vi.fn
>;
const buildFileContextMock = buildFileContext as unknown as ReturnType<
  typeof vi.fn
>;
const generateText = vi.fn();

const USER = "u1";
const SCAN = "scan-1";

interface State {
  /** Human-readable op log (payloads serialized). */
  ops: string[];
  rpcLog: Array<{ name: string; args: Record<string, unknown> }>;
  scanRow: { id: string; goal: string; status: string } | null;
  scanFiles: Array<Record<string, unknown>>;
  uploads: Array<Record<string, unknown>>;
  reserveAiError: { message: string } | null;
}

function freshState(overrides: Partial<State> = {}): State {
  return {
    ops: [],
    rpcLog: [],
    scanRow: { id: SCAN, goal: "ausbildung", status: "uploading" },
    scanFiles: [
      {
        filename: "cv.pdf",
        mime_type: "application/pdf",
        storage_file_id: "up-1",
      },
    ],
    uploads: [
      {
        id: "up-1",
        filename: "cv.pdf",
        mime_type: "application/pdf",
        storage_path: "u1/cv.pdf",
        size_bytes: 123,
      },
    ],
    reserveAiError: null,
    ...overrides,
  };
}

/** Chain-accurate fake for the exact query shapes runScan() issues. */
function adminFake(state: State) {
  return {
    from(table: string) {
      if (table === "bewerbung_scans") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                single: async () => {
                  state.ops.push("scans.select");
                  return state.scanRow
                    ? { data: state.scanRow, error: null }
                    : { data: null, error: { message: "no rows" } };
                },
              }),
            }),
          }),
          update: (payload: Record<string, unknown>) => ({
            eq: () => ({
              eq: async () => {
                state.ops.push(`scans.update:${JSON.stringify(payload)}`);
                return { data: null, error: null };
              },
            }),
          }),
        };
      }
      if (table === "bewerbung_scan_files") {
        return {
          select: () => ({
            eq: () => ({
              eq: async () => {
                state.ops.push("files.select");
                return { data: state.scanFiles, error: null };
              },
            }),
          }),
        };
      }
      if (table === "ai_file_uploads") {
        return {
          select: () => ({
            in: () => ({
              eq: async () => {
                state.ops.push("uploads.select");
                return { data: state.uploads, error: null };
              },
            }),
          }),
        };
      }
      if (table === "candidate_profiles") {
        return {
          upsert: async (payload: Record<string, unknown>) => {
            state.ops.push(`profiles.upsert:${JSON.stringify(payload)}`);
            return { data: null, error: null };
          },
        };
      }
      if (table === "activity_logs") {
        return {
          insert: async (payload: Record<string, unknown>) => {
            state.ops.push(`activity.insert:${JSON.stringify(payload)}`);
            return { data: null, error: null };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      state.rpcLog.push({ name, args });
      if (name === "reserve_ai_request")
        return state.reserveAiError
          ? { data: null, error: state.reserveAiError }
          : { data: { remaining: 4 }, error: null };
      if (name === "release_ai_request") return { data: null, error: null };
      return { data: null, error: { message: `unknown rpc ${name}` } };
    },
  };
}

let state: State;

beforeEach(() => {
  state = freshState();
  vi.clearAllMocks();
  activeUserMock.mockResolvedValue({ id: USER });
  adminClient.mockReturnValue(adminFake(state) as never);
  reserve.mockResolvedValue({ outcome: "reserved" });
  complete.mockResolvedValue({ outcome: "completed" });
  release.mockResolvedValue({ outcome: "released" });
  getEntitlementsMock.mockResolvedValue({ aiPerDay: 5 });
  createAIProviderMock.mockReturnValue({ generateText });
  // < SPARSE_MIN_DOC_CHARS (800) → the controlled sparse-retry pass is never
  // triggered, so exactly ONE model call happens.
  buildFileContextMock.mockResolvedValue("KURZER KONTEXT");
  generateText.mockResolvedValue(
    JSON.stringify(candidateProfileFixture()),
  );
});

function rpcNames(): string[] {
  return state.rpcLog.map((r) => r.name);
}

describe("runScan — scanner quota cycle", () => {
  const DENIALS: Array<[string, string]> = [
    ["quota_exhausted", "Scanner limit reached for your current plan."],
    ["feature_disabled", "Scanner is not available on your current plan."],
    ["error", "Scanner quota could not be verified. Please try again later."],
  ];

  it.each(DENIALS)(
    "%s → exact message, no AI rpc, no ledger settlement, no model call",
    async (outcome, message) => {
      reserve.mockResolvedValue({ outcome } as never);
      await expect(runScan(SCAN)).rejects.toThrow(message);

      expect(reserve).toHaveBeenCalledTimes(1);
      expect(reserve).toHaveBeenCalledWith(USER, "scanner", SCAN);
      expect(complete).not.toHaveBeenCalled();
      expect(release).not.toHaveBeenCalled();
      expect(rpcNames()).toEqual([]); // AI quota never touched
      expect(generateText).not.toHaveBeenCalled();
      // The pre-reserve status flip already happened (real behavior);
      // nothing AFTER the denial runs — no files select, no failed update.
      expect(state.ops).toEqual([
        "scans.select",
        'scans.update:{"status":"analyzing","error_message":null}',
      ]);
    },
  );

  it("AI reservation failure (ai_daily_limit_reached) → exact message, scanner released, AI NOT released", async () => {
    state.reserveAiError = {
      message: "ai_daily_limit_reached: 5 of 5 used",
    };
    await expect(runScan(SCAN)).rejects.toThrow(
      "AI daily request limit reached. Please try again tomorrow.",
    );

    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(USER, "scanner", SCAN);
    expect(complete).not.toHaveBeenCalled();
    expect(rpcNames()).toEqual(["reserve_ai_request"]);
    expect(generateText).not.toHaveBeenCalled();
    // The throw is OUTSIDE the try block → no "failed" status update either.
    expect(state.ops.filter((o) => o.startsWith("scans.update:"))).toEqual([
      'scans.update:{"status":"analyzing","error_message":null}',
    ]);
  });

  it("AI reservation failure (other) → 'AI usage is unavailable.', scanner released", async () => {
    state.reserveAiError = { message: "boom" };
    await expect(runScan(SCAN)).rejects.toThrow("AI usage is unavailable.");
    expect(release).toHaveBeenCalledWith(USER, "scanner", SCAN);
    expect(rpcNames()).toEqual(["reserve_ai_request"]);
  });

  it("no scan files → released (scanner + AI), failed status stores the safe message", async () => {
    state = freshState({ scanFiles: [] });
    adminClient.mockReturnValue(adminFake(state) as never);
    await expect(runScan(SCAN)).rejects.toThrow("No scan files found.");

    expect(release).toHaveBeenCalledWith(USER, "scanner", SCAN);
    expect(complete).not.toHaveBeenCalled();
    expect(rpcNames()).toEqual([
      "reserve_ai_request",
      "release_ai_request",
    ]);
    expect(state.ops).toContain(
      'scans.update:{"status":"failed","error_message":"No scan files found."}',
    );
    expect(generateText).not.toHaveBeenCalled();
  });

  it("upload/scan-file count mismatch → ownership error, both reservations released", async () => {
    state = freshState({
      scanFiles: [
        { filename: "a.pdf", mime_type: "application/pdf", storage_file_id: "up-1" },
        { filename: "b.pdf", mime_type: "application/pdf", storage_file_id: "up-2" },
      ],
    });
    adminClient.mockReturnValue(adminFake(state) as never);
    await expect(runScan(SCAN)).rejects.toThrow(
      "Scan file ownership could not be verified.",
    );
    expect(release).toHaveBeenCalledWith(USER, "scanner", SCAN);
    expect(complete).not.toHaveBeenCalled();
    expect(rpcNames()).toEqual([
      "reserve_ai_request",
      "release_ai_request",
    ]);
    expect(state.ops).toContain(
      'scans.update:{"status":"failed","error_message":"Scan file ownership could not be verified."}',
    );
  });

  it("success → complete with the scan id, profile upsert carries the SCAN goal", async () => {
    const profile = await runScan(SCAN);

    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith(USER, "scanner", SCAN);
    expect(release).not.toHaveBeenCalled();
    // AI quota unit consumed, not released.
    expect(rpcNames()).toEqual(["reserve_ai_request"]);
    expect(getEntitlements).toHaveBeenCalledWith(USER);

    expect(buildFileContext).toHaveBeenCalledWith(state.uploads, 10);
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(generateText).toHaveBeenCalledWith(
      [{ role: "user", content: "PROMPT:ausbildung" }],
      180_000,
    );

    const upsertOp = state.ops.find((o) =>
      o.startsWith("profiles.upsert:"),
    );
    expect(upsertOp).toBeTruthy();
    const upsertPayload = JSON.parse(
      upsertOp!.slice("profiles.upsert:".length),
    ) as {
      user_id: string;
      scan_id: string;
      profile_json: { goal: string };
    };
    expect(upsertPayload.user_id).toBe(USER);
    expect(upsertPayload.scan_id).toBe(SCAN);
    expect(upsertPayload.profile_json.goal).toBe("ausbildung");
    // The returned profile is the zod-parsed + normalized document: the raw
    // fixture fields survive, the schema fills defaults (candidate block),
    // and the goal is forced to the SCAN's goal — not the fixture's.
    expect(candidateProfileSchema.safeParse(profile).success).toBe(true);
    expect(profile).toMatchObject({
      goal: "ausbildung",
      education: [
        expect.objectContaining({
          education_level: "Mittlerer Schulabschluss",
        }),
      ],
      training: [expect.objectContaining({ name: "Mechatroniker" })],
      experience: [
        expect.objectContaining({
          job_title: "Mechatroniker",
          responsibilities: ["Wartung von Anlagen"],
        }),
      ],
      languages: [expect.objectContaining({ language: "German", level: "C1" })],
    });

    expect(state.ops.some((o) => o.startsWith('scans.update:{"status":"completed"'))).toBe(true);
    const activityOp = state.ops.find((o) => o.startsWith("activity.insert:"));
    expect(activityOp).toBeTruthy();
    const activity = JSON.parse(
      activityOp!.slice("activity.insert:".length),
    ) as { activity_type: string; metadata: { scan_id: string } };
    expect(activity.activity_type).toBe("bewerbung_scan_completed");
    expect(activity.metadata.scan_id).toBe(SCAN);
  });

  it("unexpected technical provider error → stable SCAN_UNEXPECTED_FAILED, both reservations released", async () => {
    generateText.mockRejectedValue(new Error("DOMMatrix is not defined"));
    await expect(runScan(SCAN)).rejects.toThrow("SCAN_UNEXPECTED_FAILED");

    expect(release).toHaveBeenCalledWith(USER, "scanner", SCAN);
    expect(complete).not.toHaveBeenCalled();
    expect(rpcNames()).toEqual([
      "reserve_ai_request",
      "release_ai_request",
    ]);
    expect(state.ops).toContain(
      'scans.update:{"status":"failed","error_message":"SCAN_UNEXPECTED_FAILED"}',
    );
  });

  it("already_reserved (re-run of the same scan) → still completes exactly once", async () => {
    reserve.mockResolvedValue({ outcome: "already_reserved" });
    const profile = await runScan(SCAN);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith(USER, "scanner", SCAN);
    expect(release).not.toHaveBeenCalled();
    expect(profile.goal).toBe("ausbildung");
  });

  it("unmetered (legacy) → scanner still settles via complete; the ledger service no-ops it", async () => {
    reserve.mockResolvedValue({ outcome: "unmetered" });
    complete.mockResolvedValue({ outcome: "no_op" });
    await expect(runScan(SCAN)).resolves.toMatchObject({
      goal: "ausbildung",
    });
    // release is the refund path — a legacy scan never refunds anything.
    expect(release).not.toHaveBeenCalled();
    expect(rpcNames()).toEqual(["reserve_ai_request"]);
  });
});
