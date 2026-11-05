/**
 * AUTO BEWERB — Step 2 analyze-ad: ROUTE-LEVEL ERROR MAPPING.
 *
 * The companion of auto-bewerb-analyze-ad-provider.test.ts: here the provider
 * boundary is stubbed (like the generate-letter suite) so the ROUTE's
 * contract is pinned in isolation:
 *   - `analyzeAdFailureResponse` maps every failure code to the correct HTTP
 *     status (provider faults are 5xx to the browser, NOT 400), a stable
 *     machine `code`, and a `retryable` flag,
 *   - the timeout case (a 120 s real budget cannot be exercised in CI) maps
 *     to HTTP 504,
 *   - quota settlement: every failure RELEASES the reservation,
 *   - the bounded JSON retry still fires exactly once before invalid_ai_output.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/ai-service", () => ({ provider: vi.fn() }));
vi.mock("@/lib/billing/entitlement-service", () => ({
  reserveFeatureOp: vi.fn(),
  completeFeatureOp: vi.fn(),
  releaseFeatureOp: vi.fn(),
}));
vi.mock("@/lib/rate-limit", async () => {
  const { NextResponse } = await import("next/server");
  return {
    checkRateLimit: vi.fn(async () => ({ allowed: true, count: 1, limit: 10, retryAfterSeconds: 0 })),
    rateLimitHeaders: vi.fn(() => ({})),
    tooManyRequests: vi.fn(() => NextResponse.json({ error: "RATE_LIMITED_MARKER" }, { status: 429 })),
  };
});
vi.mock("@/lib/auto-bewerb/engine", () => ({
  getAutoBewerbCompany: vi.fn(),
  getAutoBewerbProfile: vi.fn(),
}));

const { createClient } = await import("@/lib/supabase/server");
const { provider } = await import("@/lib/ai-service");
const {
  reserveFeatureOp,
  completeFeatureOp,
  releaseFeatureOp,
} = await import("@/lib/billing/entitlement-service");
const { getAutoBewerbCompany, getAutoBewerbProfile } = await import("@/lib/auto-bewerb/engine");
const { POST, analyzeAdFailureResponse } = await import("@/app/api/auto-bewerb/analyze-ad/route");
const { AIProviderError } = await import("@/lib/ai-provider");

const USER = "22222222-2222-4222-8222-222222222222";
const AD_TEXT =
  "Ausbildung als Kauffrau im E-Commerce (m/w/d) bei Testfirma GmbH in Berlin. " +
  "Vollständige Anzeige mit Aufgaben, Profil und Bewerbungsadresse.";

function postRoute() {
  const request = new Request("http://localhost/api/auto-bewerb/analyze-ad", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ adText: AD_TEXT }),
  });
  return POST(request);
}

beforeEach(() => {
  vi.clearAllMocks();
  (createClient as ReturnType<typeof vi.fn>).mockReturnValue({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: USER } }, error: null })) },
  });
  (reserveFeatureOp as ReturnType<typeof vi.fn>).mockResolvedValue({ outcome: "reserved" });
  (completeFeatureOp as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  (releaseFeatureOp as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  (getAutoBewerbProfile as ReturnType<typeof vi.fn>).mockResolvedValue({
    cv_hash: "h",
    extracted: null,
  });
  (getAutoBewerbCompany as ReturnType<typeof vi.fn>).mockResolvedValue(null);
});

// ---------------------------------------------------------------------------
// The pure mapping table (unit level — no route execution needed).
// ---------------------------------------------------------------------------
describe("analyzeAdFailureResponse — status/code/retryable mapping", () => {
  it.each([
    ["provider_not_configured", 503, false],
    ["provider_auth", 502, false],
    ["provider_quota", 502, false],
    ["provider_rate_limited", 429, true],
    ["provider_request_rejected", 502, false],
    ["provider_unavailable", 503, true],
    ["provider_timeout", 504, true],
    ["provider_network", 503, true],
    ["provider_invalid_response", 502, true],
  ] as const)("maps %s → HTTP %i, retryable %s", (code, expectedStatus, expectedRetryable) => {
    const res = analyzeAdFailureResponse(
      new AIProviderError(code, "safe message", {
        status: 500,
        retryable: expectedRetryable,
        detail: "provider-detail-never-leaked",
      }),
    );
    expect(res.status).toBe(expectedStatus);
    const body = (res as unknown as { json: () => Promise<Record<string, unknown>> }).json();
    return expect(body).resolves.toMatchObject({
      code,
      retryable: expectedRetryable,
    });
  });

  it("never exposes the provider detail or credentials in the browser response", async () => {
    const res = analyzeAdFailureResponse(
      new AIProviderError("provider_unavailable", "The AI provider is temporarily unavailable.", {
        status: 502,
        retryable: true,
        detail: "upstream said: Bearer sk-supersecretkey123456789abcdef failed",
      }),
    );
    const text = await res.text();
    expect(text).not.toContain("detail");
    expect(text).not.toContain("Bearer");
    expect(text).not.toContain("sk-supersecretkey123456789abcdef");
  });

  it("unknown errors keep the safe 400 fallback", async () => {
    const res = analyzeAdFailureResponse(new Error("some unexpected internal error"));
    expect(res.status).toBe(400);
    const data = (await res.json()) as { code: string; retryable: boolean };
    expect(data.code).toBe("unknown_error");
    expect(data.retryable).toBe(false);
  });

  it("non-Error throws get a generic safe message", async () => {
    const res = analyzeAdFailureResponse("weird string failure");
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toBe("AI request failed.");
  });
});

// ---------------------------------------------------------------------------
// Route integration with a stubbed provider.
// ---------------------------------------------------------------------------
describe("route — provider failures through the full handler", () => {
  it("provider TIMEOUT → HTTP 504 + code provider_timeout + quota released", async () => {
    (provider as ReturnType<typeof vi.fn>).mockReturnValue({
      generateText: vi.fn().mockRejectedValue(
        new AIProviderError("provider_timeout", "The AI provider timed out.", {
          retryable: true,
          detail: "aborted after 120000ms",
        }),
      ),
    });
    const res = await postRoute();
    const data = (await res.json()) as { code: string; retryable: boolean };
    expect(res.status).toBe(504);
    expect(data.code).toBe("provider_timeout");
    expect(data.retryable).toBe(true);
    expect(releaseFeatureOp).toHaveBeenCalledTimes(1);
    expect(completeFeatureOp).not.toHaveBeenCalled();
  });

  it("provider 5xx → HTTP 503 (not the old flat 400) + quota released", async () => {
    (provider as ReturnType<typeof vi.fn>).mockReturnValue({
      generateText: vi.fn().mockRejectedValue(
        new AIProviderError("provider_unavailable", "The AI provider is temporarily unavailable.", {
          status: 500,
          retryable: true,
        }),
      ),
    });
    const res = await postRoute();
    const data = (await res.json()) as { code: string; retryable: boolean };
    expect(res.status).toBe(503);
    expect(data.code).toBe("provider_unavailable");
    expect(data.retryable).toBe(true);
    expect(releaseFeatureOp).toHaveBeenCalledTimes(1);
  });

  it("provider AUTH failure → HTTP 502, retryable=false (a user retry would not help)", async () => {
    (provider as ReturnType<typeof vi.fn>).mockReturnValue({
      generateText: vi.fn().mockRejectedValue(
        new AIProviderError("provider_auth", "The AI request could not be completed.", {
          status: 401,
          retryable: false,
        }),
      ),
    });
    const res = await postRoute();
    const data = (await res.json()) as { code: string; retryable: boolean };
    expect(res.status).toBe(502);
    expect(data.code).toBe("provider_auth");
    expect(data.retryable).toBe(false);
  });

  it("broken model output: exactly ONE bounded retry, then 502 invalid_ai_output + release", async () => {
    const generateText = vi.fn().mockResolvedValue("Kein JSON, nur Prosa.");
    (provider as ReturnType<typeof vi.fn>).mockReturnValue({ generateText });
    const res = await postRoute();
    const data = (await res.json()) as { code: string; retryable: boolean };
    expect(res.status).toBe(502);
    expect(data.code).toBe("invalid_ai_output");
    expect(data.retryable).toBe(true);
    expect(generateText).toHaveBeenCalledTimes(2); // initial + single nudge
    expect(releaseFeatureOp).toHaveBeenCalledTimes(1);
  });
});
