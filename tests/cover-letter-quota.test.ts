import { beforeEach, describe, expect, it, vi } from "vitest";

// Cover-letter endpoint: the server-side `cover_letter` quota meter
// (reserve BEFORE the model call, complete on success, release on failure,
// denials fail closed and never call the model) + the pure
// `isCoverLetterRequest` detector used by the chat route to route messages
// to this quota.
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(),
}));
vi.mock("@/lib/billing/entitlement-service", () => ({
  reserveFeatureOp: vi.fn(),
  completeFeatureOp: vi.fn(),
  releaseFeatureOp: vi.fn(),
}));
vi.mock("@/lib/ai-service", () => ({
  provider: vi.fn(),
}));
vi.mock("@/lib/templates/cv", () => ({
  sanitizeCvDocument: (cv: unknown) => cv ?? null,
}));
vi.mock("@/lib/templates/cover-letter", () => ({
  formatCvForPrompt: (cv: unknown) => (cv ? "CV" : "lebenslauf: nicht verfuegbar"),
  formatProfileForPrompt: (profile: unknown) =>
    profile ? "PROFIL" : "profil: nicht verfuegbar",
}));
vi.mock("@/lib/rate-limit", async () => {
  const { NextResponse } = await import("next/server");
  return {
    checkRateLimit: vi.fn(),
    rateLimitHeaders: vi.fn(() => ({ "x-ratelimit-remaining": "8" })),
    tooManyRequests: vi.fn(
      () => NextResponse.json({ error: "RATE_LIMITED_MARKER" }, { status: 429 }),
    ),
  };
});

const { createClient } = await import("@/lib/supabase/server");
const { createAdminClient } = await import("@/lib/supabase/admin");
const {
  reserveFeatureOp,
  completeFeatureOp,
  releaseFeatureOp,
} = await import("@/lib/billing/entitlement-service");
const { provider } = await import("@/lib/ai-service");
const { checkRateLimit } = await import("@/lib/rate-limit");
// Pure module (only @/lib/germany-knowledge) — safe to import for real.
const { isCoverLetterRequest } = await import("@/lib/ai-scope");

const authClient = createClient as unknown as ReturnType<typeof vi.fn>;
const adminClient = createAdminClient as unknown as ReturnType<typeof vi.fn>;
const reserve = reserveFeatureOp as unknown as ReturnType<typeof vi.fn>;
const complete = completeFeatureOp as unknown as ReturnType<typeof vi.fn>;
const release = releaseFeatureOp as unknown as ReturnType<typeof vi.fn>;
const generateText = vi.fn();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function authed(userId: string) {
  authClient.mockResolvedValue({
    auth: { getUser: async () => ({ data: { user: { id: userId } } }) },
  } as never);
}

async function postDirect(body: Record<string, unknown>) {
  const { POST } = await import("@/app/api/ai/cover-letter/route");
  return POST(
    new Request("http://localhost/api/ai/cover-letter", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  authed("u1");
  adminClient.mockReturnValue({
    from: (table: string) =>
      table === "candidate_profiles"
        ? {
            select: () => ({
              eq: () => ({ order: () => ({ limit: () => ({
                maybeSingle: async () => ({ data: null, error: null }),
              }) }) }),
            }),
          }
        : { select: () => ({}) },
  } as never);
  (checkRateLimit as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    allowed: true,
    limit: 20,
    remaining: 9,
    retryAfterMs: 0,
  });
  reserve.mockResolvedValue({ outcome: "reserved" });
  complete.mockResolvedValue({ outcome: "completed" });
  release.mockResolvedValue({ outcome: "released" });
  (provider as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    generateText,
  });
  generateText.mockResolvedValue("GENERATED_BODY");
});

function runId(): string {
  return String(reserve.mock.calls[0]?.[2] ?? "");
}

const VALID_BODY = {
  mode: "generate",
  position: "Fachinformatiker",
  company: "Muster GmbH",
};

describe("POST /api/ai/cover-letter — cover_letter quota cycle", () => {
  it("requires authentication (no quota call)", async () => {
    authClient.mockResolvedValue({
      auth: { getUser: async () => ({ data: { user: null } }) },
    } as never);
    const res = await postDirect({});
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(reserve).not.toHaveBeenCalled();
  });

  it("rate-limited → 429 before any reservation", async () => {
    (checkRateLimit as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      allowed: false,
      limit: 20,
      remaining: 0,
      retryAfterMs: 60_000,
    });
    const res = await postDirect(VALID_BODY);
    expect(res.status).toBe(429);
    expect(reserve).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
  });

  it("improve mode without a body → 400 before any reservation", async () => {
    const res = await postDirect({ mode: "improve" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Body is required for improve mode.",
    });
    expect(reserve).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
  });

  it("quota_exhausted → exact 429 body, model NEVER called", async () => {
    reserve.mockResolvedValue({ outcome: "quota_exhausted" });
    const res = await postDirect(VALID_BODY);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      error: "Cover letter limit reached. It resets daily (UTC).",
      code: "quota_exhausted",
    });
    expect(generateText).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it("feature_disabled → exact 403 body, model NEVER called", async () => {
    reserve.mockResolvedValue({ outcome: "feature_disabled" });
    const res = await postDirect(VALID_BODY);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "Cover letter generation is not available on your current plan.",
      code: "feature_disabled",
    });
    expect(generateText).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it("quota service error (with message) → 503 quota_unavailable", async () => {
    reserve.mockResolvedValue({
      outcome: "error",
      message: "QUOTA_SERVICE_DETAIL",
    });
    const res = await postDirect(VALID_BODY);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: "QUOTA_SERVICE_DETAIL",
      code: "quota_unavailable",
    });
    expect(generateText).not.toHaveBeenCalled();
  });

  it("quota service error (no message) → 503 default message", async () => {
    reserve.mockResolvedValue({ outcome: "error" });
    const res = await postDirect(VALID_BODY);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: "Quota service temporarily unavailable.",
      code: "quota_unavailable",
    });
  });

  it("success → complete with the SAME run id, 200 { text } + rate headers", async () => {
    const res = await postDirect(VALID_BODY);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "GENERATED_BODY" });
    expect(res.headers.get("x-ratelimit-remaining")).toBe("8");

    expect(reserve).toHaveBeenCalledTimes(1);
    expect(reserve).toHaveBeenCalledWith(
      "u1",
      "cover_letter",
      expect.any(String),
    );
    const id = runId();
    expect(id).toMatch(UUID_RE);
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith("u1", "cover_letter", id);
    expect(release).not.toHaveBeenCalled();
  });

  it("provider failure → release with the SAME run id, 400 { error }", async () => {
    generateText.mockRejectedValue(new Error("model down"));
    const res = await postDirect(VALID_BODY);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "model down" });

    const id = runId();
    expect(id).toMatch(UUID_RE);
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith("u1", "cover_letter", id);
    expect(complete).not.toHaveBeenCalled();
  });
});

describe("isCoverLetterRequest — pure detector (real module)", () => {
  const cases: Array<[string, boolean]> = [
    // German
    ["Schreib mir ein Anschreiben", true],
    ["Anschreiben erstellen", true],
    ["Erstelle mir ein Bewerbungsschreiben", true],
    ["Verbessere mein Anschreiben", true],
    ["Was brauche ich für ein Anschreiben?", false],
    // English
    ["Write me a cover letter", true],
    ["WRITE A COVER LETTER", true],
    ["improve my cover letter", true],
    ["Write a letter of application", true],
    ["What is a cover letter?", false],
    // French (accent-free: the normalizer keeps é/è, so "ecri" must appear)
    ["ecris moi une lettre de motivation", true],
    ["lettre de motivation ecrire", true],
    ["qu'est-ce qu'une lettre de motivation ?", false],
    // Arabic — note: the bare-phrase patterns (خطاب التقديم / خطاب التغطية /
    // رسالة تغطية) are deliberately over-inclusive, so a QUESTION about a
    // cover letter also counts as a cover-letter op (harmless: it consumes a
    // meter slot but never generates a letter; the under-inclusive direction
    // — metering a real generation against the general AI quota — is what
    // must not happen).
    ["اكتب لي خطاب تقديم", true],
    ["خطاب التغطية", true],
    ["رسالة تغطية", true],
    ["ما هي مكونات خطاب تقديم؟", true],
    // Empty / whitespace
    ["", false],
    ["   ", false],
  ];

  it.each(cases)("%j → %j", (input, expected) => {
    expect(isCoverLetterRequest(input)).toBe(expected);
  });
});
