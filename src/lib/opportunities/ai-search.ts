import "server-only";

import { z } from "zod";
import type { CandidateProfile } from "@/lib/bewerbung-schema";
import { createAIProvider } from "@/lib/ai-provider";
import { applyMatch } from "@/lib/opportunities/matching";
import { BaFetchFailure } from "@/lib/opportunities/providers/arbeitsagentur";
import {
  mergeOpportunities,
  runWebDiscovery,
  type ProviderErrorDetail,
  type SourceCategory,
} from "@/lib/opportunities/web-discovery";
import {
  computeResultStats,
  runCompanyEnrichment,
  type AiSearchStats,
  type EnrichmentTelemetry,
} from "@/lib/opportunities/enrichment";
import { sourceLabel } from "@/lib/opportunities/sources";
import {
  BA_SOURCE_ID,
  getCandidateProfile,
  resolveOpportunityCached,
  searchOpportunities,
} from "@/lib/opportunities/search";
import {
  getWebSearchClient,
  type WebSearchProviderName,
} from "@/lib/web-search";
import {
  normalizeSearchParams,
  type Opportunity,
  type SourceStatus,
} from "@/lib/opportunities/types";

/**
 * AI Ausbildung Search — pipeline.
 *
 * Flow: validated candidate profile (from the Bewerbung Scanner) → ONE AI
 * planning call that turns profile facts into (a) BA Jobsuche queries and
 * (b) broad web-search queries → parallel collection:
 *   - official: the public Bundesagentur für Arbeit Jobsuche (shared
 *     provider + cache) with per-result detail enrichment;
 *   - web: surface-level discovery across publicly indexed pages via Google
 *     Gemini with Google Search Grounding in four categories (web, job
 *     portals, company career pages, public social media), guarded page
 *     verification (robots.txt respected, anti-bot skipped) and bounded
 *     batched AI extraction — see web-discovery.ts.
 * → multi-source dedupe (identity fingerprint + AI duplicate links;
 *   most authoritative source wins, provenance kept) → documented match
 * ranking → top N.
 *
 * Invariants (same discipline as the rest of the app):
 * - The AI plans queries and extracts from provided page text. It never
 *   contributes opportunity content: every row comes from a real source
 *   (BA search window + details, or a discovered public page).
 * - Queries may only restate facts documented in the candidate profile
 *   (roles, keywords, locations). No invented roles, companies, or dates.
 * - Extraction URLs are cross-checked against the discovered candidate
 *   set; anything else is dropped. Missing data stays empty — never
 *   guessed. Blocked sources are skipped, never bypassed.
 * - AI quota: one reservation for the planning call (the route) plus one
 *   per extraction batch (≤ 2), via the same atomic RPC as chat/scanner.
 * - Without a configured search provider the web layer degrades
 *   gracefully; the official BA source keeps working.
 */

export const AI_SEARCH_COUNTS = [10, 25, 50, 100] as const;
export const aiSearchCountSchema = z.union([
  z.literal(10),
  z.literal(25),
  z.literal(50),
  z.literal(100),
]);
export type AiSearchCount = (typeof AI_SEARCH_COUNTS)[number];
export const aiSearchGoalSchema = z.enum(["ausbildung", "arbeit"]);

/** Strict: any AI-invented extra field fails the whole plan (safe
 *  direction — a rejected plan costs a retry, a smuggled field does not). */
export const aiSearchQuerySchema = z
  .object({
    /** Free-text keyword from the profile (e.g. a keyword or industry term). */
    keyword: z.string().trim().max(120).default(""),
    /** Occupation/role phrase from the profile (matches hauptberuf fields). */
    role: z.string().trim().max(120).default(""),
    /** City, PLZ or Bundesland from the profile — "" = nationwide. */
    location: z.string().trim().max(120).default(""),
  })
  .strict();
export type AiSearchQuery = z.infer<typeof aiSearchQuerySchema>;

/** Strict shape of the AI-generated plan. Anything else is rejected. */
export const aiSearchPlanSchema = z
  .object({
    /** One short sentence explaining the query strategy (profile facts). */
    rationale: z.string().trim().max(400).default(""),
    queries: z.array(aiSearchQuerySchema).min(1).max(5),
    /** Broad web-search queries (quoted-phrase style, Google/Bing-ready)
     *  for surface-level discovery across public sources. Optional — an
     *  empty plan still runs the official BA source. */
    web_queries: z.array(z.string().trim().min(3).max(300)).max(6).default([]),
  })
  .strict();
export type AiSearchPlan = z.infer<typeof aiSearchPlanSchema>;

/** Client-facing profile summary (own data only; no contact details). */
export interface AiSearchProfileSummary {
  goal: "ausbildung" | "arbeit";
  target_roles: string[];
  locations: string[];
  skills: string[];
  keywords: string[];
}

export function summarizeProfile(
  profile: CandidateProfile,
): AiSearchProfileSummary {
  const unique = (values: Array<string | null | undefined>) =>
    [...new Set(values.filter((value): value is string => !!value))];
  return {
    goal: profile.goal,
    target_roles: unique(profile.target_roles.map((role) => role.role)).slice(
      0,
      6,
    ),
    locations: unique([
      profile.candidate.current_location,
      ...profile.candidate.target_location,
      ...profile.preferences.preferred_locations,
    ]).slice(0, 6),
    skills: unique([
      ...profile.skills.technical,
      ...profile.skills.software_tools,
      ...profile.skills.it,
      ...profile.skills.marketing,
      ...profile.skills.soft,
    ]).slice(0, 10),
    keywords: unique(profile.keywords).slice(0, 10),
  };
}

// ---------------------------------------------------------------------------
// 1) AI planning (the ONLY AI step; one quota-reserved call per run)
// ---------------------------------------------------------------------------

/** The Ausbildung intake year a fresh search should target: German
 *  Ausbildung starts Aug/Sep, so from January–July the CURRENT year's
 *  intake is the next one; from August on, next year's. */
export function targetStartYear(now: Date = new Date()): number {
  return now.getMonth() + 1 >= 8 ? now.getFullYear() + 1 : now.getFullYear();
}

function planPrompt(
  profile: CandidateProfile,
  goal: "ausbildung" | "arbeit",
  targetCount: AiSearchCount,
  startYear: number,
): string {
  const facts = {
    goal,
    start_year: startYear,
    current_location: profile.candidate.current_location,
    target_locations: profile.candidate.target_location,
    target_roles: profile.target_roles.map((role) => role.role),
    preferred_job_titles: profile.preferences.preferred_job_titles,
    preferred_locations: profile.preferences.preferred_locations,
    preferred_industries: profile.preferences.preferred_industries,
    keywords: profile.keywords,
    skills: {
      technical: profile.skills.technical,
      software_tools: profile.skills.software_tools,
      it: profile.skills.it,
      marketing: profile.skills.marketing,
      soft: profile.skills.soft,
    },
  };
  return `You are the AI Ausbildung Search planner.
 You plan TWO kinds of searches for goal "${goal}", intake year ${startYear}, targeting ${targetCount} real postings.

 (A) BA queries for the public Bundesagentur für Arbeit Jobsuche:
 - Use ONLY facts present in the candidate profile below. Never invent roles, keywords, locations, companies, or requirements.
 - "role": short German occupation phrases from target_roles / preferred_job_titles (e.g. "Mechatroniker/in").
 - "keyword": short additional keyword phrases from keywords / preferred_industries / skills (e.g. "Logistik").
 - "location": a German city, PLZ, or Bundesland from current_location / target_locations / preferred_locations. Use "" (nationwide) when the profile documents no matching location.
 - Create 2 to 4 complementary BA queries (different role phrasings or locations). Use exactly one only when the profile documents a single, unambiguous target.
 - Keep every string under 60 characters where possible; the API matches literally.

 (B) web_queries for broad web discovery (Google-style). Create 2 to 4 quoted-phrase queries that would find real public postings, e.g.:
   "Kaufmann im E-Commerce" Ausbildung ${startYear}
   "Ausbildung ${startYear}" "Köln" Marketing
   "Ausbildung" "m/w/d" "${startYear}"
  Rules for web_queries:
  - Each is ONE search string (max 120 chars) combining the target role (in double quotes) + "Ausbildung" + the year ${startYear}, plus one location (city/PLZ/Bundesland from the profile) when documented.
  - Vary them: one with a location, one with an industry/keyword, one with "m/w/d", one combining role + year + "Bewerbung".
  - Include SYNONYM / spelling variants of the target role so the multi-source registry finds the same posting phrased differently (e.g. "Kaufmann im E-Commerce" → also "Kaufmann/-frau E-Commerce", "Online Marketing", "E-Commerce Ausbildung"; "Kaufmann für Büromanagement" → also "Bürokaufmann/-frau"). Derived from the profile's roles/skills/keywords only — no invented professions.
  - Use ONLY profile facts; do not invent companies or roles.

 Return ONLY valid JSON, no markdown, exactly:
 {"rationale":"<one short sentence>","queries":[{"keyword":"...","role":"...","location":"..."}],"web_queries":["...","..."]}

 Candidate profile (facts):
 ${JSON.stringify(facts)}`;
}

/** Generate + validate the search plan. Throws a controlled message on any
 *  provider/JSON/schema failure (no raw error leakage). */
export async function planAISearch(args: {
  profile: CandidateProfile;
  goal: "ausbildung" | "arbeit";
  targetCount: AiSearchCount;
}): Promise<AiSearchPlan> {
  const startYear = targetStartYear();
  const response = await createAIProvider().generateText([
    {
      role: "user",
      content: planPrompt(args.profile, args.goal, args.targetCount, startYear),
    },
  ]);
  let jsonText = response
    .replace(/^```json\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const start = jsonText.indexOf("{");
  if (start < 0)
    throw new Error(
      "The AI search plan could not be generated. Please try again.",
    );
  jsonText = jsonText.slice(start);
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(jsonText);
  } catch {
    throw new Error(
      "The AI search plan could not be generated. Please try again.",
    );
  }
  const parsed = aiSearchPlanSchema.safeParse(parsedJson);
  if (!parsed.success)
    throw new Error(
      "The AI search plan was invalid. Please try again.",
    );
  return parsed.data;
}

// ---------------------------------------------------------------------------
// 2) Deterministic collection (public source; shared cache; real data only)
// ---------------------------------------------------------------------------

/** Max source pages per query (4 × 50 = up to 200 candidates). */
const MAX_PAGES_PER_QUERY = 4;
/** Enrich a small buffer beyond the target so dropped postings (details no
 *  longer available) cannot shrink the final list unnecessarily. */
const ENRICH_BUFFER = 10;

export interface AiSearchDiscovery {
  /** Whether a web-search provider is configured. */
  configured: boolean;
  provider: WebSearchProviderName | null;
  /** Discovered candidates per category (REAL counts, 0 when unconfigured). */
  categories: Record<SourceCategory, number>;
  /** Raw candidate hits per registry source id (AI Search 2.0). */
  sources: Record<string, number>;
  /** Per-source run status (ok/degraded/failed/skipped_budget) — the
   *  diagnostics the UI shows so a dead provider is never invisible. */
  sourceStatuses: Array<{
    source: string;
    status: "ok" | "degraded" | "failed" | "skipped_budget";
    candidates: number;
  }>;
  /** Grounding calls that actually succeeded (honest usage metric). */
  webSearchesOk: number;
  /** Provider-level errors (key rejected, 429, 5xx) — surfaced in the UI. */
  providerErrors: number;
  /** Safe detail of the first provider error (root-cause visibility in the
   *  UI — never a key/prompt). Null when there were no provider errors. */
  firstProviderError: ProviderErrorDetail | null;
  /** Unique candidates that were page-checked (guarded fetch). */
  checked: number;
  /** Web opportunities extracted before dedupe. */
  webFound: number;
  /** Rows removed by multi-source dedupe (BA + web). */
  duplicatesRemoved: number;
}

export type AiSearchProgress =
  | { type: "profile"; summary: AiSearchProfileSummary }
  | { type: "plan"; plan: AiSearchPlan }
  | {
      type: "web_status";
      configured: boolean;
      provider: WebSearchProviderName | null;
    }
  | { type: "discover"; category: SourceCategory; results: number }
  | { type: "check"; done: number; total: number }
  | { type: "extract"; done: number; total: number }
  | { type: "dedupe"; removed: number; total: number }
  | {
      type: "search";
      queryIndex: number;
      queryTotal: number;
      collected: number;
      target: number;
    }
  | { type: "enrich"; done: number; total: number }
  | {
      type: "company_enrich";
      done: number;
      total: number;
    }
  | {
      type: "complete";
      results: Opportunity[];
      found: number;
      enriched: number;
      plan: AiSearchPlan;
      elapsedMs: number;
      discovery: AiSearchDiscovery;
      /** Per-source availability ("bundesagentur" entry) so the UI can show
       *  a small notice when the official source failed or degraded. */
      sources: SourceStatus[];
      /** Honest result statistics (email/application/official counters). */
      stats: AiSearchStats;
    };

/** Availability of the official BA source during collection:
 *  ok — no failures; degraded — data was collected despite failures;
 *  unavailable — no BA data at all. `baRetryable` mirrors the internal
 *  classification (transient network/timeout/5xx/429 → true; a deliberate
 *  access block/challenge → false). */
export interface AiSearchCollection {
  opportunities: Opportunity[];
  ba: "ok" | "degraded" | "unavailable";
  baRetryable: boolean;
}

/** Collect unique opportunities for every planned query (source order per
 *  query; query priority order preserved across queries). Stops early once
 *  the enrichment budget is met.
 *
 *  Resilience contract: a BA failure NEVER fails the collection.
 *  - A retryable failure (already retried 3× inside the provider) stops the
 *    BA work for THIS run — hitting the flapping upstream with more queries
 *    would only extend the wait (bounded, no storm).
 *  - A non-retryable failure (access block/challenge) stops it as well — BA's
 *    controls are respected, never pushed through.
 *  - Whatever was collected before the failure is returned as-is, so the web
 *    source's results are never discarded along with a BA blip. */
export async function collectOpportunities(args: {
  plan: AiSearchPlan;
  goal: "ausbildung" | "arbeit";
  targetCount: AiSearchCount;
  onProgress?: (event: Extract<AiSearchProgress, { type: "search" }>) => void;
}): Promise<AiSearchCollection> {
  const { plan, goal, targetCount, onProgress } = args;
  const budget = targetCount + ENRICH_BUFFER;
  const merged = new Map<string, Opportunity>();
  let baFailures = 0;
  let baRetryable = false;
  let baStopped = false;
  for (let queryIndex = 0; queryIndex < plan.queries.length; queryIndex += 1) {
    if (baStopped) break;
    const query = plan.queries[queryIndex];
    for (let page = 1; page <= MAX_PAGES_PER_QUERY; page += 1) {
      if (merged.size >= budget) break;
      let response: Awaited<ReturnType<typeof searchOpportunities>>;
      try {
        response = await searchOpportunities(
          normalizeSearchParams({
            goal,
            keyword: query.keyword,
            role: query.role,
            company: "",
            location: query.location,
            radius: undefined,
            freshness: "any",
            sort: "relevance",
            employment: "any",
            training_type: "any",
            home_office: "any",
            salary_documented: false,
            distance_max: undefined,
            page,
            pageSize: 50,
            match: false,
          }),
          null,
        );
      } catch (error) {
        if (error instanceof BaFetchFailure) {
          baFailures += 1;
          baRetryable = error.retryable || baRetryable;
          baStopped = true;
          onProgress?.({
            type: "search",
            queryIndex: queryIndex + 1,
            queryTotal: plan.queries.length,
            collected: merged.size,
            target: targetCount,
          });
          break;
        }
        // Unexpected (non-provider) error — let the pipeline fail loudly.
        throw error;
      }
      for (const item of response.results) {
        if (!merged.has(item.id)) merged.set(item.id, item);
      }
      // A partial (degraded) window: real results, but the source was already
      // struggling — count it so the availability status reflects reality.
      if (response.sources?.some((s) => s.status !== "ok")) baFailures += 1;
      onProgress?.({
        type: "search",
        queryIndex: queryIndex + 1,
        queryTotal: plan.queries.length,
        collected: merged.size,
        target: targetCount,
      });
      if (response.mode === "scan")
        // A scan window is bounded AND page-independent — one call already
        // covered the whole server-side filter/sort window; further pages
        // would only repeat it.
        break;
      // True upstream pagination: stop when the source is exhausted.
      if (page * 50 >= response.total || response.results.length < 50)
        break;
    }
  }
  // An empty result set with zero failures is a SUCCESSFUL answer (the
  // source was reachable and simply matched nothing) — never "unavailable".
  const ba: AiSearchCollection["ba"] =
    baFailures === 0
      ? "ok"
      : merged.size > 0
        ? "degraded"
        : "unavailable";
  return { opportunities: [...merged.values()], ba, baRetryable };
}

/** Detail enrichment: resolve each candidate from the source's details
 *  endpoint (published description, contact, requirements, application URL,
 *  deadline) via the short-lived details cache — an export or a repeated view
 *  reuses the already-fetched record instead of re-hitting BA. Bounded
 *  concurrency (≤ 5 in flight); failures are skipped, never substituted. */
const ENRICH_CONCURRENCY = 5;

export async function enrichOpportunities(
  items: Opportunity[],
  onProgress?: (done: number, total: number) => void,
): Promise<Opportunity[]> {
  const enriched: Opportunity[] = [];
  let done = 0;
  for (let start = 0; start < items.length; start += ENRICH_CONCURRENCY) {
    const batch = items.slice(start, start + ENRICH_CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map((item) => resolveOpportunityCached(item.id)),
    );
    for (const result of settled) {
      if (result.status === "fulfilled") enriched.push(result.value);
      // rejected: posting no longer available at the source or transient
      // upstream error — keep everything else, never invent a replacement.
      done += 1;
    }
    onProgress?.(done, items.length);
  }
  return enriched;
}

// ---------------------------------------------------------------------------
// 3) Ranking + result
// ---------------------------------------------------------------------------

/** Documented match order (same semantics as the search layer): complete
 *  matches by score descending (ties by stable id), then incomplete matches
 *  (no score — never ranked as a perfect match), then unmatched; slice N. */
export function rankOpportunities(
  items: Opportunity[],
  profile: CandidateProfile | null,
  limit: number,
): Opportunity[] {
  const withMatch = profile
    ? items.map((item) => applyMatch(profile, item))
    : items;
  const byId = (a: Opportunity, b: Opportunity) =>
    a.id === b.id ? 0 : a.id < b.id ? -1 : 1;
  const complete = withMatch
    .filter((item) => item.match?.status === "complete")
    .sort(
      (a, b) =>
        (b.match?.score ?? 0) - (a.match?.score ?? 0) || byId(a, b),
    );
  const incomplete = withMatch
    .filter(
      (item) =>
        item.match?.status === "incomplete" ||
        item.match?.status === "unavailable",
    )
    .sort(byId);
  const unmatched = withMatch.filter((item) => item.match === null).sort(byId);
  return [...complete, ...incomplete, ...unmatched].slice(0, limit);
}

export interface AiSearchResult {
  plan: AiSearchPlan;
  results: Opportunity[];
  /** Final rows returned. */
  found: number;
  /** Unique BA candidates collected before enrichment. */
  searched: number;
  /** BA candidates whose details were successfully re-fetched. */
  enriched: number;
  /** Real discovery statistics for the progress UI / export. */
  discovery: AiSearchDiscovery;
  /** Per-source availability (the "bundesagentur" entry) for the UI notice. */
  sources: SourceStatus[];
  /** Honest result statistics (email/application/official counters). */
  stats: AiSearchStats;
  elapsedMs: number;
}

const emptyDiscovery = (): AiSearchDiscovery => ({
  configured: false,
  provider: null,
  categories: {
    search_engine: 0,
    job_portal: 0,
    company_website: 0,
    social_media: 0,
  },
  sources: {},
  sourceStatuses: [],
  webSearchesOk: 0,
  providerErrors: 0,
  firstProviderError: null,
  checked: 0,
  webFound: 0,
  duplicatesRemoved: 0,
});

/** End-to-end pipeline. The route reserves one AI request for the planning
 *  call; web extraction batches reserve their own (≤ 2). BA + web discovery
 *  run in parallel; the expensive BA detail enrichment only starts once the
 *  web side has finished (dedupe before expensive enrichment). Emits real
 *  progress events — every counter is actual work, never simulated. */
export async function runAISearch(args: {
  userId: string;
  goal: "ausbildung" | "arbeit";
  targetCount: AiSearchCount;
  onProgress?: (event: AiSearchProgress) => void;
}): Promise<AiSearchResult> {
  const startedAt = Date.now();
  const emit = (event: AiSearchProgress) => args.onProgress?.(event);
  const profile = await getCandidateProfile(args.userId);
  if (!profile)
    throw new Error(
      "No candidate profile found. Upload and analyze your CV first.",
    );
  emit({ type: "profile", summary: summarizeProfile(profile) });
  const plan = await planAISearch({
    profile,
    goal: args.goal,
    targetCount: args.targetCount,
  });
  emit({ type: "plan", plan });

  // Official BA collection (shared provider + cache).
  const collectPromise = collectOpportunities({
    plan,
    goal: args.goal,
    targetCount: args.targetCount,
    onProgress: (event) => emit(event),
  });
  // Broad web discovery (only when a provider is configured + planned).
  const client = getWebSearchClient();
  const hasWeb = client !== null && plan.web_queries.length > 0;
  const webPromise = hasWeb
    ? runWebDiscovery({
        client: client!,
        webQueries: plan.web_queries,
        goal: args.goal,
        userId: args.userId,
        onCategoryResults: (category, results) =>
          emit({ type: "discover", category, results }),
        onCheckProgress: (done, total) => emit({ type: "check", done, total }),
        onExtractProgress: (done, total) =>
          emit({ type: "extract", done, total }),
      })
    : Promise.resolve(null);
  if (client === null && plan.web_queries.length > 0)
    emit({ type: "web_status", configured: false, provider: null });
  else if (client !== null)
    emit({ type: "web_status", configured: true, provider: client.name });

  const [collection, webResult] = await Promise.all([
    collectPromise,
    webPromise,
  ]);
  const collected = collection.opportunities;

  const discovery: AiSearchDiscovery = webResult
    ? {
        configured: true,
        provider: client!.name,
        categories: webResult.categoryCounts,
        sources: webResult.sourceCounts,
        sourceStatuses: webResult.sourceStatuses,
        webSearchesOk: webResult.groundingCallsOk,
        providerErrors: webResult.providerErrors,
        firstProviderError: webResult.firstProviderError,
        checked: webResult.verifiedCount,
        webFound: webResult.opportunities.length,
        duplicatesRemoved: 0,
      }
    : emptyDiscovery();

  // Official-source availability for the UI notice (only shown when not ok).
  const sources: SourceStatus[] = [
    {
      source: BA_SOURCE_ID,
      status:
        collection.ba === "ok"
          ? "ok"
          : collection.ba === "degraded"
            ? "degraded"
            : "temporarily_unavailable",
      retryable: collection.baRetryable,
    },
  ];

  // BA detail enrichment (expensive) — starts only after web discovery.
  const buffer = Math.min(collected.length, args.targetCount + ENRICH_BUFFER);
  const enriched = await enrichOpportunities(
    collected.slice(0, buffer),
    (done, total) => emit({ type: "enrich", done, total }),
  );

  // Multi-source dedupe (BA + web) with provenance, then rank.
  const merge = mergeOpportunities({
    ba: enriched,
    web: webResult?.opportunities ?? [],
    aiDuplicates: webResult?.aiDuplicates ?? [],
  });
  discovery.duplicatesRemoved = merge.duplicatesRemoved;
  emit({
    type: "dedupe",
    removed: merge.duplicatesRemoved,
    total: merge.merged.length,
  });

  // Ranking FIRST (dedupe → rank → enrich, AI Search 2.1): the bounded
  // company budget (12 companies/run) goes to the rows the user actually
  // sees, not to raw duplicates that may be filtered out.
  const ranked = rankOpportunities(merge.merged, profile, args.targetCount);
  console.info(
    "[SEARCH] raw=%d dedupeRemoved=%d final=%d webSources=%d providerErrors=%d",
    collected.length,
    merge.duplicatesRemoved,
    ranked.length,
    discovery.sources ? Object.keys(discovery.sources).length : 0,
    discovery.providerErrors,
  );

  // Company enrichment (AI Search 2.0): official-website discovery (Google
  // Search grounding, structured + content-verified) → career/impressum
  // pages → contact/email extraction with provenance, per company
  // (cache-first). Failures are contained: an enrichment problem degrades
  // a row, never the whole run.
  const telemetry: EnrichmentTelemetry = {
    companiesEnriched: 0,
    webSearchesExecuted: 0,
    companiesWithEmail: 0,
    pagesFetched: 0,
  };
  let results: Opportunity[] = ranked;
  try {
    results = await runCompanyEnrichment(ranked, {
      // No provider client: the enrichment must NOT spend a web-search
      // request per company. Instead it reuses the contact data the
      // discovery already read from the provider response (candidate company
      // website + addresses published in the result text) and the guarded
      // pages of that website — so official websites and public emails are
      // found without a single extra provider request.
      client: null,
      contactSeeds: webResult?.companyContacts ?? [],
      telemetry,
      onProgress: (done, total) =>
        emit({ type: "company_enrich", done, total }),
    });
  } catch (error) {
    console.warn(
      "[ai-search] company enrichment failed (rows kept as ranked)",
      error instanceof Error ? error.message : String(error),
    );
  }

  const sourcesSearched =
    1 +
    (discovery.sourceStatuses ?? []).filter(
      (status) => status.status !== "skipped_budget",
    ).length;
  const sourcesWithResults = Object.values(discovery.sources ?? {}).filter(
    (count) => count > 0,
  ).length;
  const stats = computeResultStats(results, {
    sourcesSearched,
    sourcesWithResults,
    webSearchesExecuted:
      discovery.webSearchesOk + telemetry.webSearchesExecuted,
    companiesEnriched: telemetry.companiesEnriched,
    companiesWithPublicEmail: telemetry.companiesWithEmail,
  });
  const elapsedMs = Date.now() - startedAt;
  const result: AiSearchResult = {
    plan,
    results,
    found: results.length,
    searched: collected.length,
    enriched: enriched.length,
    discovery,
    sources,
    stats,
    elapsedMs,
  };
  emit({
    type: "complete",
    results,
    found: result.found,
    enriched: result.enriched,
    plan,
    elapsedMs,
    discovery,
    sources,
    stats,
  });
  return result;
}

// ---------------------------------------------------------------------------
// 4) Excel export row mapping (pure — shared by the export route and tests)
// ---------------------------------------------------------------------------

/** One export row: ONLY information actually found on the source. Missing
 *  values are empty strings (never placeholders, never guesses). */
export interface OpportunityExportRow {
  company: string;
  title: string;
  location: string;
  bundesland: string;
  start_date: string;
  application_deadline: string;
  email: string;
  phone: string;
  company_website: string;
  application_url: string;
  source_url: string;
  requirements: string;
  other: string;
  /** Kind of the primary source. */
  source_type: string;
  /** Provenance: the other public sources where the same vacancy was found. */
  additional_sources: string;
  /** Registry sources this vacancy was found on (labels, " · " joined). */
  sources: string;
  /** Official company application link ("" when the application URL is
   *  itself the aggregator one or absent). */
  official_application_url: string;
  /** Preserved aggregator application link ("" when not applicable). */
  aggregator_url: string;
  /** Classification of the found email (application/career/hr/contact/
   *  general, "" when none). Deterministic, never guessed. */
  email_type: string;
}

export function buildExportRow(opportunity: Opportunity): OpportunityExportRow {
  const other: string[] = [];
  if (opportunity.salary?.label) other.push(`Salary: ${opportunity.salary.label}`);
  if (opportunity.education_requirement)
    other.push(`Education requirement: ${opportunity.education_requirement.raw}`);
  if (opportunity.training_type)
    other.push(`Training type: ${opportunity.training_type}`);
  if (opportunity.employment_type)
    other.push(`Employment: ${opportunity.employment_type}`);
  if (opportunity.profession) other.push(`Occupation: ${opportunity.profession}`);
  if (opportunity.contact?.person)
    other.push(`Contact person: ${opportunity.contact.person}`);
  if (opportunity.posted_at)
    other.push(`Posted: ${opportunity.posted_at.slice(0, 10)}`);
  return {
    company: opportunity.company_name ?? "",
    title: opportunity.title,
    location: opportunity.location ?? "",
    bundesland: opportunity.location_detail?.region ?? "",
    // Source stores ISO timestamps; the export shows the documented day.
    start_date: opportunity.valid_from ? opportunity.valid_from.slice(0, 10) : "",
    application_deadline: opportunity.application_deadline ?? "",
    email: opportunity.contact?.email ?? "",
    phone: opportunity.contact?.phone ?? "",
    company_website: opportunity.company_url ?? "",
    application_url: opportunity.application_url ?? "",
    source_url: opportunity.source_url,
    requirements: opportunity.requirements.join("\n"),
    other: other.join("\n"),
    source_type: opportunity.source_type,
    additional_sources: opportunity.additional_sources
      .map(
        (source) =>
          `${source.url} (${source.source_type}, ${source.source_name})`,
      )
      .join("\n"),
    sources: opportunity.source_ids.map((id) => sourceLabel(id)).join(" · "),
    official_application_url:
      opportunity.enrichment?.official_company_source === true
        ? (opportunity.application_url ?? "")
        : "",
    aggregator_url: opportunity.aggregator_url ?? "",
    email_type: opportunity.enrichment?.email_type ?? "",
  };
}
