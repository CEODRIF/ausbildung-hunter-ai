"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { Button, Card, ErrorState } from "@/components/ui";
import { activateSearchUpgrade } from "@/app/opportunities/ai-search/actions";
import { Icon } from "@/components/icon";
import { SaveOpportunityButton } from "@/components/opportunity-save-button";
import type {
  Opportunity,
  SourceStatus,
} from "@/lib/opportunities/types";
import {
  opportunityEmail,
  resultsWithEmailCount,
} from "@/lib/opportunities/email-export";
import { sourceLabel } from "@/lib/opportunities/sources";
import { useI18n } from "@/lib/i18n";

/**
 * AI Ausbildung Search — client.
 *
 * Consumes the NDJSON progress stream from /api/opportunities/ai-search and
 * renders setup → live multi-source progress → results table → Excel export.
 * The wire event shapes mirror `AiSearchProgress` in
 * `lib/opportunities/ai-search.ts` (declared locally: this is a client
 * component, the lib is server-only). Every counter shown is a REAL event
 * from the pipeline — nothing is simulated.
 */

const COUNTS = [10, 25, 50, 100] as const;
type Goal = "ausbildung" | "arbeit";
type Stage = "setup" | "running" | "done" | "error";
type SourceCategory =
  | "search_engine"
  | "job_portal"
  | "company_website"
  | "social_media";

interface PlanQuery {
  keyword: string;
  role: string;
  location: string;
}
interface Plan {
  rationale: string;
  queries: PlanQuery[];
  web_queries?: string[];
}
interface ProfileSummary {
  goal: Goal;
  target_roles: string[];
  locations: string[];
  skills: string[];
  keywords: string[];
}
interface SourceRunStatus {
  source: string;
  status: "ok" | "degraded" | "failed" | "skipped_budget";
  candidates: number;
}
/** Safe provider-error detail (never a key/prompt) — root cause in the UI. */
interface ProviderErrorDetail {
  provider: string;
  model: string | null;
  http: number | null;
  code: number | null;
  providerStatus: string | null;
  message: string;
  /** Google's own (truncated, key-scrubbed) error text. */
  providerMessage?: string | null;
}
interface Discovery {
  configured: boolean;
  provider: string | null;
  categories: Record<SourceCategory, number>;
  /** Raw candidate hits per registry source (AI Search 2.0). */
  sources?: Record<string, number>;
  /** Per-source run status — powers the diagnostics card (2.1). */
  sourceStatuses?: SourceRunStatus[];
  /** Grounding calls that actually succeeded (honest metric). */
  webSearchesOk?: number;
  /** Provider-level errors (key rejected, 429, 5xx) — surfaced visibly. */
  providerErrors?: number;
  /** First provider error detail (root-cause visibility, 2.2). */
  firstProviderError?: ProviderErrorDetail | null;
  checked: number;
  webFound: number;
  duplicatesRemoved: number;
}
interface Stats {
  found: number;
  withPublicEmail: number;
  withApplicationUrl: number;
  withOfficialSource: number;
  sourcesSearched?: number;
  sourcesWithResults?: number;
  webSearchesExecuted?: number;
  companiesEnriched?: number;
  companiesWithPublicEmail?: number;
  officialWebsitesFound?: number;
  officialApplicationLinks?: number;
}

/** Client-side result filters (AI Search 2.0). All values are plain
 *  selections over the REAL result data — no server round-trip, no
 *  invented options. Empty value = "no filter". */
interface Filters {
  minMatch: number; // 0 = any
  bundesland: string; // "" = any
  city: string; // "" = any (substring, case-insensitive)
  source: string; // "" = any registry source id
  startYear: string; // "" = any
  maxDistance: string; // "" = any (km)
  hasEmail: boolean;
  hasApplyLink: boolean;
  officialSource: boolean;
}
const EMPTY_FILTERS: Filters = {
  minMatch: 0,
  bundesland: "",
  city: "",
  source: "",
  startYear: "",
  maxDistance: "",
  hasEmail: false,
  hasApplyLink: false,
  officialSource: false,
};

function matchesFilters(opportunity: Opportunity, filters: Filters): boolean {
  if (filters.minMatch > 0) {
    const score =
      opportunity.match?.status === "complete" ? (opportunity.match.score ?? 0) : 0;
    if (score < filters.minMatch) return false;
  }
  if (
    filters.bundesland &&
    opportunity.location_detail?.region !== filters.bundesland
  )
    return false;
  if (filters.city) {
    const city = (opportunity.location_detail?.city ?? opportunity.location ?? "")
      .toLowerCase();
    if (!city.includes(filters.city.toLowerCase())) return false;
  }
  if (filters.source && !opportunity.source_ids.includes(filters.source))
    return false;
  if (filters.startYear) {
    const year =
      opportunity.valid_from?.slice(0, 4) ??
      opportunity.title.match(/\b(20\d{2})\b/)?.[1] ??
      "";
    if (year !== filters.startYear) return false;
  }
  if (filters.maxDistance !== "") {
    const max = Number(filters.maxDistance);
    if (
      !Number.isFinite(max) ||
      opportunity.distance_km === null ||
      opportunity.distance_km > max
    )
      return false;
  }
  if (filters.hasEmail && opportunityEmail(opportunity) === null) return false;
  if (filters.hasApplyLink && !opportunity.application_url) return false;
  if (
    filters.officialSource &&
    !(
      opportunity.enrichment?.official_company_source === true ||
      opportunity.source_type === "company_website"
    )
  )
    return false;
  return true;
}
type AiSearchEvent =
  | { type: "profile"; summary: ProfileSummary }
  | { type: "credits"; creditsRemaining: number; creditLimit: number }
  | { type: "plan"; plan: Plan }
  | { type: "web_status"; configured: boolean; provider: string | null }
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
  | { type: "company_enrich"; done: number; total: number }
  | {
      type: "complete";
      results: Opportunity[];
      found: number;
      enriched: number;
      plan: Plan;
      elapsedMs: number;
      discovery: Discovery;
      /** Per-source availability; a non-"ok" entry shows a small notice. */
      sources?: SourceStatus[];
      /** Honest result statistics (email/application/official counters). */
      stats?: Stats;
    }
  | { type: "error"; message: string };

function formatDay(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
}

/** Display form of a URL (host only) for provenance lines. */
function hostOfUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function queryLabel(query: PlanQuery): string {
  return (
    [query.role, query.keyword, query.location].filter(Boolean).join(" · ") ||
    "(no constraints)"
  );
}

const CATEGORY_LABELS: Record<SourceCategory, string> = {
  search_engine: "Google / web search",
  job_portal: "Ausbildung & job websites",
  company_website: "Company websites",
  social_media: "Public social media",
};

function MatchBadge({ opportunity }: { opportunity: Opportunity }) {
  const match = opportunity.match;
  if (!match || match.status === "unavailable")
    return <span className="text-xs text-faint">—</span>;
  if (match.status === "incomplete")
    return (
      <span className="inline-flex rounded-full bg-warning-soft px-2.5 py-0.5 text-[11px] font-bold text-warning">
        Partial match
      </span>
    );
  return (
    <span className="inline-flex rounded-full bg-success-soft px-2.5 py-0.5 text-[11px] font-bold text-success">
      {match.score}% match
    </span>
  );
}

function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex rounded-lg bg-surface-2 px-2.5 py-1 text-xs font-semibold text-ink-soft">
      {children}
    </span>
  );
}

export function AISearchClient({
  hasProfile,
  profileSummary,
  defaultGoal,
  initialCredits,
}: {
  hasProfile: boolean;
  profileSummary: ProfileSummary | null;
  defaultGoal: Goal;
  /** Server-resolved balance. Display only — the server charges atomically. */
  initialCredits: {
    creditsRemaining: number;
    creditLimit: number;
    resetHours?: number;
    premium?: boolean;
  };
}) {
  const { t } = useI18n();
  const [goal, setGoal] = useState<Goal>(defaultGoal);
  const [count, setCount] = useState<(typeof COUNTS)[number]>(25);
  const [credits, setCredits] = useState(initialCredits);
  // Search upgrade code — verified server-side only (never in the bundle).
  const [upgradeCode, setUpgradeCode] = useState("");
  const [upgradeState, setUpgradeState] = useState<
    "idle" | "loading" | "ok" | "error"
  >("idle");
  const [upgradeMessage, setUpgradeMessage] = useState("");
  /** The selected count IS the price (10/25/50/100 credits). */
  const sufficientCredits = credits.creditsRemaining >= count;
  const [stage, setStage] = useState<Stage>("setup");
  const [error, setError] = useState("");
  const [summary, setSummary] = useState<ProfileSummary | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [webStatus, setWebStatus] = useState<{
    configured: boolean;
    provider: string | null;
  } | null>(null);
  const [categoryCounts, setCategoryCounts] = useState<
    Partial<Record<SourceCategory, number>>
  >({});
  const [checkProgress, setCheckProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const [extractProgress, setExtractProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const [dedupe, setDedupe] = useState<{
    removed: number;
    total: number;
  } | null>(null);
  const [searchProgress, setSearchProgress] = useState<{
    queryIndex: number;
    queryTotal: number;
    collected: number;
    target: number;
  } | null>(null);
  const [enrichProgress, setEnrichProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [results, setResults] = useState<Opportunity[] | null>(null);
  const [found, setFound] = useState(0);
  const [companyEnrich, setCompanyEnrich] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  /** Per-source availability from the complete event (notice only when a
   *  source failed or degraded — never shown on a clean run). */
  const [sourceStatuses, setSourceStatuses] = useState<SourceStatus[] | null>(
    null,
  );
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  function toggleExpanded(id: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleEvent(event: AiSearchEvent) {
    switch (event.type) {
      case "profile":
        setSummary(event.summary);
        break;
      case "credits":
        // Balance AFTER the charge, sent with the run (server is the source
        // of truth — the client only displays it).
        setCredits({
          creditsRemaining: event.creditsRemaining,
          creditLimit: event.creditLimit,
        });
        break;
      case "plan":
        setPlan(event.plan);
        break;
      case "web_status":
        setWebStatus({
          configured: event.configured,
          provider: event.provider,
        });
        break;
      case "discover":
        setCategoryCounts((current) => ({
          ...current,
          [event.category]: event.results,
        }));
        break;
      case "check":
        setCheckProgress(event);
        break;
      case "extract":
        setExtractProgress(event);
        break;
      case "dedupe":
        setDedupe(event);
        break;
      case "search":
        setSearchProgress(event);
        break;
      case "enrich":
        setEnrichProgress(event);
        break;
      case "company_enrich":
        setCompanyEnrich(event);
        break;
      case "complete":
        setResults(event.results);
        setFound(event.found);
        setDiscovery(event.discovery);
        setSourceStatuses(event.sources ?? null);
        setStats(event.stats ?? null);
        setStage("done");
        break;
      case "error":
        setError(event.message);
        setStage("error");
        break;
    }
  }

  async function submitUpgradeCode(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = upgradeCode.trim();
    if (upgradeState === "loading" || !code) return;
    setUpgradeState("loading");
    setUpgradeMessage("");
    try {
      const result = await activateSearchUpgrade(code);
      if (!result.ok) {
        setUpgradeState("error");
        setUpgradeMessage(result.message);
        return;
      }
      // The entitlement comes back FROM THE SERVER (database state).
      setCredits((current) => ({
        ...current,
        creditsRemaining: result.creditsRemaining ?? current.creditsRemaining,
        creditLimit: result.creditLimit ?? current.creditLimit,
        resetHours: result.resetHours ?? current.resetHours,
        premium: result.premium ?? true,
      }));
      setUpgradeState("ok");
      setUpgradeMessage(result.message);
      setUpgradeCode("");
    } catch {
      setUpgradeState("error");
      setUpgradeMessage("Unable to activate the upgrade code.");
    }
  }

  function start() {
    // Guard: never start a search the balance cannot pay for.
    if (!sufficientCredits) return;
    setStage("running");
    setError("");
    setSummary(null);
    setPlan(null);
    setWebStatus(null);
    setCategoryCounts({});
    setCheckProgress(null);
    setExtractProgress(null);
    setDedupe(null);
    setSearchProgress(null);
    setEnrichProgress(null);
    setCompanyEnrich(null);
    setDiscovery(null);
    setStats(null);
    setResults(null);
    setSourceStatuses(null);
    setFilters(EMPTY_FILTERS);
    setExpanded(new Set());
    setExportError("");
    const controller = new AbortController();
    abortRef.current = controller;
    (async () => {
      let finished = false;
      const consume = (event: AiSearchEvent) => {
        if (event.type === "complete" || event.type === "error")
          finished = true;
        handleEvent(event);
      };
      try {
        const response = await fetch("/api/opportunities/ai-search", {
          method: "POST",
          headers: { "content-type": "application/json" },
          // requestId = idempotency key: a replayed request (retry, duplicate
          // tab, refreshed browser) is never charged twice.
          body: JSON.stringify({
            goal,
            targetCount: count,
            requestId: crypto.randomUUID(),
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as {
            error?: string;
            creditsRemaining?: number;
          } | null;
          if (payload?.error === "insufficient_credits") {
            // Nothing was charged and the search never started — show the
            // server's balance and return to the setup screen.
            if (typeof payload.creditsRemaining === "number")
              setCredits((current) => ({
                ...current,
                creditsRemaining: payload.creditsRemaining as number,
              }));
            setError(
              `Not enough search credits. You have ${
                payload.creditsRemaining ?? credits.creditsRemaining
              } credits remaining, but this search requires ${count} credits.`,
            );
            setStage("setup");
            return;
          }
          throw new Error(payload?.error ?? "The AI search could not be started.");
        }
        const reader = response.body?.getReader();
        if (!reader) throw new Error("The AI search stream was unavailable.");
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            consume(JSON.parse(line) as AiSearchEvent);
          }
        }
        if (buffer.trim()) consume(JSON.parse(buffer) as AiSearchEvent);
        if (!finished) {
          // The server always emits complete or error; this is a safety net
          // for a stream that ended without either.
          setError("The AI search ended unexpectedly. Please try again.");
          setStage("error");
        }
      } catch (runError) {
        if (controller.signal.aborted) {
          setStage("setup");
          return;
        }
        setError(
          runError instanceof Error
            ? runError.message
            : "The AI search could not be completed.",
        );
        setStage("error");
      }
    })();
  }

  function cancel() {
    abortRef.current?.abort();
  }

  async function exportExcel() {
    if (!plan) return;
    setExporting(true);
    setExportError("");
    try {
      const response = await fetch(
        "/api/opportunities/ai-search/export",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ goal, targetCount: count, plan }),
        },
      );
       if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(payload?.error ?? t("aiSearch.exportError"));
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download =
        response.headers
          .get("content-disposition")
          ?.match(/filename="([^"]+)"/)?.[1] ?? "ausbildung-search.xlsx";
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
     } catch (exportFailed) {
       setExportError(
         exportFailed instanceof Error
           ? exportFailed.message
           : t("aiSearch.exportError"),
       );
     } finally {
       setExporting(false);
     }
   }

  // ------------------------------------------------------------------ setup
  if (stage === "setup") {
    const shown = summary ?? profileSummary;
    return (
      <div className="grid gap-5 lg:grid-cols-[0.85fr_1.15fr]">
        <Card className="p-5 sm:p-6">
          <p className="text-xs font-bold uppercase tracking-[0.12em] text-faint">
            Your CV profile
          </p>
          {hasProfile && shown ? (
            <div className="mt-4 space-y-4">
              <p className="text-sm leading-6 text-ink-soft">
                The AI will use this profile (from the Bewerbung Scanner) to
                build your search. No extra CV upload is needed.
              </p>
              {shown.target_roles.length > 0 && (
                <div>
                  <p className="text-xs font-bold text-muted">
                    Target roles
                  </p>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {shown.target_roles.map((role) => (
                      <Chip key={role}>{role}</Chip>
                    ))}
                  </div>
                </div>
              )}
              {shown.locations.length > 0 && (
                <div>
                  <p className="text-xs font-bold text-muted">
                    Locations
                  </p>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {shown.locations.map((location) => (
                      <Chip key={location}>{location}</Chip>
                    ))}
                  </div>
                </div>
              )}
              {shown.skills.length > 0 && (
                <div>
                  <p className="text-xs font-bold text-muted">Skills</p>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {shown.skills.map((skill) => (
                      <Chip key={skill}>{skill}</Chip>
                    ))}
                  </div>
                </div>
              )}
              <Link
                href="/bewerbung-scanner"
                className="text-sm font-semibold text-accent"
              >
                Re-analyze my CV →
              </Link>
            </div>
          ) : (
            <div className="mt-4 space-y-4">
              <p className="text-sm leading-6 text-ink-soft">
                Upload your CV so the AI can build a profile from it. The
                Bewerbung Scanner extracts your roles, skills, and locations —
                only what your document actually says.
              </p>
              <Link
                href="/bewerbung-scanner"
                className="mt-1 inline-flex h-12 items-center justify-center rounded-xl bg-accent px-5 text-sm font-semibold text-white shadow-[0_8px_18px_rgba(var(--glow-accent-rgb),0.22)] transition-colors hover:bg-accent-deep"
              >
                Upload &amp; analyze my CV
              </Link>
            </div>
          )}
        </Card>
        <Card className="p-5 sm:p-6">
          <p className="text-xs font-bold uppercase tracking-[0.12em] text-faint">
            Search settings
          </p>
          <p className="mt-4 text-xs font-bold text-muted">
            What are you looking for?
          </p>
          <div className="mt-2 grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => setGoal("ausbildung")}
              className={`rounded-2xl border p-4 text-left ${goal === "ausbildung" ? "border-accent bg-accent-soft" : "border-line"}`}
            >
              <p className="font-bold text-ink-soft">Ausbildung</p>
              <p className="mt-1 text-xs text-muted">
                Vocational training
              </p>
            </button>
            <button
              type="button"
              onClick={() => setGoal("arbeit")}
              className={`rounded-2xl border p-4 text-left ${goal === "arbeit" ? "border-accent bg-accent-soft" : "border-line"}`}
            >
              <p className="font-bold text-ink-soft">Arbeit</p>
              <p className="mt-1 text-xs text-muted">Jobs &amp; work</p>
            </button>
          </div>
          <p className="mt-5 text-xs font-bold text-muted">
            How many opportunities?
          </p>
          <div className="mt-2 grid grid-cols-4 gap-3">
            {COUNTS.map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setCount(value)}
                className={`rounded-2xl border py-3.5 text-center font-bold ${count === value ? "border-accent bg-accent-soft text-accent" : "border-line text-ink-soft"}`}
              >
                {value}
              </button>
            ))}
          </div>
          <div className="mt-4 rounded-xl border border-line p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <p className="text-xs font-bold text-ink-soft">Search Credits</p>
              <p className="text-sm font-bold text-ink-soft">
                {credits.creditsRemaining} / {credits.creditLimit} credits
                remaining
              </p>
            </div>
            <p className="mt-1.5 text-xs leading-5 text-muted">
              This search will use {count} credits.
              <br />
              Remaining after search:{" "}
              {Math.max(0, credits.creditsRemaining - count)} credits.
            </p>
            {!sufficientCredits && (
              <p className="mt-2 text-xs font-semibold text-warning">
                Not enough search credits. You have {credits.creditsRemaining}{" "}
                credits remaining, but this search requires {count} credits.
              </p>
            )}

            {credits.premium ? (
              <p className="mt-3 rounded-xl bg-surface-2 px-3 py-2 text-xs font-semibold text-ink-soft">
                Search upgrade active — {credits.creditLimit} credits every{" "}
                {credits.resetHours ?? 24} h.
              </p>
            ) : (
              <div className="mt-4 border-t border-line pt-4">
                <p className="text-xs font-bold text-ink-soft">
                  Have a search upgrade code?
                </p>
                <form
                  className="mt-2.5 flex flex-col gap-3 sm:flex-row"
                  onSubmit={submitUpgradeCode}
                >
                  <input
                    value={upgradeCode}
                    onChange={(event) => {
                      setUpgradeCode(event.target.value);
                      if (upgradeState !== "loading") {
                        setUpgradeState("idle");
                        setUpgradeMessage("");
                      }
                    }}
                    className="h-11 flex-1 rounded-xl border border-line-strong bg-surface px-3.5 text-sm uppercase tracking-[0.12em] outline-none focus:border-accent"
                    placeholder="UPGRADE CODE"
                    autoComplete="off"
                    spellCheck={false}
                    disabled={upgradeState === "loading"}
                  />
                  <Button
                    type="submit"
                    className="h-11 px-5"
                    disabled={
                      upgradeState === "loading" ||
                      upgradeCode.trim().length === 0
                    }
                  >
                    {upgradeState === "loading" ? "Activating…" : "Activate"}
                  </Button>
                </form>
                {upgradeState === "ok" && (
                  <p className="mt-2 text-xs font-semibold text-ink-soft">
                    {upgradeMessage}
                  </p>
                )}
                {upgradeState === "error" && (
                  <p className="mt-2 text-xs font-semibold text-warning">
                    {upgradeMessage}
                  </p>
                )}
              </div>
            )}
          </div>
          <div className="mt-5 rounded-xl bg-surface-2 p-4 text-xs leading-5 text-muted">
            The AI reads your profile, creates focused queries, and searches
            the official Bundesagentur für Arbeit Jobsuche plus publicly
            indexed web sources (job portals, company career pages, public
            social media). Only real, currently published postings are shown —
            nothing is invented. Blocked or private sources are skipped, never
            bypassed.
          </div>
          <Button
            className="mt-5 w-full"
            size="lg"
            onClick={start}
            disabled={!hasProfile || !sufficientCredits}
          >
            Start AI search
          </Button>
          {!hasProfile && (
            <p className="mt-2 text-xs text-muted">
              Analyze your CV first to enable the search.
            </p>
          )}
        </Card>
      </div>
    );
  }

  // --------------------------------------------------------------- running
  if (stage === "running") {
    const webConfigured = webStatus?.configured ?? null;
    const searchingActive =
      searchProgress !== null || webStatus !== null;
    const steps: Array<{
      label: string;
      state: "done" | "active" | "pending";
      detail?: string;
      subRows?: Array<{ label: string; value: string }>;
      chips?: string[];
    }> = [
      {
        label: "Candidate profile",
        state: summary ? "done" : "active",
        detail: summary
          ? [
              ...summary.target_roles.slice(0, 3),
              ...summary.locations.slice(0, 2),
            ]
              .filter(Boolean)
              .join(" · ")
          : "Loading…",
      },
      {
        label: "AI search plan",
        state: plan ? "done" : "active",
        detail: plan ? plan.rationale || `${plan.queries.length} queries` : "",
        chips: plan ? plan.queries.map(queryLabel) : undefined,
      },
      {
        label: t("aiSearch.searching"),
        state: searchingActive ? "active" : "pending",
        subRows: [
          {
            label: "Official source (Arbeitsagentur)",
            value: searchProgress
              ? `Query ${searchProgress.queryIndex}/${searchProgress.queryTotal} · ${searchProgress.collected} found`
              : "…",
          },
          ...(webConfigured === null
            ? []
            : webConfigured
              ? (Object.keys(CATEGORY_LABELS) as SourceCategory[]).map(
                  (category) => ({
                    label: CATEGORY_LABELS[category],
                    value:
                      categoryCounts[category] !== undefined
                        ? String(categoryCounts[category])
                        : "…",
                  }),
                )
              : [{ label: "Web search", value: "not configured — skipped" }]),
        ],
      },
      {
        label: "Checking opportunities",
        state: checkProgress || extractProgress ? "active" : "pending",
        detail:
          checkProgress || extractProgress
            ? [
                checkProgress
                  ? `Pages checked: ${checkProgress.done}/${checkProgress.total}`
                  : null,
                extractProgress
                  ? `AI extraction: ${extractProgress.done}/${extractProgress.total}`
                  : null,
              ]
                .filter(Boolean)
                .join(" · ")
            : undefined,
      },
      {
        label: "Collecting details & contacts",
        state: enrichProgress ? "active" : "pending",
        detail: enrichProgress
          ? `${enrichProgress.done} of ${enrichProgress.total}`
          : undefined,
      },
      {
        label: "Removing duplicates",
        state: dedupe ? "done" : "pending",
        detail: dedupe ? `${dedupe.removed} duplicates removed` : undefined,
      },
      {
        label: t("aiSearch.enrichingStep"),
        state: companyEnrich
          ? companyEnrich.done >= companyEnrich.total
            ? "done"
            : "active"
          : dedupe
            ? "active"
            : "pending",
        detail: companyEnrich
          ? `${companyEnrich.done} of ${companyEnrich.total} companies`
          : undefined,
      },
      {
        label: "Matching & preparing results",
        state: "pending",
      },
    ];
    return (
      <Card className="p-5 sm:p-8">
        <h2 className="text-lg font-bold text-ink">
          Searching for {goal === "ausbildung" ? "Ausbildung" : "job"} opportunities…
        </h2>
        <p className="mt-1 text-sm text-muted">
          Target: {count} real postings across public sources.
        </p>
        <ol className="mt-6 space-y-4">
          {steps.map((step, index) => (
            <li key={step.label} className="flex items-start gap-3">
              <span
                className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                  step.state === "done"
                    ? "bg-success-soft text-success"
                    : step.state === "active"
                      ? "bg-accent-soft text-accent"
                      : "bg-surface-2 text-faint"
                }`}
              >
                {step.state === "done" ? "✓" : index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-3">
                  <p
                    className={`text-sm font-semibold ${
                      step.state === "pending" ? "text-faint" : "text-ink-soft"
                    }`}
                  >
                    {step.label}
                  </p>
                  {step.state === "active" && (
                    <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-line-strong border-t-accent" />
                  )}
                </div>
                {step.detail && (
                  <p className="mt-0.5 text-xs text-muted">
                    {step.detail}
                  </p>
                )}
                {step.subRows && (
                  <ul className="mt-2 space-y-1">
                    {step.subRows.map((row) => (
                      <li
                        key={row.label}
                        className="flex items-center justify-between gap-3 text-xs"
                      >
                        <span className="text-muted">{row.label}</span>
                        <span className="font-bold text-ink-soft">
                          {row.value}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {step.chips && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {step.chips.map((chip, chipIndex) => (
                      <Chip key={`${chipIndex}-${chip}`}>{chip}</Chip>
                    ))}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ol>
        <div className="mt-7 flex items-center gap-3">
          <Button variant="secondary" onClick={cancel}>
            Cancel
          </Button>
          <p className="text-xs text-muted">
            You can keep this page open — progress updates live.
          </p>
        </div>
      </Card>
    );
  }

  // ----------------------------------------------------------------- error
  if (stage === "error") {
    return (
      <ErrorState
        title="The AI search could not be completed"
        description={error || "Please try again."}
        onRetry={start}
      />
    );
  }

  // ------------------------------------------------------------------ done
  const withEmail = results ? resultsWithEmailCount(results) : 0;
  const visibleResults = results
    ? results.filter((opportunity) => matchesFilters(opportunity, filters))
    : [];
  const filtersActive =
    filters.minMatch > 0 ||
    filters.bundesland !== "" ||
    filters.city !== "" ||
    filters.source !== "" ||
    filters.startYear !== "" ||
    filters.maxDistance !== "" ||
    filters.hasEmail ||
    filters.hasApplyLink ||
    filters.officialSource;
  const bundeslandOptions = [
    ...new Set(
      (results ?? [])
        .map((opportunity) => opportunity.location_detail?.region ?? "")
        .filter(Boolean),
    ),
  ].sort();
  const sourceOptions = [
    ...new Set((results ?? []).flatMap((opportunity) => opportunity.source_ids)),
  ].filter((id) => id !== "web");
  const yearOptions = [
    ...new Set(
      (results ?? [])
        .map(
          (opportunity) =>
            opportunity.valid_from?.slice(0, 4) ??
            opportunity.title.match(/\b(20\d{2})\b/)?.[1] ??
            "",
        )
        .filter(Boolean),
    ),
  ].sort();
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-ink">
            {found > 0
              ? `${found} of ${count} opportunities found`
              : t("aiSearch.empty")}
          </h2>
          <p className="mt-0.5 text-sm text-muted">
            {found > 0
              ? found < count
                ? "This is everything the public sources currently document for your search — no results are invented to fill the list."
                : "Real, currently published postings from official and public web sources."
              : "The public sources currently have no matching postings. Adjust the goal, count, or re-analyze your CV."}
          </p>
        </div>
        <Button
          variant="secondary"
          onClick={() => setStage("setup")}
          disabled={exporting}
        >
          New search
        </Button>
      </div>
      {/* Honest result statistics — an email only counts when a public
          source actually published it (same rule as the export). */}
      {stats && stats.found > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-xl bg-surface-2 p-3">
            <p className="text-xl font-bold text-ink">{stats.found}</p>
            <p className="text-xs font-semibold text-muted">
              {t("aiSearch.statsFound")}
            </p>
          </div>
          <div className="rounded-xl bg-surface-2 p-3">
            <p className="text-xl font-bold text-ink">{stats.withPublicEmail}</p>
            <p className="text-xs font-semibold text-muted">
              {t("aiSearch.statsEmail", { count: stats.withPublicEmail })}
            </p>
          </div>
          <div className="rounded-xl bg-surface-2 p-3">
            <p className="text-xl font-bold text-ink">
              {stats.withApplicationUrl}
            </p>
            <p className="text-xs font-semibold text-muted">
              {t("aiSearch.statsApply", { count: stats.withApplicationUrl })}
            </p>
          </div>
          <div className="rounded-xl bg-surface-2 p-3">
            <p className="text-xl font-bold text-ink">
              {stats.withOfficialSource}
            </p>
            <p className="text-xs font-semibold text-muted">
              {t("aiSearch.statsOfficial", { count: stats.withOfficialSource })}
            </p>
          </div>
        </div>
      )}
      {/* AI Search 2.1: extended pipeline stats — every number is an
          honest, server-computed counter (executed calls, found sites),
          never an estimate. */}
      {stats && stats.found > 0 && (
        <div className="flex flex-wrap gap-1.5">
          <Chip>{t("aiSearch.sourcesSearched")}: {stats.sourcesSearched ?? 0}</Chip>
          <Chip>{t("aiSearch.sourcesWithResults")}: {stats.sourcesWithResults ?? 0}</Chip>
          <Chip>{t("aiSearch.webSearchesExecuted")}: {stats.webSearchesExecuted ?? 0}</Chip>
          <Chip>{t("aiSearch.companiesEnriched")}: {stats.companiesEnriched ?? 0}</Chip>
          <Chip>{t("aiSearch.companiesWithEmail")}: {stats.companiesWithPublicEmail ?? 0}</Chip>
          <Chip>{t("aiSearch.officialWebsites")}: {stats.officialWebsitesFound ?? 0}</Chip>
          <Chip>{t("aiSearch.officialApplyLinks")}: {stats.officialApplicationLinks ?? 0}</Chip>
        </div>
      )}
      {/* Source diagnostics: one line per registry source (results +
          status). A dead web provider is NEVER invisible again. */}
      {discovery?.sourceStatuses && discovery.sourceStatuses.length > 0 && (
        <Card className="p-4">
          <p className="text-xs font-bold uppercase tracking-[0.12em] text-faint">
            {t("aiSearch.diagTitle")}
          </p>
          {(discovery.providerErrors ?? 0) > 0 && (
            <div className="mt-2 rounded-xl bg-warning-soft p-3 text-sm font-medium text-warning">
              {t("aiSearch.providerErrors", { n: discovery.providerErrors ?? 0 })}
              {discovery.firstProviderError && (
                <p className="mt-1.5 font-mono text-xs font-normal break-words">
                  {t("aiSearch.providerErrorDetail", {
                    model: discovery.firstProviderError.model ?? "—",
                    http:
                      discovery.firstProviderError.http != null
                        ? String(discovery.firstProviderError.http)
                        : "—",
                    code:
                      discovery.firstProviderError.code != null
                        ? String(discovery.firstProviderError.code)
                        : "—",
                    providerStatus: discovery.firstProviderError.providerStatus ?? "—",
                  })}
                  {" · "}
                  {discovery.firstProviderError.message}
                </p>
              )}
              {discovery.firstProviderError?.providerMessage && (
                <p className="mt-1 font-mono text-xs font-normal break-words opacity-80">
                  {discovery.firstProviderError.providerMessage}
                </p>
              )}
            </div>
          )}
          <div className="mt-3 flex flex-wrap gap-1.5">
            {discovery.sourceStatuses.map((status) => {
              const label =
                status.candidates > 0
                  ? `${status.candidates} → ${t("aiSearch.statusOk")}`
                  : status.status === "skipped_budget"
                    ? t("aiSearch.statusSkipped")
                    : status.status === "degraded"
                      ? t("aiSearch.statusDegraded")
                      : t("aiSearch.statusFailed");
              return (
                <Chip key={status.source}>
                  {sourceLabel(status.source)}: {label}
                </Chip>
              );
            })}
          </div>
        </Card>
      )}
      {(sourceStatuses ?? []).some((s) => s.status !== "ok") && (
        <div className="rounded-xl bg-warning-soft p-3 text-sm font-medium text-warning">
          {t("aiSearch.sourceNotice")}
        </div>
      )}
      {discovery && (
        <div className="flex flex-wrap items-center gap-1.5">
          <Chip>
            Official (Arbeitsagentur): {searchProgress?.collected ?? 0}
          </Chip>
          {discovery.configured &&
            (Object.keys(CATEGORY_LABELS) as SourceCategory[]).map(
              (category) => (
                <Chip key={category}>
                  {CATEGORY_LABELS[category]}: {discovery.categories[category]}
                </Chip>
              ),
            )}
          {discovery.configured && (
            <Chip>
              Duplicates removed: {discovery.duplicatesRemoved}
            </Chip>
          )}
          <Chip>Final: {found}</Chip>
        </div>
      )}
      {plan && (
        <Card className="p-4">
          <p className="text-xs font-bold uppercase tracking-[0.12em] text-faint">
            AI search plan
          </p>
          {plan.rationale && (
            <p className="mt-1.5 text-sm text-ink-soft">{plan.rationale}</p>
          )}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {plan.queries.map((query, index) => (
              <Chip key={`q-${index}-${queryLabel(query)}`}>
                {queryLabel(query)}
              </Chip>
            ))}
            {(plan.web_queries ?? []).map((webQuery, index) => (
              <Chip key={`w-${index}-${webQuery}`}>
                “{webQuery}”
              </Chip>
            ))}
          </div>
        </Card>
      )}
      {results && results.length > 0 && (
        <Card className="p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-faint">
              {t("aiSearch.filtersTitle")}
            </p>
            {filtersActive && (
              <button
                type="button"
                onClick={() => setFilters(EMPTY_FILTERS)}
                className="text-xs font-bold text-muted hover:text-ink-soft"
              >
                {t("aiSearch.filterAll")} · {visibleResults.length}/
                {results.length}
              </button>
            )}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <label className="text-xs font-semibold text-muted">
              {t("aiSearch.filterMatch")}
              <select
                value={filters.minMatch}
                onChange={(event) =>
                  setFilters((current) => ({
                    ...current,
                    minMatch: Number(event.target.value),
                  }))
                }
                className="mt-1 w-full rounded-lg border border-line bg-surface px-2 py-1.5 text-sm font-medium text-ink-soft"
              >
                <option value={0}>{t("aiSearch.filterAll")}</option>
                <option value={70}>≥ 70%</option>
                <option value={80}>≥ 80%</option>
                <option value={90}>≥ 90%</option>
              </select>
            </label>
            <label className="text-xs font-semibold text-muted">
              {t("aiSearch.filterBundesland")}
              <select
                value={filters.bundesland}
                onChange={(event) =>
                  setFilters((current) => ({
                    ...current,
                    bundesland: event.target.value,
                  }))
                }
                className="mt-1 w-full rounded-lg border border-line bg-surface px-2 py-1.5 text-sm font-medium text-ink-soft"
              >
                <option value="">{t("aiSearch.filterAll")}</option>
                {bundeslandOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs font-semibold text-muted">
              {t("aiSearch.filterCity")}
              <input
                type="text"
                value={filters.city}
                onChange={(event) =>
                  setFilters((current) => ({
                    ...current,
                    city: event.target.value,
                  }))
                }
                placeholder="…"
                className="mt-1 w-full rounded-lg border border-line bg-surface px-2 py-1.5 text-sm font-medium text-ink-soft"
              />
            </label>
            <label className="text-xs font-semibold text-muted">
              {t("aiSearch.filterSource")}
              <select
                value={filters.source}
                onChange={(event) =>
                  setFilters((current) => ({
                    ...current,
                    source: event.target.value,
                  }))
                }
                className="mt-1 w-full rounded-lg border border-line bg-surface px-2 py-1.5 text-sm font-medium text-ink-soft"
              >
                <option value="">{t("aiSearch.filterAll")}</option>
                {sourceOptions.map((option) => (
                  <option key={option} value={option}>
                    {sourceLabel(option)}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs font-semibold text-muted">
              {t("aiSearch.filterStartYear")}
              <select
                value={filters.startYear}
                onChange={(event) =>
                  setFilters((current) => ({
                    ...current,
                    startYear: event.target.value,
                  }))
                }
                className="mt-1 w-full rounded-lg border border-line bg-surface px-2 py-1.5 text-sm font-medium text-ink-soft"
              >
                <option value="">{t("aiSearch.filterAll")}</option>
                {yearOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs font-semibold text-muted">
              {t("aiSearch.filterDistance")}
              <input
                type="number"
                min={5}
                max={500}
                value={filters.maxDistance}
                onChange={(event) =>
                  setFilters((current) => ({
                    ...current,
                    maxDistance: event.target.value,
                  }))
                }
                placeholder="…"
                className="mt-1 w-full rounded-lg border border-line bg-surface px-2 py-1.5 text-sm font-medium text-ink-soft"
              />
            </label>
          </div>
          <div className="mt-3 flex flex-wrap gap-4">
            <label className="flex cursor-pointer items-center gap-2 text-xs font-semibold text-ink-soft">
              <input
                type="checkbox"
                checked={filters.hasEmail}
                onChange={(event) =>
                  setFilters((current) => ({
                    ...current,
                    hasEmail: event.target.checked,
                  }))
                }
                className="h-4 w-4 accent-[var(--accent)]"
              />
              {t("aiSearch.filterHasEmail")}
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-xs font-semibold text-ink-soft">
              <input
                type="checkbox"
                checked={filters.hasApplyLink}
                onChange={(event) =>
                  setFilters((current) => ({
                    ...current,
                    hasApplyLink: event.target.checked,
                  }))
                }
                className="h-4 w-4 accent-[var(--accent)]"
              />
              {t("aiSearch.filterHasApplyLink")}
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-xs font-semibold text-ink-soft">
              <input
                type="checkbox"
                checked={filters.officialSource}
                onChange={(event) =>
                  setFilters((current) => ({
                    ...current,
                    officialSource: event.target.checked,
                  }))
                }
                className="h-4 w-4 accent-[var(--accent)]"
              />
              {t("aiSearch.filterOfficialSource")}
            </label>
          </div>
          {filtersActive && (
            <p className="mt-3 text-xs font-semibold text-muted">
              {t("aiSearch.shownOf", {
                shown: visibleResults.length,
                total: results.length,
              })}
            </p>
          )}
        </Card>
      )}
      {results && results.length > 0 && (
        <Card className="overflow-hidden">
          {visibleResults.length === 0 ? (
            <p className="px-6 py-10 text-center text-sm text-muted">
              {t("aiSearch.noResultsAfterFilter")}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[980px] border-collapse text-left">
                <thead>
                  <tr className="border-b border-line bg-surface-2 text-xs font-bold uppercase tracking-[0.06em] text-muted">
                    <th className="px-4 py-3">#</th>
                    <th className="px-4 py-3">Company</th>
                    <th className="px-4 py-3">Ausbildung title</th>
                    <th className="px-4 py-3">Location</th>
                    <th className="px-4 py-3">Bundesland</th>
                    <th className="px-4 py-3">Start</th>
                    <th className="px-4 py-3">Deadline</th>
                    <th className="px-4 py-3">Contact</th>
                    <th className="px-4 py-3">Match</th>
                    <th className="px-4 py-3">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleResults.map((opportunity, index) => {
                    const isExpanded = expanded.has(opportunity.id);
                    return (
                      <FragmentRow
                        key={opportunity.id}
                        opportunity={opportunity}
                        index={index + 1}
                        expanded={isExpanded}
                        onToggle={() => toggleExpanded(opportunity.id)}
                      />
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {/* Excel export (outreach): only rows with a valid email are exported */}
      {results && results.length > 0 && (
        <Card className="p-5 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-bold text-ink">
                {t("aiSearch.exportTitle")}
              </p>
              <p className="mt-1 text-sm font-medium text-muted">
                {withEmail > 0
                  ? t("aiSearch.exportSummary", {
                      email: withEmail,
                      total: found,
                    })
                  : t("aiSearch.exportNone")}
              </p>
              <p className="mt-1 text-xs text-faint">
                {t("aiSearch.exportNote")}
              </p>
            </div>
            <Button
              onClick={exportExcel}
              disabled={exporting || withEmail === 0}
              title={
                withEmail === 0
                  ? t("aiSearch.exportNone")
                  : t("aiSearch.exportButton")
              }
            >
              <Icon name="download" size={16} />
              {exporting
                ? t("aiSearch.exportPreparing")
                : t("aiSearch.exportButton")}
            </Button>
          </div>
          {exportError && (
            <p className="mt-4 rounded-xl border border-danger/25 bg-danger-soft px-4 py-3 text-sm text-danger">
              {exportError}
            </p>
          )}
        </Card>
      )}
    </div>
  );
}

function FragmentRow({
  opportunity,
  index,
  expanded,
  onToggle,
}: {
  opportunity: Opportunity;
  index: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  const other = [
    opportunity.salary?.label ? `Salary: ${opportunity.salary.label}` : null,
    opportunity.education_requirement
      ? `Education requirement: ${opportunity.education_requirement.raw}`
      : null,
    opportunity.training_type ? `Training type: ${opportunity.training_type}` : null,
    opportunity.employment_type ? `Employment: ${opportunity.employment_type}` : null,
    opportunity.profession ? `Occupation: ${opportunity.profession}` : null,
    opportunity.contact?.person ? `Contact person: ${opportunity.contact.person}` : null,
    opportunity.posted_at ? `Posted: ${opportunity.posted_at.slice(0, 10)}` : null,
  ].filter(Boolean) as string[];
  const isWeb = opportunity.provider === "web";
  const enrichment = opportunity.enrichment;
  const isOfficial =
    enrichment?.official_company_source === true ||
    opportunity.source_type === "company_website";
  const sourceLabels = opportunity.source_ids
    .map((id) => sourceLabel(id))
    .filter((label, position, all) => label !== "web" || all.length === 1);
  const hasEmail = opportunityEmail(opportunity) !== null;
  return (
    <>
      <tr
        className={`border-b border-line transition-colors hover:bg-surface-2 ${expanded ? "bg-surface-2" : ""}`}
      >
        <td className="px-4 py-3 text-xs font-bold text-faint">{index}</td>
        <td className="px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-ink-soft">
            <span>{opportunity.company_name ?? "—"}</span>
            {isOfficial && (
              <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-bold text-accent">
                {t("aiSearch.officialBadge")}
              </span>
            )}
          </div>
          {sourceLabels.length > 0 && (
            <p className="mt-0.5 max-w-[220px] truncate text-[11px] font-medium text-faint" title={sourceLabels.join(" · ")}>
              {sourceLabels.join(" · ")}
              {sourceLabels.length > 1 && (
                <span className="ml-1 rounded bg-surface-2 px-1 text-[10px] font-bold text-muted">
                  {sourceLabels.length}
                </span>
              )}
            </p>
          )}
        </td>
        <td className="max-w-[260px] px-4 py-3">
          {isWeb ? (
            <a
              href={opportunity.source_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-semibold text-accent hover:underline"
            >
              {opportunity.title}
            </a>
          ) : (
            <Link
              href={`/opportunities/${encodeURIComponent(opportunity.id)}`}
              className="text-sm font-semibold text-accent hover:underline"
            >
              {opportunity.title}
            </Link>
          )}
        </td>
        <td className="px-4 py-3 text-sm text-ink-soft">
          {opportunity.location ?? <span className="text-faint">—</span>}
        </td>
        <td className="px-4 py-3 text-sm text-ink-soft">
          {opportunity.location_detail?.region ?? (
            <span className="text-faint">—</span>
          )}
        </td>
        <td className="whitespace-nowrap px-4 py-3 text-sm text-ink-soft">
          {formatDay(opportunity.valid_from)}
        </td>
        <td className="whitespace-nowrap px-4 py-3 text-sm text-ink-soft">
          {formatDay(opportunity.application_deadline)}
        </td>
        <td className="max-w-[210px] px-4 py-3 text-xs leading-5 text-ink-soft">
          {hasEmail ? (
            <div
              className="truncate font-semibold"
              title={opportunity.contact?.email ?? undefined}
            >
              {opportunity.contact?.email}
            </div>
          ) : (
            <div className="truncate italic text-faint" title={t("aiSearch.emailNotFound")}>
              {t("aiSearch.emailNotFound")}
            </div>
          )}
          {opportunity.contact?.phone ? (
            <div className="truncate">{opportunity.contact.phone}</div>
          ) : null}
          {opportunity.contact?.person ? (
            <div className="truncate text-muted">{opportunity.contact.person}</div>
          ) : null}
        </td>
        <td className="whitespace-nowrap px-4 py-3">
          <MatchBadge opportunity={opportunity} />
        </td>
        <td className="px-4 py-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onToggle}
              className="rounded-lg px-2 py-1 text-xs font-bold text-muted hover:bg-surface-2 hover:text-ink-soft"
              aria-expanded={expanded}
            >
              {expanded ? "Hide" : "Details"}
            </button>
            {opportunity.application_url && (
              <a
                href={opportunity.application_url}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-lg px-2 py-1 text-xs font-bold text-accent hover:bg-accent-soft"
              >
                Apply ↗
              </a>
            )}
          </div>
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-line bg-surface-2">
          <td colSpan={10} className="px-6 py-4">
            <div className="grid gap-5 lg:grid-cols-[1.2fr_0.8fr]">
              <div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Chip>{opportunity.source_type}</Chip>
                  <Chip>{opportunity.source_name}</Chip>
                </div>
                <p className="mt-4 text-xs font-bold uppercase tracking-[0.1em] text-faint">
                  Requirements
                </p>
                {opportunity.requirements.length > 0 ? (
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-soft">
                    {opportunity.requirements.map((requirement) => (
                      <li key={requirement}>{requirement}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-sm text-faint">
                    No requirements documented by the source.
                  </p>
                )}
                {other.length > 0 && (
                  <>
                    <p className="mt-4 text-xs font-bold uppercase tracking-[0.1em] text-faint">
                      Other useful information
                    </p>
                    <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-soft">
                      {other.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  </>
                )}
                {opportunity.additional_sources.length > 0 && (
                  <>
                    <p className="mt-4 text-xs font-bold uppercase tracking-[0.1em] text-faint">
                      Also found at
                    </p>
                    <ul className="mt-2 space-y-1">
                      {opportunity.additional_sources.map((source) => (
                        <li key={source.url}>
                          <a
                            href={source.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="break-all text-sm font-semibold text-accent hover:underline"
                          >
                            {source.source_name} ↗
                          </a>
                          <span className="ml-2 text-xs text-faint">
                            {source.source_type}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
              <div className="space-y-3">
                <div className="flex flex-wrap gap-2">
                  <a
                    href={opportunity.source_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded-xl bg-accent-soft px-3.5 py-2 text-xs font-bold text-accent transition hover:bg-accent-soft"
                  >
                    Source posting ↗
                  </a>
                  {opportunity.company_url && (
                    <a
                      href={opportunity.company_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="rounded-xl bg-accent-soft px-3.5 py-2 text-xs font-bold text-accent transition hover:bg-accent-soft"
                    >
                      {t("aiSearch.websiteLink")} ↗
                    </a>
                  )}
                  {enrichment?.career_url && (
                    <a
                      href={enrichment.career_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="rounded-xl bg-accent-soft px-3.5 py-2 text-xs font-bold text-accent transition hover:bg-accent-soft"
                    >
                      {t("aiSearch.careerLink")} ↗
                    </a>
                  )}
                  {enrichment?.ausbildung_url && (
                    <a
                      href={enrichment.ausbildung_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="rounded-xl bg-accent-soft px-3.5 py-2 text-xs font-bold text-accent transition hover:bg-accent-soft"
                    >
                      Ausbildung ↗
                    </a>
                  )}
                  {opportunity.application_url && (
                    <a
                      href={opportunity.application_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="rounded-xl bg-success-soft px-3.5 py-2 text-xs font-bold text-success transition hover:bg-success-soft"
                    >
                      {isOfficial ? "Jetzt bewerben ↗" : "Apply ↗"}
                    </a>
                  )}
                </div>
                {enrichment &&
                  (enrichment.email ||
                    enrichment.phone ||
                    enrichment.website_url ||
                    enrichment.last_verified_at) && (
                    <div className="rounded-xl bg-surface-2 p-3 text-xs leading-5 text-ink-soft">
                      <div className="flex items-center justify-between gap-2">
                        <p className="font-bold uppercase tracking-[0.1em] text-faint">
                          {t("aiSearch.sourcesLabel")}
                        </p>
                        {enrichment.data_confidence && (
                          <span className="rounded-full bg-surface px-2 py-0.5 text-[10px] font-bold text-muted">
                            {t("aiSearch.confidenceLabel")}:{" "}
                            {enrichment.data_confidence}
                          </span>
                        )}
                      </div>
                      {hasEmail && enrichment.email_source && (
                        <p className="mt-1.5">
                          {t("aiSearch.emailSourceLabel")}:{" "}
                          <a
                            href={enrichment.email_source}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="break-all font-semibold text-accent hover:underline"
                          >
                            {t("aiSearch.foundAt")} {hostOfUrl(enrichment.email_source)}
                          </a>
                        </p>
                      )}
                      {enrichment.website_url && (
                        <p className="mt-1.5">
                          {t("aiSearch.websiteLink")}:{" "}
                          <a
                            href={enrichment.website_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="break-all font-semibold text-accent hover:underline"
                          >
                            {hostOfUrl(enrichment.website_url)}
                          </a>
                        </p>
                      )}
                      {enrichment.last_verified_at && (
                        <p className="mt-1.5 text-faint">
                          {t("aiSearch.verifiedAt")}{" "}
                          {new Date(enrichment.last_verified_at).toLocaleDateString(
                            "en-GB",
                          )}
                        </p>
                      )}
                    </div>
                  )}
                {!isWeb && (
                  <SaveOpportunityButton
                    opportunityKey={opportunity.id}
                    initialSaved={false}
                  />
                )}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
