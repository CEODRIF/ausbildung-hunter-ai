import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The Camofox client — the browser engine's REST boundary.
 *
 * Contract tested here (mirrors the camofox-browser server implementation):
 *  - SSRF: loopback / private / link-local / metadata targets are refused
 *    BEFORE the browser is asked, and a redirect to a private address is
 *    dropped (the FINAL url is re-checked);
 *  - session isolation: every request carries the run's userId;
 *  - auth: the Bearer key is sent when configured;
 *  - fail-soft breaker: a network failure / 5xx marks the engine
 *    unavailable for the run; a 404 page does NOT (page_not_found);
 *  - budgets: the run's page + interaction counters are measured and
 *    enforced (no call beyond the budget reaches the engine).
 */

import {
  CamofoxClient,
  camofoxConfigFromEnv,
  type CamofoxConfig,
} from "@/lib/company-discovery/camofox/client";

const CONFIG: CamofoxConfig = {
  baseUrl: "http://127.0.0.1:9377",
  accessKey: null,
  timeoutMs: 2000,
};

interface FakeServerOptions {
  healthStatus?: number;
  openStatus?: number;
  /** navigate/openTab lands here instead of the requested url. */
  redirectFinalTo?: string;
  /** The Nth navigation and beyond fail at the network level. */
  failAfterNavigate?: number;
}

type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** A faithful fake of the camofox-browser REST API (verified contract). */
function fakeServer(options: FakeServerOptions = {}) {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  const state = { tabCounter: 0, navigations: 0 };
  const current: Record<string, { status: number; finalUrl: string }> = {};

  const engineFetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const raw = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const body =
      init?.body !== undefined
        ? (JSON.parse(init.body as string) as Record<string, unknown>)
        : undefined;
    calls.push({ method, url: raw, body });
    const url = new URL(raw);
    const parts = url.pathname.split("/").filter(Boolean);

    if (method === "GET" && url.pathname === "/health") {
      const status = options.healthStatus ?? 200;
      return Response.json({ ok: status === 200 }, { status });
    }
    if (method === "DELETE" && url.pathname.startsWith("/sessions/")) {
      return Response.json({ ok: true });
    }
    if (method === "DELETE" && parts[0] === "tabs" && parts.length === 2) {
      return Response.json({ ok: true });
    }
    if (method === "POST" && url.pathname === "/tabs") {
      state.tabCounter += 1;
      const tabId = `tab-${state.tabCounter}`;
      const pageUrl = String(body?.url ?? "about:blank");
      const status = options.openStatus ?? 200;
      current[tabId] = {
        status,
        finalUrl: options.redirectFinalTo ?? pageUrl,
      };
      return Response.json({
        tabId,
        url: current[tabId].finalUrl,
        httpStatus: status,
        navigationOk: status < 400,
      });
    }
    const nav = url.pathname.match(/^\/tabs\/([^/]+)\/navigate$/);
    if (method === "POST" && nav) {
      state.navigations += 1;
      if (
        options.failAfterNavigate &&
        state.navigations > options.failAfterNavigate
      ) {
        throw new Error("network down");
      }
      const pageUrl = String(body?.url ?? "");
      current[nav[1]] = { status: 200, finalUrl: options.redirectFinalTo ?? pageUrl };
      return Response.json({
        ok: true,
        tabId: nav[1],
        url: current[nav[1]].finalUrl,
        httpStatus: 200,
        navigationOk: true,
      });
    }
    const ev = url.pathname.match(/^\/tabs\/([^/]+)\/evaluate$/);
    if (method === "POST" && ev) {
      const page = current[ev[1]] ?? { finalUrl: "https://firma.de/" };
      return Response.json({
        ok: true,
        result: {
          title: "Firma",
          href: page.finalUrl,
          html: `<html><body>Rendered content of ${page.finalUrl}</body></html>`,
          text: `Rendered visible text of ${page.finalUrl} — long enough to count as content.`,
        },
      });
    }
    if (method === "GET" && url.pathname.match(/^\/tabs\/[^/]+\/links$/)) {
      return Response.json({
        links: [
          { url: "https://firma.de/karriere", text: "Karriere" },
          { url: "https://firma.de/impressum", text: "Impressum" },
        ],
        pagination: { total: 2, offset: 0, limit: 100, hasMore: false },
      });
    }
    if (method === "GET" && url.pathname.match(/^\/tabs\/[^/]+\/snapshot$/)) {
      return Response.json({
        url: "https://firma.de/",
        snapshot: '- button "Mehr anzeigen" [ref=e42]',
      });
    }
    if (
      method === "POST" &&
      url.pathname.match(/^\/tabs\/[^/]+\/(click|scroll|wait)$/)
    ) {
      return Response.json({ ok: true });
    }
    return Response.json({ error: "unknown route" }, { status: 404 });
  };
  const fetch = vi.fn(engineFetch) as unknown as FetchImpl;

  return {
    fetch,
    calls,
    tabCount: () => state.tabCounter,
    navigations: () => state.navigations,
  };
}

function newClient(
  deps: { fetchImpl?: typeof fetch; isPublicHost?: (h: string) => Promise<boolean> } = {},
  maxPages = 10,
  maxInteractions = 10,
): CamofoxClient {
  return new CamofoxClient(CONFIG, "discovery:test-run", {
    maxPages,
    maxInteractions,
    deps,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("camofoxConfigFromEnv", () => {
  it("defaults to the local engine, no key, 45s timeout", () => {
    const config = camofoxConfigFromEnv({});
    expect(config).not.toBeNull();
    expect(config?.baseUrl).toBe("http://127.0.0.1:9377");
    expect(config?.accessKey).toBeNull();
    expect(config?.timeoutMs).toBe(45_000);
  });

  it("is disabled by an empty or `disabled` CAMOFOX_URL", () => {
    expect(camofoxConfigFromEnv({ CAMOFOX_URL: "" })).toBeNull();
    expect(camofoxConfigFromEnv({ CAMOFOX_URL: "disabled" })).toBeNull();
  });

  it("clamps a runaway timeout into [>0, 120000]", () => {
    const config = camofoxConfigFromEnv({
      CAMOFOX_URL: "http://browser:9377",
      CAMOFOX_TIMEOUT_MS: "999999",
    });
    expect(config?.timeoutMs).toBe(120_000);
  });
});

describe("SSRF protection — the browser is never steered at internal targets", () => {
  // The REAL guard (DNS resolution): numeric literals + localhost resolve
  // without any external network.
  it.each([
    "http://127.0.0.1/secret",
    "http://localhost:8080/secret",
    "http://10.0.0.5/internal",
    "http://192.168.1.10/router",
    "http://172.16.0.3/vlan",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/v6-loopback",
    "ftp://firma.de/file",
    "http://user:pass@firma.de/page",
  ])("refuses %s before the engine is asked", async (target) => {
    const server = fakeServer();
    const client = newClient({ fetchImpl: server.fetch });
    const page = await client.openPage(target);
    expect(page).toBeNull();
    // No /tabs request may have reached the engine for a refused URL.
    expect(
      server.calls.filter((c) => c.method === "POST" && c.url.endsWith("/tabs")).length,
    ).toBe(0);
  });

  it("drops a page whose FINAL url is a private address (redirect SSRF)", async () => {
    const server = fakeServer({ redirectFinalTo: "http://169.254.169.254/meta" });
    // Offline test: the guard resolves names "successfully" for everything
    // except the link-local metadata address (the SSRF semantics under test).
    const client = newClient({
      fetchImpl: server.fetch,
      isPublicHost: async (host) =>
        host !== "169.254.169.254" && !host.startsWith("127."),
    });
    await expect(client.probe()).resolves.toBe(true);
    const page = await client.openPage("https://firma.de/");
    // The engine WAS asked (the page loaded in the browser) …
    expect(server.tabCount()).toBe(1);
    // …but its content must never surface: the final url failed the re-check.
    expect(page).toBeNull();
  });
});

describe("session isolation + auth", () => {
  it("carries the run's userId in every request that needs one", async () => {
    const server = fakeServer();
    const client = newClient({ fetchImpl: server.fetch });
    await client.openPage("https://firma.de/");
    const bodies = server.calls
      .map((c) => c.body)
      .filter((b): b is Record<string, unknown> => b !== undefined);
    // /tabs, /evaluate, /click… all carry the session id.
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      expect(body.userId).toBe("discovery:test-run");
    }
  });

  it("sends the Bearer key when configured", async () => {
    const seen: string[] = [];
    const client = new CamofoxClient(
      { ...CONFIG, accessKey: "secret-key" },
      "discovery:auth-run",
      {
        maxPages: 5,
        maxInteractions: 5,
        deps: {
          fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
            const headers = new Headers(init?.headers as Record<string, string>);
            seen.push(headers.get("authorization") ?? "");
            return Response.json({
              ok: true,
              result: {
                title: "t",
                href: "https://firma.de/",
                html: "<html></html>",
                text: "x".repeat(120),
              },
            });
          }) as unknown as typeof fetch,
        },
      },
    );
    await client.probe();
    expect(seen).toEqual(["Bearer secret-key"]);
  });
});

describe("fail-soft breaker + budgets", () => {
  it("an unreachable engine opens the breaker — later calls short-circuit (no network)", async () => {
    const failingImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const client = newClient({
      fetchImpl: failingImpl as unknown as typeof fetch,
    });
    await expect(client.probe()).resolves.toBe(false);
    expect(client.available).toBe(false);
    expect(client.unavailableReason).toBe("browser_unreachable");
    const callsBefore = failingImpl.mock.calls.length;
    const page = await client.openPage("https://firma.de/");
    expect(page).toBeNull();
    expect(failingImpl.mock.calls.length).toBe(callsBefore); // short-circuited
  });

  it("a 5xx from the engine opens the breaker", async () => {
    const client = newClient({
      fetchImpl: (async () =>
        new Response("boom", { status: 502 })) as unknown as typeof fetch,
    });
    await expect(client.probe()).resolves.toBe(false);
    expect(client.available).toBe(false);
    expect(client.unavailableReason).toBe("engine_http_502");
  });

  it("a 404 page is a page_not_found — NOT a breaker", async () => {
    const server = fakeServer({ openStatus: 404 });
    const client = newClient({ fetchImpl: server.fetch });
    await expect(client.probe()).resolves.toBe(true);
    const page = await client.openPage("https://firma.de/missing");
    expect(page?.notFound).toBe(true);
    expect(client.available).toBe(true);
  });

  it("the page budget is measured and enforced (no call beyond it)", async () => {
    const server = fakeServer();
    const tiny = new CamofoxClient(CONFIG, "discovery:budget", {
      maxPages: 2,
      maxInteractions: 1,
      deps: { fetchImpl: server.fetch },
    });
    await tiny.openPage("https://firma.de/");
    await tiny.openPage("https://firma.de/karriere");
    expect(tiny.pagesUsed).toBe(2);
    const third = await tiny.openPage("https://firma.de/jobs");
    expect(third).toBeNull();
    expect(tiny.pagesUsed).toBe(2);
    expect(server.tabCount()).toBe(2); // exactly two tab creations
  });

  it("the interaction budget is enforced on clicks", async () => {
    const server = fakeServer();
    const tiny = new CamofoxClient(CONFIG, "discovery:inter", {
      maxPages: 5,
      maxInteractions: 1,
      deps: { fetchImpl: server.fetch },
    });
    const opened = await tiny.openTab("https://firma.de/");
    expect(opened).not.toBeNull();
    const first = await tiny.clickLabel(opened!.tabId, ["Mehr anzeigen"], 0);
    const second = await tiny.clickLabel(opened!.tabId, ["Mehr anzeigen"], 0);
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(tiny.interactionsUsed).toBe(1);
  });
});
