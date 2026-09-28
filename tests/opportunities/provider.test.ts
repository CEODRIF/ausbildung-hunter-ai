import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSearchQuery,
  getArbeitsagenturDetails,
  OpportunityNotFoundError,
  OpportunityProviderError,
  parseOpportunityKey,
  searchArbeitsagentur,
} from "@/lib/opportunities/providers/arbeitsagentur";
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

describe("searchArbeitsagentur normalization (real API fixtures)", () => {
  it("classifies Arbeit items from stellenangebotsart", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(searchArbeit)),
    );
    const page = await searchArbeitsagentur(baseParams());
    expect(page.results).toHaveLength(2);
    expect(page.results.every((item) => item.goal === "arbeit")).toBe(true);
    expect(
      page.results.every((item) => item.stellenangebotsart === "ARBEIT"),
    ).toBe(true);
    expect(page.results.every((item) => item.match === null)).toBe(true);
    expect(page.total).toBe(searchArbeit.maxErgebnisse);
  });

  it("classifies Ausbildung items from stellenangebotsart", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(searchAusbildung)),
    );
    const page = await searchArbeitsagentur(baseParams({ goal: "ausbildung" }));
    expect(page.results[0].goal).toBe("ausbildung");
    expect(page.results[0].training_type).toBe("AUSBILDUNG");
  });

  it("preserves the source fields (occupation, salary, company, dates, location, distance)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(searchArbeit)),
    );
    const page = await searchArbeitsagentur(baseParams());
    const first = searchArbeit.ergebnisliste[0] as Record<string, unknown>;
    const item = page.results[0];
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
    const page = await searchArbeitsagentur(baseParams());
    const item = page.results[0];
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
    const page = await searchArbeitsagentur(baseParams());
    expect(page.results[0].salary).toBeNull();
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
    await searchArbeitsagentur(baseParams({ freshness: "today" }));
    expect(urls[0]).toContain("veroeffentlichtseit=1");
    await searchArbeitsagentur(baseParams({ freshness: "14d" }));
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
    const page = await searchArbeitsagentur(
      baseParams({ freshness: "14d", pageSize: 20 }),
    );
    expect(page.results.map((item) => item.external_id)).toEqual([
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
    const page = await searchArbeitsagentur(
      baseParams({ freshness: "14d", pageSize: 20 }),
    );
    expect(page.scan_truncated).toBe(true);
    expect(page.results).toHaveLength(20);
    expect(page.total).toBe(50);
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
    const page = await searchArbeitsagentur(
      baseParams({ freshness: "30d", pageSize: 20 }),
    );
    expect(page.results.map((item) => item.external_id)).toEqual(["D-1-S"]);
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
