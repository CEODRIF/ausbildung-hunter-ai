import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getWebSearchClient,
  resolveGeminiGroundingKey,
  WebSearchError,
} from "@/lib/web-search";

/**
 * Web-search client (Gemini + Google Search Grounding).
 * Selection logic uses the real module (env manipulated per test);
 * `search()` behavior runs against a mocked global fetch — the grounding
 * metadata (NOT model text) must be the only URL source.
 */

const AI_STUDIO_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai/";

function groundingResponse(chunks: unknown, pages: unknown = []) {
  return Response.json({
    candidates: [
      {
        content: { parts: [{ text: "see search results" }] },
        groundingMetadata: {
          groundingChunks: chunks,
          searchGroundingMetadata: { dynamicSearchPages: pages },
        },
      },
    ],
  });
}

describe("getWebSearchClient / resolveGeminiGroundingKey", () => {
  const ORIGINAL = { ...process.env };
  afterEach(() => {
    process.env = { ...ORIGINAL };
  });

  function clean() {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_GROUNDING_MODEL;
    delete process.env.AI_API_KEY;
    delete process.env.AI_API_URL;
  }

  it("returns null without any key (graceful degradation)", () => {
    clean();
    expect(resolveGeminiGroundingKey()).toBeNull();
    expect(getWebSearchClient()).toBeNull();
  });

  it("uses the explicit GEMINI_API_KEY when it is a real key", () => {
    clean();
    process.env.GEMINI_API_KEY = "AIzaSy-test-gemini-key-12345";
    expect(resolveGeminiGroundingKey()).toBe("AIzaSy-test-gemini-key-12345");
    expect(getWebSearchClient()?.name).toBe("gemini_grounding");
  });

  it("treats placeholder keys as unconfigured", () => {
    clean();
    process.env.GEMINI_API_KEY = "your-gemini-api-key";
    expect(getWebSearchClient()).toBeNull();
  });

  it("reuses AI_API_KEY when the AI endpoint is Google AI Studio", () => {
    clean();
    process.env.AI_API_KEY = "AIzaSy-existing-ai-key-12345";
    process.env.AI_API_URL = AI_STUDIO_URL;
    expect(resolveGeminiGroundingKey()).toBe("AIzaSy-existing-ai-key-12345");
    expect(getWebSearchClient()?.name).toBe("gemini_grounding");
  });

  it("does NOT reuse AI_API_KEY for non-Google AI endpoints", () => {
    clean();
    process.env.AI_API_KEY = "sk-a-very-long-provider-key-12345";
    process.env.AI_API_URL = "https://api.openai.com/v1";
    expect(resolveGeminiGroundingKey()).toBeNull();
    expect(getWebSearchClient()).toBeNull();
  });

  it("explicit GEMINI_API_KEY wins over the reused AI key", () => {
    clean();
    process.env.AI_API_KEY = "AIzaSy-existing-ai-key-12345";
    process.env.AI_API_URL = AI_STUDIO_URL;
    process.env.GEMINI_API_KEY = "AIzaSy-explicit-gemini-key-999";
    expect(resolveGeminiGroundingKey()).toBe("AIzaSy-explicit-gemini-key-999");
  });
});

describe("geminiGroundingSearch (mocked fetch)", () => {
  const ORIGINAL = { ...process.env };
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...ORIGINAL };
  });

  function clientWithKey(key = "AIzaSy-test-gemini-key-12345") {
    delete process.env.AI_API_KEY;
    delete process.env.AI_API_URL;
    process.env.GEMINI_API_KEY = key;
    const client = getWebSearchClient();
    if (!client) throw new Error("expected a client");
    return client;
  }

  it("sends the grounding request (tool, default model, key header)", async () => {
    fetchMock.mockResolvedValue(
      groundingResponse([
        { web: { uri: "https://example.test/job", title: "Ausbildung 2027" } },
      ]),
    );
    const client = clientWithKey();
    await client.search("site:ausbildung.de kaufmann", 10);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent",
    );
    expect(init?.headers["x-goog-api-key"]).toBe(keyValue());
    const body = JSON.parse(init?.body as string);
    expect(body.tools).toEqual([{ google_search: {} }]);
    expect(body.contents[0].parts[0].text).toContain(
      "site:ausbildung.de kaufmann",
    );

    function keyValue() {
      return "AIzaSy-test-gemini-key-12345";
    }
  });

  it("honors GEMINI_GROUNDING_MODEL", async () => {
    process.env.GEMINI_GROUNDING_MODEL = "gemini-2.5-flash";
    fetchMock.mockResolvedValue(groundingResponse([]));
    const client = clientWithKey();
    await client.search("q", 5);
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      "/models/gemini-2.5-flash:generateContent",
    );
  });

  it("maps grounding chunks to results (https only, deduped, capped)", async () => {
    fetchMock.mockResolvedValue(
      groundingResponse(
        [
          { web: { uri: "https://a.test/1", title: "One" } },
          { web: { uri: "https://a.test/1#anchor", title: "One again" } },
          { web: { uri: "http://insecure.test/2", title: "Insecure" } },
          { web: { uri: "not-a-url", title: "Broken" } },
          { web: { uri: "https://b.test/3", title: "Three" } },
        ],
        ["https://a.test/1", "https://c.test/4"],
      ),
    );
    const client = clientWithKey();
    const results = await client.search("q", 10);
    expect(results).toEqual([
      { title: "One", url: "https://a.test/1", snippet: "" },
      { title: "Three", url: "https://b.test/3", snippet: "" },
      { title: "", url: "https://c.test/4", snippet: "" },
    ]);
  });

  it("caps results at maxResults", async () => {
    fetchMock.mockResolvedValue(
      groundingResponse(
        Array.from(
          { length: 6 },
          (_, i) => ({
            web: { uri: `https://m.test/${i}`, title: `T${i}` },
          }),
        ),
      ),
    );
    const client = clientWithKey();
    const results = await client.search("q", 3);
    expect(results.map((r) => r.url)).toEqual([
      "https://m.test/0",
      "https://m.test/1",
      "https://m.test/2",
    ]);
  });

  it("returns [] when the search produced no grounding metadata", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ candidates: [{ content: { parts: [{ text: "none" }] } }] }),
    );
    const client = clientWithKey();
    await expect(client.search("q", 10)).resolves.toEqual([]);
  });

  it("maps provider errors to controlled WebSearchError statuses", async () => {
    const client = clientWithKey();
    for (const [status, messagePart] of [
      [401, "rejected the configured key"],
      [403, "rejected the configured key"],
      [429, "rate limit"],
      [500, "temporarily unavailable"],
      [400, "rejected the request"],
    ] as const) {
      fetchMock.mockResolvedValueOnce(
        new Response("err", { status, statusText: "ERR" }),
      );
      await expect(client.search("q", 10)).rejects.toMatchObject({
        name: "WebSearchError",
        status,
        message: expect.stringContaining(messagePart),
      });
    }
  });

  it("keeps the key out of error messages", async () => {
    const client = clientWithKey("AIzaSy-super-secret-key-1234567");
    fetchMock.mockResolvedValue(
      new Response("err", { status: 403, statusText: "ERR" }),
    );
    const error = await client.search("q", 10).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WebSearchError);
    expect(String((error as Error).message)).not.toContain(
      "AIzaSy-super-secret-key-1234567",
    );
  });
});
