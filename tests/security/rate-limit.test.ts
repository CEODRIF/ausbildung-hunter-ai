import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Rate-limit ENFORCEMENT for the endpoints that had no burst protection.
 *
 * `tests/rate-limit.test.ts` already covers the limiter library and the routes
 * that were limited from the start. This suite pins the three endpoints added
 * now — the scanner run, the AI upload and the AI file generation — so that a
 * refactor which drops the check (or moves it after the expensive call) fails
 * the build instead of silently reopening the abuse path.
 *
 * The limiter itself is the real one; only `checkRateLimit` is stubbed, so the
 * assertion is about ORDER and STATUS, not about the fixture.
 */
/** RFC-4122 v4 id: it is also used as `conversationId`, which is validated. */
const USER_ID = "11111111-2222-4333-8444-555555555555";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/rate-limit", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/rate-limit")>("@/lib/rate-limit");
  return { ...actual, checkRateLimit: vi.fn() };
});
vi.mock("@/lib/bewerbung-scanner", () => ({
  createScan: vi.fn(),
  runScan: vi.fn(),
}));
vi.mock("@/lib/ai-service", () => ({
  uploadAIFile: vi.fn(),
  deleteAIFile: vi.fn(),
  AIFileInUseError: class AIFileInUseError extends Error {},
}));
vi.mock("@/lib/auth", () => ({ getCurrentUserAndProfile: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/ai-provider", () => ({ createAIProvider: vi.fn() }));

const { checkRateLimit } = await import("@/lib/rate-limit");
const { createClient } = await import("@/lib/supabase/server");
const { createScan, runScan } = await import("@/lib/bewerbung-scanner");
const { uploadAIFile } = await import("@/lib/ai-service");
const { getCurrentUserAndProfile } = await import("@/lib/auth");
const { createAIProvider } = await import("@/lib/ai-provider");

function mockSession() {
  vi.mocked(createClient).mockResolvedValue({
    auth: { getUser: async () => ({ data: { user: { id: USER_ID } } }) },
  } as never);
}

function mockDenied(scope: string, retryAfterSeconds = 42) {
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: false,
    count: 99,
    limit: 1,
    retryAfterSeconds,
    scope,
  } as never);
}

function mockAllowed(scope: string) {
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    count: 1,
    limit: 10,
    retryAfterSeconds: 0,
    scope,
  } as never);
}

const scanFile = {
  id: USER_ID,
  filename: "lebenslauf.pdf",
  mime_type: "application/pdf",
};

afterEach(() => vi.clearAllMocks());

describe("scanner run is limited before the vision model is called", () => {
  it("returns 429 and never starts a scan when the budget is exhausted", async () => {
    mockSession();
    mockDenied("scanner_scan");
    const { POST } = await import("@/app/api/bewerbung-scanner/scan/route");
    const res = await POST(
      new Request("http://localhost/api/bewerbung-scanner/scan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ goal: "arbeit", files: [scanFile] }),
      }),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("42");
    expect(checkRateLimit).toHaveBeenCalledWith("scanner_scan", USER_ID);
    expect(createScan).not.toHaveBeenCalled();
    expect(runScan).not.toHaveBeenCalled();
  });

  it("checks authentication BEFORE the limiter (401 wins over 429)", async () => {
    vi.mocked(createClient).mockResolvedValue({
      auth: { getUser: async () => ({ data: { user: null } }) },
    } as never);
    mockDenied("scanner_scan");
    const { POST } = await import("@/app/api/bewerbung-scanner/scan/route");
    const res = await POST(
      new Request("http://localhost/api/bewerbung-scanner/scan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ goal: "arbeit", files: [scanFile] }),
      }),
    );
    expect(res.status).toBe(401);
    expect(checkRateLimit).not.toHaveBeenCalled();
  });

  it("rejects a malformed payload without spending budget on it", async () => {
    mockSession();
    mockAllowed("scanner_scan");
    const { POST } = await import("@/app/api/bewerbung-scanner/scan/route");
    const res = await POST(
      new Request("http://localhost/api/bewerbung-scanner/scan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ goal: "arbeit", files: [{ id: "not-a-uuid" }] }),
      }),
    );
    expect(res.status).toBe(400);
    expect(createScan).not.toHaveBeenCalled();
  });
});

describe("AI uploads are limited before the body is buffered", () => {
  it("returns 429 and never stores the file when the budget is exhausted", async () => {
    mockSession();
    mockDenied("ai_upload");
    const { POST } = await import("@/app/api/ai/files/route");
    const body = new FormData();
    body.set("file", new File([new Uint8Array([1, 2, 3])], "x.pdf"));
    const res = await POST(
      new Request("http://localhost/api/ai/files", { method: "POST", body }),
    );
    expect(res.status).toBe(429);
    expect(checkRateLimit).toHaveBeenCalledWith("ai_upload", USER_ID);
    expect(uploadAIFile).not.toHaveBeenCalled();
  });

  it("the scanner upload endpoint shares the same budget", async () => {
    mockSession();
    mockDenied("ai_upload");
    const { POST } = await import("@/app/api/bewerbung-scanner/files/route");
    const body = new FormData();
    body.set("file", new File([new Uint8Array([1, 2, 3])], "x.pdf"));
    const res = await POST(
      new Request("http://localhost/api/bewerbung-scanner/files", {
        method: "POST",
        body,
      }),
    );
    expect(res.status).toBe(429);
    expect(checkRateLimit).toHaveBeenCalledWith("ai_upload", USER_ID);
    expect(uploadAIFile).not.toHaveBeenCalled();
  });
});

describe("AI file generation is limited before the paid call", () => {
  it("returns 429 and never calls the provider when the budget is exhausted", async () => {
    vi.mocked(getCurrentUserAndProfile).mockResolvedValue({
      user: { id: USER_ID },
      profile: { account_status: "active" },
    } as never);
    mockDenied("ai_generate_file");
    const { POST } = await import("@/app/api/ai/generate-file/route");
    const res = await POST(
      new Request("http://localhost/api/ai/generate-file", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          conversationId: USER_ID,
          filename: "anschreiben.txt",
          mimeType: "text/plain",
          prompt: "Schreibe ein Anschreiben.",
        }),
      }),
    );
    expect(res.status).toBe(429);
    expect(checkRateLimit).toHaveBeenCalledWith("ai_generate_file", USER_ID);
    expect(createAIProvider).not.toHaveBeenCalled();
  });

  it("an inactive account is refused before the limiter", async () => {
    vi.mocked(getCurrentUserAndProfile).mockResolvedValue({
      user: { id: USER_ID },
      profile: { account_status: "suspended" },
    } as never);
    mockDenied("ai_generate_file");
    const { POST } = await import("@/app/api/ai/generate-file/route");
    const res = await POST(
      new Request("http://localhost/api/ai/generate-file", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          conversationId: USER_ID,
          filename: "anschreiben.txt",
          mimeType: "text/plain",
          prompt: "x",
        }),
      }),
    );
    expect(res.status).toBe(401);
    expect(checkRateLimit).not.toHaveBeenCalled();
  });
});
