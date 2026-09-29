"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { Button, Card, ErrorState } from "@/components/ui";
import { SaveOpportunityButton } from "@/components/opportunity-save-button";
import type { Opportunity } from "@/lib/opportunities/types";

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
interface Discovery {
  configured: boolean;
  provider: string | null;
  categories: Record<SourceCategory, number>;
  checked: number;
  webFound: number;
  duplicatesRemoved: number;
}
type AiSearchEvent =
  | { type: "profile"; summary: ProfileSummary }
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
  | {
      type: "complete";
      results: Opportunity[];
      found: number;
      enriched: number;
      plan: Plan;
      elapsedMs: number;
      discovery: Discovery;
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
    return <span className="text-xs text-[#8b9ab0]">—</span>;
  if (match.status === "incomplete")
    return (
      <span className="inline-flex rounded-full bg-[#fbf1e3] px-2.5 py-0.5 text-[11px] font-bold text-[#a06a24]">
        Partial match
      </span>
    );
  return (
    <span className="inline-flex rounded-full bg-[#e8f5ee] px-2.5 py-0.5 text-[11px] font-bold text-[#177a55]">
      {match.score}% match
    </span>
  );
}

function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex rounded-lg bg-[#f1f5fb] px-2.5 py-1 text-xs font-semibold text-[#41546f]">
      {children}
    </span>
  );
}

export function AISearchClient({
  hasProfile,
  profileSummary,
  defaultGoal,
}: {
  hasProfile: boolean;
  profileSummary: ProfileSummary | null;
  defaultGoal: Goal;
}) {
  const [goal, setGoal] = useState<Goal>(defaultGoal);
  const [count, setCount] = useState<(typeof COUNTS)[number]>(25);
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
  const [results, setResults] = useState<Opportunity[] | null>(null);
  const [found, setFound] = useState(0);
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
      case "complete":
        setResults(event.results);
        setFound(event.found);
        setDiscovery(event.discovery);
        setStage("done");
        break;
      case "error":
        setError(event.message);
        setStage("error");
        break;
    }
  }

  function start() {
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
    setDiscovery(null);
    setResults(null);
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
          body: JSON.stringify({ goal, targetCount: count }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as {
            error?: string;
          } | null;
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
        throw new Error(payload?.error ?? "The Excel export failed.");
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
          : "The Excel export failed.",
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
          <p className="text-xs font-bold uppercase tracking-[0.12em] text-[#8b9ab0]">
            Your CV profile
          </p>
          {hasProfile && shown ? (
            <div className="mt-4 space-y-4">
              <p className="text-sm leading-6 text-[#41546f]">
                The AI will use this profile (from the Bewerbung Scanner) to
                build your search. No extra CV upload is needed.
              </p>
              {shown.target_roles.length > 0 && (
                <div>
                  <p className="text-xs font-bold text-[#6d7d96]">
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
                  <p className="text-xs font-bold text-[#6d7d96]">
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
                  <p className="text-xs font-bold text-[#6d7d96]">Skills</p>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {shown.skills.map((skill) => (
                      <Chip key={skill}>{skill}</Chip>
                    ))}
                  </div>
                </div>
              )}
              <Link
                href="/bewerbung-scanner"
                className="text-sm font-semibold text-[#2f6fed]"
              >
                Re-analyze my CV →
              </Link>
            </div>
          ) : (
            <div className="mt-4 space-y-4">
              <p className="text-sm leading-6 text-[#41546f]">
                Upload your CV so the AI can build a profile from it. The
                Bewerbung Scanner extracts your roles, skills, and locations —
                only what your document actually says.
              </p>
              <Link
                href="/bewerbung-scanner"
                className="mt-1 inline-flex h-12 items-center justify-center rounded-xl bg-[#2f6fed] px-5 text-sm font-semibold text-white shadow-[0_8px_18px_rgba(47,111,237,0.22)] transition-colors hover:bg-[#255dcc]"
              >
                Upload &amp; analyze my CV
              </Link>
            </div>
          )}
        </Card>
        <Card className="p-5 sm:p-6">
          <p className="text-xs font-bold uppercase tracking-[0.12em] text-[#8b9ab0]">
            Search settings
          </p>
          <p className="mt-4 text-xs font-bold text-[#6d7d96]">
            What are you looking for?
          </p>
          <div className="mt-2 grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => setGoal("ausbildung")}
              className={`rounded-2xl border p-4 text-left ${goal === "ausbildung" ? "border-[#2f6fed] bg-[#f3f7ff]" : "border-[#e3e9f1]"}`}
            >
              <p className="font-bold text-[#1d3458]">Ausbildung</p>
              <p className="mt-1 text-xs text-[#8290a4]">
                Vocational training
              </p>
            </button>
            <button
              type="button"
              onClick={() => setGoal("arbeit")}
              className={`rounded-2xl border p-4 text-left ${goal === "arbeit" ? "border-[#2f6fed] bg-[#f3f7ff]" : "border-[#e3e9f1]"}`}
            >
              <p className="font-bold text-[#1d3458]">Arbeit</p>
              <p className="mt-1 text-xs text-[#8290a4]">Jobs &amp; work</p>
            </button>
          </div>
          <p className="mt-5 text-xs font-bold text-[#6d7d96]">
            How many opportunities?
          </p>
          <div className="mt-2 grid grid-cols-4 gap-3">
            {COUNTS.map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setCount(value)}
                className={`rounded-2xl border py-3.5 text-center font-bold ${count === value ? "border-[#2f6fed] bg-[#f3f7ff] text-[#2f6fed]" : "border-[#e3e9f1] text-[#41546f]"}`}
              >
                {value}
              </button>
            ))}
          </div>
          <div className="mt-5 rounded-xl bg-[#f7f9fc] p-4 text-xs leading-5 text-[#8290a4]">
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
            disabled={!hasProfile}
          >
            Start AI search
          </Button>
          {!hasProfile && (
            <p className="mt-2 text-xs text-[#8492a7]">
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
        label: "Searching public sources",
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
        label: "Matching & preparing results",
        state: "pending",
      },
    ];
    return (
      <Card className="p-5 sm:p-8">
        <h2 className="text-lg font-bold text-[#10203b]">
          Searching for {goal === "ausbildung" ? "Ausbildung" : "job"} opportunities…
        </h2>
        <p className="mt-1 text-sm text-[#71819a]">
          Target: {count} real postings across public sources.
        </p>
        <ol className="mt-6 space-y-4">
          {steps.map((step, index) => (
            <li key={step.label} className="flex items-start gap-3">
              <span
                className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                  step.state === "done"
                    ? "bg-[#e8f5ee] text-[#177a55]"
                    : step.state === "active"
                      ? "bg-[#edf3ff] text-[#2f6fed]"
                      : "bg-[#f1f5fb] text-[#8b9ab0]"
                }`}
              >
                {step.state === "done" ? "✓" : index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-3">
                  <p
                    className={`text-sm font-semibold ${
                      step.state === "pending" ? "text-[#8b9ab0]" : "text-[#1d3458]"
                    }`}
                  >
                    {step.label}
                  </p>
                  {step.state === "active" && (
                    <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-[#dbe5f4] border-t-[#2f6fed]" />
                  )}
                </div>
                {step.detail && (
                  <p className="mt-0.5 text-xs text-[#71819a]">
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
                        <span className="text-[#71819a]">{row.label}</span>
                        <span className="font-bold text-[#41546f]">
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
          <p className="text-xs text-[#8492a7]">
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
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-[#10203b]">
            {found > 0
              ? `${found} of ${count} opportunities found`
              : "No opportunities found"}
          </h2>
          <p className="mt-0.5 text-sm text-[#71819a]">
            {found > 0
              ? found < count
                ? "This is everything the public sources currently document for your search — no results are invented to fill the list."
                : "Real, currently published postings from official and public web sources."
              : "The public sources currently have no matching postings. Adjust the goal, count, or re-analyze your CV."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <Button
            variant="secondary"
            onClick={() => setStage("setup")}
            disabled={exporting}
          >
            New search
          </Button>
          <Button onClick={exportExcel} disabled={exporting || found === 0}>
            {exporting ? "Preparing Excel…" : "Export to Excel"}
          </Button>
        </div>
      </div>
      {exportError && (
        <p className="rounded-xl border border-[#f0d9da] bg-[#fff8f8] px-4 py-3 text-sm text-[#a3404b]">
          {exportError}
        </p>
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
          <p className="text-xs font-bold uppercase tracking-[0.12em] text-[#8b9ab0]">
            AI search plan
          </p>
          {plan.rationale && (
            <p className="mt-1.5 text-sm text-[#41546f]">{plan.rationale}</p>
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
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px] border-collapse text-left">
              <thead>
                <tr className="border-b border-[#e7ecf3] bg-[#f8faff] text-xs font-bold uppercase tracking-[0.06em] text-[#6d7d96]">
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
                {results.map((opportunity, index) => {
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
  return (
    <>
      <tr
        className={`border-b border-[#eef2f7] transition-colors hover:bg-[#f8faff] ${expanded ? "bg-[#f8faff]" : ""}`}
      >
        <td className="px-4 py-3 text-xs font-bold text-[#8b9ab0]">{index}</td>
        <td className="px-4 py-3 text-sm font-semibold text-[#1d3458]">
          {opportunity.company_name ?? <span className="text-[#8b9ab0]">—</span>}
        </td>
        <td className="max-w-[260px] px-4 py-3">
          {isWeb ? (
            <a
              href={opportunity.source_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-semibold text-[#2f6fed] hover:underline"
            >
              {opportunity.title}
            </a>
          ) : (
            <Link
              href={`/opportunities/${encodeURIComponent(opportunity.id)}`}
              className="text-sm font-semibold text-[#2f6fed] hover:underline"
            >
              {opportunity.title}
            </Link>
          )}
        </td>
        <td className="px-4 py-3 text-sm text-[#41546f]">
          {opportunity.location ?? <span className="text-[#8b9ab0]">—</span>}
        </td>
        <td className="px-4 py-3 text-sm text-[#41546f]">
          {opportunity.location_detail?.region ?? (
            <span className="text-[#8b9ab0]">—</span>
          )}
        </td>
        <td className="whitespace-nowrap px-4 py-3 text-sm text-[#41546f]">
          {formatDay(opportunity.valid_from)}
        </td>
        <td className="whitespace-nowrap px-4 py-3 text-sm text-[#41546f]">
          {formatDay(opportunity.application_deadline)}
        </td>
        <td className="max-w-[190px] px-4 py-3 text-xs leading-5 text-[#41546f]">
          {opportunity.contact?.email ? (
            <div className="truncate">{opportunity.contact.email}</div>
          ) : null}
          {opportunity.contact?.phone ? (
            <div className="truncate">{opportunity.contact.phone}</div>
          ) : null}
          {!opportunity.contact?.email && !opportunity.contact?.phone ? (
            <span className="text-[#8b9ab0]">—</span>
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
              className="rounded-lg px-2 py-1 text-xs font-bold text-[#6d7d96] hover:bg-[#f1f5fb] hover:text-[#1d3458]"
              aria-expanded={expanded}
            >
              {expanded ? "Hide" : "Details"}
            </button>
            {opportunity.application_url && (
              <a
                href={opportunity.application_url}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-lg px-2 py-1 text-xs font-bold text-[#2f6fed] hover:bg-[#edf3ff]"
              >
                Apply ↗
              </a>
            )}
          </div>
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-[#eef2f7] bg-[#f8faff]">
          <td colSpan={10} className="px-6 py-4">
            <div className="grid gap-5 lg:grid-cols-[1.2fr_0.8fr]">
              <div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Chip>{opportunity.source_type}</Chip>
                  <Chip>{opportunity.source_name}</Chip>
                </div>
                <p className="mt-4 text-xs font-bold uppercase tracking-[0.1em] text-[#8b9ab0]">
                  Requirements
                </p>
                {opportunity.requirements.length > 0 ? (
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-[#41546f]">
                    {opportunity.requirements.map((requirement) => (
                      <li key={requirement}>{requirement}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-sm text-[#8b9ab0]">
                    No requirements documented by the source.
                  </p>
                )}
                {other.length > 0 && (
                  <>
                    <p className="mt-4 text-xs font-bold uppercase tracking-[0.1em] text-[#8b9ab0]">
                      Other useful information
                    </p>
                    <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-[#41546f]">
                      {other.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  </>
                )}
                {opportunity.additional_sources.length > 0 && (
                  <>
                    <p className="mt-4 text-xs font-bold uppercase tracking-[0.1em] text-[#8b9ab0]">
                      Also found at
                    </p>
                    <ul className="mt-2 space-y-1">
                      {opportunity.additional_sources.map((source) => (
                        <li key={source.url}>
                          <a
                            href={source.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="break-all text-sm font-semibold text-[#2f6fed] hover:underline"
                          >
                            {source.source_name} ↗
                          </a>
                          <span className="ml-2 text-xs text-[#8b9ab0]">
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
                    className="rounded-xl bg-[#edf3ff] px-3.5 py-2 text-xs font-bold text-[#2f6fed] transition hover:bg-[#dce9ff]"
                  >
                    Source posting ↗
                  </a>
                  {opportunity.company_url && (
                    <a
                      href={opportunity.company_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="rounded-xl bg-[#edf3ff] px-3.5 py-2 text-xs font-bold text-[#2f6fed] transition hover:bg-[#dce9ff]"
                    >
                      Company website ↗
                    </a>
                  )}
                </div>
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
