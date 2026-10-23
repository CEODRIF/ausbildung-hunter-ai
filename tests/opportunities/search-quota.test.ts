import { beforeEach, describe, expect, it, vi } from "vitest";

// Opportunity-search quota (the `opportunity_search` ledger meter inside the
// search route):
//   reserved AFTER parameter validation (invalid requests cost nothing),
//   settled on success, released on every failed execution (upstream
//   502/500), denial responses exact and metered.
//
// `@/lib/opportunities/search` is faked so the suite is hermetic (no BA
// network, no cache). `@/lib/opportunities/types` stays REAL — the 400
// assertions below exercise the actual zod validation, so "invalid costs
// nothing" is proven against the real schema.

vi.mock("@/lib/auth", () => ({
  getCurrentUserAndProfile: vi.fn(),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
  rateLimitHeaders: vi.fn(() => ({ "x-rate-limit-mock": "1" })),
  tooManyRequests: vi.fn(() => ({ status: 429 })),
}));
vi.mock("@/lib/billing/entitlement-service", () => ({
  reserveFeatureOp: vi.fn(),
  completeFeatureOp: vi.fn(),
  releaseFeatureOp: vi.fn(),
}));
vi.mock("@/lib/opportunities/search", () => {
  class OpportunityProviderError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "OpportunityProviderError";
    }
  }
  // Mirrors the real BaFetchFailure (src/lib/opportunities/providers/
  // arbeitsagentur.ts L610-631): constructor takes { kind, status?, attempts? }
  // and derives `retryable` from the kind — same derivation as production.
  type MockBaFailureKind =
    | "NETWORK_ERROR"
    | "TIMEOUT"
    | "RATE_LIMITED"
    | "SERVER_ERROR"
    | "BLOCKED_OR_CHALLENGED"
    | "INVALID_RESPONSE";
  class BaFetchFailure extends OpportunityProviderError {
    readonly kind: MockBaFailureKind;
    readonly retryable: boolean;
    constructor(
      message: string,
      details: {
        kind: MockBaFailureKind;
        status?: number | null;
        attempts?: number;
      },
    ) {
      super(message);
      this.name = "BaFetchFailure";
      this.kind = details.kind;
      this.retryable =
        details.kind === "NETWORK_ERROR" ||
        details.kind === "TIMEOUT" ||
        details.kind === "RATE_LIMITED" ||
        details.kind === "SERVER_ERROR";
    }
  }
  return {
    BA_SOURCE_ID: "bundesagentur",
    OpportunityProviderError,
    BaFetchFailure,
    searchOpportunities: vi.fn(),
  };
});

const { getCurrentUserAndProfile } = await import("@/lib/auth");
const { checkRateLimit } = await import("@/lib/rate-limit");
const {
  reserveFeatureOp,
  completeFeatureOp,
  releaseFeatureOp,
} = await import("@/lib/billing/entitlement-service");
const {
  BA_SOURCE_ID,
  BaFetchFailure,
  OpportunityProviderError,
  searchOpportunities,
} = await import("@/lib/opportunities/search");
const { GET } = await import("@/app/api/opportunities/search/route");

const reserve = reserveFeatureOp as unknown as ReturnType<typeof vi.fn>;
const complete = completeFeatureOp as unknown as ReturnType<typeof vi.fn>;
const release = releaseFeatureOp as unknown as ReturnType<typeof vi.fn>;
const search = searchOpportunities as unknown as ReturnType<typeof vi.fn>;

const USER = "u1";
const searchUrl = (qs: string) =>
  `http://localhost/api/opportunities/search?${qs}`;

function authed() {
  vi.mocked(getCurrentUserAndProfile).mockResolvedValue({
    user: { id: USER },
    profile: { account_status: "active" },
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  authed();
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
  reserve.mockResolvedValue({ outcome: "reserved" });
  complete.mockResolvedValue({ outcome: "completed" });
  release.mockResolvedValue({ outcome: "released" });
  search.mockResolvedValue({ results: [] });
});

describe("search route — opportunity_search quota cycle", () => {
  it("401 without a user (nothing reserved)", async () => {
    vi.mocked(getCurrentUserAndProfile).mockResolvedValue({
      user: null,
      profile: null,
    } as never);
    const response = await GET(new Request(searchUrl("goal=ausbildung")));
    expect(response.status).toBe(401);
    expect(reserve).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });

  it("400 invalid params → reserveFeatureOp is NEVER called (invalid requests cost nothing)", async () => {
    const response = await GET(
      new Request(searchUrl("goal=ausbildung&sort=bogus")),
    );
    expect(response.status).toBe(400);
    expect(reserve).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });

  it.each([
    ["quota_exhausted", 429, "Opportunity search limit reached. It resets daily (UTC)."],
    ["feature_disabled", 403, "Opportunity search is not available on your current plan."],
  ] as const)(
    "reservation outcome %s → exact %i response, search never runs",
    async (outcome, status, message) => {
      reserve.mockResolvedValue({ outcome } as never);
      const response = await GET(
        new Request(searchUrl("goal=ausbildung")),
      );
      expect(response.status).toBe(status);
      const body = (await response.json()) as {
        error: string;
        code: string;
      };
      expect(body.error).toBe(message);
      expect(body.code).toBe(outcome);
      expect(reserve).toHaveBeenCalledTimes(1);
      expect(reserve).toHaveBeenCalledWith(
        USER,
        "opportunity_search",
        expect.any(String),
      );
      expect(complete).not.toHaveBeenCalled();
      expect(release).not.toHaveBeenCalled();
      expect(search).not.toHaveBeenCalled();
    },
  );

  it("reservation error → 503 with the service message (search never runs)", async () => {
    reserve.mockResolvedValue({
      outcome: "error",
      message: "ledger down",
    } as never);
    const response = await GET(new Request(searchUrl("goal=ausbildung")));
    expect(response.status).toBe(503);
    const body = (await response.json()) as {
      error: string;
      code: string;
    };
    expect(body.error).toBe("ledger down");
    expect(body.code).toBe("quota_unavailable");
    expect(search).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it("success → settled with complete, 200 body, real normalized params + user context", async () => {
    const payload = { results: [], total: 0 };
    search.mockResolvedValue(payload);

    const response = await GET(new Request(searchUrl("goal=ausbildung")));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(payload);
    const runId = reserve.mock.calls[0][2] as string;
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith(
      USER,
      "opportunity_search",
      runId, // same idempotency key that was reserved
    );
    expect(release).not.toHaveBeenCalled();
    expect(search).toHaveBeenCalledTimes(1);
    const [params, context] = search.mock.calls[0] as unknown as [
      { goal: string },
      { userId: string },
    ];
    expect(params.goal).toBe("ausbildung");
    expect(context).toEqual({ userId: USER });
  });

  it("BaFetchFailure → released + structured 502 source_status (retryable)", async () => {
    search.mockRejectedValue(
      new BaFetchFailure("BA temporarily unreachable", {
        kind: "NETWORK_ERROR",
      }),
    );
    const response = await GET(new Request(searchUrl("goal=ausbildung")));

    expect(response.status).toBe(502);
    const body = (await response.json()) as {
      error: string;
      source_status: { source: string; status: string; retryable: boolean };
    };
    expect(body.error).toBe("BA temporarily unreachable");
    expect(body.source_status).toEqual({
      source: BA_SOURCE_ID,
      status: "temporarily_unavailable",
      retryable: true,
    });
    expect(release).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled();
  });

  it("OpportunityProviderError → 502 with the provider message + released", async () => {
    search.mockRejectedValue(new OpportunityProviderError("BA blocked access"));
    const response = await GET(new Request(searchUrl("goal=ausbildung")));

    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("BA blocked access");
    expect(release).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled();
  });

  it("generic error → 500 + released (failed op never consumes quota)", async () => {
    search.mockRejectedValue(new Error("kaboom"));
    const response = await GET(new Request(searchUrl("goal=ausbildung")));

    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("kaboom");
    expect(release).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled();
  });
});
