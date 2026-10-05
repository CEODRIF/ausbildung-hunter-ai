import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * BEGINN VERIFICATION — a missing start date in ONE source is no proof about
 * the company (SOURCE → DISCOVER → EXTRACT → VERIFY, not → missing field →
 * REJECT).
 *
 * The three-honest-state contract under test (run: year 2027):
 *   documented start 2027            → confirmed      → accepted path
 *   documented start 2028            → mismatch       → rejected at discovery
 *   documented start on the COMPANY'S SITE ("Ausbildung 2027" in context)
 *                                    → confirmed      → accepted path
 *   documented start 2028 on the site→ mismatch       → rejected beginn_mismatch
 *   nothing documented anywhere      → unconfirmed    → rejected beginn_not_confirmed
 *   `null` never becomes `true` (no guessing).
 *
 * Plus: the Tavily adapter is honest in both states — configured (real
 * queries executed) and missing (skipped, reason `search_provider_not_configured`).
 *
 * Everything is offline and deterministic: fetch + provider stubbed.
 */

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  finishOutcome: null as unknown,
  companies: [] as Row[],
  emails: [] as Row[],
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from(table: string) {
      const rows = () => (state.db[table] ??= []);
      const api: Record<string, unknown> = {};
      const chain = () => api;
      for (const key of ["select", "eq", "in", "order", "limit", "not", "update", "insert", "upsert"]) {
        api[key] = chain;
      }
      api.maybeSingle = async () => ({ data: rows()[0] ?? null, error: null });
      api.single = async () => ({ data: rows()[0] ?? null, error: null });
      api.then = (resolveThen: (value: unknown) => unknown) =>
        resolveThen({ data: rows(), error: null });
      (api.insert as unknown) = (values: Row | Row[]) => {
        const list = Array.isArray(values) ? values : [values];
        if (table === "discovery_companies") state.companies.push(...list);
        if (table === "discovery_company_emails") state.emails.push(...list);
        rows().push(...list);
        return {
          select: () => ({
            single: async () => ({ data: { id: `company-${state.companies.length}` }, error: null }),
            maybeSingle: async () => ({ data: list[0] ?? null, error: null }),
          }),
          then: (r: (v: unknown) => unknown) => r({ data: list, error: null }),
        };
      };
      (api.upsert as unknown) = (values: Row | Row[]) => {
        const list = Array.isArray(values) ? values : [values];
        if (table === "discovery_company_emails") state.emails.push(...list);
        rows().push(...list);
        return {
          select: () => ({ maybeSingle: async () => ({ data: { id: `email-${state.emails.length}` }, error: null }) }),
          then: (r: (v: unknown) => unknown) => r({ data: list, error: null }),
        };
      };
      (api.update as unknown) = () => ({
        eq: () => ({
          eq: () => ({
            eq: () => ({
              in: () => ({
                select: () => ({ maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }) }),
              }),
            }),
          }),
        }),
      });
      return api;
    },
  }),
}));

vi.mock("@/lib/company-discovery/runs", async () => {
  const actual = await vi.importActual<typeof import("@/lib/company-discovery/runs")>(
    "@/lib/company-discovery/runs",
  );
  return {
    ...actual,
    getDiscoveryRun: vi.fn(),
    startDiscoveryRun: vi.fn(),
    finishDiscoveryRun: vi.fn(async (_id: string, _uid: string, outcome: unknown) => {
      state.finishOutcome = outcome;
      return { runId: "r", status: "partial" };
    }),
    setRunCounters: vi.fn(async () => undefined),
    recordCandidates: vi.fn(async () => undefined),
    recordCompany: vi.fn(async () => ({ companyId: "c", created: true })),
    recordCompanyEmail: vi.fn(async () => "e"),
  };
});

import {
  createSearchAdapter,
} from "@/lib/company-discovery/adapters";
import { beginnYearConfirmedOf } from "@/lib/company-discovery/search";
import { siteYearEvidence } from "@/lib/company-discovery/emails";
import { createFetchContext } from "@/lib/company-discovery/fetch-guard";
import { runDiscoveryPipeline } from "@/lib/company-discovery/search";
import { mapToSearchParams } from "@/lib/company-discovery/normalize";
import type { NormalizedOffer, OfferSourceAdapter } from "@/lib/company-discovery/adapter";
import type { DiscoveryRun, DiscoveryRunParams } from "@/lib/company-discovery/types";
import type { WebSearchClient } from "@/lib/web-search";
import type { OpportunityWindow } from "@/lib/opportunities/types";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";

// The run under test: Apprenticeship, START YEAR 2027, public email required.
const RUN_PARAMS: DiscoveryRunParams = {
  field: "Marketing / E-Commerce",
  role: "Kaufmann im E-Commerce",
  beginn: { mode: "year", year: 2027 },
  goal: "ausbildung",
  targetCompanies: 10,
  onlyPublicEmail: true,
};

beforeEach(() => {
  state.db = {};
  state.finishOutcome = null;
  state.companies = [];
  state.emails = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function baseRun(): DiscoveryRun {
  return {
    runId: RUN_ID,
    status: "pending",
    params: RUN_PARAMS,
    progress: {
      status: "pending",
      targetCompanies: RUN_PARAMS.targetCompanies,
      foundCompanies: 0,
      offersAnalyzed: 0,
      uniqueCompanies: 0,
      duplicatesRemoved: 0,
      companiesRejected: 0,
      emailsFound: 0,
      noPublicEmail: 0,
      sourcesBlocked: 0,
      companiesProcessed: 0,
      currentQuery: null,
      currentSource: null,
      currentStrategy: null,
      sources: [],
    },
    creditsCharged: 0,
    error: null,
    createdAt: "2026-10-03T10:00:00.000Z",
    startedAt: null,
    finishedAt: null,
  };
}

function emptyWindow(): () => Promise<OpportunityWindow> {
  return async () =>
    ({
      mode: "scan",
      window: [],
      total: 0,
      scan_truncated: false,
      exhausted: true,
      degraded: false,
      filter_counts: { any: 0, today: 0, yesterday: 0, week: 0, twoWeeks: 0, fourWeeks: 0 },
    } as unknown as OpportunityWindow);
}

function offer(
  beginn: string | null,
  index: number,
): NormalizedOffer {
  return {
    companyName: "Musterwerk GmbH",
    companyWebsite: null,
    role: "Ausbildung Kaufmann im E-Commerce",
    field: RUN_PARAMS.field,
    city: "Köln",
    state: "Nordrhein-Westfalen",
    offerType: null,
    beginn,
    salary: null,
    offerSource: "Bundesagentur für Arbeit",
    offerUrl: `https://www.arbeitsagentur.de/jobsuche/angebot/${index}`,
    publishedEmail: null,
    listingText: "Ausbildung bei Musterwerk GmbH",
    candidateRef: `arbeitsagentur:${index}-S`,
  };
}

function fakeAdapter(offers: NormalizedOffer[]): OfferSourceAdapter {
  return {
    id: "search-api",
    displayName: "Search API (Tavily)",
    category: "search",
    policy: "enabled_official_api",
    async searchOffers() {
      return { status: "ok", offers };
    },
  };
}

function tavilyStub(): { client: WebSearchClient; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    client: {
      name: "tavily" as const,
      search: async (query: string) => {
        calls.push(query);
        return [
          { title: "Impressum — Musterwerk GmbH", url: "https://musterwerk.de/impressum", snippet: "Impressum" },
        ];
      },
    } as WebSearchClient,
  };
}

/**
 * The company's site, offline. The /ausbildung page carries the scenario's
 * start-year statement (or none); the impressum publishes the address when
 * `withEmail`. No page anywhere states a year except the /ausbildung one.
 */
function musterwerkFetch(withEmail: boolean, ausbildungText: string) {
  const calls: string[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(url);
    if (url.includes("/robots.txt")) {
      return new Response("User-agent: *\nDisallow:\n", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }
    let host = "";
    try {
      host = new URL(url).hostname;
    } catch {
      host = "";
    }
    if (host.endsWith("musterwerk.de")) {
      const fill = `${"x".repeat(80)} `;
      if (url.includes("/impressum")) {
        const body = withEmail
          ? `<html><body>Impressum — Musterwerk GmbH, Am Ring 5, 50667 Köln. E-Mail: bewerbung@musterwerk.de. ${fill}</body></html>`
          : `<html><body>Impressum — Musterwerk GmbH, Am Ring 5, 50667 Köln. ${fill}</body></html>`;
        return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
      }
      if (url.includes("/ausbildung")) {
        return new Response(
          `<html><body>Ausbildung bei Musterwerk GmbH — ${ausbildungText} ${fill}</body></html>`,
          { status: 200, headers: { "content-type": "text/html" } },
        );
      }
      if (url.includes("/karriere")) {
        return new Response(`<html><body>Musterwerk GmbH — Karriere. ${fill}</body></html>`, { status: 200, headers: { "content-type": "text/html" } });
      }
      if (url.includes("/kontakt")) {
        return new Response(`<html><body>Musterwerk GmbH — Kontakt-Formular. ${fill}</body></html>`, { status: 200, headers: { "content-type": "text/html" } });
      }
      if (url.includes("/jobs") || url.includes("/team")) {
        return new Response(`<html><body>Musterwerk GmbH. ${fill}</body></html>`, { status: 200, headers: { "content-type": "text/html" } });
      }
    }
    return new Response(`<html><body>Not found. ${"x".repeat(80)}</body></html>`, {
      status: 404,
      headers: { "content-type": "text/html" },
    });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

async function runPipeline(opts: {
  beginn: string | null;
  withEmail: boolean;
  ausbildungText: string;
}) {
  const site = musterwerkFetch(opts.withEmail, opts.ausbildungText);
  const tavily = tavilyStub();
  vi.stubGlobal("fetch", site.impl);
  vi.stubEnv("DISCOVERY_MAX_EMAIL_SITE_PASSES", "20");

  const store = await import("@/lib/company-discovery/runs");
  const run = baseRun();
  vi.mocked(store.getDiscoveryRun).mockResolvedValue(run);
  vi.mocked(store.startDiscoveryRun).mockResolvedValue(run);

  await runDiscoveryPipeline(RUN_ID, USER_ID, {
    window: emptyWindow(),
    adapters: [fakeAdapter([offer(opts.beginn, 1)])],
    searchClient: tavily.client,
    offerSearchClient: tavily.client,
    fetchContext: createFetchContext({
      fetchImpl: site.impl,
      isPublicHost: async () => true,
      sleep: async () => undefined,
    }),
    isCancelled: async () => false,
  });

  return {
    fetchCalls: site.calls,
    searchCalls: tavily.calls,
    outcome: state.finishOutcome as {
      status: string;
      foundCompanies: number;
      offersAnalyzed: number;
      duplicatesRemoved: number;
      companiesRejected: number;
      emailsFound: number;
      noPublicEmail: number;
      sourcesBlocked: number;
      companiesProcessed: number;
    },
  };
}

// ---------------------------------------------------------------------------
// The beginn matrix (pipeline, year 2027, onlyPublicEmail)
// ---------------------------------------------------------------------------

describe("beginn matrix — one missing field in one source is no proof", () => {
  it("1. valid_from = 2027 (documented match) → accepted path", async () => {
    const { outcome, searchCalls } = await runPipeline({
      beginn: "2027-08-01",
      withEmail: true,
      ausbildungText: "Informationen im Karrierebereich.",
    });
    expect(outcome.foundCompanies).toBe(1);
    expect(outcome.companiesProcessed).toBe(1);
    expect(outcome.emailsFound).toBe(1);
    // The company search ran (official-site flow intact).
    expect(searchCalls).toHaveLength(1);
    const store = await import("@/lib/company-discovery/runs");
    const call = vi.mocked(store.recordCompany).mock.calls[0][1] as unknown as Row;
    expect(call).toMatchObject({ status: "accepted", beginnYearConfirmed: true });
  });

  it("2. valid_from = 2028 (documented mismatch) → rejected AT DISCOVERY — no wasted company work", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { outcome, searchCalls } = await runPipeline({
      beginn: "2028-08-01",
      withEmail: true,
      ausbildungText: "Ausbildung 2028.",
    });
    expect(outcome.companiesRejected).toBe(1);
    expect(outcome.companiesProcessed).toBe(0); // never resolved
    expect(outcome.foundCompanies).toBe(0);
    expect(searchCalls).toHaveLength(0); // no email pass, no provider request
    expect(
      info.mock.calls.some((call) => String(call[0]).includes('outcome="beginn_mismatch"')),
    ).toBe(true);
  });

  it("3. valid_from = null → NOT rejected at discovery; the company is resolved (site opened)", async () => {
    const { outcome, fetchCalls } = await runPipeline({
      beginn: null,
      withEmail: false,
      ausbildungText: "Informationen im Karrierebereich.",
    });
    // The old behavior killed it here (companiesRejected). Now it is
    // INVESTIGATED: resolved, site opened, email pass run.
    expect(outcome.companiesProcessed).toBe(1);
    expect(fetchCalls.some((u) => u.includes("musterwerk.de/impressum"))).toBe(true);
    expect(fetchCalls.some((u) => u.includes("musterwerk.de/ausbildung"))).toBe(true);
    // No email published → rejected no_public_email (the email failure is
    // reported first; beginn stays unconfirmed in the stored record).
    expect(outcome.noPublicEmail).toBe(1);
    expect(outcome.foundCompanies).toBe(0);
  });

  it("4. valid_from = null + the company's site says 'Ausbildungsstart 01.08.2027' → accepted, confirmed", async () => {
    const { outcome } = await runPipeline({
      beginn: null,
      withEmail: true,
      ausbildungText: "Ausbildungsstart: 01.08.2027",
    });
    expect(outcome.foundCompanies).toBe(1);
    expect(outcome.emailsFound).toBe(1);
    const store = await import("@/lib/company-discovery/runs");
    const call = vi.mocked(store.recordCompany).mock.calls[0][1] as unknown as Row;
    expect(call).toMatchObject({ status: "accepted", beginnYearConfirmed: true });
  });

  it("5. valid_from = null + the company's site says 'Ausbildung 2028' → rejected beginn_mismatch", async () => {
    const { outcome } = await runPipeline({
      beginn: null,
      withEmail: true,
      ausbildungText: "Ausbildung 2028 — jetzt bewerben.",
    });
    expect(outcome.foundCompanies).toBe(0);
    expect(outcome.companiesProcessed).toBe(1);
    const store = await import("@/lib/company-discovery/runs");
    const call = vi.mocked(store.recordCompany).mock.calls[0][1] as unknown as Row;
    // The EMAIL was real; the REJECT is the beginn filter:
    expect(call).toMatchObject({
      status: "rejected",
      rejectReason: "beginn_mismatch",
      emailStatus: "email_found",
      beginnYearConfirmed: false,
    });
  });

  it("6. valid_from = null + the site states no year → rejected beginn_not_confirmed (never guessed)", async () => {
    const { outcome } = await runPipeline({
      beginn: null,
      withEmail: true,
      ausbildungText: "Informationen im Karrierebereich.",
    });
    expect(outcome.foundCompanies).toBe(0);
    expect(outcome.companiesProcessed).toBe(1);
    const store = await import("@/lib/company-discovery/runs");
    const call = vi.mocked(store.recordCompany).mock.calls[0][1] as unknown as Row;
    expect(call).toMatchObject({
      status: "rejected",
      rejectReason: "beginn_not_confirmed",
      emailStatus: "email_found",
      beginnYearConfirmed: null,
    });
  });
});

// ---------------------------------------------------------------------------
// siteYearEvidence — a year counts only in apprenticeship/beginning context
// ---------------------------------------------------------------------------

describe("siteYearEvidence — documented context, no bare numbers, conflict-aware", () => {
  const page = (url: string, text: string) => [{ url, text }];

  it.each([
    ["Ausbildung 2027", 2027],
    ["Ausbildungsplatz für 2027", 2027],
    ["Ausbildungsstart: 01.08.2027", 2027],
    ["Beginn August 2027", 2027],
    ["Start 2027", 2027],
    ["Ausbildung ab 2027", 2027],
    ["Ausbildungsstellen 2027", 2027],
    ["Azubis gesucht — Ausbildungsbeginn 2027", 2027],
  ])("extracts %j as year %i", (text, year) => {
    expect(siteYearEvidence(page("https://x.de/ausbildung", text))).toMatchObject({
      year,
      conflict: false,
    });
  });

  it("a bare number (copyright, address) is NOT evidence", () => {
    expect(siteYearEvidence(page("https://x.de/impressum", "© 2027 Musterwerk GmbH, Musterstr. 12"))).toMatchObject({
      year: null,
      url: null,
    });
  });

  it("conflicting years on the company's own pages → conflict (unusable, not a choice)", () => {
    const ev = siteYearEvidence([
      { url: "https://x.de/ausbildung", text: "Ausbildung 2027" },
      { url: "https://x.de/karriere", text: "Ausbildungsbeginn 2028" },
    ]);
    expect(ev.conflict).toBe(true);
  });

  it("no year anywhere → null evidence", () => {
    expect(siteYearEvidence(page("https://x.de/karriere", "Karriere bei uns. Bewirben Sie sich."))).toMatchObject({
      year: null,
      conflict: false,
    });
  });
});

// ---------------------------------------------------------------------------
// beginnYearConfirmedOf — evidence order: offer first, company site second
// ---------------------------------------------------------------------------

describe("beginnYearConfirmedOf — offer evidence outranks site evidence", () => {
  const year2027 = { beginn: { mode: "year", year: 2027 } } as const;

  it("documented offer start decides (even against the site)", () => {
    expect(beginnYearConfirmedOf({ beginn: "2027-08-01" }, year2027, { year: 2028, conflict: false })).toBe(true);
    expect(beginnYearConfirmedOf({ beginn: "2028-08-01" }, year2027, { year: 2027, conflict: false })).toBe(false);
  });

  it("undocumented offer → the company's own site confirms (year mode)", () => {
    expect(beginnYearConfirmedOf({ beginn: null }, year2027, { year: 2027, conflict: false })).toBe(true);
    expect(beginnYearConfirmedOf({ beginn: null }, year2027, { year: 2028, conflict: false })).toBe(false);
  });

  it("conflicting or absent site evidence → null (unconfirmed, never a guess)", () => {
    expect(beginnYearConfirmedOf({ beginn: null }, year2027, { year: 2027, conflict: true })).toBeNull();
    expect(beginnYearConfirmedOf({ beginn: null }, year2027, { year: null, conflict: false })).toBeNull();
    expect(beginnYearConfirmedOf({ beginn: null }, year2027, null)).toBeNull();
  });

  it("a site year cannot confirm a concrete DATE or MONTH window (precision honesty)", () => {
    expect(
      beginnYearConfirmedOf({ beginn: null }, { beginn: { mode: "date", date: "2027-08-01" } }, { year: 2027, conflict: false }),
    ).toBeNull();
    expect(
      beginnYearConfirmedOf({ beginn: null }, { beginn: { mode: "month", month: "2027-08" } }, { year: 2027, conflict: false }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tavily — the search layer is honest in both states
// ---------------------------------------------------------------------------

describe("Tavily adapter — configured runs, missing skips (never fake)", () => {
  const sp = mapToSearchParams(RUN_PARAMS, "ausbildung");

  it("configured → a REAL provider query is executed and reported", async () => {
    const calls: string[] = [];
    const client = {
      name: "tavily" as const,
      search: async (query: string) => {
        calls.push(query);
        return [];
      },
    } as WebSearchClient;
    const adapter = createSearchAdapter(
      client,
      { beginnYear: 2027 },
      { maxQueries: 4, maxResultsPerQuery: 3, maxPagesPerQuery: 3, maxPagesToFetch: 3 },
    );
    const impl = vi.fn(async () =>
      new Response("<html><body>keine ergebnisse</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
    vi.stubGlobal("fetch", impl);
    const result = await adapter.searchOffers(
      sp,
      createFetchContext({
        fetchImpl: impl as unknown as typeof fetch,
        isPublicHost: async () => true,
        sleep: async () => undefined,
      }),
    );
    expect(calls.length).toBeGreaterThan(0); // a real query left the building
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.stats?.queriesExecuted).toBeGreaterThanOrEqual(1);
  });

  it("missing → honest `search_provider_not_configured`, zero queries, no fake progress", async () => {
    const adapter = createSearchAdapter(
      null,
      { beginnYear: 2027 },
      { maxQueries: 4, maxResultsPerQuery: 3, maxPagesPerQuery: 3, maxPagesToFetch: 3 },
    );
    const impl = vi.fn(async () => {
      throw new Error("the network must NOT be touched");
    });
    const result = await adapter.searchOffers(
      sp,
      createFetchContext({
        fetchImpl: impl as unknown as typeof fetch,
        isPublicHost: async () => true,
        sleep: async () => undefined,
      }),
    );
    expect(result).toMatchObject({
      status: "skipped",
      reason: "search_provider_not_configured",
    });
    expect(impl).not.toHaveBeenCalled(); // no query, no page — nothing faked
  });
});
