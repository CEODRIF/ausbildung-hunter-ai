import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getWebSearchClient,
  resetGroundingDiagnostics,
  resolveGeminiGroundingKey,
  resolveGeminiGroundingKeySource,
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
    delete process.env.GEMINI_GROUNDING_API_KEY;
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

  it("dedicated GEMINI_GROUNDING_API_KEY wins over GEMINI_API_KEY", () => {
    clean();
    process.env.GEMINI_API_KEY = "AIzaSy-shared-gemini-key-11111";
    process.env.GEMINI_GROUNDING_API_KEY = "AIzaSy-dedicated-grounding-22222";
    expect(resolveGeminiGroundingKey()).toBe("AIzaSy-dedicated-grounding-22222");
    expect(resolveGeminiGroundingKeySource()).toBe("GEMINI_GROUNDING_API_KEY");
  });

  it("dedicated GEMINI_GROUNDING_API_KEY wins over the reused AI key", () => {
    clean();
    process.env.AI_API_KEY = "AIzaSy-existing-ai-key-12345";
    process.env.AI_API_URL = AI_STUDIO_URL;
    process.env.GEMINI_GROUNDING_API_KEY = "AIzaSy-dedicated-grounding-22222";
    expect(resolveGeminiGroundingKey()).toBe("AIzaSy-dedicated-grounding-22222");
    expect(resolveGeminiGroundingKeySource()).toBe("GEMINI_GROUNDING_API_KEY");
  });

  it("falls back to GEMINI_API_KEY when no dedicated grounding key is set", () => {
    clean();
    process.env.GEMINI_API_KEY = "AIzaSy-shared-gemini-key-11111";
    expect(resolveGeminiGroundingKey()).toBe("AIzaSy-shared-gemini-key-11111");
    expect(resolveGeminiGroundingKeySource()).toBe("GEMINI_API_KEY");
  });

  it("treats a placeholder dedicated key as unconfigured (falls through)", () => {
    clean();
    process.env.GEMINI_GROUNDING_API_KEY = "your-dedicated-grounding-key";
    process.env.GEMINI_API_KEY = "AIzaSy-shared-gemini-key-11111";
    expect(resolveGeminiGroundingKey()).toBe("AIzaSy-shared-gemini-key-11111");
    expect(resolveGeminiGroundingKeySource()).toBe("GEMINI_API_KEY");
  });

  it("reports AI_API_KEY as the source when reused on a Google endpoint", () => {
    clean();
    process.env.AI_API_KEY = "AIzaSy-existing-ai-key-12345";
    process.env.AI_API_URL = AI_STUDIO_URL;
    expect(resolveGeminiGroundingKeySource()).toBe("AI_API_KEY");
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

// ---------------------------------------------------------------------------
// Safe diagnostics + model fallback (production web=0 root-cause visibility)
// ---------------------------------------------------------------------------
describe("gemini grounding diagnostics & model fallback", () => {
  const ORIGINAL = { ...process.env };
  const fetchMock = vi.fn();
  let warnSpy!: ReturnType<typeof vi.spyOn>;
  let infoSpy!: ReturnType<typeof vi.spyOn>;

  // Fresh spies per test: mockRestore() in afterEach would otherwise leave
  // console un-patched for the remaining tests in this describe.
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    resetGroundingDiagnostics();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...ORIGINAL };
    warnSpy?.mockRestore();
    infoSpy?.mockRestore();
  });

  function clientWithKey(key = "AIzaSy-test-gemini-key-12345") {
    delete process.env.AI_API_KEY;
    delete process.env.AI_API_URL;
    process.env.GEMINI_API_KEY = key;
    // NOTE: GEMINI_GROUNDING_MODEL is intentionally left untouched here —
    // individual tests set it (the model is read at CALL time).
    const client = getWebSearchClient();
    if (!client) throw new Error("expected a client");
    return client;
  }

  function geminiError(status: number, body: unknown) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  it("stale/shut-down model (404) → ONE fallback to gemini-2.5-flash, then success", async () => {
    // Production scenario: GEMINI_GROUNDING_MODEL still points at a
    // shut-down model (e.g. gemini-2.0-flash) → every call 404s.
    process.env.GEMINI_GROUNDING_MODEL = "gemini-2.0-flash";
    fetchMock
      .mockResolvedValueOnce(
        geminiError(404, {
          error: {
            code: 404,
            status: "NOT_FOUND",
            message: "models/gemini-2.0-flash is not found for API key.",
          },
        }),
      )
      .mockResolvedValueOnce(
        groundingResponse([
          { web: { uri: "https://example.test/job", title: "Ausbildung 2027" } },
        ]),
      );
    const client = clientWithKey();
    const results = await client.search("q", 5);

    expect(results).toEqual([
      { title: "Ausbildung 2027", url: "https://example.test/job", snippet: "" },
    ]);
    // Exactly two calls: the failed model + the fallback — no retry loops.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      "/models/gemini-2.0-flash:generateContent",
    );
    expect(String(fetchMock.mock.calls[1][0])).toContain(
      "/models/gemini-2.5-flash:generateContent",
    );
    // The fallback was announced in the safe diagnostics.
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes("retrying once with gemini-2.5-flash"))).toBe(true);
  });

  it("401 (bad key) → NO model fallback, structured error detail kept", async () => {
    fetchMock.mockResolvedValue(
      geminiError(401, {
        error: {
          code: 401,
          status: "PERMISSION_DENIED",
          message: "API key not valid. Please pass a valid API key.",
        },
      }),
    );
    const client = clientWithKey();
    const error = (await client.search("q", 10).catch((e: unknown) => e)) as WebSearchError;
    expect(error).toBeInstanceOf(WebSearchError);
    expect(error.status).toBe(401);
    expect(error.geminiCode).toBe(401);
    expect(error.geminiStatus).toBe("PERMISSION_DENIED");
    // The model the call was sent to travels with the error (UI detail).
    expect(error.model).toBe("gemini-2.5-flash-lite");
    // Controlled, key-free phrase — safe for UI/log surfaces.
    expect(error.message).toContain("rejected the configured key");
    expect(error.message).toContain("HTTP 401");
    // One call only — a key problem is not fixed by switching models.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("diagnostic log line: model + http + gemini code/message — NEVER the key", async () => {
    resetGroundingDiagnostics(); // fresh warn budget (earlier tests spent it)
    const client = clientWithKey("AIzaSy-super-secret-key-1234567");
    fetchMock.mockResolvedValue(
      geminiError(403, {
        error: {
          code: 403,
          status: "PERMISSION_DENIED",
          // Even if Google ever echoed key material: it must be scrubbed.
          message: "API key AIzaSy-super-secret-key-1234567 has no access",
        },
      }),
    );
    await client.search("q", 10).catch(() => {});

    const line = warnSpy.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith("[GEMINI_GROUNDING]"));
    expect(line).toBeDefined();
    expect(line).toContain("model=gemini-2.5-flash-lite");
    expect(line).toContain("http=403");
    expect(line).toContain("gemini=403/PERMISSION_DENIED");
    expect(line).not.toContain("AIzaSy-super-secret-key-1234567");
    expect(line).toContain("[key-redacted]");
    // Duration is captured (the user asked to keep it for triage).
    expect(line).toMatch(/durationMs=\d+/);
  });

  it("diagnostic line names the env var that supplied the key (never its value)", async () => {
    resetGroundingDiagnostics();
    delete process.env.GEMINI_API_KEY;
    delete process.env.AI_API_KEY;
    delete process.env.AI_API_URL;
    process.env.GEMINI_GROUNDING_API_KEY = "AIzaSy-dedicated-grounding-33333";
    const client = getWebSearchClient();
    if (!client) throw new Error("expected a client from the dedicated key");
    fetchMock.mockResolvedValue(
      geminiError(403, {
        error: {
          code: 403,
          status: "PERMISSION_DENIED",
          message: "API key invalid.",
        },
      }),
    );
    await client.search("q", 10).catch(() => {});
    const line = warnSpy
      .mock.calls.map((c) => String(c[0]))
      .find((l) => l.startsWith("[GEMINI_GROUNDING]"));
    // Production can verify WHICH key was used from the function logs —
    // by name only.
    expect(line).toContain("source=GEMINI_GROUNDING_API_KEY");
    expect(line).not.toContain("AIzaSy-dedicated-grounding-33333");
  });

  it("HTTP 200 but NO grounding metadata → [] + honest warning (tool not accepted?)", async () => {
    resetGroundingDiagnostics();
    fetchMock.mockResolvedValue(
      Response.json({
        candidates: [{ content: { parts: [{ text: "none" }] } }],
      }),
    );
    const client = clientWithKey();
    await expect(client.search("q", 10)).resolves.toEqual([]);
    const line = warnSpy.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes("groundingChunks=0"));
    expect(line).toBeDefined();
    expect(line).toContain("NO grounding metadata");
    expect(line).toContain("model=gemini-2.5-flash-lite");
  });

  it("searchStructured: same fallback + diagnostics apply", async () => {
    process.env.GEMINI_GROUNDING_MODEL = "gemini-2.0-flash";
    const schema = {
      properties: {
        officialWebsite: { type: "STRING" as const },
      },
      required: ["officialWebsite"],
    };
    fetchMock
      .mockResolvedValueOnce(
        geminiError(404, {
          error: {
            code: 404,
            status: "NOT_FOUND",
            message: "models/gemini-2.0-flash is not found.",
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          candidates: [
            {
              content: {
                parts: [
                  { text: '{"officialWebsite":"https://www.beispiel-gmbh.de"}' },
                ],
              },
              groundingMetadata: {
                groundingChunks: [
                  { web: { uri: "https://www.beispiel-gmbh.de", title: "Beispiel" } },
                ],
              },
            },
          ],
        }),
      );
    const client = clientWithKey();
    const out = await client.searchStructured!("official website of Beispiel GmbH", schema);
    expect(out.data.officialWebsite).toBe("https://www.beispiel-gmbh.de");
    expect(out.results).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
