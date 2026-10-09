import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveSearchProvider, validateAzureEndpoint } from "@/lib/housing/web-search/config";

/**
 * Deterministic env: every relevant variable is stubbed (or cleared) in
 * each test — the resolver must never see a stray value from the host.
 */
const RELEVANT = [
  "HOUSING_WEB_SEARCH",
  "AZURE_WEB_SEARCH_ENDPOINT",
  "AZURE_WEB_SEARCH_KEY",
  "AZURE_WEB_SEARCH_MODEL",
  "AI_API_URL",
  "AI_API_KEY",
  "AI_MODEL",
  "TAVILY_API_KEY",
] as const;

function setEnv(vars: Partial<Record<(typeof RELEVANT)[number], string>> = {}): void {
  for (const k of RELEVANT) vi.stubEnv(k, vars[k] ?? "");
}

afterEach(() => vi.unstubAllEnvs());

const AZURE_BASE = "https://res.openai.azure.com/openai/v1";

describe("validateAzureEndpoint (documented Responses base only)", () => {
  it("accepts the documented form https://{resource}.openai.azure.com/openai/v1", () => {
    expect(validateAzureEndpoint(AZURE_BASE)).toBe(AZURE_BASE);
    // Trailing slash is normalized away.
    expect(validateAzureEndpoint(`${AZURE_BASE}/`)).toBe(AZURE_BASE);
    expect(validateAzureEndpoint(`${AZURE_BASE}//`)).toBe(AZURE_BASE);
  });

  it.each([
    ["OpenAI standard API base (wrong surface + wrong auth)", "https://api.openai.com/v1"],
    ["non-https scheme", "http://res.openai.azure.com/openai/v1"],
    ["missing /openai/v1 path", "https://res.openai.azure.com"],
    ["wrong path /openai", "https://res.openai.azure.com/openai"],
    ["wrong path /openai/v2", "https://res.openai.azure.com/openai/v2"],
    ["apex domain is not a resource", "https://openai.azure.com/openai/v1"],
    ["lookalike host (suffix trap)", "https://evil-openai.azure.com/openai/v1"],
    ["unrelated azure.com host", "https://res.services.ai.azure.com/openai/v1"],
    ["not a URL", "res.openai.azure.com/openai/v1"],
  ])("rejects %s", (_name, base) => {
    expect(validateAzureEndpoint(base)).toBeNull();
  });
});

describe("resolveSearchProvider — Azure-only by construction", () => {
  it("returns a validated azure provider when endpoint+key+model are set", () => {
    setEnv({
      AZURE_WEB_SEARCH_ENDPOINT: `${AZURE_BASE}/`,
      AZURE_WEB_SEARCH_KEY: "k1",
      AZURE_WEB_SEARCH_MODEL: "gpt-5-mini",
    });
    expect(resolveSearchProvider()).toEqual({
      kind: "azure",
      base: AZURE_BASE,
      key: "k1",
      model: "gpt-5-mini",
    });
  });

  it("warns once (no secrets) when a non-azure mode is configured", () => {
    // NOTE: the module warns only once per process — this test must be the
    // first in the file to invoke the resolver with a non-azure mode.
    const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      setEnv({ HOUSING_WEB_SEARCH: "tavily" });
      resolveSearchProvider();
      const warns = spy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("HOUSING_WEB_SEARCH"));
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain("Azure-only");
      // The warning names the mode, never a key.
      expect(warns[0]).not.toContain("tvly-");
    } finally {
      spy.mockRestore();
    }
  });

  it("never resolves to tavily — not even with TAVILY_API_KEY set (every mode)", () => {
    for (const mode of ["", "auto", "azure", "tavily", "TAVILY", "anything"]) {
      setEnv({ HOUSING_WEB_SEARCH: mode, TAVILY_API_KEY: "tvly-test" });
      const p = resolveSearchProvider();
      // Without Azure config the honest state is null — NOT tavily.
      expect(p).toBeNull();
    }
  });

  it("stays azure (and ignores the mode) when TAVILY_API_KEY and Azure are both present", () => {
    setEnv({
      HOUSING_WEB_SEARCH: "tavily",
      TAVILY_API_KEY: "tvly-test",
      AZURE_WEB_SEARCH_ENDPOINT: AZURE_BASE,
      AZURE_WEB_SEARCH_KEY: "k1",
      AZURE_WEB_SEARCH_MODEL: "gpt-5-mini",
    });
    expect(resolveSearchProvider()).toMatchObject({ kind: "azure", model: "gpt-5-mini" });
  });

  it("returns null when any of endpoint/key/model is missing", () => {
    setEnv({ AZURE_WEB_SEARCH_KEY: "k1", AZURE_WEB_SEARCH_MODEL: "gpt-5-mini" });
    expect(resolveSearchProvider()).toBeNull(); // no endpoint
    setEnv({ AZURE_WEB_SEARCH_ENDPOINT: AZURE_BASE, AZURE_WEB_SEARCH_MODEL: "gpt-5-mini" });
    expect(resolveSearchProvider()).toBeNull(); // no key
    setEnv({ AZURE_WEB_SEARCH_ENDPOINT: AZURE_BASE, AZURE_WEB_SEARCH_KEY: "k1" });
    expect(resolveSearchProvider()).toBeNull(); // no model
  });

  it("returns null for a malformed endpoint (fails safe, no paid call possible)", () => {
    for (const bad of [
      "https://api.openai.com/v1",
      "http://res.openai.azure.com/openai/v1",
      "https://res.openai.azure.com",
    ]) {
      setEnv({
        AZURE_WEB_SEARCH_ENDPOINT: bad,
        AZURE_WEB_SEARCH_KEY: "k1",
        AZURE_WEB_SEARCH_MODEL: "gpt-5-mini",
      });
      expect(resolveSearchProvider()).toBeNull();
    }
  });

  it("reuses AI_API_URL/AI_API_KEY/AI_MODEL only when the app endpoint is a valid Foundry Responses base", () => {
    setEnv({ AI_API_URL: AZURE_BASE, AI_API_KEY: "k-app", AI_MODEL: "gpt-5-mini" });
    expect(resolveSearchProvider()).toEqual({
      kind: "azure",
      base: AZURE_BASE,
      key: "k-app",
      model: "gpt-5-mini",
    });

    // A non-Foundry app endpoint (the repo default) is never used —
    // and it does not fall through to Tavily either.
    setEnv({
      AI_API_URL: "https://api.openai.com/v1",
      AI_API_KEY: "k-app",
      AI_MODEL: "gpt-5-mini",
      TAVILY_API_KEY: "tvly-test",
    });
    expect(resolveSearchProvider()).toBeNull();
  });

  it("explicit AZURE_WEB_SEARCH_* win over the app AI_* endpoint", () => {
    setEnv({
      AZURE_WEB_SEARCH_ENDPOINT: AZURE_BASE,
      AZURE_WEB_SEARCH_KEY: "k-explicit",
      AZURE_WEB_SEARCH_MODEL: "gpt-5-mini",
      AI_API_URL: AZURE_BASE,
      AI_API_KEY: "k-app",
      AI_MODEL: "other-model",
    });
    expect(resolveSearchProvider()).toMatchObject({ key: "k-explicit", model: "gpt-5-mini" });
  });

});
