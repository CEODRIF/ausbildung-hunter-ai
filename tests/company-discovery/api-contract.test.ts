import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Company Discovery — API contract regression tests (the reported bug).
 *
 * Reported symptom: pressing "بحث عن شركات" always answered with the single
 * generic line "تعذّر بدء البحث. حاول مرة أخرى." — regardless of whether the
 * session had expired, the request was malformed, the rate limit was hit or
 * the database refused the insert. The user could not act on it.
 *
 * What is locked here:
 *  1. every failure carries the RIGHT machine code (and never internal
 *     Postgres text) — including the missing-migration case (PGRST205),
 *     which must read as "not ready", not as "try again";
 *  2. the run is registered AND answered BEFORE the engine works, so the UI
 *     can poll the real counters and Stop Search meanwhile;
 *  3. a pipeline failure is logged, never leaked into the response;
 *  4. the read-only progress endpoint does NOT consume the 4/min mutation
 *     budget (polling must not turn the live panel into a 429).
 */

const mocks = vi.hoisted(() => ({
  auth: {
    user: null as null | { id: string; email: string },
    accountStatus: "active" as string,
  },
  rate: { allowed: true, count: 1, limit: 4, retryAfterSeconds: 0 },
  createRun: vi.fn(),
  getRunStrict: vi.fn(),
  cancelRun: vi.fn(),
  pipeline: vi.fn(),
  checkRateLimit: vi.fn(),
  scheduled: [] as Array<() => Promise<void>>,
  scheduleSupported: true,
}));

vi.mock("@/lib/auth", () => ({
  getCurrentUserAndProfile: vi.fn(async () =>
    mocks.auth.user
      ? {
          user: mocks.auth.user,
          profile: {
            id: mocks.auth.user.id,
            account_status: mocks.auth.accountStatus,
          },
        }
      : { user: null, profile: null },
  ),
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));

vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>();
  return {
    ...actual,
    checkRateLimit: (...args: unknown[]) => {
      mocks.checkRateLimit(...args);
      return Promise.resolve(mocks.rate);
    },
  };
});

vi.mock("@/lib/company-discovery/runs", () => ({
  createDiscoveryRun: (...args: unknown[]) => mocks.createRun(...args),
  getDiscoveryRunStrict: (...args: unknown[]) => mocks.getRunStrict(...args),
  cancelDiscoveryRun: (...args: unknown[]) => mocks.cancelRun(...args),
}));

vi.mock("@/lib/company-discovery/search", () => ({
  runDiscoveryPipeline: (...args: unknown[]) => mocks.pipeline(...args),
}));

vi.mock("@/lib/company-discovery/schedule", () => ({
  runAfterResponse: (work: () => Promise<void>) => {
    if (!mocks.scheduleSupported) throw new Error("after() is not available here");
    mocks.scheduled.push(work);
  },
}));

import { POST as startRoute } from "@/app/api/company-discovery/start/route";
import { GET as runRoute } from "@/app/api/company-discovery/[runId]/route";
import { POST as cancelRoute } from "@/app/api/company-discovery/[runId]/cancel/route";

// ---------------------------------------------------------------------------

const USER_ID = "9f1d3a2c-77b4-4c1e-9a52-0d5f3c7b1e08";
const RUN_ID = "4c8b0f7e-1d2a-4b3c-8e5f-6a7b8c9d0e1f";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const VALID_PARAMS = {
  field: "Marketing / E-Commerce",
  role: "Kaufmann",
  beginn: { mode: "year", year: 2027 },
  goal: "both",
  targetCompanies: 10,
  onlyPublicEmail: true,
};

const PENDING_RUN = {
  runId: RUN_ID,
  status: "pending",
  params: VALID_PARAMS,
  progress: {
    status: "pending",
    targetCompanies: 10,
    foundCompanies: 0,
    offersAnalyzed: 0,
    uniqueCompanies: 0,
    duplicatesRemoved: 0,
    companiesRejected: 0,
    emailsFound: 0,
    noPublicEmail: 0,
    sourcesBlocked: 0,
    sources: [],
  },
  creditsCharged: 0,
  error: null,
  createdAt: "2026-10-03T10:00:00.000Z",
  startedAt: null,
  finishedAt: null,
};

function startRequest(body: unknown, raw?: string) {
  return new Request("http://localhost/api/company-discovery/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw ?? JSON.stringify(body),
  });
}

const runContext = (runId = RUN_ID) => ({
  params: Promise.resolve({ runId }),
});

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  if (!UUID_RE.test(USER_ID) || !UUID_RE.test(RUN_ID))
    throw new Error("malformed test UUID");
  mocks.auth.user = { id: USER_ID, email: "u@example.com" };
  mocks.auth.accountStatus = "active";
  mocks.rate = { allowed: true, count: 1, limit: 4, retryAfterSeconds: 0 };
  mocks.createRun.mockReset().mockResolvedValue(PENDING_RUN);
  mocks.getRunStrict.mockReset().mockResolvedValue(PENDING_RUN);
  mocks.cancelRun.mockReset().mockResolvedValue({
    ...PENDING_RUN,
    status: "cancelled",
  });
  mocks.pipeline.mockReset().mockResolvedValue(undefined);
  mocks.checkRateLimit.mockReset();
  mocks.scheduled = [];
  mocks.scheduleSupported = true;
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// 1. Auth gate
// ---------------------------------------------------------------------------

describe("start — auth gate", () => {
  it("no session → 401 with the unauthorized code, and nothing is written", async () => {
    mocks.auth.user = null;
    const response = await startRoute(startRequest(VALID_PARAMS));
    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe("unauthorized");
    expect(mocks.createRun).not.toHaveBeenCalled();
  });

  it("a signed-in but inactive account → 401 (not a generic failure)", async () => {
    mocks.auth.accountStatus = "pending";
    const response = await startRoute(startRequest(VALID_PARAMS));
    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe("unauthorized");
  });
});

// ---------------------------------------------------------------------------
// 2. Rate limit (4/min) — the user must see the documented wait
// ---------------------------------------------------------------------------

describe("start — rate limit", () => {
  it("a denied run → 429 with a code, a Retry-After header and no run row", async () => {
    mocks.rate = { allowed: false, count: 4, limit: 4, retryAfterSeconds: 7 };
    const response = await startRoute(startRequest(VALID_PARAMS));
    expect(response.status).toBe(429);
    const body = await response.json();
    expect(body.code).toBe("rate_limited");
    expect(body.retry_after).toBe(7);
    expect(response.headers.get("retry-after")).toBe("7");
    expect(mocks.createRun).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. Validation
// ---------------------------------------------------------------------------

describe("start — validation", () => {
  it("a broken JSON body → 400 invalid_params (no DB call)", async () => {
    const response = await startRoute(startRequest(null, "{not json"));
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("invalid_params");
    expect(mocks.createRun).not.toHaveBeenCalled();
  });

  it("schema violations → 400 invalid_params with field paths", async () => {
    const response = await startRoute(
      startRequest({ ...VALID_PARAMS, role: "  " }),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe("invalid_params");
    expect(body.issues.join(" ")).toContain("role");
    expect(mocks.createRun).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. Persistence failures — the real root-cause surface
// ---------------------------------------------------------------------------

describe("start — persistence failures", () => {
  it("missing migration (PGRST205) → database_not_ready, Postgres text never exposed", async () => {
    mocks.createRun.mockRejectedValueOnce({
      code: "PGRST205",
      message:
        "Could not find the table 'public.discovery_runs' in the schema cache",
    });
    const response = await startRoute(startRequest(VALID_PARAMS));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.code).toBe("database_not_ready");
    // No internals, no SQL state, no table names in the user-facing body.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("PGRST205");
    expect(serialized).not.toContain("schema cache");
    expect(serialized).not.toContain("discovery_runs");
    // …but the operator sees it in the log.
    expect(errorSpy).toHaveBeenCalled();
  });

  it("relation missing at the SQL level (42P01) → database_not_ready", async () => {
    mocks.createRun.mockRejectedValueOnce({
      code: "42P01",
      message: 'relation "public.discovery_runs" does not exist',
    });
    const response = await startRoute(startRequest(VALID_PARAMS));
    expect((await response.json()).code).toBe("database_not_ready");
  });

  it("any other persistence failure → search_failed", async () => {
    mocks.createRun.mockRejectedValueOnce({ message: "insert failed" });
    const response = await startRoute(startRequest(VALID_PARAMS));
    expect(response.status).toBe(500);
    expect((await response.json()).code).toBe("search_failed");
  });
});

// ---------------------------------------------------------------------------
// 5. Answer first, then run — the live-progress contract
// ---------------------------------------------------------------------------

describe("start — registers the run, answers, THEN works", () => {
  it("responds 201 with the pending run before the engine starts", async () => {
    const response = await startRoute(startRequest(VALID_PARAMS));
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.runId).toBe(RUN_ID);
    expect(body.status).toBe("pending");
    expect(body.scheduled).toBe(true);
    // The engine has NOT run yet — the client gets the id immediately and
    // reads real progress from the run row, not from this response.
    expect(mocks.pipeline).not.toHaveBeenCalled();
    expect(mocks.scheduled).toHaveLength(1);
  });

  it("the scheduled work runs the engine for exactly this run + user", async () => {
    await startRoute(startRequest(VALID_PARAMS));
    await mocks.scheduled[0]();
    expect(mocks.pipeline).toHaveBeenCalledTimes(1);
    expect(mocks.pipeline).toHaveBeenCalledWith(RUN_ID, USER_ID);
  });

  it("a failing engine is logged, never returned (the run row is the truth)", async () => {
    mocks.pipeline.mockRejectedValueOnce(new Error("BA unreachable"));
    const response = await startRoute(startRequest(VALID_PARAMS));
    expect(response.status).toBe(201);
    await expect(mocks.scheduled[0]()).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("without after() support the engine is awaited instead of dropped", async () => {
    mocks.scheduleSupported = false;
    const response = await startRoute(startRequest(VALID_PARAMS));
    expect(response.status).toBe(201);
    expect((await response.json()).scheduled).toBe(false);
    expect(mocks.pipeline).toHaveBeenCalledWith(RUN_ID, USER_ID);
  });
});

// ---------------------------------------------------------------------------
// 6. Progress read (polled) — must not consume the mutation budget
// ---------------------------------------------------------------------------

describe("GET [runId] — live progress", () => {
  it("returns the real run for its owner", async () => {
    const response = await runRoute(new Request("http://localhost/x"), runContext());
    expect(response.status).toBe(200);
    expect((await response.json()).run.runId).toBe(RUN_ID);
    expect(mocks.getRunStrict).toHaveBeenCalledWith(RUN_ID, USER_ID);
  });

  it("does NOT consume the 4/min mutation budget (polling is a read)", async () => {
    await runRoute(new Request("http://localhost/x"), runContext());
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
  });

  it("an unknown/foreign run id → 404 not_found", async () => {
    mocks.getRunStrict.mockResolvedValueOnce(null);
    const response = await runRoute(new Request("http://localhost/x"), runContext());
    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe("not_found");
  });

  it("a database outage is NOT reported as a missing run", async () => {
    mocks.getRunStrict.mockRejectedValueOnce({ code: "PGRST205", message: "schema cache" });
    const response = await runRoute(new Request("http://localhost/x"), runContext());
    expect(response.status).toBe(500);
    expect((await response.json()).code).toBe("database_not_ready");
  });

  it("requires an active session", async () => {
    mocks.auth.accountStatus = "pending";
    const response = await runRoute(new Request("http://localhost/x"), runContext());
    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe("unauthorized");
  });
});

// ---------------------------------------------------------------------------
// 7. Stop Search
// ---------------------------------------------------------------------------

describe("POST [runId]/cancel — Stop Search", () => {
  it("returns the cancelled run", async () => {
    const response = await cancelRoute(
      new Request("http://localhost/x", { method: "POST" }),
      runContext(),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).run.status).toBe("cancelled");
  });

  it("requires an active session", async () => {
    mocks.auth.user = null;
    const response = await cancelRoute(
      new Request("http://localhost/x", { method: "POST" }),
      runContext(),
    );
    expect(response.status).toBe(401);
  });

  it("an unknown run → 404 not_found", async () => {
    mocks.cancelRun.mockRejectedValueOnce(new Error("Discovery run not found."));
    const response = await cancelRoute(
      new Request("http://localhost/x", { method: "POST" }),
      runContext(),
    );
    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe("not_found");
  });

  it("a persistence failure → 500 with a code the UI can translate", async () => {
    mocks.cancelRun.mockRejectedValueOnce(new Error("Failed to cancel"));
    const response = await cancelRoute(
      new Request("http://localhost/x", { method: "POST" }),
      runContext(),
    );
    expect(response.status).toBe(500);
    expect((await response.json()).code).toBe("search_failed");
  });

  it("is rate-limited like the other mutations", async () => {
    await cancelRoute(
      new Request("http://localhost/x", { method: "POST" }),
      runContext(),
    );
    expect(mocks.checkRateLimit).toHaveBeenCalledWith("company_discovery", USER_ID);
  });
});
