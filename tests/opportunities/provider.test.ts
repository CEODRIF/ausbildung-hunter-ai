import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildMatchers,
  buildSearchQuery,
  getArbeitsagenturDetails,
  OpportunityNotFoundError,
  OpportunityProviderError,
  parseOpportunityKey,
  fetchOpportunityWindow,
  sortWindow,
} from "@/lib/opportunities/providers/arbeitsagentur";
import type { Opportunity } from "@/lib/opportunities/types";
import { baseParams, httpError, jsonResponse, mkSearchItem } from "../helpers";

const searchArbeit = (await import("../fixtures/ba-search-arbeit.json")) as {
  ergebnisliste: Record<string, unknown>[];
  maxErgebnisse: number;
};
const searchAusbildung =
  (await import("../fixtures/ba-search-ausbildung.json")) as {
    ergebnisliste: Record<string, unknown>[];
    maxErgebnisse: number;
  };
const detailsArbeit =
  (await import("../fixtures/ba-details-arbeit.json")) as Record<
    string,
    unknown
  >;
const detailsAusbildung =
  (await import("../fixtures/ba-details-ausbildung.json")) as Record<
    string,
    unknown
  >;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("buildSearchQuery (verified BA v6 parameter surface)", () => {
  it("maps goal to angebotsart (1=Arbeit, 4=Ausbildung)", () => {
    expect(
      buildSearchQuery({
        goal: "arbeit",
        keyword: "",
        location: "",
        freshness: "any",
        page: 1,
        size: 20,
      }).get("angebotsart"),
    ).toBe("1");
    expect(
      buildSearchQuery({
        goal: "ausbildung",
        keyword: "",
        location: "",
        freshness: "any",
        page: 1,
        size: 20,
      }).get("angebotsart"),
    ).toBe("4");
  });

  it("uses ver关于entlichtseit=1 only for freshness=today", () => {
    for (const [freshness, expected] of [
      ["today", "1"],
      ["any", null],
      ["14d", null],
      ["30d", null],
    ] as const) {
      expect(
        buildSearchQuery({
          goal: "arbeit",
          keyword: "",
          location: "",
          freshness,
          page: 1,
          size: 20,
        }).get("veroeffentlichtseit"),
      ).toBe(expected);
    }
  });

  it("never sends provider filters the API does not support (remote/role/company)", () => {
    const query = buildSearchQuery({
      goal: "arbeit",
      keyword: "service",
      location: "Berlin",
      radius: 20,
      freshness: "30d",
      page: 1,
      size: 20,
    });
    const keys = [...query.keys()];
    expect(keys).not.toContain("arbeitszeit");
    expect(keys).not.toContain("beruf");
    expect(keys).not.toContain("arbeitgeber");
    expect(query.get("was")).toBe("service");
    expect(query.get("wo")).toBe("Berlin");
    expect(query.get("umkreis")).toBe("20");
  });

  it("only sends umkreis together with a location", () => {
    expect(
      buildSearchQuery({
        goal: "arbeit",
        keyword: "",
        location: "",
        radius: 20,
        freshness: "any",
        page: 1,
        size: 20,
      }).get("umkreis"),
    ).toBeNull();
  });
});

describe("fetchOpportunityWindow normalization (real API fixtures)", () => {
  it("classifies Arbeit items from stellenangebotsart", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(searchArbeit)),
    );
    const page = await fetchOpportunityWindow(baseParams());
    expect(page.mode).toBe("upstream");
    expect(page.window).toHaveLength(2);
    expect(page.window.every((item) => item.goal === "arbeit")).toBe(true);
    expect(
      page.window.every((item) => item.stellenangebotsart === "ARBEIT"),
    ).toBe(true);
    expect(page.window.every((item) => item.match === null)).toBe(true);
    expect(page.total).toBe(searchArbeit.maxErgebnisse);
    expect(page.exhausted).toBe(true);
  });

  it("classifies Ausbildung items from stellenangebotsart", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(searchAusbildung)),
    );
    const page = await fetchOpportunityWindow(
      baseParams({ goal: "ausbildung" }),
    );
    expect(page.window[0].goal).toBe("ausbildung");
    expect(page.window[0].training_type).toBe("AUSBILDUNG");
  });

  it("preserves the source fields (occupation, salary, company, dates, location, distance)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(searchArbeit)),
    );
    const page = await fetchOpportunityWindow(baseParams());
    const first = searchArbeit.ergebnisliste[0] as Record<string, unknown>;
    const item = page.window[0];
    expect(item.external_id).toBe(first.referenznummer);
    expect(item.profession).toBe(first.hauptberuf);
    expect(item.company_name).toBe(first.firma);
    expect(item.salary?.amount).toBe(13.9);
    expect(item.salary?.unit).toBe("hourly");
    expect(item.salary?.label).toContain("13,90 €");
    expect(item.distance_km).toBe(1);
    expect(item.employment_type).toBe("Full-time");
    expect(item.career_change_friendly).toBe(false);
    expect(item.location).toContain("Berlin");
    expect(item.location_detail?.postal_code).toBe("10179");
    expect(item.posted_at?.slice(0, 10)).toBe(
      first.datumErsteVeroeffentlichung,
    );
    expect(item.source_url).toContain(String(first.referenznummer));
    expect(item.provider).toBe("arbeitsagentur");
    expect(item.id).toBe(`arbeitsagentur:${first.referenznummer}`);
  });

  it("leaves null/empty what the source does not provide", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          ergebnisliste: [
            {
              referenznummer: "12345-987-S",
              stellenangebotsTitel: "Teststelle",
              stellenangebotsart: "ARBEIT",
            },
          ],
          maxErgebnisse: 1,
        }),
      ),
    );
    const page = await fetchOpportunityWindow(baseParams());
    const item = page.window[0];
    expect(item.salary).toBeNull();
    expect(item.profession).toBeNull();
    expect(item.location).toBeNull();
    expect(item.distance_km).toBeNull();
    expect(item.home_office).toBeNull(); // Arbeit search items: field absent
    expect(item.description).toBeNull();
    expect(item.contact).toBeNull();
    expect(item.education_requirement).toBeNull();
    expect(item.tasks).toEqual([]);
    expect(item.required_skills).toEqual([]);
    expect(item.application_url).toBeNull();
  });

  it("never reports a salary without a source amount", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          ergebnisliste: [
            mkSearchItem("11111-1-S", "2026-09-28", {
              verguetungsangabe: "GEHALT",
              festgehalt: null,
            }),
          ],
          maxErgebnisse: 1,
        }),
      ),
    );
    const page = await fetchOpportunityWindow(baseParams());
    expect(page.window[0].salary).toBeNull();
  });
});

describe("freshness behavior (explicit, never silently ignored)", () => {
  const day = (offsetDays: number) =>
    new Date(Date.now() - offsetDays * 86_400_000).toISOString().slice(0, 10);

  it("sends the API parameter for today and nothing for 14d/30d", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        urls.push(String(url));
        return jsonResponse({ ergebnisliste: [], maxErgebnisse: 0 });
      }),
    );
    await fetchOpportunityWindow(baseParams({ freshness: "today" }));
    expect(urls[0]).toContain("veroeffentlichtseit=1");
    await fetchOpportunityWindow(baseParams({ freshness: "14d" }));
    expect(urls[1]).not.toContain("veroeffentlichtseit");
  });

  it("applies 14d server-side on the source publication date", async () => {
    const pages: Record<string, unknown> = {
      "1": {
        ergebnisliste: [
          mkSearchItem("A-1-S", day(1)),
          mkSearchItem("B-2-S", day(30)),
          mkSearchItem("C-3-S", day(2)),
        ],
        maxErgebnisse: 3,
      },
      "2": { ergebnisliste: [], maxErgebnisse: 3 },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        jsonResponse(
          pages[new URL(String(url)).searchParams.get("page") ?? "1"],
        ),
      ),
    );
    const page = await fetchOpportunityWindow(
      baseParams({ freshness: "14d", pageSize: 20 }),
    );
    expect(page.window.map((item) => item.external_id)).toEqual([
      "A-1-S",
      "C-3-S",
    ]);
    expect(page.total).toBe(2);
    expect(page.scan_truncated).toBe(false);
  });

  it("flags truncation when the scan budget ends before the source", async () => {
    const items = Array.from({ length: 50 }, (_, index) =>
      mkSearchItem(`R-${index}-S`, day(1)),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ ergebnisliste: items, maxErgebnisse: 5000 }),
      ),
    );
    const page = await fetchOpportunityWindow(
      baseParams({ freshness: "14d", pageSize: 20 }),
    );
    expect(page.mode).toBe("scan");
    expect(page.scan_truncated).toBe(true);
    // The scan keeps the full bounded window (pages are sliced later).
    expect(page.window).toHaveLength(50);
    expect(page.total).toBe(50);
    expect(page.exhausted).toBe(false);
  });

  it("reports exhausted=false only when the scan budget ended early", async () => {
    const pages: Record<string, unknown> = {
      "1": {
        ergebnisliste: [mkSearchItem("E-1-S", day(1))],
        maxErgebnisse: 1,
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        jsonResponse(
          pages[new URL(String(url)).searchParams.get("page") ?? "1"],
        ),
      ),
    );
    const page = await fetchOpportunityWindow(baseParams({ freshness: "14d" }));
    expect(page.exhausted).toBe(true);
    expect(page.scan_truncated).toBe(false);
    expect(page.mode).toBe("scan");
  });

  it("collects the full bounded window before sorting (no partial-order bias)", async () => {
    // The newest item sits on API page 2 (relevance order) — a partial
    // collection (stopping at the first requested page) would miss it.
    const oldItems = Array.from({ length: 50 }, (_, index) =>
      mkSearchItem(`OLD-${index}-S`, day(20)),
    );
    const pages: Record<string, unknown> = {
      "1": { ergebnisliste: oldItems, maxErgebnisse: 51 },
      "2": {
        ergebnisliste: [mkSearchItem("NEW-1-S", day(0))],
        maxErgebnisse: 51,
      },
    };
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(String(url));
        return jsonResponse(
          pages[new URL(String(url)).searchParams.get("page") ?? "1"],
        );
      }),
    );
    const page = await fetchOpportunityWindow(baseParams({ sort: "newest" }));
    // Both API pages were scanned before sorting.
    expect(urls.length).toBe(2);
    expect(page.window[0].external_id).toBe("NEW-1-S");
    expect(page.window).toHaveLength(51);
    expect(page.total).toBe(51);
    expect(page.exhausted).toBe(true);
  });

  it("excludes items without a documented publication date from date filters", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          ergebnisliste: [
            mkSearchItem("D-1-S", day(1)),
            {
              referenznummer: "D-2-S",
              stellenangebotsTitel: "No date",
              stellenangebotsart: "ARBEIT",
            },
          ],
          maxErgebnisse: 2,
        }),
      ),
    );
    const page = await fetchOpportunityWindow(
      baseParams({ freshness: "30d", pageSize: 20 }),
    );
    expect(page.window.map((item) => item.external_id)).toEqual(["D-1-S"]);
  });
});

describe("getArbeitsagenturDetails (real API fixtures)", () => {
  it("classifies Ausbildung details from stellenangebotsart", async () => {
    const ref = detailsAusbildung.referenznummer as string;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(detailsAusbildung)),
    );
    const opportunity = await getArbeitsagenturDetails(ref);
    expect(opportunity.goal).toBe("ausbildung");
    expect(opportunity.stellenangebotsart).toBe("AUSBILDUNG");
    expect(opportunity.training_type).toBe("AUSBILDUNG");
    expect(opportunity.profession).toBe(detailsAusbildung.hauptberuf);
    expect(opportunity.company_name).toBe(detailsAusbildung.firma);
  });

  it("NICHT_RELEVANT education requirement is stored as 'none documented'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(detailsAusbildung)),
    );
    const opportunity = await getArbeitsagenturDetails(
      detailsAusbildung.referenznummer as string,
    );
    expect(opportunity.education_requirement).toBeNull();
  });

  it("maps real education requirement values to levels", async () => {
    for (const [value, level] of [
      ["MITTLERE_REIFE_MITLLERER_BILDUNGSABSCHLUSS", "intermediate"],
      ["ABITUR", "university"],
      ["HAUPTSCHULABSCHLUSS", "basic"],
      ["FACHOBERT", "advanced"],
      ["NEUER_UNGEBEKRÄFTIGTER_WERT", "unknown"],
    ] as const) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          jsonResponse({
            ...detailsAusbildung,
            geforderterBildungsabschluss: value,
          }),
        ),
      );
      const opportunity = await getArbeitsagenturDetails(
        detailsAusbildung.referenznummer as string,
      );
      expect(opportunity.education_requirement?.level).toBe(level);
      expect(opportunity.education_requirement?.raw).toBe(value.toUpperCase());
    }
  });

  it("extracts contact, sections and application URL from the published description", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(detailsArbeit)),
    );
    const opportunity = await getArbeitsagenturDetails(
      detailsArbeit.referenznummer as string,
    );
    expect(opportunity.contact?.email).toBe("wedding.service@perzukunft.de");
    expect(opportunity.contact?.phone).toContain("22954506");
    expect(opportunity.contact?.person).toBe("Schneider");
    expect(opportunity.tasks).toHaveLength(4);
    expect(opportunity.requirements).toHaveLength(4);
    expect(opportunity.tasks[0]).toContain("Snacks");
    expect(opportunity.application_url).toBe(
      "https://www.perzukunft.de/job/freundliche-servicekraft-m-w-d-jugendherberge-dringend-1201610005438342",
    );
    expect(opportunity.company_name).toBe(detailsArbeit.firma);
    expect(opportunity.description).toBeTruthy();
  });

  it("throws typed errors for expired references and provider failures", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        messages: [{ code: "STELLENANGEBOT_NICHT_GEFUNDEN" }],
        timestamp: "2026-09-28T00:00:00Z",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      getArbeitsagenturDetails("12016-10005438342-S"),
    ).rejects.toBeInstanceOf(OpportunityNotFoundError);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => httpError(503)),
    );
    await expect(
      getArbeitsagenturDetails("12016-10005438342-S"),
    ).rejects.toBeInstanceOf(OpportunityProviderError);
  });

  it("rejects malformed references before any network call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(getArbeitsagenturDetails("../admin")).rejects.toBeInstanceOf(
      OpportunityProviderError,
    );
    await expect(getArbeitsagenturDetails("a")).rejects.toBeInstanceOf(
      OpportunityProviderError,
    );
    await expect(
      getArbeitsagenturDetails("12016-10005438342;DROP"),
    ).rejects.toBeInstanceOf(OpportunityProviderError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("parseOpportunityKey", () => {
  it("accepts well-formed keys", () => {
    expect(parseOpportunityKey("arbeitsagentur:12016-10005438342-S")).toEqual({
      provider: "arbeitsagentur",
      externalId: "12016-10005438342-S",
    });
  });

  it("rejects foreign or malformed keys", () => {
    expect(() => parseOpportunityKey("not-a-key")).toThrow(
      OpportunityProviderError,
    );
    expect(() => parseOpportunityKey("otherprovider:abc123-S")).toThrow(
      OpportunityProviderError,
    );
    expect(() => parseOpportunityKey("arbeitsagentur:bad ref")).toThrow(
      OpportunityProviderError,
    );
    expect(() => parseOpportunityKey("arbeitsagentur:")).toThrow(
      OpportunityProviderError,
    );
  });
});

// Minimal normalized opportunity for pure ordering/filter unit tests.
function mkOpp(overrides: Record<string, unknown>): Opportunity {
  return {
    id: `arbeitsagentur:X-S`,
    provider: "arbeitsagentur",
    external_id: "X-S",
    source_name: "S",
    source_url: "https://example.test/x",
    source_type: "official_source",
    additional_sources: [],
    source_ids: [],
    enrichment: null,
    application_url: null,
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
    retrieved_at: "2026-09-28T00:00:00.000Z",
    contact: null,
    required_skills: [],
    preferred_skills: [],
    required_languages: [],
    extracted_keywords: [],
    match: null,
    ...overrides,
  } as Opportunity;
}

describe("sortWindow (deterministic, structured values, nulls last)", () => {
  const items = [
    mkOpp({
      id: "arbeitsagentur:A-S",
      posted_at: "2026-09-01T00:00:00.000Z",
      salary: { amount: 20, unit: "hourly", label: "20 €" },
      distance_km: 12,
    }),
    mkOpp({
      id: "arbeitsagentur:B-S",
      posted_at: null,
      salary: null,
      distance_km: null,
    }),
    mkOpp({
      id: "arbeitsagentur:C-S",
      posted_at: "2026-09-20T00:00:00.000Z",
      salary: { amount: 50, unit: "hourly", label: "50 €" },
      distance_km: 3,
    }),
    mkOpp({
      id: "arbeitsagentur:D-S",
      posted_at: "2026-09-10T00:00:00.000Z",
      salary: { amount: 10, unit: "hourly", label: "10 €" },
      distance_km: 40,
    }),
  ];

  it("newest: date desc, undated last", () => {
    expect(sortWindow(items, "newest").map((o) => o.id)).toEqual([
      "arbeitsagentur:C-S",
      "arbeitsagentur:D-S",
      "arbeitsagentur:A-S",
      "arbeitsagentur:B-S",
    ]);
  });

  it("oldest: date asc, undated last", () => {
    expect(sortWindow(items, "oldest").map((o) => o.id)).toEqual([
      "arbeitsagentur:A-S",
      "arbeitsagentur:D-S",
      "arbeitsagentur:C-S",
      "arbeitsagentur:B-S",
    ]);
  });

  it("salary: amount desc, undocumented last (never guessed)", () => {
    expect(sortWindow(items, "salary").map((o) => o.id)).toEqual([
      "arbeitsagentur:C-S",
      "arbeitsagentur:A-S",
      "arbeitsagentur:D-S",
      "arbeitsagentur:B-S",
    ]);
  });

  it("distance: km asc, undocumented last", () => {
    expect(sortWindow(items, "distance").map((o) => o.id)).toEqual([
      "arbeitsagentur:C-S",
      "arbeitsagentur:A-S",
      "arbeitsagentur:D-S",
      "arbeitsagentur:B-S",
    ]);
  });

  it("relevance: keeps source order; does not mutate input", () => {
    const before = items.map((o) => o.id);
    expect(sortWindow(items, "relevance").map((o) => o.id)).toEqual(before);
    expect(items.map((o) => o.id)).toEqual(before);
  });

  it("breaks ties by stable id", () => {
    const tied = [
      mkOpp({
        id: "arbeitsagentur:Z-S",
        posted_at: "2026-09-01T00:00:00.000Z",
      }),
      mkOpp({
        id: "arbeitsagentur:A-S",
        posted_at: "2026-09-01T00:00:00.000Z",
      }),
    ];
    expect(sortWindow(tied, "newest").map((o) => o.id)).toEqual([
      "arbeitsagentur:A-S",
      "arbeitsagentur:Z-S",
    ]);
  });
});

describe("buildMatchers (new Phase 3 filters, source-faithful)", () => {
  const opps = {
    full: mkOpp({ employment_type: "Full-time" }),
    part: mkOpp({ employment_type: "Part-time" }),
    both: mkOpp({ employment_type: "Full-time or part-time" }),
    none: mkOpp({ employment_type: null }),
  };

  it("employment=full_time matches full-time and mixed, not part-only/unknown", () => {
    const [m] = buildMatchers(baseParams({ employment: "full_time" }));
    expect(m(opps.full)).toBe(true);
    expect(m(opps.both)).toBe(true);
    expect(m(opps.part)).toBe(false);
    expect(m(opps.none)).toBe(false);
  });

  it("employment=part_time matches part-time and mixed, not full-only/unknown", () => {
    const [m] = buildMatchers(baseParams({ employment: "part_time" }));
    expect(m(opps.part)).toBe(true);
    expect(m(opps.both)).toBe(true);
    expect(m(opps.full)).toBe(false);
    expect(m(opps.none)).toBe(false);
  });

  it("training_type matches only documented training types", () => {
    const [m] = buildMatchers(baseParams({ training_type: "DUALES_STUDIUM" }));
    expect(m(mkOpp({ training_type: "DUALES_STUDIUM" }))).toBe(true);
    expect(m(mkOpp({ training_type: "AUSBILDUNG" }))).toBe(false);
    expect(m(mkOpp({ training_type: null }))).toBe(false);
  });

  it("home_office=yes matches only documented true (null excluded)", () => {
    const [m] = buildMatchers(baseParams({ home_office: "yes" }));
    expect(m(mkOpp({ home_office: true }))).toBe(true);
    expect(m(mkOpp({ home_office: false }))).toBe(false);
    expect(m(mkOpp({ home_office: null }))).toBe(false);
  });

  it("salary_documented matches only items with a documented salary", () => {
    const [m] = buildMatchers(baseParams({ salary_documented: true }));
    expect(
      m(mkOpp({ salary: { amount: 5, unit: "hourly", label: "5" } })),
    ).toBe(true);
    expect(m(mkOpp({ salary: null }))).toBe(false);
  });

  it("distance_max excludes items beyond the bound and undocumented distance", () => {
    const [m] = buildMatchers(
      baseParams({ distance_max: 10, location: "Berlin" }),
    );
    expect(m(mkOpp({ distance_km: 5 }))).toBe(true);
    expect(m(mkOpp({ distance_km: 10 }))).toBe(true);
    expect(m(mkOpp({ distance_km: 11 }))).toBe(false);
    expect(m(mkOpp({ distance_km: null }))).toBe(false);
  });
});
