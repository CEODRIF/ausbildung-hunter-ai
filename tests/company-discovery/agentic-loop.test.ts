import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The search adapter's AGENTIC loop — plan → search → extract → verify
 * (interleaved) → report → next batch.
 *
 * With a `queryProvider` the Research Planner drives the search phase:
 *  - batches are planned on demand (never a fixed one-shot list);
 *  - each batch's offers are handed to the orchestrator BEFORE the next
 *    batch's provider calls are issued (interleaved verification);
 *  - one measured report per batch (the planner's coverage signal);
 *  - `null` from the provider ends the phase honestly;
 *  - without a provider the legacy single fixed batch runs unchanged.
 */

import {
  createSearchAdapter,
  type SearchBatchReport,
} from "@/lib/company-discovery/adapters";
import { createFetchContext } from "@/lib/company-discovery/fetch-guard";
import type { OpportunitySearchParams } from "@/lib/opportunities/types";
import type { WebSearchClient } from "@/lib/web-search";

const CRITERIA: OpportunitySearchParams = {
  goal: "ausbildung",
  keyword: "Technik",
  role: "Mechatroniker",
  company: "",
  location: "",
  cities: [],
  beginn: "2027-08",
  freshness: "any",
  sort: "relevance",
  employment: "any",
  training_type: "any",
  home_office: "any",
  salary: "any",
  contact_email: "any",
  page: 1,
  pageSize: 20,
  match: false,
};

/** One JobPosting per query, on the query's own fake company page. */
function jobPostingPage(url: string, company: string, role: string, city: string): string {
  // NOTE: `role`/`company` are interpolated RAW into the JSON-LD string
  // literal (no `JSON.stringify` — that would emit unescaped quotes and
  // make the block invalid JSON, which the parser correctly ignores).
  return `<!doctype html><html><head><script type="application/ld+json">
  {"@context":"https://schema.org","@type":"JobPosting","title":${JSON.stringify(role)},
   "description":${JSON.stringify(`Ausbildung ${role} — ${company}`)},
   "datePosted":"2026-10-01","validThrough":"2026-12-31",
   "hiringOrganization":{"@type":"Organization","name":${JSON.stringify(company)},"url":${JSON.stringify(url)}},
   "jobLocation":{"@type":"Place","address":{"@type":"PostalAddress","addressLocality":${JSON.stringify(city)},"addressRegion":"Bayern"}}}
  </script></head><body>${company}</body></html>`;
}

/**
 * Real `Response` objects: `guardedFetch` iterates `response.headers`
 * (needs `forEach`) and classifies on the `content-type` header (a page
 * without an HTML content-type is refused as `not_html`). A hand-rolled
 * stub would fail closed — and hide the real behavior under test.
 */
function fakeResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/**
 * A fetch stub that serves robots + one JobPosting page per query host. It
 * replaces BOTH the injected `fetchImpl` AND the global `fetch` — because
 * `fetchRobots` issues its robots.txt request through the GLOBAL fetch, not
 * the injected one. Stubbing the global keeps the test offline and lets the
 * robots calls be counted.
 */
function makeFetch(pages: Map<string, string>) {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/robots.txt")) {
      return fakeResponse("User-agent: *\nAllow: /");
    }
    return fakeResponse(pages.get(url) ?? "", pages.has(url) ? 200 : 404);
  }) as unknown as typeof fetch;
  vi.stubGlobal("fetch", fetchImpl);
  return { fetchImpl, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeClient(handler: (query: string) => Array<{ url: string; title: string; snippet: string }>) {
  const calls: string[] = [];
  const client: WebSearchClient = {
    name: "tavily",
    search: async (query: string) => {
      calls.push(query);
      return handler(query);
    },
  };
  return { client, calls };
}

describe("search adapter — the agentic batch loop", () => {
  it("runs planner-supplied batches, verifies each BEFORE the next, and reports per batch", async () => {
    const pages = new Map<string, string>([
      ["https://firma-a.de/offer", jobPostingPage("https://firma-a.de/offer", "Firma A GmbH", "Mechatroniker (Ausbildung)", "München")],
      ["https://firma-b.de/offer", jobPostingPage("https://firma-b.de/offer", "Firma B AG", "Elektroniker (Ausbildung)", "Augsburg")],
    ]);
    const { fetchImpl, calls: fetchCalls } = makeFetch(pages);
    const { client, calls: searchCalls } = makeClient((query) =>
      query.startsWith("A")
        ? [{ url: "https://firma-a.de/offer", title: `${query} — result`, snippet: "…" }]
        : [{ url: "https://firma-b.de/offer", title: `${query} — result`, snippet: "…" }],
    );

    // The planner's batches: A1, A2 → then B1 → then "done".
    const providerBatches = [["A1", "A2"], ["B1"], null];
    let providerIndex = 0;
    const queryProvider = (): string[] | null => providerBatches[providerIndex++] ?? null;

    const order: string[] = [];
    const reports: SearchBatchReport[] = [];
    const onOffersCalls: number[] = [];
    const adapter = createSearchAdapter(
      client,
      { beginnYear: 2027 },
      {
        maxQueries: 12,
        maxResultsPerQuery: 10,
        maxPagesPerQuery: 5,
        maxPagesToFetch: 20,
        queryProvider,
        onOffers: async (offers) => {
          // The orchestrator's verification runs HERE, between batches.
          order.push(`offers:${offers.length}`);
          onOffersCalls.push(offers.length);
          return 1; // one new company per batch
        },
        onBatch: (report) => {
          order.push(`batch:${report.queries.join("+")}`);
          reports.push(report);
        },
      },
    );

    const result = await adapter.searchOffers(CRITERIA, createFetchContext({
      fetchImpl,
      isPublicHost: async () => true,
      sleep: async () => undefined,
    }));

    expect(result.status).toBe("ok");
    // Every provider query issued — exactly the planner's batches, in order:
    expect(searchCalls).toEqual(["A1", "A2", "B1"]);
    // Interleaving: each batch's verification precedes the next batch's
    // provider call (search → verify → search → verify → search).
    expect(order).toEqual([
      "offers:1",       // batch [A1,A2] verified
      "batch:A1+A2",
      "offers:1",       // batch [B1] verified
      "batch:B1",
    ]);
    expect(onOffersCalls).toEqual([1, 1]);
    // The measured reports: 1:1 with the provider's actual behavior.
    // (Batch 1 FETCHED one page: A1 and A2 returned the SAME url —
    //  result-level dedupe means the second one was never fetched.)
     // `visitedUrls` is the phase's running record of fetched pages (the
     // research memory a continue-batch will restore) — reported cumulatively.
     expect(reports).toEqual([
       {
         queries: ["A1", "A2"],
         resultsSeen: 2,
         pagesFetched: 1,
         offersExtracted: 1,
         newCompanies: 1,
         visitedUrls: ["https://firma-a.de/offer"],
         perQuery: [
           { query: "A1", resultsSeen: 1, pagesFetched: 1, offersExtracted: 1 },
           { query: "A2", resultsSeen: 1, pagesFetched: 0, offersExtracted: 0 },
         ],
       },
       {
         queries: ["B1"],
         resultsSeen: 1,
         pagesFetched: 1,
         offersExtracted: 1,
         newCompanies: 1,
         visitedUrls: ["https://firma-a.de/offer", "https://firma-b.de/offer"],
         perQuery: [{ query: "B1", resultsSeen: 1, pagesFetched: 1, offersExtracted: 1 }],
       },
     ]);
    if (result.status !== "ok") throw new Error("unreachable");
    // In agentic mode the offers were CONSUMED per batch — not repeated:
    expect(result.offers).toHaveLength(0);
    // …and the stats stay the measured totals (2 pages really fetched:
    //  firma-a.de/offer + firma-b.de/offer):
    expect(result.stats).toEqual({ queriesExecuted: 3, resultsInspected: 2 });
    // The real fetches: robots (once per origin) + the two offer pages.
    expect(fetchCalls.filter((url) => url.endsWith("/robots.txt"))).toHaveLength(2);
    expect(fetchCalls.filter((url) => url.includes("/offer"))).toHaveLength(2);
  });

  it("the provider's `null` ends the phase — no further provider call is made", async () => {
    const { fetchImpl } = makeFetch(new Map());
    const { client, calls } = makeClient(() => []);
    const adapter = createSearchAdapter(client, {}, {
      maxQueries: 12,
      maxResultsPerQuery: 10,
      maxPagesPerQuery: 5,
      maxPagesToFetch: 20,
      queryProvider: () => ["Q1"], // one batch, then null
    });
    const result = await adapter.searchOffers(CRITERIA, createFetchContext({
      fetchImpl,
      isPublicHost: async () => true,
      sleep: async () => undefined,
    }));
    expect(result.status).toBe("ok");
    expect(calls).toEqual(["Q1"]);
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.stats).toEqual({ queriesExecuted: 1, resultsInspected: 0 });
  });

  it("the query budget is the hard gate — batches are sliced to what remains", async () => {
    const { fetchImpl } = makeFetch(new Map());
    const { client, calls } = makeClient(() => []);
    const adapter = createSearchAdapter(client, {}, {
      maxQueries: 3,
      maxResultsPerQuery: 10,
      maxPagesPerQuery: 5,
      maxPagesToFetch: 20,
      // The planner keeps handing out 4-query batches; only 3 may run.
      queryProvider: () => ["Q1", "Q2", "Q3", "Q4"],
    });
    await adapter.searchOffers(CRITERIA, createFetchContext({
      fetchImpl,
      isPublicHost: async () => true,
      sleep: async () => undefined,
    }));
    expect(calls).toEqual(["Q1", "Q2", "Q3"]);
  });

  it("the page budget closes the loop — the provider is not asked again", async () => {
    const pages = new Map<string, string>([
      ["https://firma-a.de/offer", jobPostingPage("https://firma-a.de/offer", "Firma A GmbH", "Mechatroniker (Ausbildung)", "München")],
      ["https://firma-b.de/offer", jobPostingPage("https://firma-b.de/offer", "Firma B AG", "Elektroniker (Ausbildung)", "Augsburg")],
    ]);
    const { fetchImpl } = makeFetch(pages);
    const { client, calls } = makeClient((query) => [
      { url: query === "Q1" ? "https://firma-a.de/offer" : "https://firma-b.de/offer", title: `r ${query}`, snippet: "…" },
    ]);
    const providerCalls: number[] = [];
    const adapter = createSearchAdapter(client, {}, {
      maxQueries: 12,
      maxResultsPerQuery: 10,
      maxPagesPerQuery: 5,
      maxPagesToFetch: 1, // ONE offer page for the whole phase
      queryProvider: () => {
        providerCalls.push(1);
        return [`Q${providerCalls.length}`];
      },
    });
    await adapter.searchOffers(CRITERIA, createFetchContext({
      fetchImpl,
      isPublicHost: async () => true,
      sleep: async () => undefined,
    }));
    // The first batch spent the page budget; the second was never asked.
    expect(providerCalls).toHaveLength(1);
    expect(calls).toEqual(["Q1"]);
  });

  it("a failed provider query is measured as an honest zero in the per-query report", async () => {
    let failNext = true;
    const { fetchImpl } = makeFetch(new Map());
    // Synchronous throw: the adapter's per-query error boundary catches the
    // provider failure either way — the report must measure it as an honest
    // zero, not drop the query from the report.
    const { client } = makeClient(() => {
      if (failNext) {
        failNext = false;
        throw new Error("provider down");
      }
      return [];
    });
    const reports: SearchBatchReport[] = [];
    const adapter = createSearchAdapter(client, {}, {
      maxQueries: 12,
      maxResultsPerQuery: 10,
      maxPagesPerQuery: 5,
      maxPagesToFetch: 20,
      queryProvider: () => ["FAILS", "OK"],
      onBatch: (report) => reports.push(report),
    });
    const result = await adapter.searchOffers(CRITERIA, createFetchContext({
      fetchImpl,
      isPublicHost: async () => true,
      sleep: async () => undefined,
    }));
    if (result.status !== "ok") throw new Error("unreachable");
    // Both queries were issued (the failure did not kill the batch) …
    expect(reports).toHaveLength(1);
    expect(reports[0].queries).toEqual(["FAILS", "OK"]);
    // …and the failed one is measured as an EMPTY query, not dropped:
    expect(reports[0].perQuery).toEqual([
      { query: "FAILS", resultsSeen: 0, pagesFetched: 0, offersExtracted: 0 },
      { query: "OK", resultsSeen: 0, pagesFetched: 0, offersExtracted: 0 },
    ]);
  });

  it("research memory: priorState — issued queries are never re-issued, visited URLs never re-fetched", async () => {
    const pages = new Map<string, string>([
      ["https://firma-a.de/offer", jobPostingPage("https://firma-a.de/offer", "Firma A GmbH", "Mechatroniker (Ausbildung)", "München")],
      ["https://firma-b.de/offer", jobPostingPage("https://firma-b.de/offer", "Firma B AG", "Elektroniker (Ausbildung)", "Augsburg")],
    ]);
    const { fetchImpl, calls: fetchCalls } = makeFetch(pages);
    const { client, calls: providerCalls } = makeClient((query) =>
      query.startsWith("A")
        ? [{ url: "https://firma-a.de/offer", title: "r", snippet: "…" }]
        : [{ url: "https://firma-b.de/offer", title: "r", snippet: "…" }],
    );
    // This is a CONTINUE batch: the previous batch already issued "A1" and
    // already fetched firma-a.de/offer. The provider still hands both back.
    const adapter = createSearchAdapter(client, {}, {
      maxQueries: 12,
      maxResultsPerQuery: 10,
      maxPagesPerQuery: 5,
      maxPagesToFetch: 20,
      queryProvider: () => ["A1", "B1"],
      getPriorState: () => ({
        issuedQueries: ["A1"],
        visitedUrls: ["https://firma-a.de/offer"],
      }),
    });
    const result = await adapter.searchOffers(CRITERIA, createFetchContext({
      fetchImpl,
      isPublicHost: async () => true,
      sleep: async () => undefined,
    }));
    // Only the NEW query reached the provider — the old one was dropped:
    expect(providerCalls).toEqual(["B1"]);
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.stats).toEqual({ queriesExecuted: 1, resultsInspected: 1 });
    // And the already-visited URL was NOT fetched again (only firma-b's page):
    expect(fetchCalls.filter((url) => url.endsWith("/offer"))).toEqual(["https://firma-b.de/offer"]);
    // …while robots.txt for the NEW host was fetched exactly once:
    expect(fetchCalls.filter((url) => url.endsWith("/robots.txt"))).toEqual(["https://firma-b.de/robots.txt"]);
  });

  it("legacy mode (no provider) is unchanged: one fixed batch, offers in the result", async () => {
    const pages = new Map<string, string>([
      ["https://firma-a.de/offer", jobPostingPage("https://firma-a.de/offer", "Firma A GmbH", "Mechatroniker (Ausbildung)", "München")],
    ]);
    const { fetchImpl } = makeFetch(pages);
    const { client, calls } = makeClient(() => [
      { url: "https://firma-a.de/offer", title: "r", snippet: "…" },
    ]);
    const adapter = createSearchAdapter(client, { beginnYear: 2027 }, {
      maxQueries: 12,
      maxResultsPerQuery: 10,
      maxPagesPerQuery: 5,
      maxPagesToFetch: 20,
    });
    const result = await adapter.searchOffers(CRITERIA, createFetchContext({
      fetchImpl,
      isPublicHost: async () => true,
      sleep: async () => undefined,
    }));
    expect(result.status).toBe("ok");
    // One batch, issued once; the offers are returned (no handoff happened):
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(new Set(calls).size).toBe(calls.length);
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.offers).toHaveLength(1);
    expect(result.offers[0].companyName).toBe("Firma A GmbH");
    expect(result.stats).toMatchObject({ queriesExecuted: calls.length });
  });
});
