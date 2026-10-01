import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * BA (Bundesagentur für Arbeit) reliability — the 12 spec-mandated tests:
 *   1. first-attempt success (no spurious retries)
 *   2. timeout → controlled retry → success
 *   3. 5xx → controlled retry → success
 *   4. 429 → RATE_LIMITED classification (3 attempts, then classified error)
 *   5. all attempts fail → structured 502 `source_status: temporarily_unavailable`
 *   6. BA fails, other source succeeds → other source's results are kept
 *   7. empty result → SUCCESS, never "unavailable"
 *   8. malformed body → INVALID_RESPONSE (and HTML → BLOCKED_OR_CHALLENGED), no retry
 *   9. 100-opportunity run → bounded concurrency (≤ 5 in flight), no burst
 *  10. email collection (re-run) → reuses cached data, no repeated BA requests
 *  11. duplicate search → shared cache reuse (one provider call)
 *  12. retry after failure → fresh attempt succeeds without a full reload
 *
 * The admin (Supabase) mock is STATEFUL: it stores what the code writes into
 * `opportunity_cache` and serves it back on later reads, so cache behavior is
 * tested against the real read/write code paths — not faked away.
 */

const { adminState, makeAdminClient } = vi.hoisted(() => {
  const adminState = {
    profileRow: null as Record<string, unknown> | null,
    cache: new Map<
      string,
      { results: unknown; expires_at: string; schema_version: number }
    >(),
  };
  function makeAdminClient() {
    const chain = (table: string) => {
      const filters: Record<string, unknown> = {};
      const make = (): unknown =>
        new Proxy(
          {},
          {
            get(_target, prop) {
              if (typeof prop !== "string") return undefined;
              if (prop === "then")
                return (
                  onFulfilled?: unknown,
                  onRejected?: unknown,
                ): Promise<unknown> =>
                  Promise.resolve({ data: null, error: null }).then(
                    onFulfilled as never,
                    onRejected as never,
                  );
              if (prop === "maybeSingle")
                return async () => {
                  if (table === "candidate_profiles")
                    return {
                      data: adminState.profileRow
                        ? { profile_json: adminState.profileRow }
                        : null,
                      error: null,
                    };
                  if (table === "opportunity_cache") {
                    const row = adminState.cache.get(
                      String(filters.cache_key),
                    );
                    const valid =
                      row !== undefined &&
                      row.schema_version === Number(filters.schema_version) &&
                      new Date(row.expires_at).getTime() >= Date.now();
                    return {
                      data: valid ? { results: row.results } : null,
                      error: null,
                    };
                  }
                  return { data: null, error: null };
                };
              if (prop === "upsert")
                return async (value: {
                  cache_key: string;
                  results: unknown;
                  expires_at: string;
                  schema_version: number;
                }) => {
                  if (table === "opportunity_cache")
                    adminState.cache.set(value.cache_key, {
                      results: value.results,
                      expires_at: value.expires_at,
                      schema_version: value.schema_version,
                    });
                  return { data: null, error: null };
                };
              // select / eq / gte / order / limit / delete / or — chain.
              if (prop === "eq" || prop === "gte")
                return (column: string, value: unknown) => {
                  filters[column] = value;
                  return make();
                };
              return () => make();
            },
          },
        );
      return make();
    };
    return {
      from: (table: string) => chain(table),
      // rate limit: fail-open (null data → allowed)
      rpc: async () => ({ data: null, error: null }),
    };
  }
  return { adminState, makeAdminClient };
});

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => makeAdminClient(),
}));
vi.mock("@/lib/auth", () => ({
  getCurrentUserAndProfile: vi.fn(async () => ({
    user: { id: "user-test", email: "test@example.test" },
    profile: { account_status: "active" },
  })),
}));
vi.mock("@/lib/ai-provider", () => ({
  createAIProvider: vi.fn(),
}));
vi.mock("@/lib/web-search", () => ({
  getWebSearchClient: vi.fn(),
}));
vi.mock("@/lib/opportunities/web-discovery", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/lib/opportunities/web-discovery")
  >();
  return { ...actual, runWebDiscovery: vi.fn() };
});

import { GET as searchRoute } from "@/app/api/opportunities/search/route";
import { createAIProvider } from "@/lib/ai-provider";
import { collectOpportunities, enrichOpportunities, runAISearch } from "@/lib/opportunities/ai-search";
import { searchOpportunities } from "@/lib/opportunities/search";
import {
  configureBaFetchDefaults,
  fetchBaJson,
  fetchOpportunityWindow,
} from "@/lib/opportunities/providers/arbeitsagentur";
import { getWebSearchClient } from "@/lib/web-search";
import {
  runWebDiscovery,
} from "@/lib/opportunities/web-discovery";
import type {
  Opportunity,
  OpportunitySearchParams,
} from "@/lib/opportunities/types";
import { candidateProfileFixture, jsonResponse, mkSearchItem } from "../helpers";

const detailsArbeit = (await import("../fixtures/ba-details-arbeit.json")) as Record<
  string,
  unknown
>;

const FAST_DEFAULTS = {
  timeoutMs: 20,
  maxAttempts: 3,
  backoffBaseMs: 1,
  backoffMaxMs: 2,
  deadlineMs: 300,
};

function timeoutError(): Error {
  const error = new Error("The operation was aborted due to timeout");
  error.name = "TimeoutError";
  return error;
}

function networkError(): Error {
  return new Error("fetch failed");
}

/** Scripted global fetch with in-flight (concurrency) tracking. */
function scriptedFetch(
  script: Array<(call: number, url: string) => Response | never>,
) {
  let calls = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchMock = vi.fn(async (url: string | URL | Request): Promise<Response> => {
    calls += 1;
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      const step = script[Math.min(calls - 1, script.length - 1)];
      return step(calls - 1, String(url));
    } finally {
      inFlight -= 1;
    }
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls: () => calls, maxInFlight: () => maxInFlight };
}

function baItem(ref: string): Opportunity {
  return {
    id: `arbeitsagentur:${ref}`,
    provider: "arbeitsagentur",
    external_id: ref,
    source_name: "Bundesagentur für Arbeit – Jobbörse",
    source_url: "https://www.arbeitsagentur.de/jobboerse",
    source_type: "job_portal",
    additional_sources: [],
    source_ids: [],
    enrichment: null,
    application_url: null,
    aggregator_url: null,
    title: "Stelle",
    goal: "ausbildung",
    stellenangebotsart: null,
    company_name: "Firma Bergmann",
    company_url: null,
    location: "Berlin",
    location_detail: null,
    distance_km: null,
    latitude: null,
    longitude: null,
    profession: "Mechatroniker/in",
    alternative_professions: [],
    description: null,
    tasks: [],
    requirements: [],
    employment_type: null,
    home_office: null,
    career_change_friendly: null,
    salary: null,
    training_type: null,
    education_requirement: null,
    valid_from: null,
    application_deadline: null,
    posted_at: null,
    updated_at: null,
    retrieved_at: "2026-09-30T12:00:00.000Z",
    contact: null,
    required_skills: [],
    preferred_skills: [],
    required_languages: [],
    extracted_keywords: [],
    match: null,
  };
}

function webOpportunity(): Opportunity {
  return {
    id: "web:career1",
    provider: "web",
    external_id: "career1",
    source_name: "Company Careers",
    source_url: "https://careers.example.test/jobs/1",
    source_type: "company_website",
    additional_sources: [],
    source_ids: [],
    enrichment: null,
    application_url: null,
    aggregator_url: null,
    title: "Ausbildung Industriekaufmann (web)",
    goal: "ausbildung",
    stellenangebotsart: null,
    company_name: "Example GmbH",
    company_url: "https://example.test",
    location: "Berlin",
    location_detail: null,
    distance_km: null,
    latitude: null,
    longitude: null,
    profession: "Industriekaufmann",
    alternative_professions: [],
    description: null,
    tasks: [],
    requirements: [],
    employment_type: null,
    home_office: null,
    career_change_friendly: null,
    salary: null,
    training_type: "AUSBILDUNG",
    education_requirement: null,
    valid_from: null,
    application_deadline: null,
    posted_at: null,
    updated_at: null,
    retrieved_at: "2026-09-30T12:00:00.000Z",
    contact: null,
    required_skills: [],
    preferred_skills: [],
    required_languages: [],
    extracted_keywords: [],
    match: null,
  };
}

beforeEach(() => {
  adminState.profileRow = null;
  adminState.cache.clear();
  configureBaFetchDefaults(FAST_DEFAULTS);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  // Restore production defaults.
  configureBaFetchDefaults({
    timeoutMs: 15000,
    maxAttempts: 3,
    backoffBaseMs: 750,
    backoffMaxMs: 5000,
    deadlineMs: 25000,
  });
});

// ---------------------------------------------------------------------------
// 1) First-attempt success
// ---------------------------------------------------------------------------
describe("1. first-attempt success", () => {
  it("makes exactly one provider call and reports a clean (non-degraded) window", async () => {
    const probe = scriptedFetch([
      () =>
        jsonResponse({
          ergebnisliste: [mkSearchItem("REF-1", "2026-09-28")],
          maxErgebnisse: 1,
        }),
    ]);
    const window = await fetchOpportunityWindow({
      goal: "arbeit",
      keyword: "",
      role: "",
      company: "",
      location: "",
      freshness: "any",
      sort: "relevance",
      employment: "any",
      training_type: "any",
      home_office: "any",
      salary_documented: false,
      page: 1,
      pageSize: 20,
      match: false,
    });
    expect(probe.calls()).toBe(1);
    expect(window.mode).toBe("upstream");
    expect(window.window).toHaveLength(1);
    expect(window.degraded).toBe(false);
    expect(window.exhausted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2) + 3) Transient failures → controlled retry → success
// ---------------------------------------------------------------------------
describe("controlled retries", () => {
  it("2. retries a timeout and succeeds on the second attempt", async () => {
    const probe = scriptedFetch([
      () => {
        throw timeoutError();
      },
      () => jsonResponse({ ergebnisliste: [], maxErgebnisse: 0 }),
    ]);
    const raw = await fetchBaJson("https://ba.example.test/search", {
      timeoutMs: 50,
      backoffBaseMs: 1,
      deadlineMs: 1000,
      label: "test",
    });
    expect(raw.maxErgebnisse).toBe(0);
    expect(probe.calls()).toBe(2);
  });

  it("3. retries a 5xx (503) and succeeds on the second attempt", async () => {
    const probe = scriptedFetch([
      () => new Response("{}", { status: 503 }),
      () => jsonResponse({ ergebnisliste: [], maxErgebnisse: 0 }),
    ]);
    const raw = await fetchBaJson("https://ba.example.test/search", {
      timeoutMs: 50,
      backoffBaseMs: 1,
      deadlineMs: 1000,
      label: "test",
    });
    expect(raw.maxErgebnisse).toBe(0);
    expect(probe.calls()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 4) 429 → RATE_LIMITED
// ---------------------------------------------------------------------------
describe("4. rate-limit classification", () => {
  it("classifies 429 as RATE_LIMITED after 3 controlled attempts (honouring Retry-After)", async () => {
    const probe = scriptedFetch([
      () =>
        new Response("{}", {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "0" },
        }),
    ]);
    await expect(
      fetchBaJson("https://ba.example.test/search", {
        timeoutMs: 50,
        backoffBaseMs: 1,
        deadlineMs: 1000,
        label: "test",
      }),
    ).rejects.toMatchObject({
      name: "BaFetchFailure",
      kind: "RATE_LIMITED",
      retryable: true,
      status: 429,
      attempts: 3,
    });
    expect(probe.calls()).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 8) Response validation (malformed / challenge) — no retry
// ---------------------------------------------------------------------------
describe("8. response validation", () => {
  it("classifies an unparseable 200 body as INVALID_RESPONSE without retrying", async () => {
    const probe = scriptedFetch([
      () =>
        new Response("not json at all", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ]);
    await expect(
      fetchBaJson("https://ba.example.test/search", {
        timeoutMs: 50,
        backoffBaseMs: 1,
        deadlineMs: 1000,
        label: "test",
      }),
    ).rejects.toMatchObject({
      name: "BaFetchFailure",
      kind: "INVALID_RESPONSE",
      retryable: false,
    });
    expect(probe.calls()).toBe(1);
  });

  it("classifies an HTML challenge page (200) as BLOCKED_OR_CHALLENGED without retrying", async () => {
    const probe = scriptedFetch([
      () =>
        new Response("<!doctype html><html>captcha</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    ]);
    await expect(
      fetchBaJson("https://ba.example.test/search", {
        timeoutMs: 50,
        backoffBaseMs: 1,
        deadlineMs: 1000,
        label: "test",
      }),
    ).rejects.toMatchObject({
      name: "BaFetchFailure",
      kind: "BLOCKED_OR_CHALLENGED",
      retryable: false,
    });
    expect(probe.calls()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5) All attempts fail → structured 502 with source_status
// ---------------------------------------------------------------------------
describe("5. total failure → structured source_status", () => {
  it("returns 502 with {source, status: temporarily_unavailable, retryable: true}", async () => {
    const probe = scriptedFetch([() => {
      throw networkError();
    }]);
    const response = await searchRoute(
      new Request("http://localhost/api/opportunities/search?goal=arbeit"),
    );
    expect(response.status).toBe(502);
    const body = (await response.json()) as {
      error: string;
      source_status: {
        source: string;
        status: string;
        retryable: boolean;
      };
    };
    expect(body.error).toContain("Bundesagentur für Arbeit");
    expect(body.source_status).toEqual({
      source: "bundesagentur",
      status: "temporarily_unavailable",
      retryable: true,
    });
    // 3 controlled attempts — not 1, not a storm.
    expect(probe.calls()).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 6) BA fails, other source succeeds → results are kept
// ---------------------------------------------------------------------------
describe("6. multi-source resilience", () => {
  it("keeps web-discovery results when BA is down (and reports the source status)", async () => {
    adminState.profileRow = candidateProfileFixture();
    vi.mocked(createAIProvider).mockReturnValue({
      generateText: vi.fn(async () =>
        JSON.stringify({
          rationale: "Profile documents Mechatroniker in Berlin.",
          queries: [{ keyword: "", role: "Mechatroniker", location: "Berlin" }],
          web_queries: ["\"Mechatroniker\" Ausbildung 2027"],
        }),
      ),
      streamText: vi.fn(),
      analyzeFile: vi.fn(),
      analyzeImage: vi.fn(),
      generateFile: vi.fn(),
    } as never);
    vi.mocked(getWebSearchClient).mockReturnValue({
      name: "tavily",
      search: async () => [],
    } as never);
    vi.mocked(runWebDiscovery).mockResolvedValue({
      opportunities: [webOpportunity()],
      categoryCounts: {
        search_engine: 0,
        job_portal: 0,
        company_website: 1,
        social_media: 0,
      },
      sourceCounts: { company_career: 1 },
      sourceStatuses: [
        { source: "company_career", status: "ok", candidates: 1 },
      ],
      groundingCallsOk: 1,
      verifiedCount: 1,
      aiUsed: false,
      providerErrors: 0,
      firstProviderError: null,
      failures: {},
      aiDuplicates: [],
    });
    const probe = scriptedFetch([() => {
      throw networkError();
    }]);

    const events: Array<Record<string, unknown>> = [];
    const result = await runAISearch({
      userId: "user-test",
      goal: "ausbildung",
      targetCount: 10,
      onProgress: (event) => events.push(event as unknown as Record<string, unknown>),
    });

    // The web source's real result survives the BA outage.
    expect(result.found).toBe(1);
    expect(result.results[0].id).toBe("web:career1");
    expect(result.sources).toEqual([
      {
        source: "bundesagentur",
        status: "temporarily_unavailable",
        retryable: true,
      },
    ]);
    // The complete event carries the same status (client shows the notice).
    const complete = events.find((event) => event.type === "complete");
    expect(complete?.sources).toEqual(result.sources);
    // BA was attempted (3 controlled retries of the single query), the web
    // discovery ran despite the failure.
    expect(probe.calls()).toBe(3);
    expect(vi.mocked(runWebDiscovery)).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 7) EMPTY_RESULT is a success, not an unavailability
// ---------------------------------------------------------------------------
describe("7. empty result ≠ failure", () => {
  it("treats a valid zero-result response as ok (never temporarily_unavailable)", async () => {
    const probe = scriptedFetch([
      () => jsonResponse({ ergebnisliste: [], maxErgebnisse: 0 }),
    ]);
    const window = await fetchOpportunityWindow({
      goal: "arbeit",
      keyword: "",
      role: "",
      company: "",
      location: "",
      freshness: "any",
      sort: "relevance",
      employment: "any",
      training_type: "any",
      home_office: "any",
      salary_documented: false,
      page: 1,
      pageSize: 20,
      match: false,
    });
    expect(window.window).toHaveLength(0);
    expect(window.degraded).toBe(false);
    expect(probe.calls()).toBe(1);

    // Same truth at the collection level: reachable source + no matches = ok.
    const collected = await collectOpportunities({
      plan: {
        rationale: "r",
        queries: [{ keyword: "", role: "Unbekannter Beruf", location: "" }],
        web_queries: [],
      },
      goal: "ausbildung",
      targetCount: 10,
    });
    expect(collected.opportunities).toHaveLength(0);
    expect(collected.ba).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// 9) 100-opportunity run → bounded concurrency, no uncontrolled burst
// ---------------------------------------------------------------------------
describe("9. bounded concurrency for a 100-opportunity run", () => {
  it("never runs more than 5 provider requests in flight; bounded total calls", async () => {
    let searchCalls = 0;
    let detailCalls = 0;
    const probe = scriptedFetch([
      (_call, url) => {
        if (url.includes("/v4/jobdetails")) {
          detailCalls += 1;
          return jsonResponse(detailsArbeit);
        }
        const q = searchCalls;
        searchCalls += 1;
        const items = Array.from({ length: 50 }, (_, i) =>
          mkSearchItem(`Q${q}-P${i + 1}`, "2026-09-20", {
            hauptberuf: "Mechatroniker/in",
          }),
        );
        return jsonResponse({ ergebnisliste: items, maxErgebnisse: items.length });
      },
    ]);

    // Five planned queries (the plan maximum), target 100. Distinct keywords
    // (API-level, no server-side matcher) keep the role matcher satisfiable
    // by the fixture items ("Mechatroniker/in" ⊇ token "mechaniker").
    const plan = {
      rationale: "r",
      queries: [1, 2, 3, 4, 5].map((n) => ({
        keyword: `Logistik ${n}`,
        role: "Mechatroniker",
        location: "",
      })),
      web_queries: [],
    } as const;

    const collection = await collectOpportunities({
      plan: plan as unknown as Parameters<typeof collectOpportunities>[0]["plan"],
      goal: "ausbildung",
      targetCount: 100,
    });
    // Budget = 100 + 10; scan mode (role set) → one window per query.
    expect(collection.opportunities.length).toBe(150);
    expect(searchCalls).toBeLessThanOrEqual(5);

    // Detail enrichment of the 110-item budget buffer, concurrency ≤ 5.
    const enriched = await enrichOpportunities(
      collection.opportunities.slice(0, 110),
    );
    expect(enriched).toHaveLength(110);
    expect(detailCalls).toBe(110);
    // The hard guarantee: at most 5 simultaneous provider requests.
    expect(probe.maxInFlight()).toBeLessThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// 10) Email collection must not re-hammer BA for the same opportunities
// ---------------------------------------------------------------------------
describe("10. export re-run reuses already-fetched data", () => {
  it("re-collecting and re-enriching the same plan issues zero extra BA requests", async () => {
    const plan = {
      rationale: "r",
      queries: [{ keyword: "", role: "Mechatroniker", location: "Berlin" }],
      web_queries: [],
    } as const;
    const args = {
      plan: plan as unknown as Parameters<typeof collectOpportunities>[0]["plan"],
      goal: "ausbildung" as const,
      targetCount: 25 as const,
    };
    let searchCalls = 0;
    let detailCalls = 0;
    const probe = scriptedFetch([
      (_call, url) => {
        if (url.includes("/v4/jobdetails")) {
          detailCalls += 1;
          return jsonResponse(detailsArbeit);
        }
        searchCalls += 1;
        const items = Array.from({ length: 30 }, (_, i) =>
          mkSearchItem(`X-${i + 1}`, "2026-09-20", {
            hauptberuf: "Mechatroniker/in",
          }),
        );
        return jsonResponse({ ergebnisliste: items, maxErgebnisse: items.length });
      },
    ]);

    const first = await collectOpportunities(args);
    expect(first.opportunities).toHaveLength(30);
    await enrichOpportunities(first.opportunities.slice(0, 25));
    const searchesAfterRun1 = searchCalls;
    const detailsAfterRun1 = detailCalls;
    expect(searchesAfterRun1).toBe(1); // scan window, single provider call
    expect(detailsAfterRun1).toBe(25);

    // The export route re-runs the SAME deterministic collection + enrichment.
    const second = await collectOpportunities(args);
    expect(second.opportunities.map((item) => item.id)).toEqual(
      first.opportunities.map((item) => item.id),
    );
    await enrichOpportunities(second.opportunities.slice(0, 25));

    // Zero repeated BA requests for the same data.
    expect(searchCalls).toBe(searchesAfterRun1);
    expect(detailCalls).toBe(detailsAfterRun1);
    expect(probe.maxInFlight()).toBeLessThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// 11) Duplicate search → shared cache reuse
// ---------------------------------------------------------------------------
describe("11. duplicate search reuses the shared cache", () => {
  it("a second identical search makes no provider call (5-minute cache)", async () => {
    const probe = scriptedFetch([
      () =>
        jsonResponse({
          ergebnisliste: [mkSearchItem("REF-C", "2026-09-28")],
          maxErgebnisse: 1,
        }),
    ]);
    const params: OpportunitySearchParams = {
      goal: "arbeit",
      keyword: "",
      role: "",
      company: "",
      location: "",
      freshness: "any",
      sort: "relevance",
      employment: "any",
      training_type: "any",
      home_office: "any",
      salary_documented: false,
      page: 1,
      pageSize: 20,
      match: false,
    };
    const first = await searchOpportunities(params, null);
    const second = await searchOpportunities(params, null);
    expect(probe.calls()).toBe(1);
    expect(second.results.map((item) => item.id)).toEqual(
      first.results.map((item) => item.id),
    );
    expect(first.sources).toBeUndefined();
    expect(second.sources).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 12) Retry after failure → new attempt without reload
// ---------------------------------------------------------------------------
describe("12. retry issues a fresh attempt (no reload needed)", () => {
  it("first request fails (502 + retryable source_status); the retry succeeds (200)", async () => {
    // Calls 1–3: the first request's 3 attempts (all fail). Call 4: the
    // user's "Erneut versuchen" click — a fresh client request, no page
    // reload — succeeds on its first attempt.
    const probe = scriptedFetch([
      () => {
        throw networkError();
      },
      () => {
        throw networkError();
      },
      () => {
        throw networkError();
      },
      () =>
        jsonResponse({
          ergebnisliste: [mkSearchItem("REF-R", "2026-09-28")],
          maxErgebnisse: 1,
        }),
    ]);

    const firstResponse = await searchRoute(
      new Request("http://localhost/api/opportunities/search?goal=arbeit"),
    );
    expect(firstResponse.status).toBe(502);
    const firstBody = (await firstResponse.json()) as {
      source_status?: { retryable: boolean; status: string; source: string };
    };
    expect(firstBody.source_status).toMatchObject({
      source: "bundesagentur",
      status: "temporarily_unavailable",
      retryable: true,
    });
    expect(probe.calls()).toBe(3);

    // The retry button simply re-runs the same client fetch (same URL/state).
    const retryResponse = await searchRoute(
      new Request("http://localhost/api/opportunities/search?goal=arbeit"),
    );
    expect(retryResponse.status).toBe(200);
    const retryBody = (await retryResponse.json()) as {
      results: Array<{ id: string }>;
    };
    expect(retryBody.results).toHaveLength(1);
    expect(retryBody.results[0].id).toBe("arbeitsagentur:REF-R");
    expect(probe.calls()).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Extended coverage — 403/WAF, all sources fail, partial results,
// email collection without fake emails (spec §14 items 3, 8, 12, 13, 14)
// ---------------------------------------------------------------------------
describe("extended WAF / partial-results coverage", () => {
  it("classifies 403 (access block / WAF) as BLOCKED_OR_CHALLENGED — never retried, never bypassed", async () => {
    const probe = scriptedFetch([
      () =>
        new Response("{}", {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
    ]);
    await expect(
      fetchBaJson("https://ba.example.test/search", {
        timeoutMs: 50,
        backoffBaseMs: 1,
        deadlineMs: 1000,
        label: "test",
      }),
    ).rejects.toMatchObject({
      name: "BaFetchFailure",
      kind: "BLOCKED_OR_CHALLENGED",
      retryable: false,
      status: 403,
    });
    // A deliberate block is respected: exactly one attempt, no hammering.
    expect(probe.calls()).toBe(1);
  });

  it("all sources fail → structured 'temporarily_unavailable', the pipeline does not throw", async () => {
    adminState.profileRow = candidateProfileFixture();
    vi.mocked(createAIProvider).mockReturnValue({
      generateText: vi.fn(async () =>
        JSON.stringify({
          rationale: "Profile documents Mechatroniker in Berlin.",
          queries: [{ keyword: "", role: "Mechatroniker", location: "Berlin" }],
          web_queries: [],
        }),
      ),
      streamText: vi.fn(),
      analyzeFile: vi.fn(),
      analyzeImage: vi.fn(),
      generateFile: vi.fn(),
    } as never);
    // No web client configured → the ONLY source is BA, and it is down.
    vi.mocked(getWebSearchClient).mockReturnValue(null);
    const probe = scriptedFetch([() => {
      throw networkError();
    }]);

    const events: Array<Record<string, unknown>> = [];
    const result = await runAISearch({
      userId: "user-test",
      goal: "ausbildung",
      targetCount: 10,
      onProgress: (event) => events.push(event as unknown as Record<string, unknown>),
    });

    // No exception, no fabricated results — a clean "nothing, here is why".
    expect(result.found).toBe(0);
    expect(result.results).toEqual([]);
    expect(result.sources).toEqual([
      {
        source: "bundesagentur",
        status: "temporarily_unavailable",
        retryable: true,
      },
    ]);
    const complete = events.find((event) => event.type === "complete");
    expect(complete).toBeDefined();
    expect(probe.calls()).toBe(3); // 3 controlled attempts, then stopped
  });

  it("scan window: page 1 ok + page 2 fails → partial (degraded) results are returned, not an error", async () => {
    // Page 1: 50 real items, source claims 100 → the scan wants a page 2.
    // Page 2: network failure on all 3 controlled attempts → the collected
    // page-1 results must still be served, flagged as degraded/partial.
    const items = Array.from({ length: 50 }, (_, i) =>
      mkSearchItem(`D-${i + 1}`, "2026-09-20", { hauptberuf: "Mechatroniker/in" }),
    );
    const probe = scriptedFetch([
      () => jsonResponse({ ergebnisliste: items, maxErgebnisse: 100 }),
      () => {
        throw networkError();
      },
      () => {
        throw networkError();
      },
      () => {
        throw networkError();
      },
    ]);
    const window = await fetchOpportunityWindow({
      goal: "ausbildung",
      keyword: "",
      role: "Mechatroniker",
      company: "",
      location: "",
      freshness: "any",
      sort: "relevance",
      employment: "any",
      training_type: "any",
      home_office: "any",
      salary_documented: false,
      page: 1,
      pageSize: 20,
      match: false,
    });
    expect(window.mode).toBe("scan");
    expect(window.window).toHaveLength(50); // real results survived
    expect(window.degraded).toBe(true);
    expect(window.scan_truncated).toBe(true);
    expect(window.exhausted).toBe(false);
    expect(probe.calls()).toBe(4); // 1 ok page + 3 controlled retries of page 2
  });

  it("email collection keeps successful emails, skips the failed source, and never invents an email", async () => {
    const publishedEmail = "bewerbung@firma-bergmann.de";
    const goodDetails = {
      ...detailsArbeit,
      stellenangebotsBeschreibung: `Bewerbung bitte direkt an ${publishedEmail} senden.`,
    };
    // Only the details call for REF-EMAIL-1 succeeds; REF-EMAIL-2's source
    // is unreachable (network failure on every attempt).
    const b64Good = Buffer.from("REF-EMAIL-1", "utf8").toString("base64");
    scriptedFetch([
      (_call, url) => {
        if (url.includes(b64Good)) return jsonResponse(goodDetails);
        throw networkError();
      },
    ]);

    const items = [baItem("REF-EMAIL-1"), baItem("REF-EMAIL-2")];
    const enriched = await enrichOpportunities(items);

    // The failed source is skipped — its row is simply absent (its email is
    // null by construction, never guessed).
    expect(enriched).toHaveLength(1);
    // The kept email is EXACTLY the one the source published.
    expect(enriched[0].contact?.email).toBe(publishedEmail);
    // No fake emails anywhere: every non-null email in the result set is the
    // published one (no info@/contact@/bewerbung@<company> synthesis).
    for (const opp of enriched) {
      if (opp.contact?.email) expect(opp.contact.email).toBe(publishedEmail);
    }
  });
});
