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
import { resolveSearchProvider } from "@/lib/housing/web-search/config";
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
const NW_A = "https://open.nrw/dataset/mieten-koeln";
const NW_B = "https://open.nrw/dataset/wg-mieten-koeln"; // NOT a prefix of NW_A (startsWith trap)
const OD_A = "https://www.opendata.de/dataset/miete";
const OD_B = "https://www.opendata.de/dataset/miete2";

function azurePayload(citations: Array<{ url: string; title: string }>) {
  return {
    output: [
      {
        type: "web_search_call",
        status: "completed",
        action: { type: "search", query: "Mietwohnung Köln", sources: [] },
      },
      {
        type: "message",
        status: "completed",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "Angebote gefunden.",
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

  it("surfaces tool_blocked when the subscription blocks the web_search tool", async () => {
    const impl = vi.fn(async () =>
      Response.json({ error: "blocked" }, { status: 403 }),
    ) as unknown as typeof fetch;
    const outcome = await runHousingWebSearch(input(), { now: () => NOW, provider: AZURE, fetchImpl: impl });
    expect(outcome.status).toBe("tool_blocked");
    expect(outcome.listings).toEqual([]);
  });
});

describe("general mode (web)", () => {
  it("returns only allowlisted listing pages, deduped, unverified, with citations preserved", async () => {
    const citations = [
      { url: IS24_A, title: "Titel A" },
      { url: IS24_B, title: "Titel B" },
      { url: IW_A, title: "Titel C" },
      { url: "https://example.com/expose/123456789", title: "not allowlisted" },
      { url: "https://www.immobilienscout24.de/impressum", title: "legal page" },
      { url: "https://www.immobilienscout24.de/", title: "homepage" },
    ];
    const { impl, calls } = makeFetch({ azure: [azurePayload(citations)] });
    const outcome = await runHousingWebSearch(input(), { now: () => NOW, provider: AZURE, fetchImpl: impl });

    expect(outcome.status).toBe("ok");
    expect(outcome.provider).toBe("azure");
    expect(outcome.warnings).toEqual([]);
    expect(outcome.stats).toEqual({ searchCalls: 1, pagesFetched: 0, bingRequests: 2 });
    // Citations are preserved verbatim for display (enterprise TOU requirement).
    expect(outcome.citations).toHaveLength(6);
    expect(outcome.queries[0]).toContain("Mietwohnung");

    expect(outcome.listings).toHaveLength(3);
    for (const l of outcome.listings) {
      expect(l.data_status).toBe("live");
      expect(l.provider).toBe("web-search");
      expect(l.verification_status).toBe("unverified"); // discovery only, never fetched
      expect(l.source_type).toBe("web_search");
      expect(l.verified).toBe(false);
      expect(l.rent_cold_eur).toBeNull(); // never invented
      expect(l.rent_warm_eur).toBeNull();
      expect(l.latitude).toBeNull();
      expect(l.longitude).toBeNull();
      expect(l.last_checked_at).toBe(NOW_ISO);
      expect(l.listing_url).toMatch(/^https:\/\//);
    }
    expect(outcome.listings[0].title).toBe("Titel A");
    // www stripped in the normalized source URL
    expect(outcome.listings[0].listing_url).toBe("https://immobilienscout24.de/expose/123456789");
    expect(outcome.fetchedAt).toBe(NOW_ISO);

    // No page or robots fetch in general mode — search call only.
    expect(calls.map((c) => c.url)).toEqual(["https://res.openai.azure.com/openai/v1/responses"]);
  });

  it("dedupes the same listing (www / tracking params / http vs https)", async () => {
    const citations = [
      { url: IS24_A, title: "Titel A" },
      { url: "https://immobilienscout24.de/expose/123456789?utm_source=x&gclid=y", title: "dup" },
      { url: `http://www.immobilienscout24.de/expose/123456789#ref`, title: "dup2" },
      { url: IS24_B, title: "Titel B" },
      { url: IW_A, title: "Titel C" },
    ];
    const { impl } = makeFetch({ azure: [azurePayload(citations)] });
    const outcome = await runHousingWebSearch(input(), { now: () => NOW, provider: AZURE, fetchImpl: impl });
    const forA = outcome.listings.filter((l) => l.listing_url === "https://immobilienscout24.de/expose/123456789");
    expect(forA).toHaveLength(1);
    expect(forA[0].title).toBe("Titel A"); // first-seen citation wins
    expect(outcome.listings).toHaveLength(3);
  });

  it("retries ONCE in English only when the German call under-delivered", async () => {
    // Thin: 1 candidate → second (EN) call happens.
    const thin = makeFetch({
      azure: [azurePayload([{ url: IS24_A, title: "A" }]), azurePayload([{ url: IS24_B, title: "B" }])],
    });
    const thinOutcome = await runHousingWebSearch(input(), { now: () => NOW, provider: AZURE, fetchImpl: thin.impl });
    expect(thinOutcome.stats.searchCalls).toBe(2);
    expect(thinOutcome.queries).toHaveLength(2);
    expect(thin.calls.filter((c) => c.url.endsWith("/responses"))).toHaveLength(2);
    expect(thinOutcome.listings).toHaveLength(2);

    // Rich: 3 candidates → exactly one paid call. (Different input: the same
    // input would be served from the result cache, not a second paid run.)
    const rich = makeFetch({
      azure: [
        azurePayload([
          { url: IS24_A, title: "A" },
          { url: IS24_B, title: "B" },
          { url: IW_A, title: "C" },
        ]),
      ],
    });
    const richOutcome = await runHousingWebSearch(
      input({ params: { ...baseParams, city: "Leipzig" } }),
      { now: () => NOW, provider: AZURE, fetchImpl: rich.impl },
    );
    expect(richOutcome.cached).toBe(false);
    expect(richOutcome.stats.searchCalls).toBe(1);
    expect(rich.calls.filter((c) => c.url.endsWith("/responses"))).toHaveLength(1);
  });

  it("reports no_candidates_on_allowed_domains when nothing usable is found", async () => {
    const { impl } = makeFetch({ azure: [azurePayload([{ url: "https://example.com/about", title: "x" }])] });
    const outcome = await runHousingWebSearch(input(), { now: () => NOW, provider: AZURE, fetchImpl: impl });
    expect(outcome.status).toBe("ok");
    expect(outcome.listings).toEqual([]);
    expect(outcome.warnings).toContain("no_candidates_on_allowed_domains");
  });

  it("honors the 25s request budget and stops fetching beyond it", async () => {
    let tick = 0;
    const now = () => (tick++ === 0 ? NOW : NOW + 30_000); // everything after start is "past deadline"
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

describe("real Azure response shape → real live listings (never demo)", () => {
  // The exact "Response shape" from the official docs (flat url_citation
  // annotations, action.query singular, action.sources as {type,url}
  // objects) — the format the deployed gpt-5-mini deployment returns.
  const docsShapePayload = {
    output: [
      {
        id: "ws_1",
        type: "web_search_call",
        status: "completed",
        action: {
          type: "search",
          query: "Mietwohnung Köln bis 800 Euro Warmmiete",
          sources: [
            { type: "url", url: "https://www.immobilienscout24.de/expose/123456789" },
            { type: "url", url: "https://www.immowelt.de/expose/555555555" },
            { type: "url", url: "https://www.wg-gesucht.de/2-zimmer-koeln-123456789.html" },
            { type: "url", url: "https://www.immobilienscout24.de/immobilien/suche/wohnung-mieten/koeln" },
          ],
        },
      },
      {
        id: "msg_1",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "Aktuelle Angebote in Köln: …",
            annotations: [
              { type: "url_citation", start_index: 0, end_index: 40, url: "https://www.immobilienscout24.de/expose/123456789", title: "2-Zimmer-Wohnung in Köln-Ehrenfeld" },
              { type: "url_citation", start_index: 40, end_index: 80, url: "https://www.immowelt.de/expose/555555555", title: "3-Zimmer-Wohnung in Köln-Sülz" },
            ],
          },
        ],
      },
    ],
    output_text: "Aktuelle Angebote in Köln: …",
    tool_usage: { web_search: { num_requests: 1 } },
  };

  it("extracts real listings (URL + title + live status) from citations AND sources, never demo", async () => {
    const { impl } = makeFetch({ azure: [docsShapePayload] });
    const outcome = await runHousingWebSearch(input(), { now: () => NOW, provider: AZURE, fetchImpl: impl });

    expect(outcome.status).toBe("ok");
    expect(outcome.warnings).toEqual([]);
    expect(outcome.stats.bingRequests).toBe(1);
    // Citations (2) + sources (3 listing pages + 1 search-overview page):
    // the overview page is dropped by the listing-URL heuristic, dedupe
    // keeps the three distinct listing URLs. ≥3 candidates also means the
    // general-mode EN retry does NOT fire (one paid call, bingRequests=1).
    expect(outcome.stats.searchCalls).toBe(1);
    expect(outcome.listings).toHaveLength(3);
    expect(outcome.listings.map((l) => l.listing_url).sort()).toEqual([
      "https://immobilienscout24.de/expose/123456789",
      "https://immowelt.de/expose/555555555",
      "https://wg-gesucht.de/2-zimmer-koeln-123456789.html",
    ]);
    for (const l of outcome.listings) {
      expect(l.data_status).toBe("live"); // never "demo"
      expect(l.provider).toBe("web-search");
      expect(l.source_type).toBe("web_search");
      expect(l.city).toBe("Köln");
      expect(l.listing_active).toBeNull();
    }
    // Citation titles are preserved on the matching listing.
    const is24 = outcome.listings.find((l) => l.listing_url.includes("immobilienscout24.de"))!;
    expect(is24.title).toBe("2-Zimmer-Wohnung in Köln-Ehrenfeld");
  });

  it("sends an explicit web-search + direct-link instruction (not a bare query)", async () => {
    const { impl, calls } = makeFetch({ azure: [docsShapePayload] });
    await runHousingWebSearch(input(), { now: () => NOW, provider: AZURE, fetchImpl: impl });
    const body = calls.find((c) => c.url.endsWith("/responses"))!.body!;
    const sentInput = String(body.input);
    // The raw user query is preserved verbatim inside the instruction…
    expect(sentInput).toContain("Mietwohnung");
    expect(sentInput).toContain("Köln");
    expect(sentInput).toContain("800");
    // …and the instruction explicitly demands a web search with direct
    // per-listing links (the documented fix for missing citations).
    expect(sentInput).toMatch(/Websuche/i);
    expect(sentInput).toMatch(/direkten Link/i);
    expect(sentInput).toMatch(/Quellen|zitiere/i);
  });

  it("reports WHY an empty result is empty: all citations off the allowlist", async () => {
    const offAllowlist = {
      ...docsShapePayload,
      output: [
        {
          type: "web_search_call",
          status: "completed",
          action: { type: "search", query: "q", sources: [] },
        },
        {
          type: "message",
          status: "completed",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "…",
              annotations: [
                { type: "url_citation", start_index: 0, end_index: 10, url: "https://blog.example.com/wohnungen", title: "a" },
                { type: "url_citation", start_index: 10, end_index: 20, url: "https://wiki.example.org/mieten", title: "b" },
              ],
            },
          ],
        },
      ],
    };
    const { impl } = makeFetch({ azure: [offAllowlist] });
    const outcome = await runHousingWebSearch(input(), { now: () => NOW, provider: AZURE, fetchImpl: impl });

    expect(outcome.status).toBe("ok"); // a real search ran — not an error
    expect(outcome.listings).toEqual([]);
    expect(outcome.warnings).toContain("no_candidates_on_allowed_domains");
    expect(outcome.warnings).toContain("candidates_dropped_off_allowlist=2");
    // Citations stay visible (Bing TOU: references displayed to the user).
    expect(outcome.citations).toHaveLength(2);
  });

  it("flags azure_no_web_search_call when the model answered without invoking the tool", async () => {
    const noTool = {
      output: [
        {
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: "Aus meinem Wissen: …", annotations: [] }],
        },
      ],
      output_text: "Aus meinem Wissen: …",
    };
    // Both the German call and the general-mode EN retry return no tool use.
    const { impl } = makeFetch({ azure: [noTool, noTool] });
    const outcome = await runHousingWebSearch(input(), { now: () => NOW, provider: AZURE, fetchImpl: impl });

    expect(outcome.status).toBe("ok");
    expect(outcome.listings).toEqual([]);
    expect(outcome.warnings).toContain("azure_no_web_search_call");
    expect(outcome.warnings).toContain("no_candidates_on_allowed_domains");
  });
});

describe("targeted mode", () => {
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

    // The IS24 URL must never have been fetched or robots-checked (ToS).
    expect(calls.some((c) => c.url.includes("immobilienscout24.de"))).toBe(false);

    const nrw = outcome.listings.find((l) => l.listing_url === NW_A)!;
    expect(nrw.verification_status).toBe("verified");
    expect(nrw.source_type).toBe("page_fetch");
    expect(nrw.rent_cold_eur).toBe(850);
    expect(nrw.rooms).toBe(2);
    expect(nrw.living_area_sqm).toBe(55);
    expect(nrw.available_from).toBe("2025-12-01");
    expect(calls.some((c) => c.url === "https://open.nrw/robots.txt")).toBe(true);
  });

  it("bounds candidates to the selected domains (allowlist is binding)", async () => {
    const citations = [
      { url: NW_A, title: "in" },
      { url: IS24_A, title: "not selected" },
    ];
    const { impl } = makeFetch({ azure: [azurePayload(citations)] });
    const outcome = await runHousingWebSearch(targeted(["open.nrw"]), {
      now: () => NOW,
      provider: AZURE,
      fetchImpl: impl,
    });
    expect(outcome.listings.map((l) => l.listing_url)).toEqual([NW_A]);
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
    expect(blocked.calls.some((c) => c.url === NW_A)).toBe(false);

    // Broken robots.txt (network failure) → unknown → also not fetched.
    // (Clear BOTH the result cache — same input would otherwise be served
    // from the first run — and the per-host robots cache so the run re-queries.)
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
    expect(outcome.listings[0].rent_cold_eur).toBeNull();
  });
});

describe("Azure-only provider enforcement (no Tavily fallback)", () => {
  it("resolves to azure via the real resolver even when TAVILY_API_KEY is present", async () => {
    vi.stubEnv("HOUSING_WEB_SEARCH", "");
    vi.stubEnv("AZURE_WEB_SEARCH_ENDPOINT", "https://res.openai.azure.com/openai/v1");
    vi.stubEnv("AZURE_WEB_SEARCH_KEY", "azure-test-key");
    vi.stubEnv("AZURE_WEB_SEARCH_MODEL", "gpt-5-mini");
    vi.stubEnv("TAVILY_API_KEY", "tvly-test-key");
    const { impl, calls } = makeFetch({ azure: [azurePayload([{ url: IS24_A, title: "A" }])] });

    // No `provider` dep injected → resolveSearchProvider() runs for real.
    const outcome = await runHousingWebSearch(input(), { now: () => NOW, fetchImpl: impl });

    expect(outcome.status).toBe("ok");
    expect(outcome.provider).toBe("azure");
    expect(calls.filter((c) => c.url.endsWith("/responses")).length).toBeGreaterThan(0);
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
