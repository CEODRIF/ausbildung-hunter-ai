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
