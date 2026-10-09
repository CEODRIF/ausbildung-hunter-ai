import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ getCurrentUserAndProfile: vi.fn() }));
const { getCurrentUserAndProfile } = await import("@/lib/auth");

const { mockGenerate } = vi.hoisted(() => ({ mockGenerate: vi.fn() }));
vi.mock("@/lib/ai-service", () => ({
  provider: () => ({ generateText: mockGenerate }),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({
    allowed: true,
    count: 1,
    limit: 5,
    retryAfterSeconds: 0,
  })),
  tooManyRequests: () =>
    new Response(JSON.stringify({ error: "Too many requests." }), { status: 429 }),
}));
const { checkRateLimit } = await import("@/lib/rate-limit");

const { POST } = await import("@/app/api/housing/scam-check/route");

type AuthResult = Awaited<ReturnType<typeof getCurrentUserAndProfile>>;
const authed = (id: string): AuthResult =>
  ({ user: { id }, profile: null }) as unknown as AuthResult;
const unauthenticated = (): AuthResult =>
  ({ user: null, profile: null }) as unknown as AuthResult;

function req(body: unknown) {
  return new Request("http://localhost/api/housing/scam-check", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mockGenerate.mockReset().mockResolvedValue("KI says: suspicious.");
  vi.clearAllMocks();
});
afterEach(() => vi.clearAllMocks());

describe("POST /api/housing/scam-check", () => {
  it("requires authentication", async () => {
    vi.mocked(getCurrentUserAndProfile).mockResolvedValue(unauthenticated());
    expect((await POST(req({ text: "x" }))).status).toBe(401);
  });

  it("rejects empty text (strict schema) with 400", async () => {
    vi.mocked(getCurrentUserAndProfile).mockResolvedValue(authed("user-1"));
    expect((await POST(req({ text: "" }))).status).toBe(400);
  });

  it("runs the heuristic (no AI) and returns the risk", async () => {
    vi.mocked(getCurrentUserAndProfile).mockResolvedValue(authed("user-1"));
    const res = await POST(req({ text: "Überweise die Kaution per Western Union" }));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { risk: string; ai_assisted: boolean };
    expect(data.risk).toBe("high");
    expect(data.ai_assisted).toBe(false);
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("adds the AI summary when useAi=true", async () => {
    vi.mocked(getCurrentUserAndProfile).mockResolvedValue(authed("user-1"));
    const res = await POST(
      req({ text: "Überweise sofort per Moneygram", useAi: true }),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      risk: string;
      ai_assisted: boolean;
      ai_summary: string | null;
    };
    expect(data.risk).toBe("high");
    expect(data.ai_assisted).toBe(true);
    expect(data.ai_summary).toBe("KI says: suspicious.");
  });

  it("degrades to the heuristic result when the AI fails", async () => {
    mockGenerate.mockRejectedValue(new Error("AI down"));
    vi.mocked(getCurrentUserAndProfile).mockResolvedValue(authed("user-1"));
    const res = await POST(
      req({ text: "Western Union", useAi: true }),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { risk: string; ai_assisted: boolean };
    expect(data.risk).toBe("high");
    expect(data.ai_assisted).toBe(false);
  });

  it("returns 429 when rate-limited", async () => {
    vi.mocked(getCurrentUserAndProfile).mockResolvedValue(authed("user-1"));
    vi.mocked(checkRateLimit).mockResolvedValueOnce({
      allowed: false,
      count: 6,
      limit: 5,
      retryAfterSeconds: 60,
    });
    expect((await POST(req({ text: "x" }))).status).toBe(429);
  });
});
