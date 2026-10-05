import { describe, expect, it, vi } from "vitest";

/**
 * The company deep crawl — the browser's research pass over ONE company site.
 *
 * A FAITHFUL fake of the camofox-browser REST API (verified contract) serves a
 * realistic multi-page German company site (firma.de), and the REAL
 * CamofoxClient + REAL crawlCompanySite run against it. What is proven:
 *
 *  - frontier priority order (Ausbildung > Karriere > Jobs > Kontakt > …);
 *  - SESSION REUSE: one tab for the whole company crawl;
 *  - bounded lazy-content interaction ("Mehr anzeigen" reveals new links);
 *  - 404 = page_not_found (no breaker, crawl continues);
 *  - cross-domain and SSRF links are NEVER loaded;
 *  - rendered content feeds the EXISTING extractors: JobPosting JSON-LD
 *    (offers), literal emails (no guessing), site-year (beginn), application
 *    page;
 *  - MAX_PAGES / MAX_DEPTH are enforced; the pending frontier survives for
 *    /continue (resume without re-fetching visited pages);
 *  - a browser failure mid-crawl yields PARTIAL evidence, not a crash.
 */

import { CamofoxClient, type CamofoxConfig } from "@/lib/company-discovery/camofox/client";
import { crawlCompanySite, priorityOf } from "@/lib/company-discovery/camofox/deep-crawl";

const CONFIG: CamofoxConfig = {
  baseUrl: "http://127.0.0.1:9377",
  accessKey: null,
  timeoutMs: 2000,
};

// ---------------------------------------------------------------------------
// The fake site (what the browser "sees" when rendered)
// ---------------------------------------------------------------------------

interface FakePageData {
  status?: number;
  title: string;
  html: string;
  text: string;
  links: string[];
  loadMore?: { label: string; ref: string; extraLinks: string[] };
}

const TEXT_120 = "Musterzeile mit ausreichend sichtbarem Text, damit die Seite als Inhalt zählt und nicht leer bleibt. Weiterer Satz.";

const JOB_POSTING = (
  name: string,
  title: string,
  url: string,
): string =>
  `<script type="application/ld+json">${JSON.stringify({
    "@type": "JobPosting",
    title,
    url,
    hiringOrganization: { "@type": "Organization", name, url: "https://firma.de" },
    jobLocation: { "@type": "Place", name: "München" },
    datePosted: "2026-10-01",
  })}</script>`;

const PAGES: Record<string, FakePageData> = {
  "/": {
    title: "Firma GmbH",
    html: "<html><body>Willkommen</body></html>",
    text: TEXT_120,
    links: [
      "https://firma.de/karriere",
      "https://firma.de/impressum",
      "https://firma.de/kontakt",
      "https://firma.de/jobs",
      "https://firma.de/ausbildung",
      "https://firma.de/ueber-uns",
      "https://anders.de/karriere", // cross-domain: must never be loaded
      "http://127.0.0.1/secret", // SSRF: must never be loaded
    ],
  },
  "/karriere": {
    title: "Karriere",
    html: JOB_POSTING("Firma GmbH", "Ausbildung Mechatroniker", "https://firma.de/karriere/mechatroniker"),
    text: TEXT_120,
    links: [
      "https://firma.de/karriere/mechatroniker",
      "https://firma.de/bewerber/online-bewerbung",
    ],
  },
  "/karriere/mechatroniker": {
    title: "Mechatroniker",
    html: JOB_POSTING("Firma GmbH", "Mechatroniker Azubi", "https://firma.de/karriere/mechatroniker"),
    text: `Ausbildung 2027 – Wir bilden Mechatroniker aus. ${TEXT_120} Mehr anzeigen`,
    links: [],
    loadMore: {
      label: "Mehr anzeigen",
      ref: "e10",
      extraLinks: ["https://firma.de/ausbildungsplatz-2"],
    },
  },
  "/ausbildungsplatz-2": {
    title: "Tochter GmbH",
    html: JOB_POSTING("Tochter GmbH", "Elektroniker Azubi", "https://firma.de/ausbildungsplatz-2"),
    text: TEXT_120,
    links: [],
  },
  "/ausbildung": {
    title: "Ausbildung",
    html: JOB_POSTING("Firma GmbH", "Ausbildung Industriemechaniker", "https://firma.de/ausbildung"),
    text: TEXT_120,
    links: [],
  },
  "/kontakt": {
    title: "Kontakt",
    html: "<html><body>Kontakt</body></html>",
    text: `Kontakt: bewerbung@firma.de, Telefon 089 123 456. ${TEXT_120}`,
    links: [],
  },
  "/impressum": {
    title: "Impressum",
    html: "<html><body>Impressum</body></html>",
    text: `Firma GmbH, Musterstraße 1, 80331 München. Geschäftsführer Max Mustermann. HRB 1234. ${TEXT_120}`,
    links: [],
  },
  "/bewerber/online-bewerbung": {
    title: "Bewerbung",
    html: "<html><body>Bewerbung</body></html>",
    text: `Online-Bewerbung bei der Firma GmbH. ${TEXT_120}`,
    links: [],
  },
  "/jobs": {
    status: 404,
    title: "404",
    html: "<html><body>Not found</body></html>",
    text: "Not Found",
    links: [],
  },
  "/ueber-uns": {
    title: "Über uns",
    html: "<html><body>Über uns</body></html>",
    text: TEXT_120,
    links: [],
  },
};

interface FakeCamofoxOptions {
  /** The Nth navigation and beyond fail at the network level. */
  failAfterNavigate?: number;
}

/** A faithful fake of the camofox-browser REST API over the site above. */
function fakeCamofoxServer(options: FakeCamofoxOptions = {}) {
  const state = {
    tabs: new Map<string, string>(), // tabId → current path
    tabCounter: 0,
    navigations: 0,
    clicks: 0,
    expanded: new Set<string>(), // paths whose load-more was clicked
    loaded: [] as string[], // every URL the "browser" actually loaded
  };
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
    const url = new URL(raw);

    if (method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true });
    }
    if (method === "DELETE") return Response.json({ ok: true });

    if (method === "POST" && url.pathname === "/tabs") {
      state.tabCounter += 1;
      const tabId = `tab-${state.tabCounter}`;
      const pageUrl = String(body?.url ?? "https://firma.de/");
      const path = new URL(pageUrl).pathname.replace(/\/+$/, "") || "/";
      state.tabs.set(tabId, path);
      state.loaded.push(pageUrl);
      return Response.json({
        tabId,
        url: pageUrl,
        httpStatus: PAGES[path]?.status ?? 200,
        navigationOk: (PAGES[path]?.status ?? 200) < 400,
      });
    }
    const nav = url.pathname.match(/^\/tabs\/([^/]+)\/navigate$/);
    if (method === "POST" && nav) {
      state.navigations += 1;
      if (options.failAfterNavigate && state.navigations > options.failAfterNavigate) {
        throw new Error("browser network down");
      }
      const pageUrl = String(body?.url ?? "");
      const path = new URL(pageUrl).pathname.replace(/\/+$/, "") || "/";
      state.tabs.set(nav[1], path);
      state.loaded.push(pageUrl);
      return Response.json({
        ok: true,
        tabId: nav[1],
        url: pageUrl,
        httpStatus: PAGES[path]?.status ?? 200,
        navigationOk: (PAGES[path]?.status ?? 200) < 400,
      });
    }
    const ev = url.pathname.match(/^\/tabs\/([^/]+)\/evaluate$/);
    if (method === "POST" && ev) {
      const path = state.tabs.get(ev[1]) ?? "/";
      const data = PAGES[path] ?? PAGES["/"];
      return Response.json({
        ok: true,
        result: {
          title: data.title,
          href: `https://firma.de${path === "/" ? "" : path}`,
          html: data.html + `<a href="#">${data.title}</a>`,
          text: data.text,
        },
      });
    }
    const links = url.pathname.match(/^\/tabs\/([^/]+)\/links$/);
    if (method === "GET" && links) {
      const path = state.tabs.get(links[1]) ?? "/";
      const data = PAGES[path] ?? PAGES["/"];
      const expanded = state.expanded.has(path);
      const all = [
        ...data.links,
        ...(expanded && data.loadMore ? data.loadMore.extraLinks : []),
      ];
      return Response.json({
        links: all.map((u) => ({ url: u, text: u })),
        pagination: { total: all.length, offset: 0, limit: 100, hasMore: false },
      });
    }
    const snap = url.pathname.match(/^\/tabs\/([^/]+)\/snapshot$/);
    if (method === "GET" && snap) {
      const path = state.tabs.get(snap[1]) ?? "/";
      const data = PAGES[path] ?? PAGES["/"];
      const snapshot = data.loadMore
        ? `- button "${data.loadMore.label}" [ref=${data.loadMore.ref}]`
        : "- document";
      return Response.json({ url: "https://firma.de", snapshot });
    }
    const click = url.pathname.match(/^\/tabs\/([^/]+)\/click$/);
    if (method === "POST" && click) {
      state.clicks += 1;
      const path = state.tabs.get(click[1]) ?? "/";
      const data = PAGES[path];
      if (data?.loadMore) state.expanded.add(path);
      return Response.json({ ok: true });
    }
    if (method === "POST" && url.pathname.match(/^\/tabs\/[^/]+\/(scroll|wait)$/)) {
      return Response.json({ ok: true });
    }
    return Response.json({ error: "unknown route" }, { status: 404 });
  };
  const fetch = vi.fn(engineFetch) as unknown as FetchImpl;

  return { fetch, state, tabCount: () => state.tabCounter };
}

type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function clientOf(server: ReturnType<typeof fakeCamofoxServer>, maxPages = 30): CamofoxClient {
  return new CamofoxClient(CONFIG, "discovery:crawl-test", {
    maxPages,
    maxInteractions: 20,
    deps: { fetchImpl: server.fetch, isPublicHost: async (host) => host === "firma.de" },
  });
}

const INPUT = {
  websiteUrl: "https://firma.de/karriere?utm=1",
  companyName: "Firma GmbH",
  companyDomain: "firma.de",
  role: "mechatroniker",
  field: "Technik",
  goal: "ausbildung" as const,
  limits: { maxDepth: 3, maxPages: 30, maxInteractions: 10, textBudget: 20_000 },
};

async function runCrawl(
  server: ReturnType<typeof fakeCamofoxServer>,
  overrides: Partial<typeof INPUT> & { extra?: Parameters<typeof crawlCompanySite>[1] } = {},
) {
  return crawlCompanySite(clientOf(server), { ...INPUT, ...overrides });
}

describe("frontier priority (§31)", () => {
  it("ranks page kinds: ausbildung 100 > karriere 95 > bewerbung 90 > jobs 85 > kontakt/impressum 80 > homepage 70 > other 20", () => {
    expect(priorityOf("ausbildung", "https://f.de/x")).toBe(100);
    expect(priorityOf("karriere", "https://f.de/karriere")).toBe(95);
    expect(priorityOf("other", "https://f.de/bewerber/online-bewerbung")).toBe(90);
    expect(priorityOf("jobs", "https://f.de/jobs")).toBe(85);
    expect(priorityOf("kontakt", "https://f.de/kontakt")).toBe(80);
    expect(priorityOf("impressum", "https://f.de/impressum")).toBe(80);
    expect(priorityOf("homepage", "https://f.de/")).toBe(70);
    expect(priorityOf("other", "https://f.de/ueber-uns")).toBe(20);
  });

  it("crawls in priority order (Ausbildung page before Karriere before Jobs)", async () => {
    const server = fakeCamofoxServer();
    const result = await runCrawl(server, {
      websiteUrl: "https://firma.de/",
      limits: { maxDepth: 1, maxPages: 6, maxInteractions: 0, textBudget: 20_000 },
    });
    const order = result.pages.map((p) => p.url);
    expect(order[0]).toBe("https://firma.de/");
    // /ausbildung (100) before /karriere (95) before /kontakt (80)
    expect(order.indexOf("https://firma.de/ausbildung")).toBeLessThan(order.indexOf("https://firma.de/karriere"));
    expect(order.indexOf("https://firma.de/karriere")).toBeLessThan(order.indexOf("https://firma.de/kontakt"));
    // /jobs (85) was ATTEMPTED between karriere and kontakt (it 404s on the
    // site, so it is recorded as not_found, not as a crawled page).
    const loaded = server.state.loaded.map((u) => new URL(u).pathname);
    expect(loaded.indexOf("/jobs")).toBeGreaterThan(loaded.indexOf("/karriere"));
    expect(loaded.indexOf("/jobs")).toBeLessThan(loaded.indexOf("/kontakt"));
  });
});

describe("session reuse + bounds", () => {
  it("uses ONE tab for the whole company crawl (session reuse)", async () => {
    const server = fakeCamofoxServer();
    await runCrawl(server, { websiteUrl: "https://firma.de/" });
    expect(server.state.tabs.size).toBe(1);
    expect(server.tabCount()).toBe(1); // exactly one POST /tabs
    // The rest were navigations inside the same session.
    expect(server.state.navigations).toBeGreaterThan(3);
  });

  it("MAX_PAGES_PER_COMPANY is enforced (the crawl stops at the budget)", async () => {
    const server = fakeCamofoxServer();
    const result = await runCrawl(server, {
      websiteUrl: "https://firma.de/",
      limits: { maxDepth: 3, maxPages: 2, maxInteractions: 0, textBudget: 20_000 },
    });
    expect(result.pagesFetched).toBeLessThanOrEqual(2);
    expect(result.pagesFetched).toBe(2);
    // The frontier still has work left → the checkpoint is non-empty.
    expect(result.pendingFrontier.length).toBeGreaterThan(0);
    expect(result.blocked).toBe(false);
  });

  it("MAX_CRAWL_DEPTH is enforced (depth-2 pages are never loaded)", async () => {
    const server = fakeCamofoxServer();
    await runCrawl(server, {
      websiteUrl: "https://firma.de/",
      limits: { maxDepth: 1, maxPages: 30, maxInteractions: 0, textBudget: 20_000 },
    });
    // /karriere/mechatroniker is depth 2 (homepage → karriere → mechatroniker).
    expect(server.state.loaded.some((u) => u.includes("mechatroniker"))).toBe(false);
  });
});

describe("honest failure handling", () => {
  it("a 404 is a page_not_found — the crawl continues, no breaker", async () => {
    const server = fakeCamofoxServer();
    const result = await runCrawl(server, {
      websiteUrl: "https://firma.de/",
      limits: { maxDepth: 1, maxPages: 10, maxInteractions: 0, textBudget: 20_000 },
    });
    // /jobs is 404 on the site:
    expect(result.blocked).toBe(false);
    // The crawl still reached the other pages (it did not stop at the 404).
    expect(result.pages.length).toBeGreaterThan(2);
    // The frontier records the 404 honestly.
    expect(
      result.pendingFrontier.some((e) => e.url.includes("/jobs")),
    ).toBe(false); // not_found is NOT pending
  });

  it("cross-domain and SSRF links are NEVER loaded by the browser", async () => {
    const server = fakeCamofoxServer();
    await runCrawl(server, { websiteUrl: "https://firma.de/" });
    expect(server.state.loaded.some((u) => u.includes("anders.de"))).toBe(false);
    expect(server.state.loaded.some((u) => u.includes("127.0.0.1"))).toBe(false);
  });

  it("a browser failure mid-crawl yields PARTIAL evidence, not a crash", async () => {
    const server = fakeCamofoxServer({ failAfterNavigate: 2 });
    const result = await runCrawl(server, {
      websiteUrl: "https://firma.de/",
      limits: { maxDepth: 3, maxPages: 30, maxInteractions: 0, textBudget: 20_000 },
    });
    expect(result.blocked).toBe(true);
    expect(result.blockedReason).toMatch(/browser/);
    // Everything fetched BEFORE the failure is preserved (evidence is never lost).
    expect(result.pagesFetched).toBeGreaterThanOrEqual(2);
    // And the checkpoint carries the remaining frontier for /continue.
    expect(result.pendingFrontier.length).toBeGreaterThan(0);
  });
});

describe("evidence from rendered content", () => {
  it("extracts JobPosting offers from rendered JSON-LD (incl. group companies)", async () => {
    const server = fakeCamofoxServer();
    // depth 3: the load-more reveal (/ausbildungsplatz-2) sits one level
    // below the role page (homepage → karriere → mechatroniker → platz-2).
    const result = await runCrawl(server, {
      websiteUrl: "https://firma.de/",
      limits: { maxDepth: 3, maxPages: 30, maxInteractions: 2, textBudget: 20_000 },
    });
    const names = result.offers.map((o) => o.companyName);
    expect(names).toContain("Firma GmbH");
    // The load-more interaction revealed /ausbildungsplatz-2 → "Tochter GmbH"
    expect(names).toContain("Tochter GmbH");
  });

  it("accepts ONLY literally published emails (never guessed)", async () => {
    const server = fakeCamofoxServer();
    const result = await runCrawl(server, {
      websiteUrl: "https://firma.de/",
      limits: { maxDepth: 1, maxPages: 30, maxInteractions: 0, textBudget: 20_000 },
    });
    const emails = result.emails.map((e) => e.email);
    expect(emails).toContain("bewerbung@firma.de");
    expect(result.emails[0].verificationMethod).toBe("literal_on_official_site");
    // …and it was found on the contact page:
    expect(
      result.emails.find((e) => e.email === "bewerbung@firma.de")?.sourceUrl,
    ).toContain("/kontakt");
    // No guessed addresses (info@, karriere@, hr@ …) exist on the site.
    expect(emails).toHaveLength(1);
  });

  it("records the documented beginn year (never a guess)", async () => {
    const server = fakeCamofoxServer();
    const result = await runCrawl(server, {
      websiteUrl: "https://firma.de/",
      limits: { maxDepth: 2, maxPages: 30, maxInteractions: 0, textBudget: 20_000 },
    });
    expect(result.siteYear.year).toBe(2027);
    expect(result.siteYear.conflict).toBe(false);
  });

  it("verifies the application page on the official domain", async () => {
    const server = fakeCamofoxServer();
    // depth 2: /bewerber/online-bewerbung is linked from /karriere.
    const result = await runCrawl(server, {
      websiteUrl: "https://firma.de/",
      limits: { maxDepth: 2, maxPages: 30, maxInteractions: 0, textBudget: 20_000 },
    });
    expect(result.applicationUrl).toBe(
      "https://firma.de/bewerber/online-bewerbung",
    );
  });
});

describe("lazy content — interactions", () => {
  it("clicks 'Mehr anzeigen' when the listing is lazy and crawls what it reveals", async () => {
    const server = fakeCamofoxServer();
    const result = await runCrawl(server, {
      websiteUrl: "https://firma.de/",
      limits: { maxDepth: 3, maxPages: 30, maxInteractions: 2, textBudget: 20_000 },
    });
    expect(server.state.clicks).toBeGreaterThanOrEqual(1);
    expect(result.interactionsUsed).toBeGreaterThanOrEqual(1);
    // The revealed page was actually crawled:
    expect(result.pages.some((p) => p.url.includes("/ausbildungsplatz-2"))).toBe(true);
  });

  it("stops interacting when the budget is exhausted (no grinding)", async () => {
    const server = fakeCamofoxServer();
    const result = await runCrawl(server, {
      websiteUrl: "https://firma.de/",
      limits: { maxDepth: 2, maxPages: 30, maxInteractions: 1, textBudget: 20_000 },
    });
    expect(result.interactionsUsed).toBeLessThanOrEqual(1);
  });
});

describe("checkpoint + resume (/continue)", () => {
  it("resumes from the persisted frontier without re-fetching visited pages", async () => {
    const server = fakeCamofoxServer();
    const first = await runCrawl(server, {
      websiteUrl: "https://firma.de/",
      limits: { maxDepth: 1, maxPages: 2, maxInteractions: 0, textBudget: 20_000 },
    });
    const visitedBefore = new Set(first.pages.map((p) => p.url));
    expect(visitedBefore.size).toBe(2);
    expect(first.pendingFrontier.length).toBeGreaterThan(0);

    // The SECOND crawl (a /continue batch) restores the frontier + visited set.
    const second = await crawlCompanySite(clientOf(server), {
      ...INPUT,
      websiteUrl: "https://firma.de/",
      limits: { maxDepth: 1, maxPages: 30, maxInteractions: 0, textBudget: 20_000 },
      frontier: first.pendingFrontier,
      visitedUrls: visitedBefore,
    });
    // No already-visited page was fetched again:
    for (const page of second.pages) {
      expect(visitedBefore.has(page.url)).toBe(false);
    }
    // And the crawl made progress beyond the first batch's stop point.
    expect(second.pagesFetched).toBeGreaterThan(0);
  });
});
