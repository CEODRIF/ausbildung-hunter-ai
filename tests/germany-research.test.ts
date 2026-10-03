import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Live research for the Germany copilot.
 *
 * Two things must hold, always:
 *  - a stable question must NOT spend a paid third-party call;
 *  - a failing / unconfigured provider must never break the chat — the lookup
 *    degrades to "not searched" and the model still answers.
 * Plus: nothing user-written may end up in the logs.
 */
const search = vi.fn();
const getWebSearchClient = vi.fn();

vi.mock("@/lib/web-search", () => ({
  getWebSearchClient: (...args: unknown[]) => getWebSearchClient(...args),
}));

const { researchGermany } = await import("@/lib/germany-research");

const hit = (url: string, title = "title") => ({
  title,
  url,
  snippet: "snippet",
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("when a lookup is not needed", () => {
  it("does not call the provider for a stable question", async () => {
    const research = await researchGermany("Was ist eine Ausbildung?");
    expect(research).toEqual({
      searched: false,
      reason: "not_needed",
      query: "",
      results: [],
    });
    expect(getWebSearchClient).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });
});

describe("when no search provider is configured", () => {
  it("degrades to not_searched instead of failing", async () => {
    getWebSearchClient.mockReturnValue(null);
    const research = await researchGermany("Wie viel kostet das Visum?");
    expect(research.searched).toBe(false);
    expect(research.reason).toBe("no_provider");
    expect(search).not.toHaveBeenCalled();
  });
});

describe("a successful lookup", () => {
  it("ranks official sources first and reports the query it used", async () => {
    getWebSearchClient.mockReturnValue({ name: "tavily", search });
    search.mockResolvedValue([
      hit("https://random-blog.example/visa"),
      hit("https://www.auswaertiges-amt.de/de/visa"),
      hit("https://www.tiktok.com/@x/video/1"),
    ]);
    const research = await researchGermany("Wie viel kostet ein Visum?");
    expect(research.searched).toBe(true);
    expect(research.reason).toBe("current_information");
    expect(research.results[0].url).toContain("auswaertiges-amt.de");
    // The social result is dropped because real sources were found.
    expect(research.results.map((entry) => entry.url)).not.toContain(
      "https://www.tiktok.com/@x/video/1",
    );
    expect(research.query).toContain("Deutschland");
    // One request per question, with the per-run budget capped at 1.
    expect(getWebSearchClient).toHaveBeenCalledWith({ maxRequests: 1 });
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("treats an empty result set as not searched", async () => {
    getWebSearchClient.mockReturnValue({ name: "tavily", search });
    search.mockResolvedValue([]);
    const research = await researchGermany("Wie viel kostet ein Visum?");
    expect(research.searched).toBe(false);
    expect(research.reason).toBe("failed");
  });
});

describe("failure handling", () => {
  it("never throws when the provider fails", async () => {
    getWebSearchClient.mockReturnValue({ name: "tavily", search });
    search.mockRejectedValue(new Error("tavily exploded: key=secret-value"));
    const research = await researchGermany("Wie viel kostet ein Visum?");
    expect(research.searched).toBe(false);
    expect(research.reason).toBe("failed");
  });

  it("logs no question text and no provider message", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    getWebSearchClient.mockReturnValue({ name: "tavily", search });
    search.mockRejectedValue(new Error("key=super-secret-token"));
    await researchGermany("Wie viel kostet das Visum für Rabat?");
    const logged = spy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(logged).not.toContain("super-secret-token");
    expect(logged).not.toContain("Rabat");
    expect(logged).toContain("[ai-chat]");
  });
});
