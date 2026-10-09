import { describe, expect, it, vi } from "vitest";

import {
  azureWebSearch,
  parseResponsesPayload,
  WebSearchApiError,
} from "@/lib/housing/web-search/azure-client";

const BASE = "https://my-resource.openai.azure.com/openai/v1/"; // trailing slash on purpose
const KEY = "test-secret-key-123";
const MODEL = "gpt-5-mini";

/** Realistic Responses API payload (shape per official docs, 2026-10-09). */
function fullPayload() {
  return {
    id: "resp_1",
    output: [
      {
        id: "ws_1",
        type: "web_search_call",
        status: "completed",
        action: {
          type: "search",
          query: "Mietwohnung Köln bis 800 Euro Warmmiete",
          state: "search",
          sources: [
            "https://www.immobilienscout24.de/expose/123456789",
            { type: "url", url: "https://www.immowelt.de/expose/987654321" },
            "https://www.immobilienscout24.de/expose/123456789", // duplicate
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
            text: "Zwei passende Angebote gefunden. ",
            annotations: [
              {
                type: "url_citation",
                start_index: 0,
                end_index: 40,
                url: "https://www.immobilienscout24.de/expose/123456789",
                title: "2-Zimmer in Köln-Ehrenfeld",
              },
              {
                type: "url_citation",
                start_index: 40,
                end_index: 80,
                url: "https://www.immowelt.de/expose/987654321",
                title: "3-Zimmer in Köln-Sülz",
              },
              {
                type: "url_citation",
                start_index: 80,
                end_index: 80,
                url: "https://www.immobilienscout24.de/expose/123456789", // duplicate
                title: "ignored",
              },
              { type: "other_annotation", url: "https://not-a-citation.example" },
            ],
          },
          { type: "refusal" },
        ],
      },
      "not-an-object",
      null,
    ],
    tool_usage: { web_search: { num_requests: 2 } },
  };
}

describe("parseResponsesPayload", () => {
  it("extracts text, citations, sources, queries and billable count", () => {
    const p = parseResponsesPayload(fullPayload());
    expect(p.text).toBe("Zwei passende Angebote gefunden. ");
    expect(p.citations).toEqual([
      { url: "https://www.immobilienscout24.de/expose/123456789", title: "2-Zimmer in Köln-Ehrenfeld" },
      { url: "https://www.immowelt.de/expose/987654321", title: "3-Zimmer in Köln-Sülz" },
    ]);
    expect(p.sources).toEqual([
      "https://www.immobilienscout24.de/expose/123456789",
      "https://www.immowelt.de/expose/987654321",
    ]);
    expect(p.queries).toEqual(["Mietwohnung Köln bis 800 Euro Warmmiete"]);
    expect(p.numRequests).toBe(2);
    expect(p.webSearchCalls).toBe(1);
  });

  it("counts web_search_call items (0 when the model answered without the tool)", () => {
    // The official troubleshooting section documents exactly this case:
    // "If the model doesn't call the tool, prompt more explicitly…"
    const noTool = parseResponsesPayload({
      output: [
        {
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: "Ich rate aus dem Training: …", annotations: [] }],
        },
      ],
      output_text: "Ich rate aus dem Training: …",
    });
    expect(noTool.webSearchCalls).toBe(0);
    expect(noTool.citations).toEqual([]);
    expect(noTool.sources).toEqual([]);
  });

  it("accepts the OpenAI nested annotation spelling, queries[] arrays and open_page actions", () => {
    const p = parseResponsesPayload({
      output: [
        {
          type: "web_search_call",
          status: "completed",
          action: { type: "search", queries: ["Mietwohnung Köln", "rental Cologne"] },
        },
        {
          type: "web_search_call",
          status: "completed",
          action: { type: "open_page", url: "https://www.wg-gesucht.de/2-zimmer-koeln-123456789.html" },
        },
        {
          type: "reasoning",
          status: "completed",
          content: [{ type: "reasoning_summary_text", text: "thinking…" }],
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
                {
                  type: "url_citation",
                  url_citation: {
                    url: "https://www.immobilienscout24.de/expose/555555555",
                    title: "Nested spelling",
                  },
                },
              ],
            },
          ],
        },
      ],
    });
    expect(p.webSearchCalls).toBe(2);
    expect(p.queries).toEqual(["Mietwohnung Köln", "rental Cologne"]);
    expect(p.sources).toEqual(["https://www.wg-gesucht.de/2-zimmer-koeln-123456789.html"]);
    expect(p.citations).toEqual([
      { url: "https://www.immobilienscout24.de/expose/555555555", title: "Nested spelling" },
    ]);
  });

  it("uses top-level output_text when no message items exist", () => {
    const p = parseResponsesPayload({ output_text: "Kurze Antwort." });
    expect(p.text).toBe("Kurze Antwort.");
    expect(p.citations).toEqual([]);
    expect(p.numRequests).toBeNull();
  });

  it("survives malformed payloads (no throw, empty result)", () => {
    expect(parseResponsesPayload({})).toEqual({
      text: "",
      citations: [],
      sources: [],
      queries: [],
      numRequests: null,
      webSearchCalls: 0,
    });
    expect(parseResponsesPayload({ output: 42, tool_usage: "x" }).text).toBe("");
    const badNum = parseResponsesPayload({ tool_usage: { web_search: { num_requests: "abc" } } });
    expect(badNum.numRequests).toBeNull();
  });
});

describe("azureWebSearch", () => {
  it("sends the documented request shape with api-key header (no Bearer needed)", async () => {
    const fetchImpl = vi.fn(async () => Response.json(fullPayload()));
    await azureWebSearch({
      base: BASE,
      key: KEY,
      model: MODEL,
      input: "Mietwohnung Köln",
      allowedDomains: ["immobilienscout24.de", "open.nrw"],
      userLocation: { country: "DE", city: "Köln" },
      fetchImpl: fetchImpl as never,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://my-resource.openai.azure.com/openai/v1/responses");
    const headers = init.headers as Record<string, string>;
    expect(headers["api-key"]).toBe(KEY);
    expect(headers["content-type"]).toBe("application/json");
    const body = JSON.parse(String(init.body)) as {
      model: string;
      input: string;
      tools: Array<Record<string, unknown>>;
      tool_choice: string;
      include: string[];
      reasoning: { effort: string };
      max_output_tokens: number;
    };
    expect(body.model).toBe(MODEL);
    expect(body.input).toBe("Mietwohnung Köln");
    expect(body.reasoning).toEqual({ effort: "low" });
    expect(body.tool_choice).toBe("auto");
    expect(body.include).toEqual(["web_search_call.action.sources"]);
    expect(body.max_output_tokens).toBe(1500); // reasoning model: reasoning + cited answer share the budget
    const tool = body.tools[0];
    expect(tool.type).toBe("web_search");
    expect(tool.filters).toEqual({ allowed_domains: ["immobilienscout24.de", "open.nrw"] });
    expect(tool.user_location).toEqual({
      type: "approximate",
      country: "DE",
      city: "Köln",
      timezone: "Europe/Berlin",
    });
  });

  it("omits filters/user_location when not provided (general mode)", async () => {
    const fetchImpl = vi.fn(async () => Response.json(fullPayload()));
    await azureWebSearch({ base: BASE, key: KEY, model: MODEL, input: "q", fetchImpl: fetchImpl as never });
    const body = JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.tools[0].filters).toBeUndefined();
    expect(body.tools[0].user_location).toBeUndefined();
  });

  it("throws not_configured when base/key/model are missing (no network call)", async () => {
    const fetchImpl = vi.fn();
    await expect(
      azureWebSearch({ base: "", key: KEY, model: MODEL, input: "q", fetchImpl: fetchImpl as never }),
    ).rejects.toMatchObject({ failure: "not_configured" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("accepts the Foundry Services host (services.ai.azure.com) and posts to /openai/v1/responses", async () => {
    const svc = "https://aboukhadija065-5137-resource.services.ai.azure.com/openai/v1";
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ output_text: "ok" }));
    await expect(
      azureWebSearch({ base: svc, key: KEY, model: MODEL, input: "q", fetchImpl: fetchImpl as never }),
    ).resolves.toMatchObject({ text: "ok" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0][0])).toBe(`${svc}/responses`);
  });

  it("rejects malformed (non-Foundry) endpoint bases BEFORE any network call", async () => {
    const fetchImpl = vi.fn();
    for (const bad of [
      "https://api.openai.com/v1", // OpenAI standard API — wrong surface, wrong auth header
      "http://res.openai.azure.com/openai/v1", // not https
      "https://res.openai.azure.com", // missing /openai/v1 path
      "https://res.openai.azure.com/openai", // wrong path
      "https://res.openai.azure.com/openai/v2", // wrong path
      "not a url",
    ]) {
      await expect(
        azureWebSearch({ base: bad, key: KEY, model: MODEL, input: "q", fetchImpl: fetchImpl as never }),
      ).rejects.toMatchObject({ failure: "not_configured" });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    [401, "tool_blocked"],
    [403, "tool_blocked"],
    [404, "endpoint_unavailable"],
    [429, "rate_limited"],
    [500, "provider_error"],
  ] as const)("maps HTTP %i to %s without leaking the provider body", async (status, failure) => {
    const fetchImpl = vi.fn(async () => Response.json({ error: { message: "SECRET_PROVIDER_DETAIL" } }, { status }));
    const err = await azureWebSearch({
      base: BASE,
      key: KEY,
      model: MODEL,
      input: "q",
      fetchImpl: fetchImpl as never,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(WebSearchApiError);
    expect((err as WebSearchApiError).failure).toBe(failure);
    expect((err as WebSearchApiError).message).toContain(String(status));
    expect(err.message).not.toContain("SECRET_PROVIDER_DETAIL");
    expect(err.message).not.toContain(KEY);
  });

  it("maps network failures to provider_error and timeouts to timeout", async () => {
    const net = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const netErr = await azureWebSearch({ base: BASE, key: KEY, model: MODEL, input: "q", fetchImpl: net as never }).catch((e) => e);
    expect(netErr).toBeInstanceOf(WebSearchApiError);
    expect((netErr as WebSearchApiError).failure).toBe("provider_error");

    const timeoutErr = Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" });
    const t = vi.fn(async () => {
      throw timeoutErr;
    });
    const toErr = await azureWebSearch({ base: BASE, key: KEY, model: MODEL, input: "q", fetchImpl: t as never }).catch((e) => e);
    expect(toErr).toBeInstanceOf(WebSearchApiError);
    expect((toErr as WebSearchApiError).failure).toBe("timeout");
  });
});
