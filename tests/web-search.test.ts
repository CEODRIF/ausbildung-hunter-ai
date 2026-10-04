import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearTavilyMemoryCache,
  defaultTavilyBudget,
  DEFAULT_TAVILY_REQUESTS_PER_RUN,
  getWebSearchClient,
  MAX_TAVILY_REQUESTS_HARD_CAP,
  MAX_TAVILY_REQUESTS_PER_RUN,
  resetTavilyDiagnostics,
  resolveTavilyKey,
  TAVILY_SEARCH_URL,
  WebSearchError,
} from "@/lib/web-search";

/**
 * Web-search provider (Tavily Search API).
 *
 * Selection logic uses the real module (env manipulated per test); the HTTP
 * layer is mocked. Requirements covered here: Tavily is called on search,
 * TAVILY_API_KEY is required, the key never leaks, Gemini grounding is never
 * called, at most DEFAULT_TAVILY_REQUESTS_PER_RUN (30) requests per search
 * operation — never more than the hard cost cap (60) — duplicates are
 * removed, provider errors are handled and reported safely.
 */

const ORIGINAL_ENV = { ...process.env };

function resetEnv() {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.TAVILY_API_KEY;
  delete process.env.TAVILY_MAX_REQUESTS_PER_RUN;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_GROUNDING_API_KEY;
  delete process.env.AI_API_KEY;
  delete process.env.AI_API_URL;
}

function tavilyResponse(
  results: Array<{
    title?: unknown;
    url?: unknown;
    content?: unknown;
    score?: unknown;
  }>,
) {
  return Response.json({
    query: "q",
    results,
    response_time: "0.42",
    usage: { credits: 1 },
    request_id: "req-test",
  });
}

describe("getWebSearchClient / resolveTavilyKey", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    resetEnv();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    resetTavilyDiagnostics();
    clearTavilyMemoryCache();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    resetEnv();
  });

  it("returns no client without TAVILY_API_KEY (graceful degradation)", () => {
    expect(resolveTavilyKey()).toBeNull();
    expect(getWebSearchClient()).toBeNull();
  });

  it("ignores GEMINI_API_KEY — the web layer no longer uses Gemini keying", () => {
    process.env.GEMINI_API_KEY = "AIzaSy-test-gemini-key-12345";
    process.env.GEMINI_GROUNDING_API_KEY = "AIzaSy-dedicated-12345";
    process.env.AI_API_KEY = "AIzaSy-existing-ai-key-12345";
    process.env.AI_API_URL =
      "https://generativelanguage.googleapis.com/v1beta/openai/";
    expect(resolveTavilyKey()).toBeNull();
    expect(getWebSearchClient()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats a placeholder key as unconfigured", () => {
    process.env.TAVILY_API_KEY = "your-tavily-api-key";
    expect(resolveTavilyKey()).toBeNull();
    expect(getWebSearchClient()).toBeNull();
  });

  it("returns a client named tavily when a key is configured", () => {
    process.env.TAVILY_API_KEY = "tvly-test-key-abcdef123456";
    const client = getWebSearchClient();
    expect(client?.name).toBe("tavily");
    // Discovery-only phase: no structured mode, so enrichment never spends a
    // provider request per company.
    expect(client?.searchStructured).toBeUndefined();
  });
});

describe("tavily search (mocked fetch)", () => {
  const fetchMock = vi.fn();
  const KEY = "tvly-test-key-abcdef123456";

  function clientWithKey() {
    process.env.TAVILY_API_KEY = KEY;
    const client = getWebSearchClient();
    if (!client) throw new Error("expected a client");
    return client;
  }

  beforeEach(() => {
    resetEnv();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    resetTavilyDiagnostics();
    clearTavilyMemoryCache();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    resetEnv();
  });

  it("calls the official Tavily endpoint with Bearer auth and maps results", async () => {
    fetchMock.mockResolvedValue(
      tavilyResponse([
        {
          title: "Ausbildung Mechatroniker 2027",
          url: "https://www.azubiyo.de/ausbildung/mechatroniker?utm_source=x",
          content: "Ausbildung 2027 in Berlin – jetzt bewerben.",
          score: 0.91,
        },
      ]),
    );
    const client = clientWithKey();
    const results = await client.search("Mechatroniker Ausbildung 2027", 10);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(TAVILY_SEARCH_URL);
    expect(url).toBe("https://api.tavily.com/search");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.query).toBe("Mechatroniker Ausbildung 2027");
    expect(body.search_depth).toBe("basic");
    expect(body.max_results).toBe(10);

    // title / url / content(snippet) / score / domain mapping.
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      title: "Ausbildung Mechatroniker 2027",
      url: "https://azubiyo.de/ausbildung/mechatroniker?utm_source=x",
      snippet: "Ausbildung 2027 in Berlin – jetzt bewerben.",
      score: 0.91,
      domain: "azubiyo.de",
    });
  });

  it("never calls a Gemini endpoint (no Google Search grounding)", async () => {
    fetchMock.mockResolvedValue(tavilyResponse([]));
    const client = clientWithKey();
    await client.search("q", 5);
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).not.toContain("generativelanguage.googleapis.com");
      expect(String(call[0])).not.toContain("google_search");
      expect(String(call[0])).toBe(TAVILY_SEARCH_URL);
    }
  });

  it("caps requests at the per-search-operation budget", async () => {
    fetchMock.mockImplementation(async () => tavilyResponse([]));
    const client = clientWithKey();
    for (let i = 0; i < MAX_TAVILY_REQUESTS_PER_RUN + 3; i += 1) {
      await client.search(`query-${i}`, 5);
    }
    // Budget exhausted: no network call after it is spent, no retry loop.
    expect(fetchMock).toHaveBeenCalledTimes(MAX_TAVILY_REQUESTS_PER_RUN);
  });

  it("raises the default budget to 30, keeping a higher cost-protection cap", () => {
    expect(DEFAULT_TAVILY_REQUESTS_PER_RUN).toBe(30);
    // The compatibility name is the DEFAULT, not the old floor of 3.
    expect(MAX_TAVILY_REQUESTS_PER_RUN).toBe(30);
    // The hard cap is strictly higher: deployments can raise the default
    // without ever exceeding the cost ceiling.
    expect(MAX_TAVILY_REQUESTS_HARD_CAP).toBeGreaterThanOrEqual(60);
  });

  it("clamps an explicit maxRequests into the hard cost cap", async () => {
    process.env.TAVILY_API_KEY = KEY;
    fetchMock.mockImplementation(async () => tavilyResponse([]));
    const client = getWebSearchClient({ maxRequests: 9_999 });
    if (!client) throw new Error("expected a client");
    for (let i = 0; i < MAX_TAVILY_REQUESTS_HARD_CAP + 5; i += 1) {
      await client.search(`query-${i}`, 5);
    }
    expect(fetchMock).toHaveBeenCalledTimes(MAX_TAVILY_REQUESTS_HARD_CAP);
  });

  it("honours TAVILY_MAX_REQUESTS_PER_RUN (env-tunable, clamped)", async () => {
    process.env.TAVILY_API_KEY = KEY;
    process.env.TAVILY_MAX_REQUESTS_PER_RUN = "5";
    fetchMock.mockImplementation(async () => tavilyResponse([]));
    const client = getWebSearchClient();
    if (!client) throw new Error("expected a client");
    for (let i = 0; i < 8; i += 1) await client.search(`q-${i}`, 5);
    expect(fetchMock).toHaveBeenCalledTimes(5);

    // Invalid → the safe default; above the cap → the cap.
    process.env.TAVILY_MAX_REQUESTS_PER_RUN = "abc";
    expect(defaultTavilyBudget()).toBe(DEFAULT_TAVILY_REQUESTS_PER_RUN);
    process.env.TAVILY_MAX_REQUESTS_PER_RUN = "9999";
    expect(defaultTavilyBudget()).toBe(MAX_TAVILY_REQUESTS_HARD_CAP);
    delete process.env.TAVILY_MAX_REQUESTS_PER_RUN;
    expect(defaultTavilyBudget()).toBe(DEFAULT_TAVILY_REQUESTS_PER_RUN);
  });

  it("removes duplicate URLs and duplicate (domain, title) pairs", async () => {
    fetchMock.mockResolvedValue(
      tavilyResponse([
        {
          title: "Ausbildung 2027",
          url: "https://firma.de/karriere/a?utm_source=x",
          content: "a",
          score: 0.9,
        },
        // Same page (www + trailing slash) → one result.
        {
          title: "Ausbildung 2027",
          url: "https://www.firma.de/karriere/a/",
          content: "b",
          score: 0.8,
        },
        // Same company page, different URL → deduped by (domain, title).
        {
          title: "ausbildung 2027",
          url: "https://firma.de/karriere/a-2",
          content: "c",
          score: 0.7,
        },
        {
          title: "Andere Stelle",
          url: "https://firma.de/karriere/b",
          content: "d",
          score: 0.6,
        },
      ]),
    );
    const client = clientWithKey();
    const results = await client.search("q", 10);
    expect(results.map((r) => r.url)).toEqual([
      "https://firma.de/karriere/a?utm_source=x",
      "https://firma.de/karriere/b",
    ]);
  });

  it("drops malformed / non-http(s) results", async () => {
    fetchMock.mockResolvedValue(
      tavilyResponse([
        { title: "ok", url: "https://firma.de/a", content: "x" },
        { title: "bad", url: "not-a-url", content: "x" },
        { title: "ftp", url: "ftp://firma.de/b", content: "x" },
        { title: "no-url" },
      ]),
    );
    const client = clientWithKey();
    const results = await client.search("q", 10);
    expect(results).toHaveLength(1);
    expect(results[0].url).toBe("https://firma.de/a");
    expect(results[0].score).toBeUndefined();
  });

  it("maps provider errors to controlled, key-free WebSearchError statuses", async () => {
    const cases: Array<{
      status: number;
      statusWord: string;
      detail: unknown;
    }> = [
      {
        status: 401,
        statusWord: "UNAUTHORIZED",
        detail: { error: "Unauthorized: missing or invalid API key." },
      },
      {
        status: 429,
        statusWord: "RATE_LIMITED",
        detail: { error: "Your request has been blocked due to excessive requests." },
      },
      {
        status: 433,
        statusWord: "USAGE_LIMIT",
        detail: { error: "This request exceeds the pay-as-you-go limit." },
      },
      { status: 400, statusWord: "INVALID_REQUEST", detail: { error: "Bad request" } },
      {
        status: 500,
        statusWord: "PROVIDER_ERROR",
        detail: { error: "Internal Server Error" },
      },
    ];
    for (const testCase of cases) {
      fetchMock.mockReset();
      clearTavilyMemoryCache();
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ detail: testCase.detail }), {
          status: testCase.status,
          headers: { "content-type": "application/json" },
        }),
      );
      const client = clientWithKey();
      const error = (await client
        .search(`q-${testCase.status}`, 5)
        .catch((e: unknown) => e)) as WebSearchError;
      expect(error).toBeInstanceOf(WebSearchError);
      expect(error.status).toBe(testCase.status);
      expect(error.code).toBe(testCase.status);
      expect(error.providerStatus).toBe(testCase.statusWord);
      // The provider's own words are kept for the diagnostics card.
      expect(typeof error.providerMessage).toBe("string");
      expect(error.message).toContain(`HTTP ${testCase.status}`);
      expect(error.message).not.toContain(KEY);
    }
  });

  it("keeps the key out of errors and out of the logs (scrubbed)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    resetTavilyDiagnostics();
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ detail: { error: `Unauthorized: invalid key ${KEY}` } }),
        { status: 401, headers: { "content-type": "application/json" } },
      ),
    );
    const client = clientWithKey();
    const error = (await client
      .search("q", 5)
      .catch((e: unknown) => e)) as WebSearchError;

    expect(error.message).not.toContain(KEY);
    const logged = [...warnSpy.mock.calls, ...errorSpy.mock.calls]
      .map((call) => String(call[0]))
      .join("\n");
    expect(logged).not.toContain(KEY);
    expect(logged).toContain("[key-redacted]");
    // The diagnostic names the request and the safe status.
    expect(logged).toContain("[TAVILY]");
    expect(logged).toContain("code=401/UNAUTHORIZED");

    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("reports an unreachable provider with a controlled message", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const client = clientWithKey();
    const error = (await client
      .search("q", 5)
      .catch((e: unknown) => e)) as WebSearchError;
    expect(error).toBeInstanceOf(WebSearchError);
    expect(error.status).toBeNull();
    expect(error.message).toBe(
      "The web search provider was unreachable (network or timeout).",
    );
  });

  it("caches identical queries (no second request)", async () => {
    fetchMock.mockImplementation(async () =>
      tavilyResponse([{ title: "t", url: "https://firma.de/a", content: "c" }]),
    );
    const client = clientWithKey();
    const first = await client.search("same query", 10);
    const second = await client.search("same query", 10);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    // Cache reset (tests / TTL eviction path) → a new request is made.
    clearTavilyMemoryCache();
    await client.search("same query", 10);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns [] for an empty result list and logs it honestly", async () => {
    resetTavilyDiagnostics();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValue(tavilyResponse([]));
    const client = clientWithKey();
    await expect(client.search("q", 10)).resolves.toEqual([]);
    const line = warnSpy.mock.calls
      .map((call) => String(call[0]))
      .find((l) => l.includes("no usable results"));
    expect(line).toContain("[TAVILY]");
    expect(line).toContain("http=200");
    warnSpy.mockRestore();
  });
});
