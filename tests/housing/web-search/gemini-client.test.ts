import { describe, expect, it, vi } from "vitest";

import { geminiWebSearch, parseGeminiPayload } from "@/lib/housing/web-search/gemini-client";
import { WebSearchApiError } from "@/lib/housing/web-search/azure-client";

/** Documented Interactions-API shape (google_search_call + model_output). */
function interactionsPayload(
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

const A = { url: "https://immobilienscout24.de/expose/111222333", title: "A" };
const B = { url: "https://immowelt.de/expose/444555666", title: "B" };

describe("parseGeminiPayload — documented shape", () => {
  it("reads citations, sources and the EXECUTED queries (billable unit)", () => {
    const p = parseGeminiPayload(interactionsPayload([A, B], ["q1", "q2"]));
    expect(p.citations.map((c) => c.url)).toEqual([A.url, B.url]);
    expect(p.citations.map((c) => c.title)).toEqual(["A", "B"]);
    expect(p.sources).toEqual([A.url, B.url]);
    expect(p.queries).toEqual(["q1", "q2"]);
    // Billable unit = executed search queries (empty ones are ignored).
    expect(p.numRequests).toBe(2);
    expect(p.webSearchCalls).toBe(1);
    expect(p.text).toBe("Angebote gefunden.");
  });

  it("dedupes repeated citation urls", () => {
    const p = parseGeminiPayload(interactionsPayload([A, A, B]));
    expect(p.citations).toHaveLength(2);
    expect(p.sources).toHaveLength(2);
  });

  it("counts a single-query spelling (arguments.query string)", () => {
    const payload = {
      interaction: {
        steps: [
          { type: "google_search_call", arguments: { query: "WG Zimmer Köln" } },
        ],
      },
    };
    const p = parseGeminiPayload(payload);
    expect(p.queries).toEqual(["WG Zimmer Köln"]);
    expect(p.numRequests).toBe(1);
  });
});

describe("parseGeminiPayload — defensive legacy shape (generateContent)", () => {
  it("reads candidates[] + groundingMetadata chunks", () => {
    const payload = {
      candidates: [
        {
          content: {
            parts: [
              { text: "Antwort.", annotations: [{ type: "url_citation", url: A.url, title: A.title }] },
            ],
          },
          groundingMetadata: {
            groundingChunks: [{ web: { uri: B.url, title: B.title } }],
            searchQueries: ["q-legacy"],
          },
        },
      ],
    };
    const p = parseGeminiPayload(payload);
    expect(p.citations.map((c) => c.url)).toEqual([A.url, B.url]);
    expect(p.queries).toEqual(["q-legacy"]);
    expect(p.numRequests).toBe(1);
  });

  it("harvests real URLs from the model text when no citations surfaced", () => {
    const payload = {
      interaction: {
        steps: [
          {
            type: "model_output",
            content: [{ text: `Siehe ${A.url} und ${B.url}.` }],
          },
        ],
      },
    };
    const p = parseGeminiPayload(payload);
    expect(p.sources).toContain(A.url);
    expect(p.sources).toContain(B.url);
  });

  it("never throws on garbage input", () => {
    expect(parseGeminiPayload(null).text).toBe("");
    expect(parseGeminiPayload({}).webSearchCalls).toBe(0);
    expect(parseGeminiPayload("string").numRequests ?? 0).toBe(0);
    expect(() => parseGeminiPayload(undefined)).not.toThrow();
  });
});

describe("geminiWebSearch — transport + security", () => {
  const KEY = "test-gemini-key-123";

  it("posts to /interactions with the key in the x-goog-api-key header only", async () => {
    const fetchImpl = vi.fn(async () => Response.json(interactionsPayload([A])));
    await geminiWebSearch({ key: KEY, model: "gemini-3.5-flash", input: "q", fetchImpl: fetchImpl as unknown as typeof fetch });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe(KEY);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.model).toBe("gemini-3.5-flash");
    expect(body.tools).toEqual([{ type: "google_search" }]);
    expect(String(init.body)).not.toContain(KEY); // key never in the body
  });

  it("supports a base-URL override (tests)", async () => {
    const fetchImpl = vi.fn(async () => Response.json(interactionsPayload([A])));
    await geminiWebSearch({ key: KEY, model: "m", input: "q", fetchImpl: fetchImpl as unknown as typeof fetch, baseUrl: "https://gemini.test/v1beta/" });
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe("https://gemini.test/v1beta/interactions");
  });

  it("maps 401/403 → tool_blocked, 404 → endpoint_unavailable, 429 → rate_limited", async () => {
    for (const [status, failure] of [
      [401, "tool_blocked"],
      [403, "tool_blocked"],
      [404, "endpoint_unavailable"],
      [429, "rate_limited"],
    ] as const) {
      const fetchImpl = vi.fn(
        async () => new Response("err", { status }),
      ) as unknown as typeof fetch;
      await expect(
        geminiWebSearch({ key: KEY, model: "m", input: "q", fetchImpl }),
      ).rejects.toMatchObject({ failure });
    }
  });

  describe("error diagnostics (production root-cause, no secrets)", () => {
    // The 2026-10-10 production defect: an unknown model name (the old
    // default "gemini-3.5-flash" is not in the official grounding
    // supported-models table) → HTTP 404 + api status NOT_FOUND. The
    // diagnostics must carry exactly that (HTTP status + machine status),
    // never the provider's message text (it can echo request details),
    // never the key.
    it("404 NOT_FOUND (unknown model) → endpoint_unavailable with the machine status in the message", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const body = JSON.stringify({
        error: {
          code: 404,
          message: "models/gemini-3.5-flash is not found (request id abc)",
          status: "NOT_FOUND",
        },
      });
      const server404 = vi.fn(async () =>
        new Response(body, { status: 404, headers: { "content-type": "application/json" } }),
      );
      const err = await geminiWebSearch({
        key: KEY,
        model: "gemini-3.5-flash",
        input: "q",
        fetchImpl: server404 as unknown as typeof fetch,
      }).catch((e) => e);
      expect(err).toBeInstanceOf(WebSearchApiError);
      expect(err.failure).toBe("endpoint_unavailable");
      expect(err.httpStatus).toBe(404);
      expect(err.message).toContain("HTTP 404");
      expect(err.message).toContain("NOT_FOUND");
      // The provider's free-text message body is NEVER echoed.
      expect(err.message).not.toContain("is not found (request");
      // The log line carries the safe machine status only.
      expect(warn.mock.calls[0]?.[0]).toContain("http=404");
      expect(warn.mock.calls[0]?.[0]).toContain("api_status=NOT_FOUND");
      expect(warn.mock.calls[0]?.[0]).not.toContain("request id abc");
      warn.mockRestore();
    });

    it("400 INVALID_ARGUMENT → provider_error with the machine status", async () => {
      const body = JSON.stringify({
        error: { code: 400, message: "tools[0].type invalid", status: "INVALID_ARGUMENT" },
      });
      const server400 = vi.fn(async () =>
        new Response(body, { status: 400, headers: { "content-type": "application/json" } }),
      );
      const err = await geminiWebSearch({
        key: KEY,
        model: "m",
        input: "q",
        fetchImpl: server400 as unknown as typeof fetch,
      }).catch((e) => e);
      expect(err).toBeInstanceOf(WebSearchApiError);
      expect(err.failure).toBe("provider_error");
      expect(err.message).toContain("INVALID_ARGUMENT");
      expect(err.message).not.toContain("tools[0].type");
    });

    it("403 PERMISSION_DENIED → tool_blocked with the machine status", async () => {
      const body = JSON.stringify({
        error: { code: 403, message: "API key not valid", status: "PERMISSION_DENIED" },
      });
      const server403 = vi.fn(async () =>
        new Response(body, { status: 403, headers: { "content-type": "application/json" } }),
      );
      const err = await geminiWebSearch({
        key: KEY,
        model: "m",
        input: "q",
        fetchImpl: server403 as unknown as typeof fetch,
      }).catch((e) => e);
      expect(err).toBeInstanceOf(WebSearchApiError);
      expect(err.failure).toBe("tool_blocked");
      expect(err.message).toContain("PERMISSION_DENIED");
      expect(err.message).not.toContain("API key not valid");
    });

    it("non-JSON error body → still a controlled message, no crash", async () => {
      const server502 = vi.fn(async () => new Response("<html>bad gateway</html>", { status: 502 }));
      const err = await geminiWebSearch({
        key: KEY,
        model: "m",
        input: "q",
        fetchImpl: server502 as unknown as typeof fetch,
      }).catch((e) => e);
      expect(err).toBeInstanceOf(WebSearchApiError);
      expect(err.failure).toBe("provider_error");
      expect(err.message).toBe("The Google search provider rejected the request (HTTP 502).");
    });

    it("never leaks the key in error messages or logs", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const body = JSON.stringify({ error: { code: 404, message: "not found", status: "NOT_FOUND" } });
      const server404 = vi.fn(async () =>
        new Response(body, { status: 404, headers: { "content-type": "application/json" } }),
      );
      const err = await geminiWebSearch({
        key: "secret-key-abc",
        model: "m",
        input: "q",
        fetchImpl: server404 as unknown as typeof fetch,
      }).catch((e) => e);
      expect(err.message).not.toContain("secret-key-abc");
      for (const call of warn.mock.calls) {
        for (const arg of call) expect(String(arg)).not.toContain("secret-key-abc");
      }
      warn.mockRestore();
    });
  });

  it("maps 5xx / network / timeout to controlled, key-free messages", async () => {
    const server500 = vi.fn(async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    await expect(geminiWebSearch({ key: KEY, model: "m", input: "q", fetchImpl: server500 }))
      .rejects.toMatchObject({ name: "WebSearchApiError", failure: "provider_error" });

    const network = vi.fn(async () => {
      throw new Error("fetch failed");
    }) as unknown as typeof fetch;
    const netErr = await geminiWebSearch({ key: KEY, model: "m", input: "q", fetchImpl: network }).catch((e) => e);
    expect(netErr).toBeInstanceOf(WebSearchApiError);
    expect(netErr.failure).toBe("provider_error");
    expect(netErr.message).not.toContain(KEY);

    // AbortSignal.timeout raises an error named "TimeoutError" — mapped to
    // "timeout" (not provider_error: clear separation of failure causes).
    const timeout = vi.fn(async () => {
      const e = new Error("The operation was aborted due to timeout");
      e.name = "TimeoutError";
      throw e;
    }) as unknown as typeof fetch;
    const tErr = await geminiWebSearch({ key: KEY, model: "m", input: "q", fetchImpl: timeout }).catch(
      (e) => e,
    );
    expect(tErr).toBeInstanceOf(WebSearchApiError);
    expect(tErr.failure).toBe("timeout");
    expect(tErr.message).not.toContain(KEY);
  });

  it("fails not_configured before any network call when the key is empty", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(geminiWebSearch({ key: "", model: "m", input: "q", fetchImpl })).rejects.toMatchObject({
      failure: "not_configured",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
