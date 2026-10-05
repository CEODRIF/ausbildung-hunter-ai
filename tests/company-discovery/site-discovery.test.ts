import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * In-site discovery (agentic engine): the company's site tells the pass where
 * its Kontakt / Karriere / Ausbildung / Bewerbung pages live, and the pass
 * follows ONLY those allow-listed, same-origin, not-yet-visited links —
 * bounded, deterministic, through the same guarded fetcher. A link the site
 * does not publish is simply not discovered: nothing is guessed.
 */

import {
  applicationUrlOf,
  createGuardedSiteFetcher,
  discoveredPageLimit,
  discoverSitePaths,
} from "@/lib/company-discovery/emails";
import { createFetchContext } from "@/lib/company-discovery/fetch-guard";

const ORIGIN = "https://firma.de";

/**
 * Real `Response` objects: `guardedFetch` iterates `response.headers`
 * (needs `forEach`) and classifies on the `content-type` header (a page
 * without an HTML content-type is refused as `not_html`). A hand-rolled
 * stub would fail closed — and hide the real behavior under test.
 */
function page(body: string): Response {
  return new Response(body, {
    status: body === "" ? 404 : 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

describe("discoverSitePaths (pure)", () => {
  const HOME_HTML = `<html><body>
    <a href="/impressum">Impressum</a>
    <a href="https://other.example/x">external</a>
    <a href="//cdn.firma.de/script.js">protocol-relative external</a>
    <a href="/karriere/ausbildung">Ausbildung</a>
    <a href="/jobs/bewerben?ref=nav">Bewerben</a>
    <a href="/shop/buerostuhl">Shop</a>
    <a href="/kontakt/">Kontakt</a>
    <a href="/karriere/ausbildung">duplicate</a>
    <a href="/bewerbung/">Bewerbung</a>
  </body></html>`;

  it("follows only allow-listed, same-origin, unvisited paths", () => {
    const found = discoverSitePaths({
      html: HOME_HTML,
      origin: ORIGIN,
      visitedUrls: [`${ORIGIN}/impressum`, `${ORIGIN}/kontakt`],
      limit: 10,
    });
    // impressum/kontakt already visited; external + shop + protocol-relative
    // never qualify; the duplicate is dropped; order = first-seen.
    expect(found).toEqual([
      { url: `${ORIGIN}/karriere/ausbildung`, path: "/karriere/ausbildung", kind: "ausbildung" },
      { url: `${ORIGIN}/jobs/bewerben`, path: "/jobs/bewerben", kind: "jobs" },
      { url: `${ORIGIN}/bewerbung`, path: "/bewerbung", kind: "bewerbung" },
    ]);
  });

  it("honors the limit and never exceeds it", () => {
    const found = discoverSitePaths({
      html: HOME_HTML,
      origin: ORIGIN,
      visitedUrls: [`${ORIGIN}/impressum`, `${ORIGIN}/kontakt`],
      limit: 1,
    });
    expect(found).toHaveLength(1);
    expect(found[0].kind).toBe("ausbildung");
  });

  it("an empty page discovers nothing (a real answer, not a failure)", () => {
    expect(
      discoverSitePaths({ html: "<p>Keine Links</p>", origin: ORIGIN, visitedUrls: [], limit: 3 }),
    ).toEqual([]);
  });

  it("trailing slashes and queries do not create phantom duplicates", () => {
    const html = `<a href="/karriere/">a</a><a href="/karriere?x=1">b</a><a href="/karriere">c</a>`;
    const found = discoverSitePaths({ html, origin: ORIGIN, visitedUrls: [], limit: 5 });
    expect(found).toHaveLength(1);
    expect(found[0].url).toBe(`${ORIGIN}/karriere`);
  });
});

describe("discoveredPageLimit (env-tunable, clamped)", () => {
  const ORIGINAL = process.env.DISCOVERY_MAX_DISCOVERED_PAGES;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.DISCOVERY_MAX_DISCOVERED_PAGES;
    else process.env.DISCOVERY_MAX_DISCOVERED_PAGES = ORIGINAL;
  });

  it("defaults to 3 when unset", () => {
    delete process.env.DISCOVERY_MAX_DISCOVERED_PAGES;
    expect(discoveredPageLimit()).toBe(3);
  });
  it("0 disables discovery entirely", () => {
    process.env.DISCOVERY_MAX_DISCOVERED_PAGES = "0";
    expect(discoveredPageLimit()).toBe(0);
  });
  it("clamps into [0, 5] and falls back on invalid input", () => {
    process.env.DISCOVERY_MAX_DISCOVERED_PAGES = "99";
    expect(discoveredPageLimit()).toBe(5);
    process.env.DISCOVERY_MAX_DISCOVERED_PAGES = "abc";
    expect(discoveredPageLimit()).toBe(3);
    process.env.DISCOVERY_MAX_DISCOVERED_PAGES = "2";
    expect(discoveredPageLimit()).toBe(2);
  });
});

describe("guarded site pass with in-site discovery", () => {
  const ORIGINAL = process.env.DISCOVERY_MAX_DISCOVERED_PAGES;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.DISCOVERY_MAX_DISCOVERED_PAGES;
    else process.env.DISCOVERY_MAX_DISCOVERED_PAGES = ORIGINAL;
    vi.unstubAllGlobals();
  });

  function siteFetchImpl(failDiscovered: boolean) {
    const calls: string[] = [];
    const impl = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/robots.txt")) {
        return page("User-agent: *\nAllow: /");
      }
      if (url === `${ORIGIN}/impressum`) {
        return page(`<html><body>
           <a href="/kontakt">Kontakt</a>
           <a href="/ausbildung">Ausbildung</a>
           <a href="/jobs/bewerben">Jetzt bewerben</a>
           <a href="/shop">Shop</a>
           E-Mail: info@firma.de
         </body></html>`);
      }
      if (url === `${ORIGIN}/kontakt`) {
        return page(`<html><body>info@firma.de</body></html>`);
      }
      if (url === `${ORIGIN}/karriere`) {
        return page("<html><body>Karriere bei Firma</body></html>");
      }
      if (url === `${ORIGIN}/ausbildung`) {
        return page(`<html><body>azubi@firma.de</body></html>`);
      }
      // A DISCOVERED-only page (never one of the fixed targets): the dead-link
      // scenario must hit this URL so its 403 stays in the discovery branch.
      if (url === `${ORIGIN}/jobs/bewerben`) {
        return failDiscovered
          ? new Response("Forbidden", {
              status: 403,
              headers: { "content-type": "text/html; charset=utf-8" },
            })
          : page(`<html><body>Stellenausschreibung</body></html>`);
      }
      return page("");
    }) as unknown as typeof fetch;
    // `fetchRobots` issues its robots.txt request through the GLOBAL fetch,
    // not the injected `fetchImpl` — stub it too so the test stays offline.
    vi.stubGlobal("fetch", impl);
    return { impl, calls };
  }

  it("opens the site's own contact/career links after the fixed targets — and nothing else", async () => {
    delete process.env.DISCOVERY_MAX_DISCOVERED_PAGES;
    const { impl, calls } = siteFetchImpl(false);
    const fetcher = createGuardedSiteFetcher(
      createFetchContext({ fetchImpl: impl, isPublicHost: async () => true, sleep: async () => undefined }),
    );
    const outcome = await fetcher(`${ORIGIN}/`);

    // Fixed targets first (priority untouched — all six of them now), then
    // the DISCOVERED page: /ausbildung is a fixed target (200 here), the
    // discovered /jobs/bewerben adds the jobs evidence.
    const kinds = outcome.pages.map((page) => page.kind);
    expect(kinds.slice(0, 3)).toEqual(["impressum", "kontakt", "karriere"]);
    expect(kinds).toContain("ausbildung");
    expect(kinds).toContain("jobs");
    expect(outcome.blocked).toBe(false);
    // The site's /shop link is NEVER fetched; neither is a second karriere:
    expect(calls).not.toContain(`${ORIGIN}/shop`);
    expect(calls.filter((url) => url.includes("karriere"))).toHaveLength(1);
    // Real requests only: robots + 6 fixed + 1 discovered = 8.
    // (The /jobs and /team fixed targets 404 empty — real answers, no block.)
    expect(calls).toHaveLength(8);
  });

  it("the env cap limits the discovered pages", async () => {
    process.env.DISCOVERY_MAX_DISCOVERED_PAGES = "1";
    const { impl, calls } = siteFetchImpl(false);
    const fetcher = createGuardedSiteFetcher(
      createFetchContext({ fetchImpl: impl, isPublicHost: async () => true, sleep: async () => undefined }),
    );
    const outcome = await fetcher(`${ORIGIN}/`);
    // Exactly ONE discovered page fetched (/jobs/bewerben); /bewerbung never
    // reached:
    expect(outcome.pages.map((page) => page.kind)).toEqual(["impressum", "kontakt", "karriere", "ausbildung", "jobs"]);
    expect(calls).not.toContain(`${ORIGIN}/bewerbung`);
  });

  it("0 disables discovery: exactly the fixed targets run", async () => {
    process.env.DISCOVERY_MAX_DISCOVERED_PAGES = "0";
    const { impl, calls } = siteFetchImpl(false);
    const fetcher = createGuardedSiteFetcher(
      createFetchContext({ fetchImpl: impl, isPublicHost: async () => true, sleep: async () => undefined }),
    );
    const outcome = await fetcher(`${ORIGIN}/`);
    expect(outcome.pages.map((page) => page.kind)).toEqual(["impressum", "kontakt", "karriere", "ausbildung"]);
    expect(calls).toHaveLength(7); // robots + 6 fixed
  });

  it("a dead DISCOVERED link never taints the pass or an email already found", async () => {
    delete process.env.DISCOVERY_MAX_DISCOVERED_PAGES;
    const { impl } = siteFetchImpl(true); // /jobs/bewerben (discovered-only) → 403
    const fetcher = createGuardedSiteFetcher(
      createFetchContext({ fetchImpl: impl, isPublicHost: async () => true, sleep: async () => undefined }),
    );
    const outcome = await fetcher(`${ORIGIN}/`);
    // The required pages (impressum/kontakt) were inspected: NOT blocked …
    expect(outcome.blocked).toBe(false);
    expect(outcome.pages.some((p) => p.kind === "impressum")).toBe(true);
    expect(outcome.pages.some((p) => p.kind === "kontakt")).toBe(true);
    // …and the email from the impressum is still usable:
    expect(outcome.pages.find((p) => p.kind === "impressum")?.text).toContain("info@firma.de");
  });
});

describe("applicationUrlOf — verified application pages only", () => {
  it("a discovered Bewerbung page counts as an application URL", () => {
    expect(
      applicationUrlOf({ inspectedPages: [{ url: "https://firma.de/bewerbung", kind: "bewerbung" }] }, null),
    ).toBe("https://firma.de/bewerbung");
    // Karriere still wins over Bewerbung (fixed page order):
    expect(
      applicationUrlOf(
        {
          inspectedPages: [
            { url: "https://firma.de/karriere", kind: "karriere" },
            { url: "https://firma.de/bewerbung", kind: "bewerbung" },
          ],
        },
        null,
      ),
    ).toBe("https://firma.de/karriere");
    // …and nothing is invented when no application page was inspected:
    expect(
      applicationUrlOf({ inspectedPages: [{ url: "https://firma.de/impressum", kind: "impressum" }] }, null),
    ).toBeNull();
  });
});
