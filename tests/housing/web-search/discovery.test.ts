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
  citations: Array<{ url: string; title: string; image?: string }>,
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
    // 4 DISTINCT pages rejected (legal / homepage / 2× search-result pages).
    expect(outcome.funnel.searchPagesRejected).toBe(4);
    expect(outcome.funnel.uniqueSearchPages).toBe(4);
    expect(outcome.warnings).toContain("candidates_dropped_search_pages=4 unique=4");
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
    // Specific type → exactly ONE complementary query (primary + alt
    // phrasing) — deterministic call count.
    // Thin first call (3) + second call (2 new) → merged result set.
    const thin = makeFetch({
      azure: [
        azurePayload([{ url: IS24_A, title: "A" }, { url: IS24_B, title: "B" }, { url: IW_A, title: "C" }]),
        azurePayload([{ url: EXT_A, title: "D" }, { url: EXT_B, title: "E" }]),
      ],
    });
    const thinOutcome = await runHousingWebSearch(
      input({ params: { ...baseParams, accommodation_type: "apartment" } }),
      { now: () => NOW, provider: AZURE, fetchImpl: thin.impl },
    );
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

  it("'all' type runs the MULTI-QUERY families (apartment / WG / student / private rental) with bounded calls", async () => {
    // Primary call returns 2 candidates (< threshold) → the bounded-
    // parallelism pool issues the complementary family calls. With an
    // exhausted queue the complements return nothing new → the pool stops
    // after the first wave: exactly 1 primary + 2 parallel calls.
    const { impl, calls } = makeFetch({
      azure: [azurePayload([{ url: IS24_A, title: "A" }, { url: IW_A, title: "B" }])],
    });
    const outcome = await runHousingWebSearch(input(), { now: () => NOW, provider: AZURE, fetchImpl: impl });
    expect(outcome.status).toBe("ok");
    expect(outcome.listings).toHaveLength(2);
    expect(outcome.stats.searchCalls).toBe(3); // 1 primary + 2 parallel complements (stall-stop)
    expect(outcome.stats.searchCalls).toBeLessThanOrEqual(LIMITS.maxSearchCallsPerRun);
    const inputs = calls
      .filter((c) => c.url.endsWith("/responses"))
      .map((c) => String(c.body?.input));
    expect(inputs[0]).toContain("Mietwohnung"); // family 1: apartments
    expect(inputs[1]).toContain("WG-Zimmer"); // family 2: shared rooms
    expect(inputs[2]).toContain("Studentenwohnung"); // family 3: student housing
  });

  it("keeps the first call's results when a COMPLEMENTARY call fails (partial success, honest warning)", async () => {
    const first = azurePayload([{ url: IS24_A, title: "A" }, { url: IW_A, title: "B" }]);
    const secondFails = new Response(JSON.stringify({ error: "boom" }), { status: 500 });
    // Specific type → exactly one complementary call (deterministic).
    // Only that /responses call fails:
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
    const outcome = await runHousingWebSearch(
      input({ params: { ...baseParams, accommodation_type: "apartment" } }),
      { now: () => NOW, provider: AZURE, fetchImpl: impl2 },
    );
    expect(outcome.status).toBe("ok");
    expect(outcome.listings).toHaveLength(2);
    expect(outcome.warnings.some((w) => w.startsWith("complementary_call_failed:"))).toBe(true);
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

  it("honors the request budget: no COMPLEMENTARY call is issued once the deadline is exhausted", async () => {
    // The primary call "consumes" the whole budget (clock jumps past the
    // deadline inside the mock) — the pool must then issue no further
    // paid calls and the enrichment loop must stop.
    let t = NOW;
    const now = () => t;
    const impl = vi.fn(async (u: RequestInfo | URL) => {
      const url = String(u);
      if (url.endsWith("/responses")) {
        t = NOW + 60_000; // past the 55 s request budget
        return Response.json(azurePayload([{ url: IS24_A, title: "A" }]));
      }
      return new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;
    const outcome = await runHousingWebSearch(input(), { now, provider: AZURE, fetchImpl: impl });
    expect(outcome.status).toBe("ok");
    expect(outcome.listings).toEqual([]);
    expect(outcome.warnings).toContain("request_timeout_budget");
    // EXACTLY one paid call — the budget-exhausted deadline blocked the pool.
    expect(outcome.stats.searchCalls).toBe(1);
  });

  it("answers an honest 'timeout' (no paid call) when the deadline has no room for the PRIMARY call", async () => {
    // The clock jumps past the budget between pipeline start and the issue
    // check (e.g. slow provider resolution): a call issued now could not
    // finish inside the route's maxDuration — do not spend the money on a
    // guaranteed-aborted request.
    let n = 0;
    // 1st now() = pipeline start; every later read (incl. the issue check)
    // is already past the 55 s budget.
    const now = () => (n++ === 0 ? NOW : NOW + 60_000);
    const impl = vi.fn(async () => {
      // Any call reaching the provider would prove the guard failed.
      throw new Error("no paid call may be issued after the deadline guard");
    }) as unknown as typeof fetch;
    const outcome = await runHousingWebSearch(input(), { now, provider: AZURE, fetchImpl: impl });
    expect(outcome.status).toBe("timeout");
    expect(outcome.stats.searchCalls).toBe(0);
    expect(outcome.listings).toEqual([]);
    expect(impl).not.toHaveBeenCalled();
  });
});

describe("regression: representative German result set (28 results in, no silent losses)", () => {
  // The 2026-10-10 search-quality incident: a 28-result Bing run displayed
  // 0 listings and "34 excluded portal pages" (an occurrence count that
  // exceeded the number of results). This fixture reproduces the shape of
  // such a run — a mix of valid direct listings, portal homepages/search
  // pages, legal pages, media articles, duplicates and a missing-optional-
  // field listing — and proves every url lands in exactly one honest bucket.
  const listings: Array<{ url: string; title: string }> = [
    { url: "https://www.immobilienscout24.de/expose/111100001", title: "3-Zi in Ehrenfeld" },
    { url: "https://www.immobilienscout24.de/expose/111100002", title: "2-Zi in Sülz" },
    { url: "https://www.immowelt.de/expose/222200001", title: "2-Zi in Mülheim" },
    { url: "https://www.wg-gesucht.de/rooms/12345678/koeln/", title: "Zimmer in WG, Longerich" },
    { url: "https://www.kleinanzeigen.de/s-2-zimmer-wohnung-mieten/c20-123456789/", title: "2-Zi WG-Zimmer" },
    { url: "https://open.nrw/dataset/wohnungen-koeln", title: "Wohnungen Köln (Open Data)" },
    { url: "https://immobilien-suche.de/wohnung/999000111", title: "3-Zi in Nippes" },
    { url: "https://wg-haus.de/apartments/888000222", title: "4-Zi in Rodenkirchen" },
    { url: "https://privat-mieten-koeln.de/2-zimmer-sued-kasten", title: "2-Zi vom Eigentümer" },
    { url: "https://mietangebote-koeln.de/123456789", title: "1-Zi in Lindenthal" },
    { url: "https://www.immowelt.de/expose/222200002", title: "1-Zi in Kalk" },
    { url: "https://www.immobilienscout24.de/expose/111100003", title: "4-Zi in Buchforst" },
  ];
  const nonListings: Array<{ url: string; title: string }> = [
    { url: "https://www.immobilienscout24.de/", title: "IS24 Start" },
    { url: "https://www.immobilienscout24.de/immobilien/suche/wohnung-mieten/koeln", title: "IS24 Suche" },
    { url: "https://www.immowelt.de/", title: "IW Start" },
    { url: "https://www.immowelt.de/suche?query=koeln", title: "IW Suche" },
    { url: "https://www.wg-gesucht.de/wohnungsangebote/koeln/", title: "WG-Gesucht Übersicht" },
    { url: "https://www.immobilienscout24.de/impressum", title: "Impressum" },
    { url: "https://www.immobilienscout24.de/datenschutz", title: "Datenschutz" },
    { url: "https://www.faz.net/aktuell/wirtschaft/immobilien/mieten-in-koeln-1790123456.html", title: "FAZ: Mieten in Köln (Analyse)" },
    { url: "https://www.welt.de/immobilien/wohnen-in-koeln-geworden.html", title: "WELT: Wohnen in Köln" },
    { url: "https://wohnungsbau-berichte.de/bericht/koeln-2026", title: "Wohnungsbericht Köln" },
    { url: "https://www.immonet.de/", title: "Immonet Start" },
    { url: "https://www.kleinanzeigen.de/s-wohnung-mieten/koeln", title: "Kleinanzeigen Suche" },
  ];

  /** Minimal mirror of the pipeline's URL normalization for expected values. */
  function normalizeForExpect(raw: string): string {
    const u = new URL(raw);
    u.hash = "";
    u.hostname = u.hostname.replace(/^www\./, "");
    return u.toString().replace(/^http:/, "https:");
  }
  const jsonText = JSON.stringify([
    { url: "https://www.immobilienscout24.de/expose/111100001", title: "3-Zi in Ehrenfeld", city: "Köln", rent_cold_eur: 700, rent_warm_eur: 750, additional_costs_eur: null, rooms: 3, living_area_sqm: 72, floor: null, available_from: null, furnished: null, source: "ImmoScout24" },
    { url: "https://www.immobilienscout24.de/expose/111100002", title: "2-Zi in Sülz", city: "Köln", rent_cold_eur: 640, rent_warm_eur: 690, additional_costs_eur: null, rooms: 2, living_area_sqm: null, floor: null, available_from: null, furnished: null, source: "ImmoScout24" },
    { url: "https://www.immowelt.de/expose/222200001", title: "2-Zi in Mülheim", city: "Köln", rent_cold_eur: null, rent_warm_eur: 720, additional_costs_eur: null, rooms: 2, living_area_sqm: 55, floor: null, available_from: null, furnished: null, source: "ImmoWelt" },
    { url: "https://www.kleinanzeigen.de/s-2-zimmer-wohnung-mieten/c20-123456789/", title: "2-Zi WG-Zimmer", city: "Köln", rent_cold_eur: null, rent_warm_eur: 650, additional_costs_eur: null, rooms: 1, living_area_sqm: null, floor: null, available_from: null, furnished: true, source: "Kleinanzeigen" },
    { url: "https://immobilien-suche.de/wohnung/999000111", title: "3-Zi in Nippes", city: "Köln", rent_cold_eur: 660, rent_warm_eur: 700, additional_costs_eur: null, rooms: 3, living_area_sqm: 68, floor: null, available_from: null, furnished: null, source: "Immobilien-Suche" },
    { url: "https://privat-mieten-koeln.de/2-zimmer-sued-kasten", title: "2-Zi vom Eigentümer", city: "Köln", rent_cold_eur: 730, rent_warm_eur: 780, additional_costs_eur: null, rooms: 2, living_area_sqm: 58, floor: null, available_from: null, furnished: null, source: "Privat" },
    { url: "https://mietangebote-koeln.de/123456789", title: "1-Zi in Lindenthal", city: "Köln", rent_cold_eur: null, rent_warm_eur: 600, additional_costs_eur: null, rooms: 1, living_area_sqm: 32, floor: null, available_from: null, furnished: null, source: "Mietangebote" },
    { url: "https://www.immowelt.de/expose/222200002", title: "1-Zi in Kalk", city: "Köln", rent_cold_eur: 560, rent_warm_eur: 620, additional_costs_eur: null, rooms: 1, living_area_sqm: 40, floor: null, available_from: null, furnished: null, source: "ImmoWelt" },
    { url: "https://www.immobilienscout24.de/expose/111100003", title: "4-Zi in Buchforst", city: "Köln", rent_cold_eur: 700, rent_warm_eur: 780, additional_costs_eur: null, rooms: 4, living_area_sqm: 95, floor: null, available_from: null, furnished: null, source: "ImmoScout24" },
  ]);

  function allCitations(): Array<{ url: string; title: string }> {
    // 28 results: 12 listings + 12 non-listings + 3 duplicates + 1 garbage.
    return [
      ...listings,
      ...nonListings,
      { url: "https://www.immobilienscout24.de/expose/111100001?utm_source=x&gclid=y", title: "dup 1" },
      { url: "http://www.immowelt.de/expose/222200001#ref", title: "dup 2" },
      { url: "https://open.nrw/dataset/wohnungen-koeln?utm_source=mail", title: "dup 3" },
      { url: "keine url", title: "garbage" },
    ];
  }
  // The provider also echoes two of the same URLs in `action.sources` — the
  // real mechanism behind the production "28 results → 34 excluded"
  // arithmetic: the parser dedupes WITHIN one call's citations, but the same
  // url arriving in citations AND sources (or in two calls) counts twice as
  // an occurrence while remaining ONE distinct result.
  const echoSources = [
    "https://www.faz.net/aktuell/wirtschaft/immobilien/mieten-in-koeln-1790123456.html",
    "https://www.immobilienscout24.de/expose/111100001",
  ];

  it("keeps every valid direct listing and puts every other URL into exactly one honest bucket", async () => {
    expect(allCitations()).toHaveLength(28);
    const { impl } = makeFetch({ azure: [azurePayload(allCitations(), jsonText, echoSources)] });
    const outcome = await runHousingWebSearch(input(), { now: () => NOW, provider: AZURE, fetchImpl: impl });

    expect(outcome.status).toBe("ok");
    // 12 valid listings — including the slugged no-id listing and the
    // bare-id listing that ONLY the model's JSON reference keeps.
    expect(outcome.listings).toHaveLength(12);
    const shown = new Set(outcome.listings.map((l) => l.listing_url));
    for (const { url } of listings) expect(shown.has(normalizeForExpect(url))).toBe(true);
    // Media articles / reports / homepages / search pages: never shown.
    for (const { url } of nonListings) expect(shown.has(normalizeForExpect(url))).toBe(false);
    expect(shown.has("https://www.faz.net/aktuell/wirtschaft/immobilien/mieten-in-koeln-1790123456.html")).toBe(false);

    // The funnel accounts for EVERY push (28 citations + 2 source echoes =
    // 30), each in exactly one bucket — no silent loss, no double counting:
    //   12 kept + 9 portal/search/legal pages + 4 content-page occurrences
    //   (3 distinct — the FAZ article arrives via citation AND source)
    //   + 4 duplicate occurrences (3 citation variants + 1 source echo)
    //   + 1 invalid = 30.
    expect(outcome.funnel).toMatchObject({
      rawCandidates: 30,
      uniqueCandidates: 24, // 12 listings + 12 non-listings (distinct)
      invalidUrls: 1,
      duplicateResults: 4,
      searchPagesRejected: 9,
      uniqueSearchPages: 9,
      contentRejected: 4,
      jsonOnlyKept: 2, // slugged no-id + bare-id kept via the model's JSON
      cityMismatches: 0,
      validListings: 12,
      displayedListings: 12,
    });
    // Rich primary result (12 ≥ 8) → the bounded pool never spends a 2nd call.
    expect(outcome.stats.searchCalls).toBe(1);
    // The JSON named exactly 9 offers, all matched real results (no fabrication).
    expect(outcome.funnel.jsonItems).toBe(9);
    expect(outcome.funnel.jsonMatched).toBe(9);
    expect(outcome.funnel.fabricatedRejected).toBe(0);
  });

  it("does NOT discard a genuine listing for missing optional fields (no area/price/image)", async () => {
    const { impl } = makeFetch({ azure: [azurePayload(allCitations(), jsonText, echoSources)] });
    const outcome = await runHousingWebSearch(input(), { now: () => NOW, provider: AZURE, fetchImpl: impl });
    const sulz = outcome.listings.find(
      (l) => l.listing_url === "https://immobilienscout24.de/expose/111100002",
    );
    expect(sulz).toBeDefined(); // missing optional fields never reject
    expect(sulz!.rent_warm_eur).toBe(690);
    expect(sulz!.living_area_sqm).toBeNull(); // honestly unknown
    expect(sulz!.images).toEqual([]);
    expect("image_url" in (sulz! as object)).toBe(false); // never a fake photo
    expect(sulz!.verification_status).toBe("partially_verified");
    // And the WG room with NO model JSON at all stays in as a real citation.
    const wg = outcome.listings.find(
      (l) => l.listing_url === "https://wg-gesucht.de/rooms/12345678/koeln/",
    );
    expect(wg).toBeDefined();
    expect(wg!.rent_warm_eur).toBeNull();
    expect(wg!.verification_status).toBe("unverified");
    expect(wg!.verification_notes).toBe("tos_no_fetch");
  });

  it("reports WHY each bucket dropped results (count-only warnings, no URLs)", async () => {
    const { impl } = makeFetch({ azure: [azurePayload(allCitations(), jsonText, echoSources)] });
    const outcome = await runHousingWebSearch(input(), { now: () => NOW, provider: AZURE, fetchImpl: impl });
    expect(outcome.warnings).toContain("candidates_dropped_search_pages=9 unique=9");
    expect(outcome.warnings).toContain("candidates_dropped_non_listing_content=4");
    expect(outcome.warnings).toContain("candidates_kept_via_json_reference=2");
    expect(outcome.warnings).toContain("candidates_dropped_invalid_url=1");
    for (const w of outcome.warnings) {
      expect(w).not.toMatch(/https?:\/\//);
      expect(w).not.toContain("Ehrenfeld");
    }
  });

  it("zero-result scenario: everything is a search/portal page or article → honest empty with the funnel proof", async () => {
    // 12 distinct non-listings as citations + the first 5 echoed in sources
    // (occurrence inflation: 14 portal-page occurrences, 9 distinct).
    const pageSources = nonListings.slice(0, 5).map((x) => x.url);
    const { impl } = makeFetch({
      azure: [azurePayload(nonListings, "Keine konkreten Angebote gefunden.", pageSources)],
    });
    const outcome = await runHousingWebSearch(input(), { now: () => NOW, provider: AZURE, fetchImpl: impl });
    expect(outcome.status).toBe("ok");
    expect(outcome.listings).toEqual([]);
    expect(outcome.warnings).toContain("no_candidates_found");
    // The funnel PROVES the cause: 12 distinct results — 9 search/portal
    // pages (14 occurrences via the source echoes) + 3 content pages.
    // NOT one silent loss.
    expect(outcome.funnel.rawCandidates).toBe(17);
    expect(outcome.funnel.uniqueCandidates).toBe(12);
    expect(outcome.funnel.uniqueSearchPages).toBe(9);
    expect(outcome.funnel.searchPagesRejected).toBe(14); // 9 distinct + 5 echoes
    expect(outcome.funnel.contentRejected).toBe(3);
    expect(outcome.funnel.displayedListings).toBe(0);
  });

  it("zero-result scenario: the model declines to search (no web_search call in the primary) → named warning", async () => {
    // No web_search_call action at all in the primary output:
    const noCall = {
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Ich habe nicht gesucht." }],
        },
      ],
    };
    const { impl } = makeFetch({ azure: [noCall as unknown as Record<string, unknown>] });
    const outcome = await runHousingWebSearch(input(), { now: () => NOW, provider: AZURE, fetchImpl: impl });
    expect(outcome.status).toBe("ok");
    expect(outcome.listings).toEqual([]);
    expect(outcome.warnings).toContain("azure_no_web_search_call");
    expect(outcome.warnings).toContain("no_candidates_found");
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
    // The Berlin listing stays. The Frankfurt listing is REJECTED (city
    // mismatch) — never shown as a Berlin result. The source-only immonet
    // link has NO title anywhere (no citation title, no JSON) — it is
    // rejected and counted: a generic "Anzeige auf <host>" label must never
    // be presented as a listing.
    expect(outcome.listings).toHaveLength(1);
    expect(outcome.listings.every((l) => !l.listing_url.includes("555555555"))).toBe(true);
    expect(outcome.listings.every((l) => !l.listing_url.includes("333333333"))).toBe(true);
    expect(outcome.funnel.cityMismatches).toBe(1);
    expect(outcome.funnel.untitledRejected).toBe(1);
    expect(outcome.warnings).toContain("city_mismatch_rejected=1");
    expect(outcome.warnings).toContain("candidates_dropped_untitled=1");

    const berlin = outcome.listings.find((l) => l.listing_url.includes("123456789"))!;
    expect(berlin.city).toBe("Berlin");
    expect(berlin.city_unverified).toBe(false);
    expect(berlin.rent_warm_eur).toBe(1200);
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

  it("source-only candidates WITHOUT any title are rejected + counted (no generic host labels)", async () => {
    const { impl } = makeFetch({
      azure: [azurePayload([], "Angebote.", ["https://wg-gesucht.de/2-zimmer-koeln-555555555.html"])],
    });
    const outcome = await runHousingWebSearch(input(), { now: () => NOW, provider: AZURE, fetchImpl: impl });
    expect(outcome.status).toBe("ok");
    expect(outcome.listings).toEqual([]);
    expect(outcome.funnel.untitledRejected).toBe(1);
    expect(outcome.warnings).toContain("candidates_dropped_untitled=1");
    // A zero-valid-listing outcome is NEVER cached — the identical repeat
    // search must run the provider again (no "bad result on repeat").
    const again = await runHousingWebSearch(input(), { now: () => NOW, provider: AZURE, fetchImpl: impl });
    expect(again.cached).toBe(false);
    expect(again.listings).toEqual([]);
  });

  it("an untitled candidate is rescued by the fetched page's own <title> (page-derived, marked as fallback)", async () => {
    const { impl } = makeFetch({
      azure: [azurePayload([], "Angebote.", [NW_A])],
      page: (url) =>
        url.startsWith(NW_A)
          ? new Response(
              `<html><head><title>Mietwohnung in Köln – offen</title></head><body><script type="application/ld+json">${JSON.stringify({
                "@context": "https://schema.org",
                "@type": "Apartment",
                numRooms: 2,
                address: { addressLocality: "Köln", postalCode: "50667" },
              })}</script></body></html>`,
              { status: 200, headers: { "content-type": "text/html" } },
            )
          : null,
    });
    const outcome = await runHousingWebSearch(input(), { now: () => NOW, provider: AZURE, fetchImpl: impl });
    expect(outcome.status).toBe("ok");
    expect(outcome.listings).toHaveLength(1);
    expect(outcome.listings[0].title).toBe("Mietwohnung in Köln – offen");
    // Page-derived <title> is a REAL (not invented) title — but it is the
    // document title, so the UI marks it as derived.
    expect(outcome.listings[0].title_is_fallback).toBe(true);
    expect(outcome.funnel.untitledRejected).toBe(0);
  });
});

describe("evidence-based acceptance (the 2026-10-10 'Anzeige auf <host>' defect)", () => {
  const SALE_URL = "https://kauf-immo.de/wohnung/42424242";
  const RENTAL_URL = "https://miet-immo.de/wohnung/43434343";
  // Bare numeric id, no listing vocabulary → on unreviewed domains this is
  // `direct_listing_id`: kept ONLY with substantive JSON evidence.
  const RESCUE_URL = "https://miet-immo.de/2-zimmer-koeln/43434343.html";

  it("a JSON rescue requires SUBSTANTIVE property fields (title-only JSON does not rescue a page)", async () => {
    // The model names a generic portal page with only a title — NOT an
    // individual offer. Old behavior: rescued via the exact-URL JSON match
    // and shown as a listing. Now: rejected as non-listing content.
    const titleOnlyJson = JSON.stringify([
      { url: "https://immobilien.de/wohnungen-koeln", title: "Wohnungen Köln", city: "Köln", rent_cold_eur: null, rent_warm_eur: null, additional_costs_eur: null, rooms: null, living_area_sqm: null, floor: null, available_from: null, furnished: null, source: "immobilien.de" },
    ]);
    const { impl } = makeFetch({
      azure: [azurePayload([], titleOnlyJson, ["https://immobilien.de/wohnungen-koeln"])],
    });
    const outcome = await runHousingWebSearch(input(), { now: () => NOW, provider: AZURE, fetchImpl: impl });
    expect(outcome.status).toBe("ok");
    expect(outcome.listings).toEqual([]);
    expect(outcome.funnel.jsonOnlyKept).toBe(0);
    expect(outcome.funnel.contentRejected).toBeGreaterThanOrEqual(1);

    // Same URL WITH a real property fact (rent) is an individual offer → kept.
    const withRentJson = JSON.stringify([
      { url: RESCUE_URL, title: "2-Zi Wohnung Köln", city: "Köln", rent_cold_eur: 850, rent_warm_eur: null, additional_costs_eur: null, rooms: null, living_area_sqm: null, floor: null, available_from: null, furnished: null, source: "miet-immo.de" },
    ]);
    const { impl: impl2 } = makeFetch({
      azure: [azurePayload([], withRentJson, [RESCUE_URL])],
    });
    const outcome2 = await runHousingWebSearch(
      input(),
      { now: () => NOW, provider: AZURE, fetchImpl: impl2 },
    );
    expect(outcome2.funnel.jsonOnlyKept).toBe(1);
    const kept = outcome2.listings.find((l) => l.listing_url === RESCUE_URL)!;
    expect(kept).toBeDefined();
    expect(kept.rent_cold_eur).toBe(850);
  });

  it("a title with clear SALE evidence is rejected (this is a rental search)", async () => {
    const { impl } = makeFetch({
      azure: [azurePayload([{ url: SALE_URL, title: "Haus zum Kauf in Köln-Ehrenfeld" }])],
    });
    const outcome = await runHousingWebSearch(input(), { now: () => NOW, provider: AZURE, fetchImpl: impl });
    expect(outcome.status).toBe("ok");
    expect(outcome.listings).toEqual([]);
    expect(outcome.funnel.nonRentalRejected).toBe(1);
    expect(outcome.warnings).toContain("candidates_dropped_non_rental=1");
  });

  it("a sale word inside a RENTAL title does not kill the listing", async () => {
    const { impl } = makeFetch({
      azure: [azurePayload([{ url: RENTAL_URL, title: "Wohnung mieten Köln – Kaution 1.500 EUR" }])],
    });
    const outcome = await runHousingWebSearch(input(), { now: () => NOW, provider: AZURE, fetchImpl: impl });
    expect(outcome.funnel.nonRentalRejected).toBe(0);
    expect(outcome.listings).toHaveLength(1);
    expect(outcome.listings[0].title).toBe("Wohnung mieten Köln – Kaution 1.500 EUR");
  });

  it("a portal root URL is a portal page, not a listing", async () => {
    const { impl } = makeFetch({
      azure: [azurePayload([], "Angebote.", ["https://immobilien.de/"])],
    });
    const outcome = await runHousingWebSearch(input(), { now: () => NOW, provider: AZURE, fetchImpl: impl });
    expect(outcome.listings).toEqual([]);
    expect(outcome.funnel.uniqueSearchPages).toBe(1);
    expect(outcome.funnel.contentRejected).toBe(0);
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
    // Two IDENTICAL payloads + the bounded-parallelism pool ("all" type):
    // call 1 (primary) and call 2 (complement) repeat everything, call 3
    // (second parallel worker) gets the empty queue payload. The funnel
    // must count every occurrence (raw) while deduping for display.
    const payload = azurePayload(citations, "Angebote.", [IW_A]);
    const { impl } = makeFetch({ azure: [payload, payload] });
    const outcome = await runHousingWebSearch(input(), { now: () => NOW, provider: AZURE, fetchImpl: impl });
    expect(outcome.funnel).toMatchObject({
      providerCalls: 3, // 2 valid candidates < 8 → bounded complementary pool
      webSearchCalls: 3,
      rawCandidates: 10, // (4 citations + 1 source) × 2 identical calls
      uniqueCandidates: 3, // IS24_A, impressum, IW_A ("not a url" unparseable)
      invalidUrls: 2, // the invalid URL is reported by every REAL call
      searchPagesRejected: 2, // occurrences…
      uniqueSearchPages: 1, // …but only ONE distinct page was lost
      contentRejected: 0,
      jsonOnlyKept: 0,
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

  it("concurrent identical searches coalesce into ONE provider run (no double spend)", async () => {
    // A provider call that resolves LATE — both searches are in flight
    // while it is pending, so the second must ride the first.
    let release!: (v: ReturnType<typeof azurePayload>) => void;
    const gate = new Promise<ReturnType<typeof azurePayload>>((r) => (release = r));
    const impl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/responses")) return Response.json(await gate);
      return new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;

    const a = runHousingWebSearch(input({ mode: "targeted" }), { now: () => NOW, provider: AZURE, fetchImpl: impl });
    const b = runHousingWebSearch(input({ mode: "targeted" }), { now: () => NOW, provider: AZURE, fetchImpl: impl });
    release(azurePayload([{ url: IS24_A, title: "A" }]));
    const [ra, rb] = await Promise.all([a, b]);

    expect(impl).toHaveBeenCalledTimes(1); // exactly ONE paid API call
    expect(ra.cached).toBe(false);
    expect(ra.deduplicated ?? false).toBe(false);
    expect(rb.cached).toBe(false);
    expect(rb.deduplicated).toBe(true); // rider: refunded by the route
    expect(rb.listings).toEqual(ra.listings);

    // The coalesced result is cacheable (ok + ≥1 listing) → a THIRD call
    // is served from the cache, still no extra provider run.
    const c = await runHousingWebSearch(input({ mode: "targeted" }), { now: () => NOW, provider: AZURE, fetchImpl: impl });
    expect(c.cached).toBe(true);
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it("case-different city input shares one cache entry (berlin === Berlin)", async () => {
    const { impl } = makeFetch({ azure: [azurePayload([{ url: IS24_A, title: "A" }])] });
    const first = await runHousingWebSearch(
      input({ mode: "targeted", params: { ...baseParams, city: "Berlin" } }),
      { now: () => NOW, provider: AZURE, fetchImpl: impl },
    );
    const second = await runHousingWebSearch(
      input({ mode: "targeted", params: { ...baseParams, city: "berlin" } }),
      { now: () => NOW, provider: AZURE, fetchImpl: impl },
    );
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
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

describe("listing photos — real, validated images only", () => {
  it("attaches a real photo from fetched-page JSON-LD (provenance: page)", async () => {
    const { impl } = makeFetch({
      azure: [azurePayload([{ url: NW_A, title: "x" }])],
      page: () =>
        listingPage({
          image: ["https://cdn.open.nrw/img/1.jpg", "https://cdn.open.nrw/img/2.jpg"],
        }),
    });
    const outcome = await runHousingWebSearch(targeted(["open.nrw"]), {
      now: () => NOW,
      provider: AZURE,
      fetchImpl: impl,
    });
    expect(outcome.listings).toHaveLength(1);
    const l = outcome.listings[0];
    expect(l.images).toEqual(["https://cdn.open.nrw/img/1.jpg", "https://cdn.open.nrw/img/2.jpg"]);
    expect(l.image_url).toBe("https://cdn.open.nrw/img/1.jpg"); // first = card photo
    expect(l.field_provenance?.images).toBe("page");
    expect(outcome.funnel.imagesAttached).toBe(1);
  });

  it("falls back to og:image and resolves RELATIVE references against the fetched page", async () => {
    const { impl } = makeFetch({
      azure: [azurePayload([{ url: NW_A, title: "x" }])],
      page: () =>
        new Response(
          '<html><head><meta property="og:image" content="/media/wohnung-1.jpg"></head>' +
            "<body></body></html>",
          { status: 200, headers: { "content-type": "text/html" } },
        ),
    });
    const outcome = await runHousingWebSearch(targeted(["open.nrw"]), {
      now: () => NOW,
      provider: AZURE,
      fetchImpl: impl,
    });
    const l = outcome.listings[0];
    expect(l.image_url).toBe("https://open.nrw/media/wohnung-1.jpg");
    expect(l.field_provenance?.images).toBe("page");
  });

  it("drops UNSAFE page images (http / data: / private IP / credentials) — never an internal reference", async () => {
    const { impl } = makeFetch({
      azure: [azurePayload([{ url: NW_A, title: "x" }])],
      page: () =>
        listingPage({
          image: [
            "http://cdn.example.de/1.jpg",
            "data:image/png;base64,AAAA",
            "https://169.254.169.254/latest/image.jpg",
            "https://user:pass@cdn.example.de/2.jpg",
            "https://10.0.0.8/inner.jpg",
          ],
        }),
    });
    const outcome = await runHousingWebSearch(targeted(["open.nrw"]), {
      now: () => NOW,
      provider: AZURE,
      fetchImpl: impl,
    });
    const l = outcome.listings[0];
    expect(l.images).toEqual([]);
    expect("image_url" in l).toBe(false); // absent — UI renders the placeholder
    expect(l.field_provenance?.images).toBeUndefined();
    expect(outcome.funnel.imagesAttached).toBe(0);
  });

  it("resolves a page-relative image reference against the fetched page (same host)", async () => {
    const { impl } = makeFetch({
      azure: [azurePayload([{ url: NW_A, title: "x" }])],
      page: () => listingPage({ image: "photos/wohnung-1.jpg" }),
    });
    const outcome = await runHousingWebSearch(targeted(["open.nrw"]), {
      now: () => NOW,
      provider: AZURE,
      fetchImpl: impl,
    });
    expect(outcome.listings[0].image_url).toBe("https://open.nrw/dataset/photos/wohnung-1.jpg");
  });

  it("keeps a valid page image when other entries are invalid (partial salvage)", async () => {
    const { impl } = makeFetch({
      azure: [azurePayload([{ url: NW_A, title: "x" }])],
      page: () =>
        listingPage({
          image: ["https://10.0.0.8/inner.jpg", "https://cdn.open.nrw/ok.jpg"],
        }),
    });
    const outcome = await runHousingWebSearch(targeted(["open.nrw"]), {
      now: () => NOW,
      provider: AZURE,
      fetchImpl: impl,
    });
    expect(outcome.listings[0].image_url).toBe("https://cdn.open.nrw/ok.jpg");
  });

  it("uses PROVIDER search-result metadata for search_only domains WITHOUT fetching them (restricted policy)", async () => {
    const { impl, calls } = makeFetch({
      azure: [
        azurePayload([{ url: IS24_A, title: "x", image: "https://img.is24.de/123456789.jpg" }]),
      ],
    });
    const outcome = await runHousingWebSearch(targeted(["immobilienscout24.de"]), {
      now: () => NOW,
      provider: AZURE,
      fetchImpl: impl,
    });
    // IS24 is ToS-restricted: never fetched — the image may only come from
    // the publicly delivered search metadata.
    expect(outcome.stats.pagesFetched).toBe(0);
    expect(calls.some((c) => c.url === IS24_A)).toBe(false);
    const l = outcome.listings[0];
    expect(l.verification_notes).toBe("tos_no_fetch");
    expect(l.image_url).toBe("https://img.is24.de/123456789.jpg");
    expect(l.images).toEqual(["https://img.is24.de/123456789.jpg"]);
    expect(l.field_provenance?.images).toBe("search");
    expect(outcome.funnel.imagesAttached).toBe(1);
  });

  it("drops INVALID search-metadata images too", async () => {
    const { impl } = makeFetch({
      azure: [
        azurePayload([{ url: IS24_A, title: "x", image: "http://img.is24.de/123456789.jpg" }]),
      ],
    });
    const outcome = await runHousingWebSearch(targeted(["immobilienscout24.de"]), {
      now: () => NOW,
      provider: AZURE,
      fetchImpl: impl,
    });
    expect("image_url" in outcome.listings[0]).toBe(false);
    expect(outcome.listings[0].images).toEqual([]);
  });

  it("prefers fetched-page images over search-metadata images (stronger evidence)", async () => {
    const { impl } = makeFetch({
      azure: [
        azurePayload([{ url: NW_A, title: "x", image: "https://img.search-meta.example/t.jpg" }]),
      ],
      page: () => listingPage({ image: "https://cdn.open.nrw/page-1.jpg" }),
    });
    const outcome = await runHousingWebSearch(targeted(["open.nrw"]), {
      now: () => NOW,
      provider: AZURE,
      fetchImpl: impl,
    });
    const l = outcome.listings[0];
    expect(l.image_url).toBe("https://cdn.open.nrw/page-1.jpg");
    expect(l.field_provenance?.images).toBe("page");
  });

  it("sets no image_url when no channel delivered a usable image", async () => {
    const { impl } = makeFetch({ azure: [azurePayload([{ url: IS24_A, title: "x" }])] });
    const outcome = await runHousingWebSearch(targeted(["immobilienscout24.de"]), {
      now: () => NOW,
      provider: AZURE,
      fetchImpl: impl,
    });
    expect("image_url" in outcome.listings[0]).toBe(false);
    expect(outcome.listings[0].images).toEqual([]);
    expect(outcome.funnel.imagesAttached).toBe(0);
  });
});
