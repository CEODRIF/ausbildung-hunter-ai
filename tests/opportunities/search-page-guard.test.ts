import { describe, expect, it, vi } from "vitest";

/**
 * Page-guard regression tests for searchOpportunities:
 *
 *  - SCAN mode is page-independent (the window IS the full filtered set): an
 *    out-of-range page must never render "N results" over an empty list —
 *    the page is clamped to a reachable one;
 *  - UPSTREAM mode: a stale page beyond the source total (old shared URL)
 *    must self-heal to page 1 instead of showing an empty page with total>0;
 *  - the response always reports the page the rows ACTUALLY belong to, so
 *    the UI can sync its pagination state.
 *
 * The provider is mocked (no network); the shared cache always misses so
 * every window read hits the (mocked) provider — writes are swallowed.
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
import { searchOpportunities } from "@/lib/opportunities/search";
import {
  opportunitySchema,
  searchParamsSchema,
  type Opportunity,
  type OpportunitySearchParams,
} from "@/lib/opportunities/types";

function mkOpp(i: number): Opportunity {
  return opportunitySchema.parse({
    id: `arbeitsagentur:PG${i}-S`,
    provider: "arbeitsagentur",
    external_id: `PG${i}-S`,
    source_name: "Bundesagentur für Arbeit",
    source_url: "https://www.arbeitsagentur.test/jobbundle/bundle/1",
    application_url: null,
    title: `Ausbildung als Kaufmann im E-Commerce (${i})`,
    goal: "ausbildung",
    stellenangebotsart: "AUSBILDUNG",
    company_name: `Company ${i} GmbH`,
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

/** Every cache read misses; every write succeeds silently. */
function mockAdminCacheMiss() {
  const terminal = { data: null, error: null };
  vi.mocked(createAdminClient).mockImplementation(() => {
    const chain: Record<string, unknown> = {};
    for (const method of [
      "select",
      "eq",
      "gte",
      "or",
      "delete",
      "upsert",
      "limit",
    ]) {
      chain[method] = vi.fn().mockReturnValue(chain);
    }
    chain.single = vi.fn().mockResolvedValue(terminal);
    chain.maybeSingle = vi.fn().mockResolvedValue(terminal);
    return { from: vi.fn().mockReturnValue(chain) } as never;
  });
}

function scanParams(page: number): OpportunitySearchParams {
  // role set → scan mode (the page-independent filtered window).
  return searchParamsSchema.parse({
    goal: "ausbildung",
    keyword: "E-Commerce",
    role: "Kaufmann im E-Commerce",
    page,
    pageSize: 20,
  });
}

function upstreamParams(page: number): OpportunitySearchParams {
  return searchParamsSchema.parse({
    goal: "ausbildung",
    keyword: "E-Commerce",
    page,
    pageSize: 20,
  });
}

describe("searchOpportunities page guard", () => {
  it("scan: an out-of-range page is clamped to a reachable page with real rows", async () => {
    mockAdminCacheMiss();
    const window = [mkOpp(1), mkOpp(2), mkOpp(3)];
    windowMock.mockReset().mockResolvedValue({
      mode: "scan",
      window,
      total: 3,
      scan_truncated: false,
      exhausted: true,
      degraded: false,
      filter_counts: null,
    });
    // Page 5 of a 3-item window must NOT render an empty list.
    const result = await searchOpportunities(scanParams(5), null);
    expect(result.page).toBe(1);
    expect(result.results).toHaveLength(3);
    expect(result.total).toBe(3);
    expect(result.mode).toBe("scan");
  });

  it("scan: a valid page is served unchanged (correct slice + page)", async () => {
    mockAdminCacheMiss();
    const window = Array.from({ length: 50 }, (_, i) => mkOpp(i + 1));
    windowMock.mockReset().mockResolvedValue({
      mode: "scan",
      window,
      total: 50,
      scan_truncated: false,
      exhausted: true,
      degraded: false,
      filter_counts: null,
    });
    const result = await searchOpportunities(scanParams(2), null);
    expect(result.page).toBe(2);
    expect(result.results).toHaveLength(20);
    // The slice is items 21..40 (0-based 20..39).
    expect(result.results[0].id).toBe("arbeitsagentur:PG21-S");
    expect(result.results[19].id).toBe("arbeitsagentur:PG40-S");
  });

  it("scan: an empty window (no matches) clamps to page 1 and stays empty", async () => {
    mockAdminCacheMiss();
    windowMock.mockReset().mockResolvedValue({
      mode: "scan",
      window: [],
      total: 0,
      scan_truncated: false,
      exhausted: true,
      degraded: false,
      filter_counts: null,
    });
    const result = await searchOpportunities(scanParams(3), null);
    expect(result.page).toBe(1);
    expect(result.results).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it("upstream: a stale page beyond the source total self-heals to page 1", async () => {
    mockAdminCacheMiss();
    windowMock.mockReset().mockImplementation(
      async (params: OpportunitySearchParams) => {
        if (params.page === 3) {
          // The source's honest answer for an out-of-range page: empty.
          return {
            mode: "upstream",
            window: [],
            total: 30,
            scan_truncated: false,
            exhausted: true,
            degraded: false,
            filter_counts: null,
          };
        }
        return {
          mode: "upstream",
          window: Array.from({ length: 20 }, (_, i) => mkOpp(i + 1)),
          total: 30,
          scan_truncated: false,
          exhausted: true,
          degraded: false,
          filter_counts: null,
        };
      },
    );
    const result = await searchOpportunities(upstreamParams(3), null);
    // One stale read + one self-healing page-1 read — bounded, no loop.
    expect(windowMock).toHaveBeenCalledTimes(2);
    expect(windowMock.mock.calls[0]![0]).toMatchObject({ page: 3 });
    expect(windowMock.mock.calls[1]![0]).toMatchObject({ page: 1 });
    expect(result.page).toBe(1);
    expect(result.results).toHaveLength(20);
    expect(result.total).toBe(30);
  });

  it("upstream: a valid page is served with a single provider read", async () => {
    mockAdminCacheMiss();
    windowMock.mockReset().mockResolvedValue({
      mode: "upstream",
      window: Array.from({ length: 20 }, (_, i) => mkOpp(i + 21)),
      total: 30,
      scan_truncated: false,
      exhausted: true,
      degraded: false,
      filter_counts: null,
    });
    const result = await searchOpportunities(upstreamParams(2), null);
    expect(windowMock).toHaveBeenCalledTimes(1);
    expect(result.page).toBe(2);
    expect(result.results).toHaveLength(20);
  });

  it("upstream: a genuinely empty source (total 0) does NOT self-heal", async () => {
    mockAdminCacheMiss();
    windowMock.mockReset().mockResolvedValue({
      mode: "upstream",
      window: [],
      total: 0,
      scan_truncated: false,
      exhausted: true,
      degraded: false,
      filter_counts: null,
    });
    const result = await searchOpportunities(upstreamParams(3), null);
    expect(windowMock).toHaveBeenCalledTimes(1); // no healing read
    expect(result.page).toBe(3);
    expect(result.results).toHaveLength(0);
    expect(result.total).toBe(0);
  });
});
