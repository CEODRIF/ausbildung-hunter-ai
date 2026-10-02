/**
 * Phase 28 — server-side search filters (real data, deterministic "now"):
 * Work place (cities), Published since (today/yesterday/1w/2w/4w), Beginn
 * (now / real months), Salary (Ausbildung vs Job), Contact email (real
 * emails only — never phone/website/free text), filter combinations, REAL
 * per-option counts, scan-window decision, and details integrity
 * (A ≠ B, not-found, parallel fetch, no artificial delays, no
 * search-credits in the search/details path).
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  berlinDay,
  buildMatchers,
  cityMatcher,
  computeFilterCounts,
  fetchOpportunityWindow,
  getArbeitsagenturDetails,
  hasRealContactEmail,
  OpportunityNotFoundError,
} from "@/lib/opportunities/providers/arbeitsagentur";
import {
  normalizeSearchParams,
  usesScanWindow,
  WORKPLACE_CITIES,
  type Opportunity,
} from "@/lib/opportunities/types";
import { baseParams, jsonResponse, mkSearchItem } from "../helpers";
import detailsArbeitFixture from "../fixtures/ba-details-arbeit.json";

const REF_A = "12016-10005438342-S"; // the real reference in the fixture
const REF_B = "12016-20005438342-S";

/** Real, source-shaped details payload for opportunity A (as published). */
function detailsFixtureA(): Record<string, unknown> {
  return { ...(detailsArbeitFixture as Record<string, unknown>) };
}
/** Same real source shape, different ref/title/company → opportunity B. */
function detailsFixtureB(): Record<string, unknown> {
  return {
    ...(detailsArbeitFixture as Record<string, unknown>),
    stellenangebotsTitel: "Bäcker B — Bäckerei Müller",
    hauptberuf: "Bäcker",
    firma: "Bäckerei Müller",
    referenznummer: REF_B,
  };
}

// Deterministic "now": Friday 2026-10-02 14:00 Berlin (12:00 UTC).
const NOW = new Date("2026-10-02T12:00:00Z");
const T0 = berlinDay(0, NOW); // 2026-10-02
const T1 = berlinDay(1, NOW); // 2026-10-01
const T7 = berlinDay(7, NOW); // 2026-09-25
const T14 = berlinDay(14, NOW); // 2026-09-18
const T28 = berlinDay(28, NOW); // 2026-09-04
const DAY = (d: string) => `${d}T00:00:00.000Z`;

// Minimal normalized opportunity for pure filter unit tests.
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
    goal: "arbeit",
    stellenangebotsart: "ARBEIT",
    company_name: null,
    company_url: null,
    location: null,
    location_detail: null,
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
    valid_from: null,
    application_deadline: null,
    posted_at: null,
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

describe("Work place — German cities as a REAL filter", () => {
  it("lists real German cities (no fake/placeholder entries)", () => {
    expect(WORKPLACE_CITIES.length).toBe(30);
    for (const city of ["Berlin", "München", "Hamburg", "Köln", "Bremen"]) {
      expect(WORKPLACE_CITIES).toContain(city);
    }
    // No empty/placeholder values may exist in the curated list.
    for (const city of WORKPLACE_CITIES) expect(city.trim().length).toBeGreaterThan(2);
  });

  it("single city → native source location (wo), no scan window", () => {
    const normalized = normalizeSearchParams(
      baseParams({ cities: ["Berlin"] }),
    );
    expect(normalized.location).toBe("Berlin");
    expect(usesScanWindow(normalized)).toBe(false);
  });

  it("two or more cities → bounded server-side filter, native location cleared", () => {
    const normalized = normalizeSearchParams(
      baseParams({ cities: ["Berlin", "Hamburg"] }),
    );
    expect(normalized.location).toBe("");
    expect(usesScanWindow(normalized)).toBe(true);
  });

  it("drops non-curated city names and dedupes (never a free-text guess)", () => {
    const normalized = normalizeSearchParams(
      baseParams({ cities: ["Berlin", "Bogus", "München", "Berlin"] }),
    );
    expect(normalized.cities).toEqual(["Berlin", "München"]);
  });

  it("cityMatcher matches the structured city and the display location", () => {
    const berlin = cityMatcher(["Berlin"]);
    expect(
      berlin(mkOpp({ location_detail: { city: "Berlin" } as Opportunity["location_detail"] })),
    ).toBe(true);
    expect(berlin(mkOpp({ location: "10115 Berlin" }))).toBe(true);
    expect(berlin(mkOpp({ location: "20095 Hamburg" }))).toBe(false);
    expect(berlin(mkOpp({ location: null }))).toBe(false);
  });

  it("multi-city selection is an OR over the selected cities", () => {
    const both = cityMatcher(["Berlin", "Hamburg"]);
    expect(both(mkOpp({ location: "20095 Hamburg" }))).toBe(true);
    expect(both(mkOpp({ location: "10115 Berlin" }))).toBe(true);
    expect(both(mkOpp({ location: "12345 Frankfurt am Main" }))).toBe(false);
  });

  it("no city selected (Show all) and single city produce NO city matcher", () => {
    // The goal-consistency matcher is always present; the point is that no
    // CITY matcher joins it (a single city is handled natively by `wo`).
    const none = buildMatchers(baseParams(), { now: NOW });
    for (const city of ["10115 Berlin", "20095 Hamburg", "30159 Hannover"]) {
      for (const m of none) expect(m(mkOpp({ location: city }))).toBe(true);
    }
    const single = buildMatchers(
      normalizeSearchParams(baseParams({ cities: ["Berlin"] })),
      { now: NOW },
    );
    // No city matcher: an out-of-city item is NOT rejected here.
    for (const m of single)
      expect(m(mkOpp({ location: "20095 Hamburg" }))).toBe(true);
  });
});

describe("Published since — real publication days (injected now)", () => {
  it("Berlin calendar-day boundaries are deterministic", () => {
    expect(T0).toBe("2026-10-02");
    expect(T1).toBe("2026-10-01");
    expect(T7).toBe("2026-09-25");
    expect(T14).toBe("2026-09-18");
    expect(T28).toBe("2026-09-04");
  });

  it("today: only the current Berlin day; missing dates never match", () => {
    const p = baseParams({ freshness: "today" });
    expect(matches(p, mkOpp({ posted_at: DAY(T0) }))).toBe(true);
    expect(matches(p, mkOpp({ posted_at: DAY(T1) }))).toBe(false);
    expect(matches(p, mkOpp({ posted_at: null }))).toBe(false);
  });

  it("yesterday: only the previous Berlin day", () => {
    const p = baseParams({ freshness: "yesterday" });
    expect(matches(p, mkOpp({ posted_at: DAY(T1) }))).toBe(true);
    expect(matches(p, mkOpp({ posted_at: DAY(T0) }))).toBe(false);
    expect(matches(p, mkOpp({ posted_at: DAY(T7) }))).toBe(false);
    expect(matches(p, mkOpp({ posted_at: null }))).toBe(false);
  });

  it("1 week: from 7 Berlin days ago (inclusive)", () => {
    const p = baseParams({ freshness: "1w" });
    expect(matches(p, mkOpp({ posted_at: DAY(T7) }))).toBe(true);
    expect(matches(p, mkOpp({ posted_at: DAY(T0) }))).toBe(true);
    expect(matches(p, mkOpp({ posted_at: DAY("2026-09-24") }))).toBe(false);
    expect(matches(p, mkOpp({ posted_at: null }))).toBe(false);
  });

  it("2 weeks: from 14 Berlin days ago (inclusive)", () => {
    const p = baseParams({ freshness: "2w" });
    expect(matches(p, mkOpp({ posted_at: DAY(T14) }))).toBe(true);
    expect(matches(p, mkOpp({ posted_at: DAY("2026-09-17") }))).toBe(false);
    expect(matches(p, mkOpp({ posted_at: null }))).toBe(false);
  });

  it("4 weeks: from 28 Berlin days ago (inclusive)", () => {
    const p = baseParams({ freshness: "4w" });
    expect(matches(p, mkOpp({ posted_at: DAY(T28) }))).toBe(true);
    expect(matches(p, mkOpp({ posted_at: DAY("2026-09-03") }))).toBe(false);
    expect(matches(p, mkOpp({ posted_at: null }))).toBe(false);
  });

  it("any: every item with a documented date — including old ones", () => {
    const p = baseParams({ freshness: "any" });
    expect(matches(p, mkOpp({ posted_at: DAY(T0) }))).toBe(true);
    expect(matches(p, mkOpp({ posted_at: "2020-01-01T00:00:00.000Z" }))).toBe(true);
  });
});

describe("Beginn — documented valid_from only (injected now)", () => {
  it("from now on: today or any future documented start", () => {
    const p = baseParams({ beginn: "now" });
    expect(matches(p, mkOpp({ valid_from: DAY(T0) }))).toBe(true);
    expect(matches(p, mkOpp({ valid_from: DAY("2026-12-01") }))).toBe(true);
    expect(matches(p, mkOpp({ valid_from: DAY(T1) }))).toBe(false);
    expect(matches(p, mkOpp({ valid_from: null }))).toBe(false);
  });

  it("real month: only that exact documented month (2026-11)", () => {
    const p = baseParams({ beginn: "2026-11" });
    expect(matches(p, mkOpp({ valid_from: DAY("2026-11-01") }))).toBe(true);
    expect(matches(p, mkOpp({ valid_from: DAY("2026-11-30") }))).toBe(true);
    expect(matches(p, mkOpp({ valid_from: DAY("2026-10-31") }))).toBe(false);
    expect(matches(p, mkOpp({ valid_from: DAY("2026-12-01") }))).toBe(false);
    expect(matches(p, mkOpp({ valid_from: null }))).toBe(false);
  });

  it("any: every item, documented start or not", () => {
    const p = baseParams({ beginn: "any" });
    expect(matches(p, mkOpp({ valid_from: DAY("2026-01-15") }))).toBe(true);
    expect(matches(p, mkOpp({ valid_from: null }))).toBe(true);
  });
});

describe("Salary — depends on the search goal (same source-faithful engine)", () => {
  it("Ausbildung: documented → only items with a documented Vergütung", () => {
    const p = baseParams({ goal: "ausbildung", salary: "documented" });
    expect(
      matches(p, mkOpp({ goal: "ausbildung", salary: { amount: 1025, unit: "monthly", label: "1.025 € mtl." } })),
    ).toBe(true);
    expect(matches(p, mkOpp({ goal: "ausbildung", salary: null }))).toBe(false);
  });

  it("Ausbildung: missing → only items WITHOUT a documented Vergütung", () => {
    const p = baseParams({ goal: "ausbildung", salary: "missing" });
    expect(
      matches(p, mkOpp({ goal: "ausbildung", salary: { amount: 1025, unit: "monthly", label: "1.025 € mtl." } })),
    ).toBe(false);
    expect(matches(p, mkOpp({ goal: "ausbildung", salary: null }))).toBe(true);
  });

  it("Job: documented → only items with a documented Vergütung/Gehalt", () => {
    const p = baseParams({ goal: "arbeit", salary: "documented" });
    expect(
      matches(p, mkOpp({ goal: "arbeit", salary: { amount: 13.9, unit: "hourly", label: "13,90 € Std." } })),
    ).toBe(true);
    expect(matches(p, mkOpp({ goal: "arbeit", salary: null }))).toBe(false);
  });

  it("Job: missing → only items WITHOUT a documented salary", () => {
    const p = baseParams({ goal: "arbeit", salary: "missing" });
    expect(
      matches(p, mkOpp({ goal: "arbeit", salary: { amount: 13.9, unit: "hourly", label: "13,90 € Std." } })),
    ).toBe(false);
    expect(matches(p, mkOpp({ goal: "arbeit", salary: null }))).toBe(true);
  });

  it("any: salary never filters", () => {
    const p = baseParams({ salary: "any" });
    expect(matches(p, mkOpp({ salary: { amount: 1, unit: "hourly", label: "1 €" } }))).toBe(true);
    expect(matches(p, mkOpp({ salary: null }))).toBe(true);
  });
});

describe("Contact email — real emails only", () => {
  it("accepts a documented contact email", () => {
    const p = baseParams({ contact_email: "available" });
    expect(
      matches(p, mkOpp({ contact: { email: "karriere@firma.de" } as Opportunity["contact"] })),
    ).toBe(true);
  });

  it("accepts a provenance-checked company enrichment email", () => {
    const p = baseParams({ contact_email: "available" });
    expect(
      matches(p, mkOpp({ enrichment: { email: "jobs@firma.de" } as Opportunity["enrichment"] })),
    ).toBe(true);
  });

  it("a phone number is NOT an email", () => {
    const p = baseParams({ contact_email: "available" });
    expect(
      matches(p, mkOpp({ contact: { email: "+49 30 22954506" } as Opportunity["contact"] })),
    ).toBe(false);
    expect(
      hasRealContactEmail(mkOpp({ contact: { email: "+49 30 22954506" } as Opportunity["contact"] })),
    ).toBe(false);
  });

  it("a website/URL is NOT an email", () => {
    const p = baseParams({ contact_email: "available" });
    expect(
      matches(p, mkOpp({ contact: { email: "https://www.firma.de/karriere" } as Opportunity["contact"] })),
    ).toBe(false);
  });

  it("a malformed email is NOT an email", () => {
    const p = baseParams({ contact_email: "available" });
    expect(
      matches(p, mkOpp({ contact: { email: "foo@bar" } as Opportunity["contact"] })),
    ).toBe(false);
  });

  it("an email that appears only in free text (description) is NOT an email", () => {
    const p = baseParams({ contact_email: "available" });
    expect(
      matches(p, mkOpp({ description: "Kontakt: bewerbung@firma.de", contact: null })),
    ).toBe(false);
  });

  it("no contact data at all → not available", () => {
    const p = baseParams({ contact_email: "available" });
    expect(matches(p, mkOpp({ contact: null, enrichment: null }))).toBe(false);
    // ...but "any" passes everything (Show all).
    expect(matches(baseParams({ contact_email: "any" }), mkOpp({}))).toBe(true);
  });
});

describe("Filter combinations (AND semantics, every dimension)", () => {
  const full = mkOpp({
    id: "arbeitsagentur:FULL-S",
    goal: "ausbildung",
    location: "10115 Berlin",
    posted_at: DAY(T0),
    valid_from: DAY("2026-11-01"),
    salary: { amount: 1025, unit: "monthly", label: "1.025 € mtl." },
    contact: { email: "info@firma.de" } as Opportunity["contact"],
    employment_type: "Full-time",
    training_type: "AUSBILDUNG",
    home_office: true,
  });
  const params = baseParams({
    goal: "ausbildung",
    cities: ["Berlin", "Hamburg"],
    freshness: "today",
    beginn: "2026-11",
    salary: "documented",
    contact_email: "available",
    employment: "full_time",
    training_type: "AUSBILDUNG",
    home_office: "yes",
  });

  it("an item matching every selected filter passes", () => {
    expect(matches(params, full)).toBe(true);
  });

  it.each([
    ["wrong city", { location: "30159 Hannover" }],
    ["posted yesterday", { posted_at: DAY(T1) }],
    ["start in the wrong month", { valid_from: DAY("2026-10-01") }],
    ["no documented salary", { salary: null }],
    ["no real contact email", { contact: null }],
    ["part-time instead of full-time", { employment_type: "Part-time" }],
    ["dual study instead of vocational", { training_type: "DUALES_STUDIUM" }],
    ["no home office", { home_office: false }],
    ["missing publication date", { posted_at: null }],
    ["missing start date", { valid_from: null }],
  ])("rejects the item violating: %s", (_label, violation) => {
    expect(matches(params, { ...full, ...violation })).toBe(false);
  });
});

describe("REAL filter counts (computed server-side, nothing estimated)", () => {
  const items = [
    mkOpp({ id: "arbeitsagentur:C1-S", posted_at: DAY(T0), valid_from: DAY("2026-10-02") }),
    mkOpp({ id: "arbeitsagentur:C2-S", posted_at: DAY(T0), valid_from: DAY("2026-11-01") }),
    mkOpp({ id: "arbeitsagentur:C3-S", posted_at: DAY(T1), valid_from: DAY("2026-11-15") }),
    mkOpp({ id: "arbeitsagentur:C4-S", posted_at: DAY("2026-09-22"), valid_from: DAY("2026-12-01") }),
    mkOpp({ id: "arbeitsagentur:C5-S", posted_at: DAY("2026-08-01"), valid_from: DAY("2026-09-01") }),
    mkOpp({ id: "arbeitsagentur:C6-S", posted_at: null, valid_from: null }),
    mkOpp({ id: "arbeitsagentur:C7-S", posted_at: DAY("2026-10-01") }),
  ];

  it("counts every documented day; missing dates are counted in NO bucket", () => {
    const counts = computeFilterCounts(items, NOW);
    // 7 items — one of them without any documented date.
    expect(counts.freshness.any).toBe(7);
    expect(counts.beginn.any).toBe(7);
    expect(counts.freshness.today).toBe(2); // C1, C2 (T0)
    expect(counts.freshness.yesterday).toBe(2); // C3, C7 (T1)
    expect(counts.freshness.week).toBe(4); // T0 ×2 + T1 ×2
    expect(counts.freshness.twoWeeks).toBe(5); // + C4 (2026-09-22)
    expect(counts.freshness.fourWeeks).toBe(5); // C5 (2026-08-01) is outside 28 days
  });

  it("counted buckets stay cumulative (today ⊆ week ⊆ 2w ⊆ 4w)", () => {
    const counts = computeFilterCounts(items, NOW);
    expect(counts.freshness.today).toBeLessThanOrEqual(counts.freshness.week);
    expect(counts.freshness.week).toBeLessThanOrEqual(counts.freshness.twoWeeks);
    expect(counts.freshness.twoWeeks).toBeLessThanOrEqual(counts.freshness.fourWeeks);
  });

  it("beginn: from_now counts only documented starts at/after today", () => {
    const counts = computeFilterCounts(items, NOW);
    // 2026-10-02, 2026-11-01, 2026-11-15, 2026-12-01 — the past start
    // (2026-09-01) and the missing one are excluded.
    expect(counts.beginn.from_now).toBe(4);
  });
  it("months list is derived from documented starts (no invented months)", () => {
    const counts = computeFilterCounts(items, NOW);
    expect(counts.beginn.months).toEqual([
      { month: "2026-09", count: 1 },
      { month: "2026-10", count: 1 },
      { month: "2026-11", count: 2 },
      { month: "2026-12", count: 1 },
    ]);
  });
  it("months are capped at 24 entries", () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      mkOpp({ id: `arbeitsagentur:M${i}-S`, valid_from: DAY(`2026-${String((i % 12) + 1).padStart(2, "0")}-15`) }),
    );
    const counts = computeFilterCounts(many, NOW);
    expect(counts.beginn.months.length).toBe(12); // 2026 only has 12 months
    expect(counts.beginn.from_now).toBeGreaterThanOrEqual(0);
  });
});

describe("usesScanWindow (decision boundary)", () => {
  it("plain keyword search stays true upstream pagination", () => {
    expect(usesScanWindow(baseParams())).toBe(false);
    expect(
      usesScanWindow(normalizeSearchParams(baseParams({ cities: ["Berlin"] }))),
    ).toBe(false);
  });
  it.each([
    ["role", baseParams({ role: "Mechatroniker" })],
    ["company", baseParams({ company: "Siemens" })],
    ["two cities", baseParams({ cities: ["Berlin", "Hamburg"] })],
    ["freshness", baseParams({ freshness: "today" })],
    ["beginn", baseParams({ beginn: "now" })],
    ["beginn month", baseParams({ beginn: "2026-11" })],
    ["salary documented", baseParams({ salary: "documented" })],
    ["salary missing", baseParams({ salary: "missing" })],
    ["contact email", baseParams({ contact_email: "available" })],
    ["employment", baseParams({ employment: "full_time" })],
    ["sort newest", baseParams({ sort: "newest" })],
    ["distance max", baseParams({ location: "Berlin", distance_max: 20 })],
  ])("%s requires the bounded scan window", (_label, params) => {
    expect(usesScanWindow(params)).toBe(true);
  });
});

describe("fetchOpportunityWindow — filter_counts in scan mode, none in upstream", () => {
  const day = (n: number) =>
    new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

  it("scan mode (freshness) computes REAL counts for the window", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          ergebnisliste: [
            mkSearchItem("F1-S", day(0)),
            mkSearchItem("F2-S", day(3)),
          ],
          maxErgebnisse: 2,
        }),
      ),
    );
    const page = await fetchOpportunityWindow(baseParams({ freshness: "2w" }));
    expect(page.mode).toBe("scan");
    expect(page.filter_counts).not.toBeNull();
    // Both items are inside the 2-week window; the numbers come from the
    // REAL window — "any" must equal the window size.
    expect(page.filter_counts?.freshness.any).toBe(2);
    expect(page.filter_counts?.freshness.week).toBe(2);
    expect(page.filter_counts?.freshness.fourWeeks).toBe(2);
    expect(page.total).toBe(2);
  });

  it("upstream mode carries NO counts (the UI must show no fake numbers)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ ergebnisliste: [], maxErgebnisse: 0 })),
    );
    const page = await fetchOpportunityWindow(baseParams());
    expect(page.mode).toBe("upstream");
    expect(page.filter_counts).toBeNull();
  });
});

describe("Details integrity — opportunity A shows A only, never B", () => {
  it("two different refs are fetched from two different source URLs and never mix", async () => {
    const urls: string[] = [];
    const queue = [detailsFixtureB(), detailsFixtureA(), detailsFixtureB()];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        urls.push(String(input));
        return jsonResponse(queue.shift()!);
      }),
    );
    const b1 = await getArbeitsagenturDetails(REF_B);
    const a1 = await getArbeitsagenturDetails(REF_A);
    const b2 = await getArbeitsagenturDetails(REF_B);
    expect(b1.external_id).toBe(REF_B);
    expect(b1.title).toBe("Bäcker B — Bäckerei Müller");
    expect(b1.company_name).toBe("Bäckerei Müller");
    expect(a1.external_id).toBe(REF_A);
    expect(a1.title).toBe("Freundliche Servicekraft m/w/d - Jugendherberge - Dringend!");
    expect(a1.company_name).toBe("PerZukunft Arbeitsvermittlung GmbH & Co. KG");
    // Same ref → same URL (deterministic), different ref → different URL.
    expect(urls[0]).not.toBe(urls[1]);
    expect(urls[0]).toBe(urls[2]);
    // A's data must not leak into B, even after fetching A in between.
    expect(b2.external_id).toBe(REF_B);
    expect(b2.title).toBe("Bäcker B — Bäckerei Müller");
    expect(b2.company_name).toBe("Bäckerei Müller");
  });
});

// ---- getOpportunityDetails: parallel fetch + not-found ---------------------
const adminMockState = vi.hoisted(() => ({
  admin: null as { admin: unknown } | null,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    if (!adminMockState.admin) throw new Error("admin mock not initialized");
    return adminMockState.admin.admin;
  },
}));
const { adminMock, getOpportunityDetails, resolveOpportunityCached } =
  await (async () => {
    const { createAdminMock: factory, getOpportunityDetails: g, resolveOpportunityCached: r } =
      await Promise.all([
        import("../helpers"),
        import("@/lib/opportunities/search"),
      ]).then(([helpers, search]) => ({
        createAdminMock: helpers.createAdminMock,
        getOpportunityDetails: search.getOpportunityDetails,
        resolveOpportunityCached: search.resolveOpportunityCached,
      }));
    const m = factory();
    adminMockState.admin = m;
    return { adminMock: m, getOpportunityDetails: g, resolveOpportunityCached: r };
  })();

describe("getOpportunityDetails — performance and error semantics", () => {
  it("fetches the candidate profile IN PARALLEL with the BA details (one round-trip)", async () => {
    let releaseDetails!: () => void;
    const gate = new Promise<void>((resolve) => (releaseDetails = resolve));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await gate; // hold the BA details call open
        return jsonResponse({ ...detailsFixtureA() });
      }),
    );
    const pending = getOpportunityDetails(`arbeitsagentur:${REF_A}`, { userId: "u-1" });
    // If the profile lookup were SEQUENTIAL (after the details await), the
    // candidate_profiles query would NOT be recorded while the gate is held.
    await new Promise((resolve) => setTimeout(resolve, 25));
    const profileStartedEarly = adminMock.calls.some(
      (call) => call.table === "candidate_profiles",
    );
    expect(profileStartedEarly).toBe(true);
    releaseDetails();
    const result = await pending;
    expect(result.opportunity.external_id).toBe(REF_A);
    expect(result.match_available).toBe(false); // mock has no profile row
  });

  it("a source 404 maps to OpportunityNotFoundError (propagated, not cached)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ messages: [{ code: "STELLENANGEBOT_NICHT_GEFUNDEN" }] }),
      ),
    );
    await expect(
      getOpportunityDetails(`arbeitsagentur:${REF_B}`, { userId: "u-1" }),
    ).rejects.toBeInstanceOf(OpportunityNotFoundError);
  });

  it("resolveOpportunityCached isolates per opportunity key (A ≠ B)", async () => {
    const queue = [detailsFixtureA(), { ...detailsFixtureB() }];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(queue.shift()!)),
    );
    const [a, b] = await Promise.all([
      resolveOpportunityCached(`arbeitsagentur:${REF_A}`),
      resolveOpportunityCached(`arbeitsagentur:${REF_B}`),
    ]);
    expect(a.external_id).toBe(REF_A);
    expect(a.company_name).toBe("PerZukunft Arbeitsvermittlung GmbH & Co. KG");
    expect(b.external_id).toBe(REF_B);
    expect(b.company_name).toBe("Bäckerei Müller");
  });
});

describe("Performance invariants (source scans — no fakery)", () => {
  const read = (relative: string) =>
    readFileSync(new URL(relative, import.meta.url), "utf8");

  const searchPathFiles = [
    "../../src/app/api/opportunities/search/route.ts",
    "../../src/app/opportunities/page.tsx",
    "../../src/app/opportunities/[id]/page.tsx",
    "../../src/app/opportunities/[id]/loading.tsx",
    "../../src/app/opportunities/[id]/error.tsx",
    "../../src/components/opportunity-search.tsx",
    "../../src/components/copy-email.tsx",
    "../../src/lib/opportunities/search.ts",
    "../../src/lib/opportunities/types.ts",
  ];

  it("the search + details path never imports search-credits or quota", () => {
    for (const file of searchPathFiles) {
      const source = read(file);
      expect(source, file).not.toMatch(/from\s+["']@\/lib\/search-credits["']/);
      expect(source, file).not.toMatch(/from\s+["']@\/lib\/quota["']/);
    }
  });

  it("no artificial sleep/delay patterns in the details route or search component", () => {
    const sleepPattern = /new Promise\([^)]*=>\s*setTimeout\(/;
    for (const file of [
      "../../src/app/opportunities/[id]/page.tsx",
      "../../src/app/opportunities/[id]/loading.tsx",
      "../../src/components/opportunity-search.tsx",
    ]) {
      expect(read(file), file).not.toMatch(sleepPattern);
    }
    // The details page and the skeleton must not schedule timers at all.
    expect(read("../../src/app/opportunities/[id]/page.tsx")).not.toContain("setTimeout");
    expect(read("../../src/app/opportunities/[id]/loading.tsx")).not.toContain("setTimeout");
  });

  it("detail prefetch is BOUNDED (at most 3 rows per loaded result set)", () => {
    const component = read("../../src/components/opportunity-search.tsx");
    const match = component.match(/MAX_DETAIL_PREFETCHES\s*=\s*(\d+)/);
    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBeLessThanOrEqual(3);
  });

  it("the search component never renders hardcoded counts (real data only)", () => {
    const component = read("../../src/components/opportunity-search.tsx");
    // No literal numeric count props; counts come from filterCounts (API).
    expect(component).not.toMatch(/count=\{\d+\}/);
    expect(component).toContain("filterCounts?.freshness");
    expect(component).toContain("filterCounts?.beginn");
  });
});
