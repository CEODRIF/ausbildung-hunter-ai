import { describe, expect, it, vi } from "vitest";

/**
 * fetchOpportunityWindowCached — the shared, user-independent window for
 * programmatic consumers (Company Discovery). Same cache as the UI search:
 * hit → no provider call; miss → provider call + cache write. The returned
 * window never carries per-user match data.
 */

const windowMock = vi.fn();
vi.mock("@/lib/opportunities/providers/arbeitsagentur", () => ({
  fetchOpportunityWindow: (...args: unknown[]) => windowMock(...args),
  resolveOpportunity: vi.fn(),
  BaFetchFailure: class BaFetchFailure extends Error {},
  OpportunityNotFoundError: class OpportunityNotFoundError extends Error {},
  OpportunityProviderError: class OpportunityProviderError extends Error {},
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(),
}));

import { createAdminClient } from "@/lib/supabase/admin";
import {
  fetchOpportunityWindowCached,
  buildCacheKey,
} from "@/lib/opportunities/search";
import {
  opportunitySchema,
  searchParamsSchema,
  type Opportunity,
  type OpportunitySearchParams,
} from "@/lib/opportunities/types";

function mkOpp(id: string): Opportunity {
  return opportunitySchema.parse({
    id: `arbeitsagentur:${id}`,
    provider: "arbeitsagentur",
    external_id: id,
    source_name: "Bundesagentur für Arbeit",
    source_url: "https://www.arbeitsagentur.test/jobbundle/bundle/1",
    application_url: null,
    title: "Ausbildung als Kaufmann im E-Commerce",
    goal: "ausbildung",
    stellenangebotsart: "AUSBILDUNG",
    company_name: "Siemens AG",
    company_url: null,
    location: "10115 Berlin",
    location_detail: {
      city: "Berlin",
      region: "Berlin",
      country: "Deutschland",
      postal_code: "10115",
    },
    distance_km: null,
    latitude: null,
    longitude: null,
    profession: "Kaufmann im E-Commerce",
    alternative_professions: [],
    description: null,
    tasks: [],
    requirements: [],
    employment_type: "Full-time",
    home_office: null,
    career_change_friendly: null,
    salary: null,
    training_type: "AUSBILDUNG",
    education_requirement: null,
    valid_from: "2027-08-01",
    application_deadline: null,
    posted_at: "2026-10-01T00:00:00.000Z",
    updated_at: null,
    retrieved_at: "2026-10-02T00:00:00.000Z",
    contact: null,
    required_skills: [],
    preferred_skills: [],
    required_languages: [],
    extracted_keywords: [],
    match: null,
  });
}

const PARAMS: OpportunitySearchParams = searchParamsSchema.parse({
  goal: "ausbildung",
  keyword: "E-Commerce",
  role: "Kaufmann im E-Commerce",
});

/** Chainable fake query; terminals resolve in call order. */
function makeChain(terminals: Array<{ data?: unknown; error?: unknown }>) {
  let terminalIndex = 0;
  const resolveTerminal = () => {
    const value =
      terminals[Math.min(terminalIndex, terminals.length - 1)] ?? {};
    terminalIndex += 1;
    return Promise.resolve(value);
  };
  const chain: Record<string, unknown> = {
    single: vi.fn(resolveTerminal),
    maybeSingle: vi.fn(resolveTerminal),
    eq: vi.fn(),
    in: vi.fn(),
    gte: vi.fn(),
    lt: vi.fn(),
    or: vi.fn(),
    select: vi.fn(),
    delete: vi.fn(),
    upsert: vi.fn(),
    order: vi.fn(),
    limit: vi.fn(),
  };
  for (const key of Object.keys(chain)) {
    if (key !== "single" && key !== "maybeSingle") {
      chain[key] = vi.fn().mockReturnValue(chain);
    }
  }
  return chain;
}

function mockAdminChain(terminals: Array<{ data?: unknown; error?: unknown }>) {
  const chain = makeChain(terminals);
  vi.mocked(createAdminClient).mockReturnValue({
    from: vi.fn().mockReturnValue(chain),
  } as never);
  return chain;
}

const SCAN_WINDOW = {
  mode: "scan",
  window: [mkOpp("w1")],
  total: 1,
  scan_truncated: false,
  exhausted: true,
  degraded: false,
  filter_counts: null,
};

describe("fetchOpportunityWindowCached", () => {
  it("cache miss: calls the provider once and writes the shared cache", async () => {
    windowMock.mockReset().mockResolvedValue(SCAN_WINDOW);
    // from #1: cache read (miss) → from #2: cleanup delete → from #3: upsert
    mockAdminChain([
      { data: null, error: null },
      { data: null, error: null },
      { data: null, error: null },
    ]);
    const result = await fetchOpportunityWindowCached(PARAMS);
    expect(windowMock).toHaveBeenCalledTimes(1);
    expect(windowMock).toHaveBeenCalledWith(PARAMS);
    expect(result).toMatchObject({
      mode: "scan",
      total: 1,
      degraded: false,
    });
    expect(result.window).toHaveLength(1);
    // The returned window carries no per-user match data (shared payload).
    expect(result.window[0].match).toBeNull();
  });

  it("cache hit: serves the stored window WITHOUT a provider call", async () => {
    windowMock.mockReset();
    const key = buildCacheKey(PARAMS);
    const payload = {
      ...SCAN_WINDOW,
      generated_at: "2026-10-02T12:00:00.000Z",
    };
    mockAdminChain([{ data: { results: payload }, error: null }]);
    const result = await fetchOpportunityWindowCached(PARAMS);
    expect(windowMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ mode: "scan", total: 1 });
    expect(result.window[0].id).toBe("arbeitsagentur:w1");
    expect(key).toContain("scan");
  });
});
