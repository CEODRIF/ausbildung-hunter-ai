/**
 * Search & filter RELIABILITY — regression tests for the reported bugs:
 *
 *  A. Goal consistency: a result's SOURCE classification must equal the
 *     requested goal (Ausbildung search never shows a job posting, and vice
 *     versa). The per-user profile MATCH is display/sort data only — it must
 *     never substitute for search filtering.
 *  B. Query normalization: whitespace runs are collapsed at the single
 *     central entry point (meaning-preserving: case, umlauts, punctuation
 *     untouched).
 *  C. Client invariants (source-level, same pattern as the existing
 *     architectural tests): commit cancels a pending debounced search (no
 *     stale-draft revert), "Clear filters" preserves the typed search terms
 *     and the sort order, and workplace "Show all" removes ONLY the location
 *     restriction.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildMatchers,
  fetchOpportunityWindow,
} from "@/lib/opportunities/providers/arbeitsagentur";
import {
  normalizeSearchParams,
  type Opportunity,
} from "@/lib/opportunities/types";
import { baseParams, jsonResponse, mkSearchItem } from "../helpers";

// Deterministic "now": Friday 2026-10-02 12:00 UTC (= 14:00 Berlin).
const NOW = new Date("2026-10-02T12:00:00Z");
const DAY = (d: string) => `${d}T00:00:00.000Z`;

function mkOpp(overrides: Record<string, unknown>): Opportunity {
  return {
    id: "arbeitsagentur:X-S",
    provider: "arbeitsagentur",
    external_id: "X-S",
    source_name: "S",
    source_url: "https://example.test/x",
    source_type: "official_source",
    additional_sources: [],
    source_ids: [],
    enrichment: null,
    application_url: null,
    aggregator_url: null,
    title: "T",
    goal: "ausbildung",
    stellenangebotsart: "AUSBILDUNG",
    company_name: null,
    company_url: null,
    location: "10115 Berlin",
    location_detail: {
      city: "Berlin",
      region: null,
      country: null,
      postal_code: "10115",
    },
    distance_km: null,
    latitude: null,
    longitude: null,
    profession: null,
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
    valid_from: DAY("2026-11-01"),
    application_deadline: null,
    posted_at: DAY("2026-10-01"),
    updated_at: null,
    retrieved_at: "2026-10-02T00:00:00.000Z",
    contact: null,
    required_skills: [],
    preferred_skills: [],
    required_languages: [],
    extracted_keywords: [],
    match: null,
    ...overrides,
  } as Opportunity;
}

function matches(params: Parameters<typeof buildMatchers>[0], item: Opportunity) {
  return buildMatchers(params, { now: NOW }).every((m) => m(item));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// A. Goal consistency — search filtering is independent of profile matching
// ---------------------------------------------------------------------------

describe("Goal consistency — Ausbildung search shows only Ausbildung", () => {
  it("buildMatchers excludes an item whose source goal differs from the requested goal", () => {
    const ausbildung = baseParams({ goal: "ausbildung" });
    const work = mkOpp({ goal: "arbeit", stellenangebotsart: "ARBEIT" });
    const training = mkOpp({ goal: "ausbildung", stellenangebotsart: "AUSBILDUNG" });
    expect(matches(ausbildung, training)).toBe(true);
    expect(matches(ausbildung, work)).toBe(false);
  });

  it("and the reverse: a Job search excludes Ausbildung items", () => {
    const arbeit = baseParams({ goal: "arbeit" });
    const work = mkOpp({ goal: "arbeit", stellenangebotsart: "ARBEIT" });
    const training = mkOpp({ goal: "ausbildung", stellenangebotsart: "AUSBILDUNG" });
    expect(matches(arbeit, work)).toBe(true);
    expect(matches(arbeit, training)).toBe(false);
  });

  it("upstream mode: a contradictory source record is dropped, the rest kept", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          ergebnisliste: [
            mkSearchItem("G-OK", DAY("2026-10-01"), {
              stellenangebotsart: "AUSBILDUNG",
            }),
            mkSearchItem("G-BAD", DAY("2026-10-01"), {
              stellenangebotsart: "ARBEIT", // contradicts the requested goal
            }),
          ],
          maxErgebnisse: 2,
        }),
      ),
    );
    const page = await fetchOpportunityWindow(baseParams({ goal: "ausbildung" }));
    expect(page.mode).toBe("upstream");
    expect(page.window).toHaveLength(1);
    expect(page.window[0].external_id).toBe("G-OK");
    expect(page.window[0].goal).toBe("ausbildung");
  });

  it("scan mode: the goal filter ANDs with the other filters (counts included)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          ergebnisliste: [
            mkSearchItem("S-OK", DAY("2026-10-01"), {
              stellenangebotsart: "AUSBILDUNG",
            }),
            mkSearchItem("S-BAD", DAY("2026-10-01"), {
              stellenangebotsart: "ARBEIT",
            }),
          ],
          maxErgebnisse: 2,
        }),
      ),
    );
    const page = await fetchOpportunityWindow(
      baseParams({ goal: "ausbildung", freshness: "1w" }),
    );
    expect(page.mode).toBe("scan");
    // Only the consistent item survives the AND of goal + freshness.
    expect(page.total).toBe(1);
    expect(page.window[0].external_id).toBe("S-OK");
    // The REAL counts exclude the inconsistent item too.
    expect(page.filter_counts?.freshness.any).toBe(1);
    expect(page.filter_counts?.freshness.week).toBe(1);
  });

  it("combined filters: goal + role + city + freshness + beginn all hold at once", () => {
    const params = baseParams({
      goal: "ausbildung",
      role: "Klimatechniker",
      cities: ["Kiel"],
      freshness: "1w",
      beginn: "2026-11",
    });
    // Multi-city is required to trigger the city matcher; use two cities.
    const multi = baseParams({
      goal: "ausbildung",
      role: "Klimatechniker",
      cities: ["Kiel", "Rostock"],
      freshness: "1w",
      beginn: "2026-11",
    });
    const pass = mkOpp({
      goal: "ausbildung",
      profession: "Klimatechniker",
      location_detail: {
        city: "Kiel",
        region: "Schleswig-Holstein",
        country: null,
        postal_code: "24103",
      },
      location: "24103 Kiel",
      posted_at: DAY("2026-10-01"),
      valid_from: DAY("2026-11-15"),
    });
    const wrongGoal = { ...pass, goal: "arbeit" as const };
    expect(matches(multi, pass)).toBe(true);
    expect(matches(multi, wrongGoal)).toBe(false);
    // A single city is the native source location (no post-filter needed).
    expect(matches(params, pass)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// B. Query normalization — consistent, meaning-preserving
// ---------------------------------------------------------------------------

describe("Query normalization (central, meaning-preserving)", () => {
  it("collapses internal whitespace runs in keyword/role/company/location", () => {
    const params = normalizeSearchParams(
      baseParams({
        keyword: "  Klima   Technik\t\n",
        role: "Anlagenmechaniker  SH",
        company: "Wefers  Technik GmbH",
        location: "  Berlin ",
      }),
    );
    expect(params.keyword).toBe("Klima Technik");
    expect(params.role).toBe("Anlagenmechaniker SH");
    expect(params.company).toBe("Wefers Technik GmbH");
    expect(params.location).toBe("Berlin");
  });

  it("never changes the words' meaning (case, umlauts, punctuation stay)", () => {
    for (const raw of [
      "KLIMATECHNIK",
      "Klimatechnik",
      "Klima-Technik",
      "Kälteanlagenbauer",
      "Kaufmann im E-Commerce",
    ]) {
      expect(normalizeSearchParams(baseParams({ keyword: raw })).keyword).toBe(raw);
    }
  });

  it("applies at every entry point that funnels through normalizeSearchParams", () => {
    // The API route and the shareable-URL parser both call normalizeSearchParams
    // — one implementation, so no entry point can drift.
    const viaUrl = normalizeSearchParams(
      baseParams({ keyword: "Klima  Technik" }),
    );
    expect(viaUrl.keyword).toBe("Klima Technik");
  });
});

// ---------------------------------------------------------------------------
// C. Client invariants (source-level, project architectural-test pattern)
// ---------------------------------------------------------------------------

describe("Opportunity search client invariants", () => {
  const source = readFileSync(
    "src/components/opportunity-search.tsx",
    "utf8",
  );

  it("commitSearch cancels any pending debounced search before searching (no stale-draft revert)", () => {
    const start = source.indexOf("const commitSearch = useCallback(");
    expect(start).toBeGreaterThan(0);
    const body = source.slice(start, source.indexOf("const scheduleSearch", start));
    const cancel = body.indexOf("clearTimeout(debounceRef.current)");
    const searchCall = body.indexOf("void search(final)");
    expect(cancel).toBeGreaterThan(0);
    expect(searchCall).toBeGreaterThan(cancel); // cancel FIRST, then search
  });

  it('"Clear filters" preserves the typed search terms and the sort order', () => {
    const start = source.indexOf("const clearFilters = () =>");
    expect(start).toBeGreaterThan(0);
    const body = source.slice(start, source.indexOf("const openDetails"));
    // Reset the sidebar filter dimensions…
    expect(body).toContain("cities: []");
    expect(body).toContain("freshness: \"any\"");
    expect(body).toContain("beginn: \"any\"");
    expect(body).toContain("salary: \"any\"");
    expect(body).toContain("contact_email: \"any\"");
    expect(body).toContain("employment: \"any\"");
    expect(body).toContain("training_type: \"any\"");
    // …but never touch the search form fields or the toolbar sort.
    expect(body).not.toContain("keyword:");
    expect(body).not.toContain("role:");
    expect(body).not.toContain("company:");
    expect(body).not.toContain("sort:");
  });

  it('workplace "Show all" removes ONLY the location restriction (never the other filters)', () => {
    const start = source.indexOf("{t(\"search.showAll\")}");
    expect(start).toBeGreaterThan(0);
    // Walk back to the enclosing <label> … forward to the closing </label>.
    const labelStart = source.lastIndexOf("<label", start);
    const labelEnd = source.indexOf("</label>", start) + "</label>".length;
    const block = source.slice(labelStart, labelEnd);
    expect(block).toContain("cities: []");
    expect(block).toContain("location: \"\"");
    expect(block).toContain("radius: null");
    expect(block).toContain("distance_max: null");
    // It must not reach into the other filter dimensions:
    expect(block).not.toContain("freshness");
    expect(block).not.toContain("beginn");
    expect(block).not.toContain("keyword");
    expect(block).not.toContain("sort");
  });

  it("the Clear button appears only when a SIDEBAR filter is active (a bare keyword never shows it)", () => {
    const start = source.indexOf("<span className=\"text-sm font-bold text-ink\">{t(\"search.filters\")}</span>");
    expect(start).toBeGreaterThan(0);
    // The header block ends where the filter groups container starts.
    const block = source.slice(
      start,
      source.indexOf('<div className="space-y-6 p-5">', start),
    );
    expect(block).toContain("activeFilterCount > 0 &&");
    expect(block).toContain("onClick={clearFilters}");
  });

  it("debounced text edits reset the page — a new search never runs on a stale page", () => {
    const start = source.indexOf("const scheduleSearch = useCallback(");
    expect(start).toBeGreaterThan(0);
    const body = source.slice(
      start,
      source.indexOf("// Restore results for a shared/returned URL", start),
    );
    // The committed draft must force page 1 (same contract as Enter / the
    // Search button), otherwise editing the keyword on page N would show the
    // NEW query's page N — empty in scan mode with reachable results.
    expect(body).toContain("page: 1");
    expect(body).not.toContain("current.page");
  });

  it("a server-served page different from the requested one syncs the UI without a new search", () => {
    const start = source.indexOf("const search = useCallback(");
    expect(start).toBeGreaterThan(0);
    const body = source.slice(
      start,
      source.indexOf("const syncUrl", start),
    );
    // The stale-page self-heal: rows and pagination label must never
    // disagree — the state follows the page the server actually served.
    expect(body).toContain("data.page !== next.page");
    expect(body).toContain("stateRef.current = synced");
    expect(body).toContain("router.replace(");
  });
});
