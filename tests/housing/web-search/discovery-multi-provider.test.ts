import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lookup } from "node:dns/promises";

// Offline: DNS and every HTTP call are mocked/injected (same pattern as
// discovery.test.ts).
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn<
    (hostname: string, options?: { all: true }) => Promise<Array<{ address: string; family: number }>>
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

import {
  clearWebSearchCache,
  runHousingWebSearch,
  type HousingWebSearchInput,
} from "@/lib/housing/web-search/discovery";
import { clearRobotsCache } from "@/lib/housing/web-search/robots";
import { __resetSessions } from "@/lib/housing/web-search/sessions";

const NOW = 1_760_000_000_000;
const PUBLIC = "93.184.216.34";

const AZURE = { kind: "azure" as const, base: "https://res.openai.azure.com/openai/v1", key: "azure-key-abc", model: "gpt-5-mini" };
const GEMINI = { kind: "gemini" as const, key: "gemini-key-xyz", model: "gemini-3.8-flash" };

const baseParams = {
  city: "Köln",
  postal_code: "",
  radius_km: 10,
  max_warm_rent: 800,
  accommodation_type: "all" as const,
  rooms: "all" as const,
  min_area_sqm: null,
  available_before: null,
  sort: "newest" as const,
};
const input = (over: Partial<HousingWebSearchInput> = {}): HousingWebSearchInput => ({
  mode: "web",
  params: { ...baseParams },
  ...over,
});

// --- fixtures -------------------------------------------------------------

const IS24_A = "https://www.immobilienscout24.de/expose/123456789";
const IS24_B = "https://www.immobilienscout24.de/expose/987654321";
const IW_A = "https://www.immowelt.de/expose/555555555";
const IS24_A_CIT = { url: IS24_A, title: "A" };

function azurePayload(
  citations: Array<{ url: string; title: string }>,
  sources: string[] = [],
) {
  return {
    output: [
      { type: "web_search_call", status: "completed", action: { type: "search", query: "Mietwohnung Köln", sources } },
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
    output_text: "Angebote gefunden.",
    tool_usage: { web_search: { num_requests: 1 } },
  };
}

function geminiPayload(
  citations: Array<{ url: string; title: string }>,
  queries: string[] = ["Mietwohnung Köln"],
) {
  return {
    interaction: {
      steps: [
        { type: "google_search_call", arguments: { queries } },
        {
          type: "model_output",
          content: [
            {
              text: "Angebote gefunden.",
              annotations: citations.map((c, i) => ({
                type: "url_citation",
                url: c.url,
                title: c.title,
                start_index: i,
                end_index: i + 1,
              })),
            },
          ],
        },
      ],
    },
  };
}

function makeFetch(opts: {
  azure?: unknown[];
  gemini?: unknown[];
  azureStatus?: number;
  geminiStatus?: number;
}) {
  const azureQueue = [...(opts.azure ?? [])];
  const geminiQueue = [...(opts.gemini ?? [])];
  const calls: { url: string; body: Record<string, unknown> | null }[] = [];
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
      if (opts.azureStatus && opts.azureStatus >= 400) {
        return new Response("blocked", { status: opts.azureStatus });
      }
      return Response.json(azureQueue.shift() ?? azurePayload([]));
    }
    if (url.endsWith("/interactions")) {
      if (opts.geminiStatus && opts.geminiStatus >= 400) {
        return new Response("blocked", { status: opts.geminiStatus });
      }
      return Response.json(geminiQueue.shift() ?? geminiPayload([]));
    }
    if (url.endsWith("/robots.txt")) {
      return new Response("User-agent: *\nAllow: /", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }
    return new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

type Rec = { url: string; body: Record<string, unknown> | null };
const isAzureCall = (calls: Rec[]) => calls.filter((c) => c.url.endsWith("/responses"));
const isGeminiCall = (calls: Rec[]) => calls.filter((c) => c.url.endsWith("/interactions"));

beforeEach(() => {
  vi.clearAllMocks();
  dnsLookup.mockReset();
  dnsLookup.mockResolvedValue([{ address: PUBLIC, family: 4 }]);
  vi.stubEnv("GEMINI_API_KEY", "");
  vi.stubEnv("HOUSING_SEARCH_MAX_COST_CENTS_PER_RUN", "");
  clearWebSearchCache();
  clearRobotsCache();
  __resetSessions();
});

afterEach(() => {
  vi.unstubAllEnvs();
  __resetSessions();
});

// --- provider resolution + labels ------------------------------------------

describe("provider resolution", () => {
  it("runs GOOGLE-ONLY when Azure is absent (graceful degradation)", async () => {
    const { impl, calls } = makeFetch({ gemini: [geminiPayload([{ url: IS24_A, title: "A" }])] });
    const outcome = await runHousingWebSearch(input(), {
      now: () => NOW,
      provider: null,
      geminiProvider: GEMINI,
      fetchImpl: impl,
    });
    expect(outcome.status).toBe("ok");
    expect(outcome.provider).toBe("google");
    expect(outcome.listings).toHaveLength(1);
    expect(isAzureCall(calls)).toHaveLength(0);
    expect(isGeminiCall(calls).length).toBeGreaterThan(0);
    const az = outcome.providers.find((p) => p.provider === "azure");
    expect(az?.status).toBe("not_configured");
    const g = outcome.providers.find((p) => p.provider === "google");
    expect(g?.status).toBe("ok");
  });

  it("labels a dual-provider run 'azure+google'", async () => {
    const { impl } = makeFetch({
      azure: [azurePayload([{ url: IS24_A, title: "A" }])],
      gemini: [geminiPayload([{ url: IW_A, title: "B" }])],
    });
    const outcome = await runHousingWebSearch(input(), {
      now: () => NOW,
      provider: AZURE,
      geminiProvider: GEMINI,
      fetchImpl: impl,
    });
    expect(outcome.status).toBe("ok");
    expect(outcome.provider).toBe("azure+google");
    expect(outcome.listings).toHaveLength(2);
  });
});

// --- cross-source dedup ------------------------------------------------------

describe("cross-source dedup (one card, 'discovered via' both)", () => {
  it("merges the SAME URL found by Google AND Azure (rule 1, URL identity)", async () => {
    const { impl } = makeFetch({
      azure: [azurePayload([{ url: IS24_A, title: "A" }])],
      gemini: [geminiPayload([{ url: IS24_A, title: "A" }])],
    });
    const outcome = await runHousingWebSearch(input(), {
      now: () => NOW,
      provider: AZURE,
      geminiProvider: GEMINI,
      fetchImpl: impl,
    });
    expect(outcome.status).toBe("ok");
    expect(outcome.listings).toHaveLength(1); // ONE card, not two
    expect(outcome.funnel.duplicateResults).toBeGreaterThanOrEqual(1);
    expect(outcome.listings[0].discovered_via).toEqual(["azure", "google"]);
  });

  it("merges rule 2: same host + same offer id under DIFFERENT url shapes (expose/ vs objekt/)", async () => {
    const { impl } = makeFetch({
      azure: [azurePayload([{ url: IW_A, title: "A" }])], // /expose/555555555
      gemini: [geminiPayload([{ url: "https://www.immowelt.de/objekt/555555555", title: "A" }])],
    });
    const outcome = await runHousingWebSearch(input(), {
      now: () => NOW,
      provider: AZURE,
      geminiProvider: GEMINI,
      fetchImpl: impl,
    });
    expect(outcome.status).toBe("ok");
    expect(outcome.listings).toHaveLength(1); // ONE card, not two
    expect(outcome.funnel.crossSourceMerges).toBe(1); // rule 2 fired
    expect(outcome.listings[0].discovered_via).toEqual(["azure", "google"]);
  });

  it("NEVER merges two different ads on the same host (different offer ids)", async () => {
    const { impl } = makeFetch({
      azure: [azurePayload([{ url: IS24_A, title: "A" }])],
      gemini: [geminiPayload([{ url: IS24_B, title: "B" }])],
    });
    const outcome = await runHousingWebSearch(input(), {
      now: () => NOW,
      provider: AZURE,
      geminiProvider: GEMINI,
      fetchImpl: impl,
    });
    expect(outcome.listings).toHaveLength(2);
    expect(outcome.funnel.crossSourceMerges).toBe(0);
  });
});

// --- provider failure isolation ----------------------------------------------

describe("provider failure isolation", () => {
  it("Azure down (403) + Google up → the run SUCCEEDS with Google results", async () => {
    const { impl, calls } = makeFetch({
      azureStatus: 403,
      gemini: [geminiPayload([{ url: IW_A, title: "B" }])],
    });
    const outcome = await runHousingWebSearch(input(), {
      now: () => NOW,
      provider: AZURE,
      geminiProvider: GEMINI,
      fetchImpl: impl,
    });
    expect(outcome.status).toBe("ok");
    expect(outcome.listings).toHaveLength(1);
    expect(outcome.providers.find((p) => p.provider === "azure")?.status).toBe("error");
    expect(outcome.providers.find((p) => p.provider === "google")?.status).toBe("ok");
    // Google kept running its rounds despite Azure's outage.
    expect(isGeminiCall(calls).length).toBeGreaterThan(0);
  });

  it("Google down (403) + Azure up → the run SUCCEEDS with Azure results", async () => {
    const { impl, calls } = makeFetch({
      azure: [azurePayload([{ url: IS24_A, title: "A" }])],
      geminiStatus: 403,
    });
    const outcome = await runHousingWebSearch(input(), {
      now: () => NOW,
      provider: AZURE,
      geminiProvider: GEMINI,
      fetchImpl: impl,
    });
    expect(outcome.status).toBe("ok");
    expect(outcome.listings).toHaveLength(1);
    expect(outcome.providers.find((p) => p.provider === "azure")?.status).toBe("ok");
    expect(outcome.providers.find((p) => p.provider === "google")?.status).toBe("error");
    expect(isAzureCall(calls).length).toBeGreaterThan(0);
  });

  it("BOTH providers down → honest failure status (no silent ok+0)", async () => {
    const { impl } = makeFetch({ azureStatus: 403, geminiStatus: 403 });
    const outcome = await runHousingWebSearch(input(), {
      now: () => NOW,
      provider: AZURE,
      geminiProvider: GEMINI,
      fetchImpl: impl,
    });
    expect(outcome.status).toBe("tool_blocked");
    expect(outcome.listings).toHaveLength(0);
  });
});

// --- Google rounds + cost cap --------------------------------------------------

describe("Google rounds, cost cap and deadline", () => {
  it("round 2 runs while unique < 30; round 3 is skipped when unique ≥ 15", async () => {
    // 20 unique candidates after round 1: round 2 (deep-dive) runs
    // (20 < 30), round 3 (gap-fill) is skipped (20 ≥ 15).
    const twenty = Array.from({ length: 20 }, (_, i) => ({
      url: `https://portal.de/expose/${200000000 + i}`,
      title: `R ${i}`,
    }));
    const { impl, calls } = makeFetch({ gemini: [geminiPayload(twenty)] });
    const outcome = await runHousingWebSearch(input(), {
      now: () => NOW,
      provider: null,
      geminiProvider: GEMINI,
      fetchImpl: impl,
    });
    expect(outcome.status).toBe("ok");
    expect(outcome.funnel.rounds).toBe(2);
    expect(isGeminiCall(calls)).toHaveLength(6); // 3 (R1) + 3 (R2)
    expect(outcome.funnel.validListings).toBe(20);
  });

  it("no round 2 when round 1 already found ≥ 30 unique candidates", async () => {
    const rich = Array.from({ length: 32 }, (_, i) => ({
      url: `https://portal.de/expose/${300000000 + i}`,
      title: `R ${i}`,
    }));
    const { impl, calls } = makeFetch({ gemini: [geminiPayload(rich)] });
    const outcome = await runHousingWebSearch(input(), {
      now: () => NOW,
      provider: null,
      geminiProvider: GEMINI,
      fetchImpl: impl,
    });
    expect(outcome.status).toBe("ok");
    expect(outcome.funnel.rounds).toBe(1);
    expect(isGeminiCall(calls)).toHaveLength(3); // round-1 cap only
  });

  it("round 3 site: gap-filling excludes portals that already surfaced candidates", async () => {
    // 10 unique candidates (< 15) → rounds 1,2,3 all run (9 calls). The
    // round-3 `site:` queries must NOT target hosts already present in
    // the earlier rounds.
    const ten = Array.from({ length: 10 }, (_, i) => ({
      url:
        i % 2 === 0
          ? `https://wg-gesucht.de/rooms/${400000000 + i}/koeln/`
          : `https://portal.de/expose/${310000000 + i}`,
      title: `R ${i}`,
    }));
    const { impl, calls } = makeFetch({
      gemini: [geminiPayload(ten), ...Array.from({ length: 8 }, () => geminiPayload([]))],
    });
    const outcome = await runHousingWebSearch(input(), {
      now: () => NOW,
      provider: null,
      geminiProvider: GEMINI,
      fetchImpl: impl,
    });
    expect(outcome.status).toBe("ok");
    expect(outcome.funnel.rounds).toBe(3);
    expect(isGeminiCall(calls)).toHaveLength(9); // 3+3+3, the run ceiling
    const geminiInputs = isGeminiCall(calls).map((c) => String(c.body?.input));
    const round3Inputs = geminiInputs.filter((i) => i.includes("site:"));
    expect(round3Inputs.length).toBeGreaterThan(0);
    // wg-gesucht.de already produced candidates → excluded from gap-fill.
    expect(round3Inputs.every((i) => !i.includes("site:wg-gesucht.de"))).toBe(true);
    expect(
      round3Inputs.some(
        (i) => i.includes("site:immowelt.de") || i.includes("site:immobilienscout24.de"),
      ),
    ).toBe(true);
  });

  it("stops issuing Google calls once the per-run COST CAP is reached (measured queries)", async () => {
    // First call reports 40 executed queries × 1.4¢ = 56¢ ≥ 50¢ default
    // cap → rounds 2/3 must not issue a single further call.
    const bigQueries = Array.from({ length: 40 }, (_, i) => `q${i}`);
    const { impl, calls } = makeFetch({ gemini: [geminiPayload([IS24_A_CIT], bigQueries)] });
    const outcome = await runHousingWebSearch(input(), {
      now: () => NOW,
      provider: null,
      geminiProvider: GEMINI,
      fetchImpl: impl,
    });
    expect(outcome.status).toBe("ok");
    const gCost = outcome.cost.find((c) => c.provider === "google");
    // 40 from the big first call (+ at most 1 from an already in-flight
    // round-1 call — in-flight calls cannot be cancelled; the cap applies
    // BEFORE the next call is issued).
    expect(gCost?.units).toBeGreaterThanOrEqual(40);
    expect(gCost?.estimatedCostCents).toBeGreaterThanOrEqual(50);
    // The cap stops the rounds: at most the 3 in-flight round-1 calls.
    expect(isGeminiCall(calls).length).toBeLessThanOrEqual(3);
    expect(outcome.funnel.rounds).toBe(1);
  });

  it("deadline guard: NO call is issued once the request budget is exhausted", async () => {
    // The clock starts at NOW (fixing the 55 s deadline) and then jumps
    // 60 s into the future: from the first guard check on, the budget is
    // exhausted → an honest "timeout" with zero paid calls (not ok+0).
    let ticks = 0;
    const { impl, calls } = makeFetch({ gemini: [geminiPayload([IS24_A_CIT])] });
    const outcome = await runHousingWebSearch(input(), {
      now: () => {
        ticks += 1;
        return ticks === 1 ? NOW : NOW + 60_000;
      },
      provider: null,
      geminiProvider: GEMINI,
      fetchImpl: impl,
    });
    expect(outcome.status).toBe("timeout");
    expect(outcome.message).toBe("request_budget_exhausted");
    expect(outcome.listings).toHaveLength(0);
    expect(isGeminiCall(calls)).toHaveLength(0);
    expect(isAzureCall(calls)).toHaveLength(0);
  });
});

// --- pagination + continuation --------------------------------------------------

describe("pagination + 'load more' continuation", () => {
  it("serves page 1 of 24 with a token when more than 24 are validated", async () => {
    const thirty = Array.from({ length: 30 }, (_, i) => ({
      url: `https://portal.de/expose/${320000000 + i}`,
      title: `R ${i}`,
    }));
    const { impl } = makeFetch({ gemini: [geminiPayload(thirty)] });
    const outcome = await runHousingWebSearch(input(), {
      now: () => NOW,
      provider: null,
      geminiProvider: GEMINI,
      fetchImpl: impl,
    });
    expect(outcome.status).toBe("ok");
    expect(outcome.listings).toHaveLength(24);
    expect(outcome.funnel.validListings).toBe(30);
    expect(outcome.loadMore?.hasMore).toBe(true);
    expect(outcome.loadMore?.remaining).toBe(6);
    expect(outcome.loadMore?.token).toBeTruthy();
  });

  it("continuation serves the next page with NO paid provider calls", async () => {
    const thirty = Array.from({ length: 30 }, (_, i) => ({
      url: `https://portal.de/expose/${330000000 + i}`,
      title: `R ${i}`,
    }));
    const first = makeFetch({ gemini: [geminiPayload(thirty)] });
    const outcome = await runHousingWebSearch(input(), {
      now: () => NOW,
      provider: null,
      geminiProvider: GEMINI,
      fetchImpl: first.impl,
    });
    const token = outcome.loadMore!.token!;
    expect(outcome.listings).toHaveLength(24);

    // Continuation: NO azure/google calls may be issued (session is served).
    const cont = makeFetch({});
    const next = await runHousingWebSearch(
      input({ continueSession: { token } }),
      { now: () => NOW + 1000, provider: null, geminiProvider: GEMINI, fetchImpl: cont.impl },
    );
    expect(next.status).toBe("ok");
    expect(next.sessionExpired).toBeFalsy();
    expect(next.listings).toHaveLength(6);
    expect(next.loadMore?.hasMore).toBe(false);
    expect(isAzureCall(cont.calls)).toHaveLength(0);
    expect(isGeminiCall(cont.calls)).toHaveLength(0);
    // No quota: the route layer handles that; here the pipeline simply
    // must not call any paid endpoint.
  });

  it("unknown/expired continuation token → sessionExpired (never a paid re-run)", async () => {
    const { impl, calls } = makeFetch({});
    const next = await runHousingWebSearch(
      input({ continueSession: { token: "ghost-token-123" } }),
      { now: () => NOW + 1000, provider: null, geminiProvider: GEMINI, fetchImpl: impl },
    );
    expect(next.status).toBe("ok");
    expect(next.sessionExpired).toBe(true);
    expect(next.listings).toHaveLength(0);
    expect(isAzureCall(calls)).toHaveLength(0);
    expect(isGeminiCall(calls)).toHaveLength(0);
  });
});

// --- production defect 2026-10-10 ---------------------------------------------

describe("production defect 2026-10-10: Google model 404 + portal pages as listings", () => {
  it("Google answers 404 NOT_FOUND (unknown model) → run still ok via Azure; diagnostics carry the machine status, never the key", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const geminiErrBody = JSON.stringify({
      error: { code: 404, message: "models/gemini-3.5-flash is not found (request id xyz)", status: "NOT_FOUND" },
    });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/interactions")) {
        return new Response(geminiErrBody, { status: 404, headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/responses")) {
        return Response.json(azurePayload([{ url: IS24_A, title: "A" }]));
      }
      return new Response("<html></html>", { status: 200 });
    });
    const outcome = await runHousingWebSearch(input(), {
      now: () => NOW,
      provider: AZURE,
      geminiProvider: { kind: "gemini" as const, key: "secret-prod-key", model: "gemini-3.5-flash" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(outcome.status).toBe("ok");
    expect(outcome.listings).toHaveLength(1); // Azure result kept
    const g = outcome.providers.find((p) => p.provider === "google");
    expect(g?.status).toBe("error");
    const serialized = JSON.stringify(outcome);
    expect(serialized).not.toContain("secret-prod-key");
    expect(serialized).not.toContain("request id xyz");
    // The RUNTIME LOG carries the root cause (HTTP + machine status + the
    // model that was sent) — and nothing sensitive.
    const warnLine = warn.mock.calls.map((c) => c[0]).find((l) => String(l).includes("api_status"));
    expect(warnLine).toContain("http=404");
    expect(warnLine).toContain("api_status=NOT_FOUND");
    expect(warnLine).toContain("model=gemini-3.5-flash");
    expect(warnLine).not.toContain("secret-prod-key");
    warn.mockRestore();
  });

  it("portal/category/search pages are NOT shown as listings (honest empty state)", async () => {
    // The 12-hit production shape: Bing returns portal section pages.
    // None of them carries an offer id → all rejected, counted, and the
    // run reports ok with ZERO listings (never fabricated).
    const sectionPages = [
      { url: "https://www.immobilienscout24.de/expose", title: "Wohnungen mieten – ImmoScout24" }, // bare listing word, no id
      { url: "https://www.wg-gesucht.de/rooms/koeln/", title: "Wohnung mieten in Köln – WG-Gesucht" }, // browse page
      { url: "https://www.immowelt.de/mieten/koeln/", title: "Wohnung mieten in Köln – ImmoWelt" }, // category tree
      { url: "https://www.immobilienscout24.de/", title: "ImmoScout24 – Immobilienangebote" }, // root
      { url: "https://www.immonet.de/kaufen/haeuser/koeln/", title: "Häuser kaufen in Köln – Immonet" }, // category (and sale)
    ];
    const { impl, calls } = makeFetch({ azure: [azurePayload(sectionPages)] });
    const outcome = await runHousingWebSearch(input(), {
      now: () => NOW,
      provider: AZURE,
      geminiProvider: null,
      fetchImpl: impl,
    });
    expect(outcome.status).toBe("ok");
    expect(outcome.listings).toEqual([]); // 0 real listings — honest
    expect(outcome.funnel.uniqueSearchPages).toBeGreaterThanOrEqual(4);
    expect(outcome.funnel.searchPagesRejected).toBeGreaterThanOrEqual(4);
    expect(outcome.warnings).toContain(
      `candidates_dropped_search_pages=${outcome.funnel.searchPagesRejected} unique=${outcome.funnel.uniqueSearchPages}`,
    );
    // And the pipeline still ran its provider call(s) normally (no crash).
    expect(isAzureCall(calls).length).toBeGreaterThan(0);
  });

  it("regression guard: real individual ads WITH offer ids are still kept (original links intact)", async () => {
    const realAds = [
      { url: "https://www.immobilienscout24.de/expose/123456789", title: "2-Zi. Köln-Ehrenfeld" },
      { url: "https://www.immowelt.de/expose/555555555", title: "Helle 3-Zi. Köln" },
      { url: "https://www.wg-gesucht.de/rooms/12345678/koeln-ehrenfeld/", title: "Zimmer in WG Köln" },
      { url: "https://www.immonet.de/mieten/654321987/", title: "Mietwohnung Köln" }, // category tree + id → the ad
    ];
    const { impl } = makeFetch({ azure: [azurePayload(realAds)] });
    const outcome = await runHousingWebSearch(input(), {
      now: () => NOW,
      provider: AZURE,
      geminiProvider: null,
      fetchImpl: impl,
    });
    expect(outcome.status).toBe("ok");
    const urls = outcome.listings.map((l) => l.listing_url).sort();
    expect(urls).toEqual(
      [
        "https://immobilienscout24.de/expose/123456789",
        "https://immowelt.de/expose/555555555",
        "https://immonet.de/mieten/654321987/",
        "https://wg-gesucht.de/rooms/12345678/koeln-ehrenfeld/",
      ].sort(),
    ); // original offer links preserved verbatim
  });
});

// --- secret hygiene ------------------------------------------------------------

describe("secret hygiene", () => {
  it("never leaks provider keys in the serialized outcome", async () => {
    const { impl } = makeFetch({
      azure: [azurePayload([{ url: IS24_A, title: "A" }])],
      gemini: [geminiPayload([{ url: IW_A, title: "B" }])],
    });
    const outcome = await runHousingWebSearch(input(), {
      now: () => NOW,
      provider: AZURE,
      geminiProvider: GEMINI,
      fetchImpl: impl,
    });
    const serialized = JSON.stringify(outcome);
    expect(serialized).not.toContain("azure-key-abc");
    expect(serialized).not.toContain("gemini-key-xyz");
  });
});
