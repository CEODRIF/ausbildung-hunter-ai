import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * HTTP-first, browser-when-needed (§11): guardedFetch escalates a page that
 * plain HTTP can only see as a JS shell / bot wall / captcha ONCE to the
 * anti-detection browser, and the rendered content goes through the SAME
 * classifier before it is accepted.
 *
 * Rules under test:
 *  - js_protected / bot_challenge / captcha  → one escalation;
 *  - robots_disallow / forbidden / login_required / rate_limited / 404
 *    → NEVER escalated (policy/technical decisions stay decisions);
 *  - a rendered page that is STILL challenged stays blocked (breaker opens);
 *  - a rendered page that shows no real content stays blocked;
 *  - the browser is fail-soft: null/throwing fallback → the plain-HTTP block
 *    stands, nothing crashes;
 *  - the accepted page carries the RENDERED content (text/html/links).
 */

import {
  createFetchContext,
  guardedFetch,
  isHostBlocked,
} from "@/lib/company-discovery/fetch-guard";
import type { RenderedPage } from "@/lib/company-discovery/camofox/client";

interface FakePage {
  status?: number;
  html: string;
  headers?: Record<string, string>;
}

function makeCtx(opts: {
  pages?: Record<string, FakePage>;
  robots?: string;
  renderFallback?: (url: string) => Promise<RenderedPage | null>;
  renderCalls?: string[];
}) {
  const pages = opts.pages ?? {};
  const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const raw = typeof input === "string" ? input : input.toString();
    if (raw.includes("/robots.txt")) {
      return new Response(opts.robots ?? "User-agent: *\n", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }
    const path = new URL(raw).pathname;
    const page = pages[path] ?? { status: 404, html: "Not Found" };
    return new Response(page.html, {
      status: page.status ?? 200,
      headers: { "content-type": "text/html", ...page.headers },
    });
  });
  const fetchImpl = fetchMock as unknown as typeof fetch;
  const ctx = createFetchContext({
    fetchImpl,
    isPublicHost: async () => true,
    sleep: async () => undefined,
    nowIso: () => "2026-10-26T00:00:00.000Z",
    nowMs: () => 0,
    renderFallback: (() => {
      const render = opts.renderFallback;
      const calls = opts.renderCalls;
      return render
        ? async (_c: unknown, url: string) => {
            void _c;
            calls?.push(url);
            return render(url);
          }
        : undefined;
    })(),
  });
  return { ctx, fetchMock };
}

/** A rendered page with real content (the browser succeeded). */
function rendered(url: string, overrides: Partial<RenderedPage> = {}): RenderedPage {
  return {
    url,
    finalUrl: url,
    status: 200,
    notFound: false,
    title: "Rendered",
    html: "<html><body>rendered</body></html>",
    text: "Gehrender Inhalt — die Seite wurde vollständig im Browser gerendert und ist jetzt lesbar.".padEnd(90, " "),
    links: ["https://firma.de/karriere"],
    ...overrides,
  };
}

const JS_SHELL =
  "<html><body><p>Bitte aktivieren Sie JavaScript in Ihrem Browser.</p></body></html>";
const CAPTCHA =
  '<html><body><div class="g-recaptcha" data-sitekey="abc"></div></body></html>';
const BOT_WALL =
  "<html><body><h1>Just a moment...</h1><p>Checking your browser before continuing.</p></body></html>";

afterEach(() => vi.unstubAllGlobals());

describe("HTTP-first, browser-when-needed escalation", () => {
  it("escalates a js_protected shell and accepts the rendered content", async () => {
    const calls: string[] = [];
    const { ctx } = makeCtx({
      pages: { "/karriere": { html: JS_SHELL } },
      renderFallback: async (url) => rendered(url),
      renderCalls: calls,
    });
    const result = await guardedFetch(ctx, "https://firma.de/karriere");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The RENDERED content is what downstream sees.
    expect(result.page.text).toContain("Gehrender Inhalt");
    expect(result.page.links).toContain("https://firma.de/karriere");
    // One measured escalation attempt, recorded as a real outcome.
    expect(calls).toEqual(["https://firma.de/karriere"]);
    expect(ctx.attempts.at(-1)?.outcome).toBe("ok_via_browser");
    // The host is NOT blocked — the breaker stays shut after a success.
    expect(isHostBlocked(ctx, "firma.de")).toBe(false);
  });

  it("escalates a captcha wall (the anti-detection render bypasses it)", async () => {
    const { ctx } = makeCtx({
      pages: { "/": { html: CAPTCHA } },
      renderFallback: async (url) => rendered(url),
    });
    const result = await guardedFetch(ctx, "https://firma.de/");
    expect(result.ok).toBe(true);
    expect(ctx.attempts.at(-1)?.outcome).toBe("ok_via_browser");
  });

  it("escalates a bot wall (cf-mitigated header) on the header, not just the body", async () => {
    const { ctx } = makeCtx({
      pages: { "/": { html: BOT_WALL, headers: { "cf-mitigated": "challenge" } } },
      renderFallback: async (url) => rendered(url),
    });
    const result = await guardedFetch(ctx, "https://firma.de/");
    expect(result.ok).toBe(true);
    expect(ctx.attempts.at(-1)?.outcome).toBe("ok_via_browser");
  });

  it("a rendered page that is STILL challenged stays blocked (breaker opens)", async () => {
    const { ctx } = makeCtx({
      pages: { "/": { html: BOT_WALL } },
      renderFallback: async (url) =>
        rendered(url, {
          html: "<html><body>Just a moment... checking your browser</body></html>",
          text: "Just a moment...",
        }),
    });
    const result = await guardedFetch(ctx, "https://firma.de/");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("blocked");
    expect(isHostBlocked(ctx, "firma.de")).toBe(true);
  });

  it.each([
    ["a 404", { status: 404, html: "Not Found" }],
    ["a 403", { status: 403, html: "Forbidden" }],
    ["a 429", { status: 429, html: "Slow down" }],
  ])("never escalates %s (policy/technical — the browser must not override)", async (_label, page) => {
    const calls: string[] = [];
    const { ctx } = makeCtx({
      pages: { "/": page },
      renderFallback: async (url) => rendered(url),
      renderCalls: calls,
    });
    const result = await guardedFetch(ctx, "https://firma.de/");
    expect(result.ok).toBe(false);
    expect(calls).toEqual([]); // the browser was never asked
  });

  it("never escalates a robots-disallowed path (and never fetches it)", async () => {
    // fetchRobots uses the GLOBAL fetch by design (it runs before the
    // context's client) — stub it to serve the denying robots.txt.
    const robotsSeen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        robotsSeen.push(typeof input === "string" ? input : input.toString());
        return new Response("User-agent: *\nDisallow: /karriere\n", {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }),
    );
    const calls: string[] = [];
    const { ctx, fetchMock } = makeCtx({
      pages: { "/karriere": { html: JS_SHELL } },
      renderFallback: async (url) => rendered(url),
      renderCalls: calls,
    });
    const result = await guardedFetch(ctx, "https://firma.de/karriere");
    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === "blocked") expect(result.reason).toBe("robots_disallow");
    expect(calls).toEqual([]);
    // Only the robots.txt request was made — the page itself was not fetched.
    expect(robotsSeen.length).toBe(1);
    expect(robotsSeen[0]).toContain("/robots.txt");
    expect(
      fetchMock.mock.calls.every(
        ([input]) => String(input).includes("/robots.txt"),
      ),
    ).toBe(true);
  });

  it("an unavailable browser (fallback → null) keeps the plain-HTTP block", async () => {
    const { ctx } = makeCtx({
      pages: { "/": { html: JS_SHELL } },
      renderFallback: async () => null,
    });
    const result = await guardedFetch(ctx, "https://firma.de/");
    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === "blocked") expect(result.reason).toBe("js_protected");
    expect(isHostBlocked(ctx, "firma.de")).toBe(true);
  });

  it("a throwing browser fallback fails soft (the block stands, no crash)", async () => {
    const { ctx } = makeCtx({
      pages: { "/": { html: JS_SHELL } },
      renderFallback: async () => {
        throw new Error("browser exploded");
      },
    });
    const result = await guardedFetch(ctx, "https://firma.de/");
    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === "blocked") expect(result.reason).toBe("js_protected");
  });

  it("a rendered shell with no real content (< 80 visible chars) stays blocked", async () => {
    const { ctx } = makeCtx({
      pages: { "/": { html: JS_SHELL } },
      renderFallback: async (url) => rendered(url, { text: "leer" }),
    });
    const result = await guardedFetch(ctx, "https://firma.de/");
    expect(result.ok).toBe(false);
  });

  it("without any renderFallback the legacy behavior is unchanged", async () => {
    const { ctx } = makeCtx({ pages: { "/": { html: JS_SHELL } } });
    const result = await guardedFetch(ctx, "https://firma.de/");
    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === "blocked") expect(result.reason).toBe("js_protected");
    expect(isHostBlocked(ctx, "firma.de")).toBe(true);
  });
});
