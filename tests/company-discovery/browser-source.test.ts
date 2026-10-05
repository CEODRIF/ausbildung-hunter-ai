import { describe, expect, it, vi } from "vitest";

/**
 * The browser discovery source — Camofox as a FIRST-CLASS discovery engine.
 *
 * The fake engine speaks the DEPLOYED v2.4.8 contract faithfully:
 * evaluate results are JSON-SERIALIZED STRINGS (resultType "string"), the
 * /links endpoint does NOT exist (404), navigate answers {ok, url} without
 * httpStatus (the status comes from the page's `performance` entry, which
 * the fake embeds into the evaluated payload).
 *
 * What is proven (real client + real source code, simulated engine):
 *  - a rendered Google SERP is parsed into external candidate urls;
 *  - google-internal / already-counted / already-visited urls are skipped;
 *  - a walled Google falls back to DuckDuckGo (honest provider chain);
 *  - a company page's OWN stated name (og:site_name) + literal email +
 *    documented 2027 become ONE offer with real evidence;
 *  - a portal page's JobPosting JSON-LD becomes an offer (stated name);
 *  - budgets, 404s, engine death and the session lifecycle are all honored.
 */

import { createCamofoxClient, type CamofoxClient } from "@/lib/company-discovery/camofox/client";
import { runBrowserDiscovery } from "@/lib/company-discovery/camofox/browser-source";
import type { NormalizedOffer } from "@/lib/company-discovery/adapter";

const TEXT_120 =
  "Musterzeile mit ausreichend sichtbarem Text, damit die Seite als Inhalt zählt und nicht leer bleibt. Weiterer Satz.";

interface FakePage {
  status?: number;
  title: string;
  html: string;
  text: string;
  links?: Array<string | { url: string; label: string }>;
}

type PageMap = Record<string, FakePage>;

function pair(links: FakePage["links"] = []): Array<string> {
  return (links ?? []).map((entry) =>
    typeof entry === "string" ? entry : `${entry.url}\u0000${entry.label}`,
  );
}

/** A faithful v2.4.8 fake: routes + serialized-string evaluate results. */
function fakeEngine(pages: PageMap) {
  const state = {
    tabs: new Map<string, string>(), // tabId → current url
    tabCounter: 0,
    navigations: 0,
    macroNavigations: 0,
    closedTabs: 0,
    destroyedSessions: 0,
    failNextNavigate: 0,
  };

  const engineFetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const raw = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const url = new URL(raw);
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : {};

    if (url.pathname === "/health") {
      return Response.json({ ok: true, running: true, engine: "camoufox", version: "2.4.8", browserConnected: true, poolSize: 1, activeUserIds: [], profileDirsTotal: 0 });
    }

    const openTab = url.pathname === "/tabs" && method === "POST";
    const openTab2 = url.pathname === "/tabs/open" && method === "POST";
    if (openTab || openTab2) {
      const target = String(body.url ?? "");
      const tabId = `t${++state.tabCounter}`;
      state.tabs.set(tabId, target);
      const page = lookUp(pages, target);
      return Response.json(
        openTab ? { tabId, url: target } : { ok: true, targetId: tabId, tabId, url: target, title: page?.title ?? "" },
      );
    }

    const nav = url.pathname.match(/^\/tabs\/([^/]+)\/navigate$/);
    if (method === "POST" && nav) {
      let target: string;
      if (typeof body.macro === "string") {
        state.macroNavigations += 1;
        target =
          body.macro === "@google_search"
            ? `https://www.google.de/search?q=${encodeURIComponent(String(body.query ?? ""))}`
            : String(body.url ?? "");
      } else {
        target = String(body.url ?? "");
      }
      if (state.failNextNavigate > 0) {
        state.failNextNavigate -= 1;
        throw new Error("ECONNRESET (simulated engine death)");
      }
      state.navigations += 1;
      state.tabs.set(nav[1], target);
      return Response.json({ ok: true, url: target });
    }

    const ev = url.pathname.match(/^\/tabs\/([^/]+)\/evaluate$/);
    if (method === "POST" && ev) {
      const current = state.tabs.get(ev[1]) ?? "";
      const page = lookUp(pages, current) ?? {
        title: "",
        html: "",
        text: "",
      };
      // THE v2.4.8 CONTRACT: the evaluated value is a serialized JSON string.
      const payload = {
        title: page.title,
        href: current,
        status: page.status ?? 200,
        html: page.html,
        text: page.text,
        links: pair(page.links),
      };
      return Response.json({ ok: true, result: JSON.stringify(payload), resultType: "string" });
    }

    const links = url.pathname.match(/^\/tabs\/([^/]+)\/links$/);
    if (links) {
      // v2.4.8 has NO /links endpoint:
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    if (method === "DELETE" && url.pathname.match(/^\/tabs\/[^/]+$/)) {
      state.closedTabs += 1;
      return Response.json({ ok: true });
    }
    if (method === "DELETE" && url.pathname.startsWith("/sessions/")) {
      state.destroyedSessions += 1;
      return Response.json({ ok: true });
    }
    return Response.json({ error: "unknown route" }, { status: 404 });
  };

  return { fetch: vi.fn(engineFetch) as unknown as typeof fetch, state };
}


/** Host without www, lowercase (page-map keys ignore the www prefix). */
function normHost(value: string): string {
  return value.toLowerCase().replace(/^www\./, "");
}

/**
 * Resolve a page for a url. Keys are "host/path" (query ignored, www
 * ignored) — the fake is a static site map standing in for rendered pages.
 */
function lookUp(pages: PageMap, target: string): FakePage | null {
  let host = "";
  let path = "/";
  try {
    const u = new URL(target);
    host = normHost(u.hostname);
    path = u.pathname.replace(/\/+$/, "") || "/";
  } catch {
    return null;
  }
  for (const [key, page] of Object.entries(pages)) {
    const idx = key.indexOf("/");
    const kHost = idx === -1 ? key : key.slice(0, idx);
    const kPath = idx === -1 ? "/" : key.slice(idx).replace(/\/+$/, "") || "/";
    if (normHost(kHost) === host && kPath === path) return page;
  }
  return null;
}

type FetchImpl = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

/** A client pointed at the fake engine (env only decides "configured"). */
function clientOf(
  engine: { fetch: FetchImpl },
  opts: { maxPages?: number; maxInteractions?: number } = {},
): CamofoxClient {
  process.env.CAMOFOX_URL = "http://fake-engine.local";
  process.env.CAMOFOX_ACCESS_KEY = "";
  const client = createCamofoxClient(
    "browser-source-test",
    opts.maxPages ?? 40,
    opts.maxInteractions ?? 40,
    { fetchImpl: engine.fetch, isPublicHost: async () => true },
  );
  if (!client) throw new Error("camofox client was not created (env disabled?)");
  return client;
}

const QUERY = "Mechatroniker Ausbildung 2027 München";
const GOOGLE_INTERNAL = "https://www.google.de/search?q=nächste+Seite";
const KNOWN_CO = "https://knownco.de/";
const VISITED_CO = "https://visitedco.de/jobs";
const COMPANY_URL = "https://www.firma-x.de/karriere/ausbildung";
const PORTAL_URL = "https://jobsportal.de/angebote/mechatroniker-muenchen";
const EXTRA_ONE = "https://extra-one.de/ausbildung";
const EXTRA_TWO = "https://extra-two.de/jobs";
const MISSING_URL = "https://firma-gone.de/ausbildung";

function serpPage(
  results: Array<{ url: string; label: string }>,
  text = TEXT_120,
): FakePage {
  return {
    title: "Suchergebnisse",
    html: "<html><body></body></html>",
    text,
    links: results,
  };
}

/** The company site's own page: stated name + literal email + stated year. */
function companyPage(): FakePage {
  return {
    title: "Firma X GmbH – Karriere",
    html:
      '<html><head><meta property="og:site_name" content="Firma X GmbH"></head>' +
      `<body><p>${TEXT_120}</p></body></html>`,
    text:
      `${TEXT_120} Wir bilden aus: Ausbildung 2027, Start im August. ` +
      `Bewerbung an: kontakt@firma-x.de`,
  };
}

/** A listing page whose structured data states the employer. */
function portalPage(): FakePage {
  const jsonld = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "JobPosting",
    title: "Ausbildung Mechatroniker (Azubi) – München",
    employmentType: "FULL_TIME",
    hiringOrganization: {
      "@type": "Organization",
      name: "Firma X GmbH",
      url: "https://www.firma-x.de",
    },
    jobLocation: {
      "@type": "Place",
      address: {
        "@type": "PostalAddress",
        addressLocality: "München",
        addressRegion: "Bayern",
      },
    },
    datePosted: "2026-09-01",
    jobStartDate: "2027-08-01",
  });
  return {
    title: "Ausbildung Mechatroniker – Jobsportal",
    html:
      `<html><body><script type="application/ld+json">${jsonld}</script>` +
      `<p>${TEXT_120}</p></body></html>`,
    text: TEXT_120,
  };
}

/** A minimal company page that states its own name (og:site_name). */
function plainCompanyPage(name: string): FakePage {
  return {
    title: `${name} – Start`,
    html:
      `<html><head><meta property="og:site_name" content="${name}"></head>` +
      `<body><p>${TEXT_120}</p></body></html>`,
    text: TEXT_120,
  };
}

function notFoundPage(): FakePage {
  return {
    status: 404,
    title: "404",
    html: "<html><body>Seite nicht gefunden</body></html>",
    text: "Seite nicht gefunden",
  };
}

interface RunHarness {
  offers: NormalizedOffer[];
  discovered: string[];
  live: string[];
}

function harness(): RunHarness {
  return { offers: [], discovered: [], live: [] };
}

async function runBrowser(
  engine: ReturnType<typeof fakeEngine>,
  h: RunHarness,
  opts: {
    maxPages?: number;
    maxInteractions?: number;
    queries?: string[];
    known?: Set<string>;
    visited?: Set<string>;
    shouldStop?: () => boolean;
  } = {},
): Promise<Awaited<ReturnType<typeof runBrowserDiscovery>>> {
  const client = clientOf(engine, {
    maxPages: opts.maxPages,
    maxInteractions: opts.maxInteractions,
  });
  return runBrowserDiscovery({
    camofox: client,
    queries: opts.queries ?? [QUERY],
    goal: "ausbildung",
    field: "Mechatronik",
    knownCompanyDomains: opts.known ?? new Set<string>(),
    visitedUrls: opts.visited ?? new Set<string>(),
    callbacks: {
      onOffer: (offer) => h.offers.push(offer),
      onUrlsDiscovered: (urls) => h.discovered.push(...urls),
      onLiveState: (text) => h.live.push(text),
      shouldStop: opts.shouldStop ?? (() => false),
    },
  });
}

describe("browser discovery source (deployed v2.4.8 contract)", () => {
  it("parses a rendered SERP, skips known/visited hosts, extracts offers", async () => {
    const engine = fakeEngine({
      "www.google.de/search": serpPage([
        { url: GOOGLE_INTERNAL, label: "Interne Google-Link" },
        { url: KNOWN_CO, label: "Known Co." },
        { url: VISITED_CO, label: "Visited Co." },
        { url: COMPANY_URL, label: "Firma X – Ausbildung 2027" },
        { url: PORTAL_URL, label: "Ausbildung Mechatroniker" },
      ]),
      "firma-x.de/karriere/ausbildung": companyPage(),
      "jobsportal.de/angebote/mechatroniker-muenchen": portalPage(),
    });
    const h = harness();
    const result = await runBrowser(engine, h, {
      known: new Set(["knownco.de"]),
      visited: new Set(["https://visitedco.de/jobs"]),
    });

    // The SERP itself + the two fresh candidates — three real page loads.
    expect(result.queriesExecuted).toBe(1);
    expect(result.pagesUsed).toBe(3);
    expect(result.interactionsUsed).toBe(0);
    expect(result.blocked).toBe(false);
    // All four EXTERNAL results were discovered (search hosts excluded).
    expect(result.urlsDiscovered).toBe(4);
    expect(h.discovered).toEqual([
      KNOWN_CO,
      VISITED_CO,
      COMPANY_URL,
      PORTAL_URL,
    ]);
    expect(result.offersFound).toBe(2);

    // 1) the company page's OWN stated facts (name/site/email/beginn):
    const companyOffer = h.offers[0];
    expect(companyOffer.companyName).toBe("Firma X GmbH");
    expect(companyOffer.companyWebsite).toBe("https://firma-x.de");
    expect(companyOffer.beginn).toBe("2027");
    expect(companyOffer.offerType).toBe("ausbildung");
    expect(companyOffer.publishedEmail?.email).toBe("kontakt@firma-x.de");
    expect(companyOffer.offerUrl).toBe(COMPANY_URL);

    // 2) the listing's structured data (stated employer, stated start):
    const listing = h.offers[1];
    expect(listing.companyName).toBe("Firma X GmbH");
    expect(listing.role).toBe("Ausbildung Mechatroniker (Azubi) – München");
    expect(listing.city).toBe("München");
    expect(listing.state).toBe("Bayern");
    expect(listing.offerType).toBe("ausbildung");
    expect(listing.beginn).toBe("2027-08-01");

    // known + visited hosts were never browsed; one tab, reused, then closed.
    expect(engine.state.navigations).toBe(2);
    expect(engine.state.tabCounter).toBe(1);
    expect(engine.state.closedTabs).toBe(1);
    expect(h.live[0]).toContain("Browser-Suche");
  });

  it("falls back to DuckDuckGo when Google is walled", async () => {
    const engine = fakeEngine({
      "www.google.de/search": serpPage(
        [],
        `${TEXT_120} Our systems have detected unusual traffic from your ` +
          `computer network. Please try again later.`,
      ),
      "duckduckgo.com/html": serpPage([
        { url: COMPANY_URL, label: "Firma X – Ausbildung" },
        { url: EXTRA_ONE, label: "Extra One" },
        { url: EXTRA_TWO, label: "Extra Two" },
      ]),
      "firma-x.de/karriere/ausbildung": companyPage(),
      "extra-one.de/ausbildung": plainCompanyPage("Extra One AG"),
      "extra-two.de/jobs": plainCompanyPage("Extra Two SE"),
    });
    const h = harness();
    const result = await runBrowser(engine, h);

    expect(result.blocked).toBe(false);
    expect(result.providerFailures).toEqual({ google_google_blocked: 1 });
    expect(result.offersFound).toBe(3);
    expect(h.offers.map((offer) => offer.companyName)).toEqual([
      "Firma X GmbH",
      "Extra One AG",
      "Extra Two SE",
    ]);
    expect(engine.state.closedTabs).toBe(1);
  });

  it("records every walled provider and ends unblocked-but-empty", async () => {
    const engine = fakeEngine({
      "www.google.de/search": serpPage(
        [],
        `${TEXT_120} Our systems have detected unusual traffic from your ` +
          `computer network.`,
      ),
      "duckduckgo.com/html": serpPage(
        [],
        `${TEXT_120} Anomaly detected! Please solve the challenge.`,
      ),
      "www.bing.com/search": serpPage(
        [],
        `${TEXT_120} Bing has detected unusual activity. Complete the captcha.`,
      ),
    });
    const h = harness();
    const result = await runBrowser(engine, h);

    expect(result.queriesExecuted).toBe(1);
    expect(result.blocked).toBe(false);
    expect(result.blockedReason).toBeNull();
    expect(result.offersFound).toBe(0);
    expect(result.pagesUsed).toBe(3);
    expect(result.providerFailures).toEqual({
      google_google_blocked: 1,
      duckduckgo_duckduckgo_blocked: 1,
      bing_bing_blocked: 1,
    });
    expect(engine.state.closedTabs).toBe(1);
  });

  it("stops the source honestly when the engine dies (fail-soft)", async () => {
    const engine = fakeEngine({
      "www.google.de/search": serpPage([
        { url: COMPANY_URL, label: "Firma X – Ausbildung" },
        { url: EXTRA_ONE, label: "Extra One" },
        { url: EXTRA_TWO, label: "Extra Two" },
      ]),
      "firma-x.de/karriere/ausbildung": companyPage(),
    });
    engine.state.failNextNavigate = 1; // the first candidate navigation dies
    const h = harness();
    const result = await runBrowser(engine, h);

    expect(result.blocked).toBe(true);
    expect(result.blockedReason).toBe("browser_unreachable");
    expect(result.pagesUsed).toBe(1); // only the SERP got loaded
    expect(result.offersFound).toBe(0);
    // The dead engine cannot even receive the tab cleanup — no retry loop.
    expect(engine.state.closedTabs).toBe(0);
  });

  it("treats a 404 candidate as gone, not as a block", async () => {
    const engine = fakeEngine({
      "www.google.de/search": serpPage([
        { url: MISSING_URL, label: "Gone Co." },
        { url: COMPANY_URL, label: "Firma X – Ausbildung" },
        { url: EXTRA_ONE, label: "Extra One" },
      ]),
      "firma-gone.de/ausbildung": notFoundPage(),
      "firma-x.de/karriere/ausbildung": companyPage(),
      "extra-one.de/ausbildung": plainCompanyPage("Extra One AG"),
    });
    const h = harness();
    const result = await runBrowser(engine, h);

    expect(result.blocked).toBe(false);
    expect(result.pagesUsed).toBe(4); // SERP + 3 candidates (one a 404)
    expect(result.offersFound).toBe(2);
    expect(h.offers.map((offer) => offer.companyName)).toEqual([
      "Firma X GmbH",
      "Extra One AG",
    ]);
    expect(engine.state.closedTabs).toBe(1);
  });

  it("honors the run's page budget", async () => {
    const engine = fakeEngine({
      "www.google.de/search": serpPage([
        { url: COMPANY_URL, label: "Firma X – Ausbildung" },
        { url: PORTAL_URL, label: "Ausbildung Mechatroniker" },
        { url: EXTRA_ONE, label: "Extra One" },
        { url: EXTRA_TWO, label: "Extra Two" },
      ]),
      "firma-x.de/karriere/ausbildung": companyPage(),
      "jobsportal.de/angebote/mechatroniker-muenchen": portalPage(),
      "extra-one.de/ausbildung": plainCompanyPage("Extra One AG"),
      "extra-two.de/jobs": plainCompanyPage("Extra Two SE"),
    });
    const h = harness();
    const result = await runBrowser(engine, h, { maxPages: 3 });

    // SERP (1) + two candidates (2, 3) — the third candidate is never loaded.
    expect(result.pagesUsed).toBe(3);
    expect(result.offersFound).toBe(2);
    expect(result.blocked).toBe(false);
    expect(engine.state.navigations).toBe(2);
    expect(engine.state.closedTabs).toBe(1);
  });

  it("reuses one tab across queries, macro-searches Google, never re-browses", async () => {
    const engine = fakeEngine({
      "www.google.de/search": serpPage([
        { url: COMPANY_URL, label: "Firma X – Ausbildung" },
        { url: EXTRA_ONE, label: "Extra One" },
        { url: EXTRA_TWO, label: "Extra Two" },
      ]),
      "firma-x.de/karriere/ausbildung": companyPage(),
      "extra-one.de/ausbildung": plainCompanyPage("Extra One AG"),
      "extra-two.de/jobs": plainCompanyPage("Extra Two SE"),
    });
    const h = harness();
    const result = await runBrowser(engine, h, {
      queries: [QUERY, "Elektronikerin Ausbildung 2027"],
    });

    // Query 1: openTab (SERP) + 3 candidates. Query 2: the SAME tab takes the
    // @google_search macro to a fresh SERP (page 5) — whose candidates are all
    // visited already, so nothing is re-browsed (work is never repeated).
    expect(result.queriesExecuted).toBe(2);
    expect(result.pagesUsed).toBe(5);
    expect(result.offersFound).toBe(3);
    expect(engine.state.tabCounter).toBe(1); // ONE tab for the whole source run
    expect(engine.state.macroNavigations).toBe(1);
    expect(engine.state.closedTabs).toBe(1);
    expect(h.live.some((line) => line.includes("Elektronikerin"))).toBe(true);
  });

  it("stops immediately when cancellation is requested", async () => {
    const engine = fakeEngine({
      "www.google.de/search": serpPage([
        { url: COMPANY_URL, label: "Firma X" },
        { url: EXTRA_ONE, label: "Extra One" },
        { url: EXTRA_TWO, label: "Extra Two" },
      ]),
    });
    const h = harness();
    const result = await runBrowser(engine, h, { shouldStop: () => true });

    expect(result.queriesExecuted).toBe(0);
    expect(result.pagesUsed).toBe(0);
    expect(result.blocked).toBe(false);
    expect(engine.state.tabCounter).toBe(0);
    expect(engine.state.closedTabs).toBe(0);
  });
});
