import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lookup } from "node:dns/promises";

// Offline: DNS and every HTTP call are mocked/injected.
// The guard always calls lookup with { all: true }; mock that overload
// (same pattern as tests/security/ssrf-redirect.test.ts).
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn<
    (hostname: string, options?: { all: true }) => Promise<
      Array<{ address: string; family: number }>
    >
  >(),
}));

type LookupAll = (
  hostname: string,
  options?: { all: true },
) => Promise<Array<{ address: string; family: number }>>;
const dnsLookup = vi.mocked(lookup) as unknown as Mock<LookupAll>;

vi.mock("@/lib/web-search", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/web-search")>();
  return { ...actual, getWebSearchClient: vi.fn() };
});
const { getWebSearchClient } = await import("@/lib/web-search");

import {
  clearWebSearchCache,
  runHousingWebSearch,
  type HousingWebSearchInput,
} from "@/lib/housing/web-search/discovery";
import { resolveSearchProvider, LIMITS } from "@/lib/housing/web-search/config";
import { clearRobotsCache } from "@/lib/housing/web-search/robots";

const NOW = 1_760_000_000_000; // 2025-10-09T09:46:40Z — deterministic clock
const NOW_ISO = new Date(NOW).toISOString();

const AZURE = { kind: "azure" as const, base: "https://res.openai.azure.com/openai/v1", key: "k", model: "gpt-5-mini" };

const baseParams = {
  city: "Köln",
  postal_code: "",
  radius_km: 10,
  max_warm_rent: 800,
  accommodation_type: "all" as const,
  rooms: "all" as const,
  min_area_sqm: null,
  available_before: null,
};

const input = (over: Partial<HousingWebSearchInput> = {}): HousingWebSearchInput => ({
  mode: "web",
  params: { ...baseParams },
  ...over,
});

const targeted = (
  domains: string[] = ["immobilienscout24.de", "open.nrw"],
): HousingWebSearchInput => input({ mode: "targeted", domains });

// --- fixtures ---------------------------------------------------------------

const IS24_A = "https://www.immobilienscout24.de/expose/123456789";
const IS24_B = "https://www.immobilienscout24.de/expose/987654321";
const IW_A = "https://www.immowelt.de/expose/555555555";
// Non-allowlisted portals — valid in WHOLE-WEB mode (not in targeted mode).
const EXT_A = "https://immobiliensuche24.de/wohnung/111222333";
const EXT_B = "https://wohnbau-portal.de/apartments/444555666";
const NW_A = "https://open.nrw/dataset/mieten-koeln";
const NW_B = "https://open.nrw/dataset/wg-mieten-koeln"; // NOT a prefix of NW_A (startsWith trap)
const OD_A = "https://www.opendata.de/dataset/miete";
const OD_B = "https://www.opendata.de/dataset/miete2";

function azurePayload(
  citations: Array<{ url: string; title: string }>,
  text = "Angebote gefunden.",
  sources: string[] = [],
) {
  return {
    output: [
      {
        type: "web_search_call",
        status: "completed",
        action: { type: "search", query: "Mietwohnung Köln", sources },
      },
      {
        type: "message",
        status: "completed",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text,
            annotations: citations.map((c, i) => ({
              type: "url_citation",
              start_index: i,
              end_index: i + 1,
              ...c,
            })),
          },
        ],
      },
    ],
    output_text: text,
    tool_usage: { web_search: { num_requests: 2 } },
  };
}

function listingPage(overrides: Record<string, unknown> = {}) {
  const node = {
    "@context": "https://schema.org",
    "@type": "Apartment",
    name: "2-Zimmer-Wohnung Köln",
    numRooms: 2,
    floorSize: { value: 55 },
    address: { addressLocality: "Köln", postalCode: "50667" },
    availableFrom: "2025-12-01",
    offers: { price: 850 },
    ...overrides,
  };
  return new Response(
    `<html><head><title>t</title></head><body><script type="application/ld+json">${JSON.stringify(
      node,
    )}</script></body></html>`,
    { status: 200, headers: { "content-type": "text/html" } },
  );
}

interface CallRecord {
  url: string;
  body: Record<string, unknown> | null;
}
function makeFetch(opts: {
  azure?: unknown[];
  robots?: (url: string) => Response | never;
  page?: (url: string) => Response | null;
}) {
  const azureQueue = [...(opts.azure ?? [])];
  const calls: CallRecord[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    let body: Record<string, unknown> | null = null;
    if (init?.body != null) {
      try {
        body = JSON.parse(String(init.body)) as Record<string, unknown>;
      } catch {
        body = null;
      }
    }
    calls.push({ url, body });
    if (url.endsWith("/responses")) {
      return Response.json(azureQueue.shift() ?? azurePayload([]));
    }
    if (url.endsWith("/robots.txt")) {
      if (opts.robots) return opts.robots(url);
      return new Response("User-agent: *\nAllow: /", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }
    return (
      (opts.page ? opts.page(url) : null) ??
      new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } })
    );
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const PUBLIC = "93.184.216.34";

beforeEach(() => {
  vi.clearAllMocks();
  dnsLookup.mockReset();
  dnsLookup.mockResolvedValue([{ address: PUBLIC, family: 4 }]);
  clearWebSearchCache();
  clearRobotsCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("provider resolution (honest states)", () => {
  it("returns not_configured without any network call when no provider exists", async () => {
    const { impl, calls } = makeFetch({});
    const outcome = await runHousingWebSearch(input(), { now: () => NOW, provider: null, fetchImpl: impl });
    expect(outcome.status).toBe("not_configured");
    expect(outcome.message).toBe("no_search_provider");
    expect(outcome.listings).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("surfaces tool_blocked when the subscription blocks the web_search tool — with real stats", async () => {
    const impl = vi.fn(async () =>
      Response.json({ error: "blocked" }, { status: 403 }),
    ) as unknown as typeof fetch;
    const outcome = await runHousingWebSearch(input(), { now: () => NOW, provider: AZURE, fetchImpl: impl });
    expect(outcome.status).toBe("tool_blocked");
    expect(outcome.listings).toEqual([]);
    // The failure path must report what actually happened (1 API call was made),
    // not a fabricated zero.
    expect(outcome.stats.searchCalls).toBe(1);
    expect(outcome.queries).toHaveLength(1);
  });
});

describe("general mode (web) — whole web, NOT allowlist-bound", () => {
  it("accepts valid listing URLs from NON-allowlisted domains (the 2026-10-10 fix)", async () => {
    const citations = [
      { url: IS24_A, title: "Titel A" },
      { url: IW_A, title: "Titel B" },
      { url: EXT_A, title: "Titel C (foreign portal)" },
      { url: EXT_B, title: "Titel D (foreign portal)" },
    ];
    const { impl } = makeFetch({ azure: [azurePayload(citations)] });
    const outcome = await runHousingWebSearch(input(), { now: () => NOW, provider: AZURE, fetchImpl: impl });

    expect(outcome.status).toBe("ok");
    expect(outcome.warnings).toEqual([]);
    // All 4 valid listings are shown — including the 2 off-allowlist portals.
    expect(outcome.listings).toHaveLength(4);
    expect(outcome.listings.map((l) => l.listing_url)).toEqual([
      "https://immobilienscout24.de/expose/123456789",
      "https://immowelt.de/expose/555555555",
      "https://immobiliensuche24.de/wohnung/111222333",
      "https://wohnbau-portal.de/apartments/444555666",
    ]);
    expect(outcome.funnel.offAllowlist).toBe(0); // web mode: allowlist not binding
    for (const l of outcome.listings) {
      expect(l.data_status).toBe("live");
      expect(l.provider).toBe("web-search");
      expect(l.verification_status).toBe("unverified");
      expect(l.source_type).toBe("web_search");
      expect(l.verified).toBe(false);
      expect(l.rent_cold_eur).toBeNull(); // never invented
      expect(l.last_checked_at).toBe(NOW_ISO);
      // No location evidence → explicitly unverified, NOT labelled "Köln".
      expect(l.city).toBe("");
      expect(l.city_unverified).toBe(true);
    }
  });

  it("still rejects legal pages, homepages and portal SEARCH-result pages (not individual listings)", async () => {
    const citations = [
      { url: IS24_A, title: "listing" },
      { url: "https://www.immobilienscout24.de/impressum", title: "legal page" },
      { url: "https://www.immobilienscout24.de/", title: "homepage" },
      { url: "https://www.immobilienscout24.de/immobilien/suche/wohnung-mieten/koeln", title: "search results" },
      { url: "https://www.immowelt.de/suche?query=koeln", title: "search w/ query" },
    ];
    const { impl } = makeFetch({ azure: [azurePayload(citations)] });
    const outcome = await runHousingWebSearch(input(), { now: () => NOW, provider: AZURE, fetchImpl: impl });
    expect(outcome.listings).toHaveLength(1);
    expect(outcome.listings[0].listing_url).toBe("https://immobilienscout24.de/expose/123456789");
    expect(outcome.funnel.searchPagesRejected).toBe(4);
    expect(outcome.warnings).toContain("candidates_dropped_search_pages=4");
  });

  it("dedupes the same listing (www / tracking params / http vs https)", async () => {
    const citations = [
      { url: IS24_A, title: "Titel A" },
      { url: "https://immobilienscout24.de/expose/123456789?utm_source=x&gclid=y", title: "dup" },
      { url: `http://www.immobilienscout24.de/expose/123456789#ref`, title: "dup2" },
      { url: IS24_B, title: "Titel B" },
      { url: IW_A, title: "Titel C" },
      { url: EXT_A, title: "Titel D" },
    ];
    const { impl } = makeFetch({ azure: [azurePayload(citations)] });
    const outcome = await runHousingWebSearch(input(), { now: () => NOW, provider: AZURE, fetchImpl: impl });
    const forA = outcome.listings.filter((l) => l.listing_url === "https://immobilienscout24.de/expose/123456789");
    expect(forA).toHaveLength(1);
    expect(forA[0].title).toBe("Titel A"); // first-seen citation wins
    expect(outcome.listings).toHaveLength(4);
    expect(outcome.funnel.duplicateResults).toBe(2);
  });

  it("does NOT stop at an arbitrary seven: returns every valid candidate (12 shown)", async () => {
    const citations = Array.from({ length: 12 }, (_, i) => ({
      url: `https://portal${i % 3}.de/expose/${100000000 + i}`,
      title: `Angebot ${i + 1}`,
    }));
    const { impl } = makeFetch({ azure: [azurePayload(citations)] });
    const outcome = await runHousingWebSearch(input(), { now: () => NOW, provider: AZURE, fetchImpl: impl });
    expect(outcome.listings).toHaveLength(12);
    // A rich first call (12 ≥ threshold) must NOT spend a second paid call.
    expect(outcome.stats.searchCalls).toBe(1);
    expect(outcome.funnel.displayedListings).toBe(12);
  });

  it("runs a SECOND (complementary) paid call only when the first call under-delivered (<8 candidates)", async () => {
    // Thin first call (3) + second call (2 new) → merged result set.
    const thin = makeFetch({
      azure: [
        azurePayload([{ url: IS24_A, title: "A" }, { url: IS24_B, title: "B" }, { url: IW_A, title: "C" }]),
        azurePayload([{ url: EXT_A, title: "D" }, { url: EXT_B, title: "E" }]),
      ],
    });
    const thinOutcome = await runHousingWebSearch(input(), { now: () => NOW, provider: AZURE, fetchImpl: thin.impl });
    expect(thinOutcome.stats.searchCalls).toBe(2);
    expect(thinOutcome.queries).toHaveLength(2);
    expect(thin.calls.filter((c) => c.url.endsWith("/responses"))).toHaveLength(2);
    expect(thinOutcome.listings).toHaveLength(5); // 3 + 2 merged, deduped
    // The two calls carry DIFFERENT complementary phrasings.
    const inputs = thin.calls
      .filter((c) => c.url.endsWith("/responses"))
      .map((c) => String(c.body?.input));
    expect(inputs[0]).toContain("Mietwohnung");
    expect(inputs[1]).toContain("Wohnung mieten");

    // Rich first call (8) → exactly one paid call (cost-aware).
    const richCitations = Array.from({ length: 8 }, (_, i) => ({
      url: `https://portal.de/expose/${200000000 + i}`,
      title: `R ${i}`,
    }));
    const rich = makeFetch({ azure: [azurePayload(richCitations)] });
    const richOutcome = await runHousingWebSearch(
      input({ params: { ...baseParams, city: "Leipzig" } }),
      { now: () => NOW, provider: AZURE, fetchImpl: rich.impl },
    );
    expect(richOutcome.cached).toBe(false);
    expect(richOutcome.stats.searchCalls).toBe(1);
    expect(rich.calls.filter((c) => c.url.endsWith("/responses"))).toHaveLength(1);
    expect(richOutcome.listings).toHaveLength(8);
  });

  it("keeps the first call's results when the SECOND call fails (partial success, honest warning)", async () => {
    const first = azurePayload([{ url: IS24_A, title: "A" }, { url: IW_A, title: "B" }]);
    const secondFails = new Response(JSON.stringify({ error: "boom" }), { status: 500 });
    // Only the second /responses call fails:
    let responsesSeen = 0;
    const impl2 = vi.fn(async (u: RequestInfo | URL) => {
      const url = String(u);
      if (url.endsWith("/responses")) {
        responsesSeen += 1;
        if (responsesSeen === 2) return secondFails;
        return Response.json(first);
      }
      return new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;
    const outcome = await runHousingWebSearch(input(), { now: () => NOW, provider: AZURE, fetchImpl: impl2 });
    expect(outcome.status).toBe("ok");
    expect(outcome.listings).toHaveLength(2);
    expect(outcome.warnings.some((w) => w.startsWith("second_call_failed:"))).toBe(true);
    expect(outcome.stats.searchCalls).toBe(2);
  });

  it("reports no_candidates_found when nothing usable is found", async () => {
    const { impl } = makeFetch({ azure: [azurePayload([{ url: "https://example.com/about", title: "x" }])] });
    const outcome = await runHousingWebSearch(input(), { now: () => NOW, provider: AZURE, fetchImpl: impl });
    expect(outcome.status).toBe("ok");
    expect(outcome.listings).toEqual([]);
    expect(outcome.warnings).toContain("no_candidates_found");
    // The funnel proves WHY (count-only): a candidate existed but was a non-listing page.
    expect(outcome.funnel.uniqueCandidates).toBe(1);
    expect(outcome.funnel.searchPagesRejected).toBe(1);
  });

  it("honors the request budget and stops processing beyond it", async () => {
    let tick = 0;
    const now = () => (tick++ === 0 ? NOW : NOW + 60_000); // past the 55 s budget
    const { impl } = makeFetch({
      azure: [
        azurePayload([
          { url: IS24_A, title: "A" },
          { url: IS24_B, title: "B" },
          { url: IW_A, title: "C" },
        ]),
      ],
    });
    const outcome = await runHousingWebSearch(input(), { now, provider: AZURE, fetchImpl: impl });
    expect(outcome.status).toBe("ok");
    expect(outcome.listings).toEqual([]);
    expect(outcome.warnings).toContain("request_timeout_budget");
  });
});

describe("location correctness (the 2026-10-10 Berlin→Frankfurt incident)", () => {
  it("a Berlin search REJECTS a Frankfurt listing and keeps unknown-location results flagged", async () => {
    const params = { ...baseParams, city: "Berlin" };
    const jsonText = JSON.stringify([
      { url: IS24_A, title: "3-Zi in Kreuzberg", city: "Berlin", rent_warm_eur: 1200, rooms: 3, living_area_sqm: 70, rent_cold_eur: null, additional_costs_eur: null, floor: null, available_from: null, furnished: null, source: "ImmoScout24" },
      { url: IW_A, title: "2-Zi in Sachsenhausen", city: "Frankfurt", rent_warm_eur: 1050, rooms: 2, living_area_sqm: 58, rent_cold_eur: null, additional_costs_eur: null, floor: null, available_from: null, furnished: null, source: "ImmoWelt" },
    ]);
    const { impl } = makeFetch({
      azure: [
        azurePayload(
          [
            { url: IS24_A, title: "3-Zi in Kreuzberg" },
            { url: IW_A, title: "2-Zi in Sachsenhausen" },
          ],
          jsonText,
          ["https://immonet.de/objekt/333333333"], // source-only, no location evidence
        ),
      ],
    });
    const outcome = await runHousingWebSearch(
      input({ params }),
      { now: () => NOW, provider: AZURE, fetchImpl: impl },
    );

    expect(outcome.status).toBe("ok");
    expect(outcome.listings).toHaveLength(2);
    // The Frankfurt listing is REJECTED — never shown as a Berlin result.
    expect(outcome.listings.every((l) => !l.listing_url.includes("555555555"))).toBe(true);
    expect(outcome.funnel.cityMismatches).toBe(1);
    expect(outcome.warnings).toContain("city_mismatch_rejected=1");

    const berlin = outcome.listings.find((l) => l.listing_url.includes("123456789"))!;
    expect(berlin.city).toBe("Berlin");
    expect(berlin.city_unverified).toBe(false);
    expect(berlin.rent_warm_eur).toBe(1200);

    // The evidence-free immonet link stays — but is flagged, never labelled "Berlin".
    const unknown = outcome.listings.find((l) => l.listing_url.includes("333333333"))!;
    expect(unknown.city).toBe("");
    expect(unknown.city_unverified).toBe(true);
  });

  it("does NOT reject unknown district names for the requested city (Neukölln ≈ Berlin)", async () => {
    const params = { ...baseParams, city: "Berlin" };
    const jsonText = JSON.stringify([
      { url: IS24_A, title: "Wohnung in Neukölln", city: "Neukölln", rent_warm_eur: 900, rooms: 1, living_area_sqm: 40, rent_cold_eur: null, additional_costs_eur: null, floor: null, available_from: null, furnished: null, source: null },
    ]);
    const { impl } = makeFetch({
      azure: [azurePayload([{ url: IS24_A, title: "Wohnung in Neukölln" }], jsonText)],
    });
    const outcome = await runHousingWebSearch(
      input({ params }),
      { now: () => NOW, provider: AZURE, fetchImpl: impl },
    );
    expect(outcome.funnel.cityMismatches).toBe(0);
    expect(outcome.listings).toHaveLength(1);
    // Shown with the evidence name + the unverified flag — not "Berlin".
    expect(outcome.listings[0].city).toBe("Neukölln");
    expect(outcome.listings[0].city_unverified).toBe(true);
  });

  it("city evidence from a FETCHED page confirms the requested city (postal code included)", async () => {
    const { impl } = makeFetch({
      azure: [azurePayload([{ url: NW_A, title: "Dataset Titel" }])],
      page: (url) => (url.startsWith(NW_A) ? listingPage() : null),
    });
    const outcome = await runHousingWebSearch(targeted(["open.nrw"]), {
      now: () => NOW,
      provider: AZURE,
      fetchImpl: impl,
    });
    const nrw = outcome.listings.find((l) => l.listing_url === NW_A)!;
    expect(nrw.city).toBe("Köln");
    expect(nrw.postal_code).toBe("50667");
    expect(nrw.city_unverified).toBe(false);
    expect(nrw.field_provenance?.city).toBe("page");
  });

  it("source-only candidates get an honest derived title, never 'Titel unbekannt'", async () => {
    const { impl } = makeFetch({
      azure: [azurePayload([], "Angebote.", ["https://wg-gesucht.de/2-zimmer-koeln-555555555.html"])],
    });
    const outcome = await runHousingWebSearch(input(), { now: () => NOW, provider: AZURE, fetchImpl: impl });
    expect(outcome.listings).toHaveLength(1);
    expect(outcome.listings[0].title).toBe("Anzeige auf wg-gesucht.de");
    expect(outcome.listings[0].title_is_fallback).toBe(true);
    // The URL slug contains the requested city → location confirmed.
    expect(outcome.listings[0].city).toBe("Köln");
    expect(outcome.listings[0].city_unverified).toBe(false);
  });
});

describe("structured JSON answer → per-listing fields (with fabrication guard)", () => {
  it("maps cited JSON items onto listings and drops invented URLs (fabrication guard)", async () => {
    const jsonText = JSON.stringify([
      {
        url: IS24_A,
        title: "2-Zi in Köln-Ehrenfeld",
        city: "Köln",
        rent_cold_eur: 850,
        rent_warm_eur: 1050,
        additional_costs_eur: 200,
        rooms: 2,
        living_area_sqm: 55,
        floor: "2. OG",
        available_from: "2026-12-01",
        furnished: false,
        source: "ImmoScout24",
      },
      { url: IW_A, title: null, city: null, rent_cold_eur: null, rent_warm_eur: null, rooms: null, living_area_sqm: null, floor: null, available_from: null, furnished: null, source: null },
      { url: "https://invented-portal.de/expose/777777777", title: "invented", city: "Köln", rent_warm_eur: 1000, rooms: 3, living_area_sqm: 70, floor: null, available_from: null, additional_costs_eur: null, furnished: null, source: "Fake" },
    ]);
    const { impl } = makeFetch({
      azure: [azurePayload([{ url: IS24_A, title: "Citation title" }, { url: IW_A, title: "IW" }], jsonText)],
    });
    const outcome = await runHousingWebSearch(input(), { now: () => NOW, provider: AZURE, fetchImpl: impl });

    expect(outcome.status).toBe("ok");
    expect(outcome.listings).toHaveLength(2); // the invented URL is NOT displayed
    expect(outcome.funnel.jsonItems).toBe(3);
    expect(outcome.funnel.jsonMatched).toBe(2);
    expect(outcome.funnel.fabricatedRejected).toBe(1);
    expect(outcome.funnel.detailsEnriched).toBe(1);
    expect(outcome.warnings).toContain("fabricated_urls_rejected=1");

    const is24 = outcome.listings.find((l) => l.listing_url.includes("123456789"))!;
    expect(is24.rent_cold_eur).toBe(850);
    expect(is24.rent_warm_eur).toBe(1050);
    expect(is24.additional_costs_eur).toBe(200);
    expect(is24.rooms).toBe(2);
    expect(is24.living_area_sqm).toBe(55);
    expect(is24.floor).toBe("2. OG");
    expect(is24.available_from).toBe("2026-12-01");
    expect(is24.furnished).toBe(false);
    expect(is24.source_label).toBe("ImmoScout24");
    expect(is24.city).toBe("Köln");
    expect(is24.city_unverified).toBe(false);
    // AI-extracted fields with a genuine citation = partially_verified, never "verified".
    expect(is24.verification_status).toBe("partially_verified");
    expect(is24.source_type).toBe("web_search");
    // Per-field provenance: everything came from the search result, not a page.
    expect(is24.field_provenance).toMatchObject({
      rent_cold_eur: "search",
      rent_warm_eur: "search",
      rooms: "search",
      living_area_sqm: "search",
      city: "search",
    });

    // The JSON-less citation keeps its title and stays unverified + unlocated.
    const iw = outcome.listings.find((l) => l.listing_url.includes("555555555"))!;
    expect(iw.title).toBe("IW");
    expect(iw.verification_status).toBe("unverified");
    expect(iw.city_unverified).toBe(true);
  });

  it("matches a RE-TRANSCRIBED URL via hostname + listing id (the 2026-10-10 field-loss fix)", async () => {
    // ImmoWelt serves the same listing at /expose/222222222 and /222222222.
    // Bing returned /expose/…; the model wrote /… in its JSON. The data must
    // still land on the real listing — and the display URL stays the one the
    // search tool returned.
    const jsonText = JSON.stringify([
      { url: "https://www.immowelt.de/222222222", title: "Helle 2-Zi. in Prenzlauer Berg", city: "Berlin", rent_cold_eur: 800, rent_warm_eur: 1000, rooms: 2, living_area_sqm: 50, floor: "1. OG", available_from: "2026-11-01", additional_costs_eur: 200, furnished: false, source: "ImmoWelt" },
    ]);
    const { impl } = makeFetch({
      azure: [
        azurePayload(
          [{ url: "https://www.immowelt.de/expose/222222222", title: "Helle 2-Zi. in Prenzlauer Berg" }],
          jsonText,
          ["https://www.immowelt.de/expose/222222222"],
        ),
      ],
    });
    const outcome = await runHousingWebSearch(
      input({ params: { ...baseParams, city: "Berlin" } }),
      { now: () => NOW, provider: AZURE, fetchImpl: impl },
    );
    expect(outcome.listings).toHaveLength(1);
    const l = outcome.listings[0];
    expect(l.listing_url).toBe("https://immowelt.de/expose/222222222"); // canonical link
    expect(l.rent_warm_eur).toBe(1000);
    expect(l.rent_cold_eur).toBe(800);
    expect(l.rooms).toBe(2);
    expect(l.living_area_sqm).toBe(50);
    expect(l.floor).toBe("1. OG");
    expect(l.available_from).toBe("2026-11-01");
    expect(l.city).toBe("Berlin");
    expect(l.city_unverified).toBe(false);
    expect(outcome.funnel.jsonMatched).toBe(1);
    expect(outcome.funnel.fabricatedRejected).toBe(0);
  });

  it("never matches a JSON url with a DIFFERENT listing id on the same host (no false merge)", async () => {
    const jsonText = JSON.stringify([
      // same host, DIFFERENT numeric id → not the returned listing
      { url: "https://www.immowelt.de/expose/999999999", title: "other apt", city: "Köln", rent_warm_eur: 1, rooms: 1, living_area_sqm: 1, rent_cold_eur: null, additional_costs_eur: null, floor: null, available_from: null, furnished: null, source: null },
    ]);
    const { impl } = makeFetch({
      azure: [azurePayload([{ url: IW_A, title: "IW" }], jsonText)],
    });
    const outcome = await runHousingWebSearch(input(), { now: () => NOW, provider: AZURE, fetchImpl: impl });
    expect(outcome.funnel.fabricatedRejected).toBe(1);
    expect(outcome.listings[0].rent_warm_eur).toBeNull();
    expect(outcome.listings[0].verification_status).toBe("unverified");
  });

  it("salvages a TRUNCATED JSON array and flags it", async () => {
    const truncatedText =
      '[{"url":"' + IS24_A + '","title":"A","rent_warm_eur":950,"rooms":2,"city":"Köln","rent_cold_eur":750,"additional_costs_eur":null,"living_area_sqm":50,"floor":null,"available_from":null,"furnished":null,"source":"IS24"},' +
      '{"url":"' + IW_A + '","title":"B","rent_warm_eur":880,"rooms":1,"city":"Köln","rent_cold_eur":null,"additional_costs_eur":null,"living_area_sqm":40,"floor":"EG","available_from":null,"furnished":true,"source":"IW"},' +
      '{"url":"https://trunc.de/expose/123,'; // cut mid-string
    const { impl } = makeFetch({
      azure: [azurePayload([{ url: IS24_A, title: "A" }, { url: IW_A, title: "B" }], truncatedText)],
    });
    const outcome = await runHousingWebSearch(input(), { now: () => NOW, provider: AZURE, fetchImpl: impl });
    expect(outcome.status).toBe("ok");
    expect(outcome.listings).toHaveLength(2);
    expect(outcome.warnings).toContain("json_truncated_salvaged");
    const is24 = outcome.listings.find((l) => l.listing_url.includes("123456789"))!;
    expect(is24.rent_warm_eur).toBe(950);
    expect(is24.verification_status).toBe("partially_verified");
  });

  it("falls back to citation-only listings when the model ignored the JSON contract", async () => {
    const prose =
      "Ich habe Wohnungen gefunden: " + IS24_A + " und " + IW_A + ". Beide scheinen aktuell ausstehend.";
    const { impl } = makeFetch({ azure: [azurePayload([{ url: IS24_A, title: "A" }, { url: IW_A, title: "B" }], prose)] });
    const outcome = await runHousingWebSearch(input(), { now: () => NOW, provider: AZURE, fetchImpl: impl });
    expect(outcome.status).toBe("ok");
    expect(outcome.listings).toHaveLength(2);
    expect(outcome.funnel.jsonItems).toBe(0);
    for (const l of outcome.listings) {
      expect(l.verification_status).toBe("unverified");
      expect(l.rent_warm_eur).toBeNull();
    }
  });

  it("never applies fields when ALL JSON URLs are invented (fields cleared, links kept)", async () => {
    const allInvented = JSON.stringify([
      { url: "https://invented.de/expose/11111111", title: "X", rent_warm_eur: 500, rooms: 1, city: null, rent_cold_eur: null, additional_costs_eur: null, living_area_sqm: null, floor: null, available_from: null, furnished: null, source: null },
      { url: "https://invented.de/expose/22222222", title: "Y", rent_warm_eur: 600, rooms: 2, city: null, rent_cold_eur: null, additional_costs_eur: null, living_area_sqm: null, floor: null, available_from: null, furnished: null, source: null },
    ]);
    const { impl } = makeFetch({
      azure: [azurePayload([{ url: IS24_A, title: "A" }], allInvented)],
    });
    const outcome = await runHousingWebSearch(input(), { now: () => NOW, provider: AZURE, fetchImpl: impl });
    expect(outcome.listings).toHaveLength(1); // only the real citation remains
    expect(outcome.listings[0].rent_warm_eur).toBeNull(); // invented fields NOT applied
    expect(outcome.funnel.fabricatedRejected).toBe(2);
    expect(outcome.funnel.jsonMatched).toBe(0);
  });
});

describe("targeted mode (selected websites remain binding)", () => {
  it("sends the domain restriction to the search API and never fetches search_only portals", async () => {
    const citations = [
      { url: IS24_A, title: "IS24 Titel" },
      { url: NW_A, title: "Dataset Titel" },
    ];
    const { impl, calls } = makeFetch({
      azure: [azurePayload(citations)],
      page: (url) => (url.startsWith(NW_A) ? listingPage() : null),
    });
    const outcome = await runHousingWebSearch(targeted(), { now: () => NOW, provider: AZURE, fetchImpl: impl });

    expect(outcome.status).toBe("ok");
    expect(outcome.stats).toEqual({ searchCalls: 1, pagesFetched: 1, bingRequests: 2 });

    // The API call carries the allowed_domains filter.
    const searchCall = calls.find((c) => c.url.endsWith("/responses"));
    const tool = (searchCall!.body!.tools as Array<Record<string, unknown>>)[0];
    expect(tool.filters).toEqual({
      allowed_domains: ["immobilienscout24.de", "open.nrw"],
    });

    const is24 = outcome.listings.find((l) => l.listing_url.includes("123456789"))!;
    expect(is24).toBeDefined();
    expect(is24.verification_status).toBe("unverified");
    expect(is24.source_type).toBe("web_search");
    // search_only portal: the user is told why we could not check the page.
    expect(is24.verification_notes).toBe("tos_no_fetch");

    // The IS24 URL must never have been fetched or robots-checked (ToS).
    expect(calls.some((c) => c.url.includes("immobilienscout24.de"))).toBe(false);

    const nrw = outcome.listings.find((l) => l.listing_url === NW_A)!;
    expect(nrw.verification_status).toBe("verified");
    expect(nrw.source_type).toBe("page_fetch");
    expect(nrw.verification_notes).toBe("page_fetched");
    expect(nrw.rent_cold_eur).toBe(850);
    expect(nrw.rooms).toBe(2);
    expect(nrw.living_area_sqm).toBe(55);
    expect(nrw.available_from).toBe("2025-12-01");
    expect(nrw.field_provenance).toMatchObject({ rent_cold_eur: "page", rooms: "page", city: "page" });
    expect(calls.some((c) => c.url === "https://open.nrw/robots.txt")).toBe(true);
  });

  it("bounds candidates to the selected domains (allowlist is binding) — unlike web mode", async () => {
    const citations = [
      { url: NW_A, title: "in" },
      { url: IS24_A, title: "not selected" },
      { url: EXT_A, title: "off allowlist" },
    ];
    const { impl } = makeFetch({ azure: [azurePayload(citations)] });
    const outcome = await runHousingWebSearch(targeted(["open.nrw"]), {
      now: () => NOW,
      provider: AZURE,
      fetchImpl: impl,
    });
    expect(outcome.listings.map((l) => l.listing_url)).toEqual([NW_A]);
    expect(outcome.funnel.offAllowlist).toBe(2);
    expect(outcome.warnings).toContain("candidates_dropped_off_allowlist=2");
  });

  it("discards a listing ONLY when the fetched page states it is already unavailable", async () => {
    const citations = [
      { url: NW_A, title: "expired" },
      { url: NW_B, title: "active" },
    ];
    const { impl } = makeFetch({
      azure: [azurePayload(citations)],
      page: (url) =>
        url.startsWith(NW_A) ? listingPage({ availableUntil: "2025-01-01" }) : listingPage({}),
    });
    const outcome = await runHousingWebSearch(targeted(["open.nrw"]), {
      now: () => NOW,
      provider: AZURE,
      fetchImpl: impl,
    });
    expect(outcome.listings.map((l) => l.listing_url)).toEqual([NW_B]);
    expect(outcome.warnings).toContain("expired_listing_discarded");
  });

  it("fails closed on robots.txt (disallowed → not fetched; broken → not fetched)", async () => {
    // Disallowed by robots.txt
    const blocked = makeFetch({
      azure: [azurePayload([{ url: NW_A, title: "x" }])],
      robots: () => new Response("User-agent: *\nDisallow: /dataset", { status: 200 }),
    });
    const blockedOutcome = await runHousingWebSearch(targeted(["open.nrw"]), {
      now: () => NOW,
      provider: AZURE,
      fetchImpl: blocked.impl,
    });
    expect(blockedOutcome.warnings).toContain("robots_blocked:open.nrw");
    expect(blockedOutcome.stats.pagesFetched).toBe(0);
    expect(blockedOutcome.listings).toHaveLength(1); // candidate stays, unverified
    expect(blockedOutcome.listings[0].verification_status).toBe("unverified");
    expect(blockedOutcome.listings[0].verification_notes).toBe("robots_blocked");
    expect(blocked.calls.some((c) => c.url === NW_A)).toBe(false);

    // Broken robots.txt (network failure) → unknown → also not fetched.
    clearWebSearchCache();
    clearRobotsCache();
    const broken = makeFetch({
      azure: [azurePayload([{ url: NW_A, title: "x" }])],
      robots: () => {
        throw new Error("network down");
      },
    });
    const brokenOutcome = await runHousingWebSearch(targeted(["open.nrw"]), {
      now: () => NOW,
      provider: AZURE,
      fetchImpl: broken.impl,
    });
    expect(brokenOutcome.warnings).toContain("robots_unknown:open.nrw");
    expect(brokenOutcome.stats.pagesFetched).toBe(0);
    expect(broken.calls.some((c) => c.url === NW_A)).toBe(false);
  });

  it("skips fetches when DNS resolves to a private address (SSRF defense in depth)", async () => {
    dnsLookup.mockImplementation(async (host) =>
      host === "open.nrw"
        ? [{ address: "192.168.0.10", family: 4 }]
        : [{ address: PUBLIC, family: 4 }],
    );
    const { impl, calls } = makeFetch({ azure: [azurePayload([{ url: NW_A, title: "x" }])] });
    const outcome = await runHousingWebSearch(targeted(["open.nrw"]), {
      now: () => NOW,
      provider: AZURE,
      fetchImpl: impl,
    });
    expect(outcome.warnings).toContain("unsafe_url_skipped:open.nrw");
    expect(outcome.stats.pagesFetched).toBe(0);
    expect(outcome.listings).toHaveLength(1); // still offered as an unverified link
    expect(outcome.listings[0].verification_status).toBe("unverified");
    expect(calls.some((c) => c.url === NW_A)).toBe(false);
  });

  it("caps page fetches at the per-request budget (3) without losing candidates", async () => {
    const citations = [
      { url: NW_A, title: "1" },
      { url: NW_B, title: "2" },
      { url: OD_A, title: "3" },
      { url: OD_B, title: "4" },
    ];
    const { impl } = makeFetch({ azure: [azurePayload(citations)], page: () => listingPage() });
    const outcome = await runHousingWebSearch(
      targeted(["open.nrw", "opendata.de"]),
      { now: () => NOW, provider: AZURE, fetchImpl: impl },
    );
    expect(outcome.stats.pagesFetched).toBe(3);
    expect(outcome.listings).toHaveLength(4);
    expect(outcome.warnings).toContain("fetch_budget_exhausted");
    const verified = outcome.listings.filter((l) => l.verification_status === "verified");
    expect(verified).toHaveLength(3);
  });

  it("treats a fetched page without structured facts as partially verified (existence only)", async () => {
    const { impl } = makeFetch({
      azure: [azurePayload([{ url: NW_A, title: "x" }])],
      page: () => new Response("<html><body>keine Daten</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    });
    const outcome = await runHousingWebSearch(targeted(["open.nrw"]), {
      now: () => NOW,
      provider: AZURE,
      fetchImpl: impl,
    });
    expect(outcome.listings).toHaveLength(1);
    expect(outcome.listings[0].verification_status).toBe("partially_verified");
    expect(outcome.listings[0].source_type).toBe("page_fetch");
    expect(outcome.listings[0].verification_notes).toBe("page_unstructured");
    expect(outcome.listings[0].rent_cold_eur).toBeNull();
  });
});

describe("funnel diagnostics (privacy-safe counters)", () => {
  it("reports count-only funnel numbers and never URLs or response text", async () => {
    const citations = [
      { url: IS24_A, title: "A" },
      { url: "https://immobilienscout24.de/impressum", title: "legal" },
      { url: "not a url", title: "bad" },
      { url: IW_A, title: "B" },
    ];
    // IW_A also arrives via action.sources → counted as a cross-source duplicate.
    // Two IDENTICAL payloads: the second call repeats everything, so the
    // funnel must count every occurrence (raw) while deduping for display.
    const payload = azurePayload(citations, "Angebote.", [IW_A]);
    const { impl } = makeFetch({ azure: [payload, payload] });
    const outcome = await runHousingWebSearch(input(), { now: () => NOW, provider: AZURE, fetchImpl: impl });
    expect(outcome.funnel).toMatchObject({
      providerCalls: 2, // 2 valid candidates < 8 → second call runs
      webSearchCalls: 2,
      rawCandidates: 10, // (4 citations + 1 source) × 2 identical calls
      uniqueCandidates: 3, // IS24_A, impressum, IW_A ("not a url" unparseable)
      invalidUrls: 2, // the invalid URL is reported by every call
      searchPagesRejected: 2, // the legal page is reported by every call
      duplicateResults: 4, // IS24_A ×1 + IW_A ×3 (repeat citation + 2× sources)
      cityMismatches: 0,
      displayedListings: 2,
    });
    // No warning may carry a URL or listing text (safe logs contract).
    for (const w of outcome.warnings) {
      expect(w).not.toMatch(/https?:\/\//);
    }
  });
});

describe("Azure-only provider enforcement (no Tavily fallback)", () => {
  it("resolves to azure via the real resolver even when TAVILY_API_KEY is present", async () => {
    vi.stubEnv("HOUSING_WEB_SEARCH", "");
    vi.stubEnv("AZURE_WEB_SEARCH_ENDPOINT", "https://res.openai.azure.com/openai/v1");
    vi.stubEnv("AZURE_WEB_SEARCH_KEY", "azure-test-key");
    vi.stubEnv("AZURE_WEB_SEARCH_MODEL", "gpt-5-mini");
    vi.stubEnv("TAVILY_API_KEY", "tvly-test-key");
    const richCitations = Array.from({ length: 8 }, (_, i) => ({
      url: `https://portal.de/expose/${300000000 + i}`,
      title: `R ${i}`,
    }));
    const { impl, calls } = makeFetch({ azure: [azurePayload(richCitations)] });

    // No `provider` dep injected → resolveSearchProvider() runs for real.
    const outcome = await runHousingWebSearch(input(), { now: () => NOW, fetchImpl: impl });

    expect(outcome.status).toBe("ok");
    expect(outcome.provider).toBe("azure");
    // The paid call went to the Foundry Responses endpoint with the
    // documented body (deployment name + hosted web_search tool; general
    // mode also carries user_location for the German/city bias).
    const body = calls.find((c) => c.url.endsWith("/responses"))!.body!;
    expect(body.model).toBe("gpt-5-mini");
    expect(body.tools).toHaveLength(1);
    expect((body.tools as Array<Record<string, unknown>>)[0]).toMatchObject({
      type: "web_search",
      user_location: { country: "DE", city: "Köln" },
    });
    // Housing must NEVER touch the shared Tavily client.
    expect(getWebSearchClient).not.toHaveBeenCalled();
  });

  it("returns not_configured (no network call) when Azure is missing, even with TAVILY_API_KEY present", async () => {
    vi.stubEnv("HOUSING_WEB_SEARCH", "azure");
    vi.stubEnv("AZURE_WEB_SEARCH_ENDPOINT", "");
    vi.stubEnv("AZURE_WEB_SEARCH_KEY", "");
    vi.stubEnv("AZURE_WEB_SEARCH_MODEL", "");
    vi.stubEnv("AI_API_URL", "");
    vi.stubEnv("AI_API_KEY", "");
    vi.stubEnv("AI_MODEL", "");
    vi.stubEnv("TAVILY_API_KEY", "tvly-test-key");
    const { impl, calls } = makeFetch({});

    const outcome = await runHousingWebSearch(input(), { now: () => NOW, fetchImpl: impl });

    expect(outcome.status).toBe("not_configured");
    expect(outcome.provider).toBeNull();
    expect(calls).toEqual([]); // no paid call of any kind
    expect(getWebSearchClient).not.toHaveBeenCalled();
  });

  it("treats a non-Foundry endpoint (OpenAI standard API) as not_configured, never as Azure", async () => {
    vi.stubEnv("HOUSING_WEB_SEARCH", "azure");
    vi.stubEnv("AZURE_WEB_SEARCH_ENDPOINT", "https://api.openai.com/v1");
    vi.stubEnv("AZURE_WEB_SEARCH_KEY", "azure-test-key");
    vi.stubEnv("AZURE_WEB_SEARCH_MODEL", "gpt-5-mini");
    vi.stubEnv("TAVILY_API_KEY", "tvly-test-key");
    const { impl, calls } = makeFetch({});

    const outcome = await runHousingWebSearch(input(), { now: () => NOW, fetchImpl: impl });

    expect(outcome.status).toBe("not_configured");
    expect(calls).toEqual([]); // malformed config fails safe BEFORE any paid call
  });

  it("ignores HOUSING_WEB_SEARCH=tavily (azure when ready, null otherwise — never tavily)", async () => {
    vi.stubEnv("HOUSING_WEB_SEARCH", "tavily");
    vi.stubEnv("TAVILY_API_KEY", "tvly-test-key");
    vi.stubEnv("AZURE_WEB_SEARCH_ENDPOINT", "");
    vi.stubEnv("AZURE_WEB_SEARCH_KEY", "");
    vi.stubEnv("AZURE_WEB_SEARCH_MODEL", "");
    vi.stubEnv("AI_API_URL", "");
    vi.stubEnv("AI_API_KEY", "");
    vi.stubEnv("AI_MODEL", "");
    expect(resolveSearchProvider()).toBeNull();

    vi.stubEnv("AZURE_WEB_SEARCH_ENDPOINT", "https://res.openai.azure.com/openai/v1");
    vi.stubEnv("AZURE_WEB_SEARCH_KEY", "azure-test-key");
    vi.stubEnv("AZURE_WEB_SEARCH_MODEL", "gpt-5-mini");
    expect(resolveSearchProvider()).toMatchObject({ kind: "azure" });
  });
});

describe("caching and budgets", () => {
  it("serves identical repeat searches from the in-memory cache (no second paid call)", async () => {
    const { impl, calls } = makeFetch({ azure: [azurePayload([{ url: IS24_A, title: "A" }])] });
    const deps = { now: () => NOW, provider: AZURE, fetchImpl: impl };
    const first = await runHousingWebSearch(input({ mode: "targeted" }), deps);
    const second = await runHousingWebSearch(input({ mode: "targeted" }), deps);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.listings).toEqual(first.listings);
    expect(calls.filter((c) => c.url.endsWith("/responses"))).toHaveLength(1);
  });

  it("does not serve a different search from the cache", async () => {
    const { impl, calls } = makeFetch({
      azure: [
        azurePayload([{ url: IS24_A, title: "A" }]),
        azurePayload([{ url: IS24_B, title: "B" }]),
      ],
    });
    await runHousingWebSearch(input(), { now: () => NOW, provider: AZURE, fetchImpl: impl });
    const other = await runHousingWebSearch(input({ params: { ...baseParams, city: "Berlin" } }), {
      now: () => NOW,
      provider: AZURE,
      fetchImpl: impl,
    });
    expect(other.cached).toBe(false);
    expect(calls.filter((c) => c.url.endsWith("/responses")).length).toBeGreaterThanOrEqual(2);
  });
});

describe("request budget constant sanity", () => {
  it("the two-call strategy fits the whole-request budget and maxDuration", () => {
    // Worst case: call 1 at full searchTimeoutMs + call 2 capped by the
    // remaining budget → total ≤ requestTimeoutMs < maxDuration (60 s),
    // with headroom for serialization + response.
    const worstCase =
      LIMITS.searchTimeoutMs +
      Math.min(LIMITS.searchTimeoutMs, LIMITS.requestTimeoutMs - LIMITS.searchTimeoutMs);
    expect(worstCase).toBeLessThanOrEqual(LIMITS.requestTimeoutMs);
    expect(LIMITS.requestTimeoutMs + 5_000).toBeLessThanOrEqual(60_000);
    expect(LIMITS.webModeSecondCallThreshold).toBeLessThanOrEqual(8);
  });
});
