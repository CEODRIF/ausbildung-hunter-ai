"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { SaveOpportunityButton } from "@/components/opportunity-save-button";
import { Icon } from "@/components/icon";
import { EmptyState } from "@/components/empty-state";
import {
  SEARCH_SOURCE_LIMIT,
  parseSearchUrlState,
  serializeSearchState,
  type Opportunity,
  type OpportunitySearchResponse,
  type SearchUrlState,
  type SourceStatus,
} from "@/lib/opportunities/types";
import { useI18n } from "@/lib/i18n";
import { localeForLang } from "@/lib/i18n/core";

interface OpportunitySearchProps {
  defaultGoal: "ausbildung" | "arbeit";
  /** Validated, whitelisted query state from the URL (may be empty). */
  initialUrlState: string;
}

const PAGE_SIZE = 20;

const SORT_OPTIONS: Array<{ value: SearchUrlState["sort"]; key: string }> = [
  { value: "relevance", key: "search.sort.relevance" },
  { value: "newest", key: "search.sort.newest" },
  { value: "oldest", key: "search.sort.oldest" },
  { value: "salary", key: "search.sort.salary" },
  { value: "distance", key: "search.sort.distance" },
  { value: "match", key: "search.sort.match" },
];

const FRESHNESS_OPTIONS = [
  { value: "any", key: "search.freshness.any" },
  { value: "today", key: "search.freshness.today" },
  { value: "14d", key: "search.freshness.days14" },
  { value: "30d", key: "search.freshness.days30" },
] as const;

function formatDay(iso: string | null, locale: string): string | null {
  if (!iso) return null;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime())
    ? null
    : parsed.toLocaleDateString(locale, {
        day: "2-digit",
        month: "short",
        year: "numeric",
      });
}

export function OpportunitySearch({
  defaultGoal,
  initialUrlState,
}: OpportunitySearchProps) {
  const router = useRouter();
  const { t, lang } = useI18n();
  const locale = localeForLang(lang);
  const [state, setState] = useState<SearchUrlState>(() =>
    parseSearchUrlState(initialUrlState, defaultGoal),
  );
  const [results, setResults] = useState<Opportunity[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [scanTruncated, setScanTruncated] = useState(false);
  const [mode, setMode] = useState<"upstream" | "scan" | null>(null);
  const [matchAvailable, setMatchAvailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Non-blocking source-status notice (degraded window) or retryable
   *  failure context (source_status from a structured 502). */
  const [sourceStatus, setSourceStatus] = useState<SourceStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const startedRef = useRef(false);

  const search = useCallback(async (next: SearchUrlState) => {
    setLoading(true);
    setError(null);
    setSourceStatus(null);
    try {
      const query = new URLSearchParams({
        goal: next.goal,
        page: String(next.page),
        pageSize: String(PAGE_SIZE),
        match: next.match ? "1" : "0",
      });
      if (next.keyword) query.set("q", next.keyword);
      if (next.role) query.set("role", next.role);
      if (next.company) query.set("company", next.company);
      if (next.location) query.set("location", next.location);
      if (next.radius !== null) query.set("radius", String(next.radius));
      if (next.freshness !== "any") query.set("freshness", next.freshness);
      if (next.sort !== "relevance") query.set("sort", next.sort);
      if (next.employment !== "any") query.set("employment", next.employment);
      if (next.training_type !== "any")
        query.set("training_type", next.training_type);
      if (next.home_office !== "any")
        query.set("home_office", next.home_office);
      if (next.salary_documented) query.set("salary", "1");
      if (next.distance_max !== null)
        query.set("distance_max", String(next.distance_max));
      const response = await fetch(
        `/api/opportunities/search?${query.toString()}`,
      );
      const data = (await response.json().catch(() => null)) as
        | (OpportunitySearchResponse & {
            error?: string;
            source_status?: SourceStatus;
          })
        | null;
      if (!response.ok) {
        const sourceStatus = data?.source_status ?? null;
        if (sourceStatus) {
          // Structured source failure (the server already retried the
          // official source): keep the previously shown results and offer a
          // no-reload retry — a BA blip must not wipe the user's page.
          setSourceStatus(sourceStatus);
          setError(t("search.sourceUnavailable"));
          return;
        }
        throw new Error(data?.error || t("search.error"));
      }
      if (!data) throw new Error(t("search.error"));
      setResults(data.results);
      setTotal(data.total);
      setScanTruncated(data.scan_truncated);
      setMode(data.mode);
      setMatchAvailable(data.match_available);
      // Non-blocking notice only when a source actually degraded.
      const failed = data.sources?.find((s) => s.status !== "ok");
      if (failed) setSourceStatus(failed);
    } catch (searchError) {
      setResults(null);
      setTotal(null);
      setScanTruncated(false);
      setSourceStatus(null);
      setError(
        searchError instanceof Error
          ? searchError.message
          : t("search.error"),
      );
    } finally {
      setLoading(false);
    }
  }, [t]);

  /** Apply a state change: run the search and sync the shareable URL. */
  const apply = useCallback(
    (mutate: (current: SearchUrlState) => SearchUrlState, resetPage = true) => {
      setState((current) => {
        const next = mutate(current);
        const final = resetPage ? { ...next, page: 1 } : next;
        void search(final);
        const qs = serializeSearchState(final);
        router.replace(qs ? `/opportunities?${qs}` : "/opportunities");
        return final;
      });
    },
    [router, search],
  );

  // Restore results for a shared/returned URL on first mount.
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void search(state);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hasLocation = state.location.trim().length > 0;
  const isAusbildung = state.goal === "ausbildung";
  const hasActiveFilters =
    state.keyword !== "" ||
    state.role !== "" ||
    state.company !== "" ||
    state.location !== "" ||
    state.radius !== null ||
    state.freshness !== "any" ||
    state.sort !== "relevance" ||
    state.employment !== "any" ||
    state.training_type !== "any" ||
    state.home_office !== "any" ||
    state.salary_documented ||
    state.distance_max !== null;

  const clearFilters = () =>
    apply((current) => ({
      ...current,
      keyword: "",
      role: "",
      company: "",
      location: "",
      radius: null,
      freshness: "any",
      sort: "relevance",
      employment: "any",
      training_type: "any",
      home_office: "any",
      salary_documented: false,
      distance_max: null,
    }));

  const maxReachable =
    mode === "scan" ? (total ?? 0) : Math.min(total ?? 0, SEARCH_SOURCE_LIMIT);
  const hasPrev = state.page > 1;
  const hasNext = state.page * PAGE_SIZE < maxReachable;

  const fromState = serializeSearchState(state);

  return (
    <div className="space-y-6">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          apply((current) => current);
        }}
        className="rounded-2xl border border-line bg-surface p-5 sm:p-6"
      >
        {/* Goal */}
        <div className="flex flex-wrap items-center gap-2">
          {(["ausbildung", "arbeit"] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => apply((current) => ({ ...current, goal: value }))}
              className={
                state.goal === value
                  ? "rounded-lg bg-navy px-4 py-2 text-xs font-bold text-white"
                  : "rounded-lg bg-surface-2 px-4 py-2 text-xs font-semibold text-muted"
              }
            >
              {t(value === "ausbildung" ? "dash.goalAusbildung" : "dash.goalArbeit")}
            </button>
          ))}
        </div>

        {/* Primary row */}
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <input
            className="rounded-xl border border-line px-4 py-3 text-sm text-ink outline-none focus:border-accent sm:col-span-2"
            placeholder={t("search.ph.keyword")}
            value={state.keyword}
            maxLength={120}
            onChange={(event) =>
              apply(
                (current) => ({ ...current, keyword: event.target.value }),
                false,
              )
            }
            aria-label={t("search.ph.keyword")}
          />
          <input
            className="rounded-xl border border-line px-4 py-3 text-sm text-ink outline-none focus:border-accent"
            placeholder={t("search.ph.location")}
            value={state.location}
            maxLength={120}
            onChange={(event) =>
              apply(
                (current) => ({ ...current, location: event.target.value }),
                false,
              )
            }
            aria-label={t("search.ph.location")}
          />
          <input
            className="rounded-xl border border-line px-4 py-3 text-sm text-ink outline-none focus:border-accent"
            placeholder={t("search.ph.radius")}
            inputMode="numeric"
            value={state.radius === null ? "" : String(state.radius)}
            onChange={(event) => {
              const raw = event.target.value.replace(/[^0-9]/g, "");
              const value = raw === "" ? null : Number(raw);
              apply(
                (current) => ({
                  ...current,
                  radius:
                    value !== null && value >= 5 && value <= 100 ? value : null,
                }),
                false,
              );
            }}
            aria-label={t("search.ph.radius")}
          />
        </div>

        {/* Filters row */}
        <div className="mt-3 grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <select
            className="rounded-xl border border-line bg-surface px-3 py-3 text-sm text-ink outline-none focus:border-accent"
            value={state.freshness}
            onChange={(event) =>
              apply((current) => ({
                ...current,
                freshness: event.target.value as SearchUrlState["freshness"],
              }))
            }
            aria-label={t("search.freshness.any")}
          >
            {FRESHNESS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {t(option.key)}
              </option>
            ))}
          </select>
          <select
            className="rounded-xl border border-line bg-surface px-3 py-3 text-sm text-ink outline-none focus:border-accent"
            value={state.sort}
            onChange={(event) =>
              apply((current) => ({
                ...current,
                sort: event.target.value as SearchUrlState["sort"],
              }))
            }
            aria-label={t("search.sort.relevance")}
          >
            {SORT_OPTIONS.map((option) => (
              <option
                key={option.value}
                value={option.value}
                disabled={option.value === "match" && !state.match}
              >
                {t(option.key)}
              </option>
            ))}
          </select>
          <select
            className="rounded-xl border border-line bg-surface px-3 py-3 text-sm text-ink outline-none focus:border-accent"
            value={state.employment}
            onChange={(event) =>
              apply((current) => ({
                ...current,
                employment: event.target.value as SearchUrlState["employment"],
              }))
            }
            aria-label={t("search.employment.any")}
          >
            <option value="any">{t("search.employment.any")}</option>
            <option value="full_time">{t("search.employment.fullTime")}</option>
            <option value="part_time">{t("search.employment.partTime")}</option>
          </select>
          {isAusbildung && (
            <select
              className="rounded-xl border border-line bg-surface px-3 py-3 text-sm text-ink outline-none focus:border-accent"
              value={state.training_type}
              onChange={(event) =>
                apply((current) => ({
                  ...current,
                  training_type: event.target
                    .value as SearchUrlState["training_type"],
                }))
              }
              aria-label={t("search.trainingType.any")}
            >
              <option value="any">{t("search.trainingType.any")}</option>
              <option value="AUSBILDUNG">{t("search.trainingType.vocational")}</option>
              <option value="DUALES_STUDIUM">{t("search.trainingType.dualStudy")}</option>
            </select>
          )}
          {isAusbildung && (
            <select
              className="rounded-xl border border-line bg-surface px-3 py-3 text-sm text-ink outline-none focus:border-accent"
              value={state.home_office}
              onChange={(event) =>
                apply((current) => ({
                  ...current,
                  home_office: event.target
                    .value as SearchUrlState["home_office"],
                }))
              }
              aria-label={t("search.homeOffice.any")}
            >
              <option value="any">{t("search.homeOffice.any")}</option>
              <option value="yes">{t("search.homeOffice.yes")}</option>
            </select>
          )}
          <select
            className="rounded-xl border border-line bg-surface px-3 py-3 text-sm text-ink outline-none focus:border-accent"
            value={state.salary_documented ? "1" : "0"}
            onChange={(event) =>
              apply((current) => ({
                ...current,
                salary_documented: event.target.value === "1",
              }))
            }
            aria-label={t("search.salary.any")}
          >
            <option value="0">{t("search.salary.any")}</option>
            <option value="1">{t("search.salary.documented")}</option>
          </select>
        </div>

        {/* Secondary row */}
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <input
            className="rounded-xl border border-line px-4 py-3 text-sm text-ink outline-none focus:border-accent"
            placeholder={t("search.ph.role")}
            value={state.role}
            maxLength={120}
            onChange={(event) =>
              apply(
                (current) => ({ ...current, role: event.target.value }),
                false,
              )
            }
            aria-label={t("search.ph.role")}
          />
          <input
            className="rounded-xl border border-line px-4 py-3 text-sm text-ink outline-none focus:border-accent"
            placeholder={t("search.ph.company")}
            value={state.company}
            maxLength={160}
            onChange={(event) =>
              apply(
                (current) => ({ ...current, company: event.target.value }),
                false,
              )
            }
            aria-label={t("search.ph.company")}
          />
          {hasLocation && (
            <input
              className="rounded-xl border border-line px-4 py-3 text-sm text-ink outline-none focus:border-accent"
              placeholder={t("search.ph.distanceMax")}
              inputMode="numeric"
              value={
                state.distance_max === null ? "" : String(state.distance_max)
              }
              onChange={(event) => {
                const raw = event.target.value.replace(/[^0-9]/g, "");
                const value = raw === "" ? null : Number(raw);
                apply(
                  (current) => ({
                    ...current,
                    distance_max:
                      value !== null && value >= 5 && value <= 100
                        ? value
                        : null,
                  }),
                  false,
                );
              }}
              aria-label={t("search.ph.distanceMax")}
            />
          )}
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-sm font-medium text-muted">
            <input
              type="checkbox"
              checked={state.match}
              onChange={(event) =>
                apply((current) => ({
                  ...current,
                  match: event.target.checked,
                  sort:
                    event.target.checked || current.sort !== "match"
                      ? current.sort
                      : "relevance",
                }))
              }
              className="h-4 w-4 accent-accent"
            />
            {t("search.matchToggle")}
          </label>
          <div className="flex items-center gap-2">
            {hasActiveFilters && (
              <button
                type="button"
                onClick={clearFilters}
                className="rounded-xl bg-surface-2 px-4 py-2.5 text-xs font-semibold text-muted transition hover:bg-line"
              >
                {t("search.clear")}
              </button>
            )}
            <button
              type="submit"
              disabled={loading}
              className="rounded-xl bg-accent px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-accent-deep disabled:opacity-60"
            >
              {loading ? t("search.searching") : t("search.search")}
            </button>
          </div>
        </div>

        {error && (
          <div className="mt-4 rounded-xl bg-warning-soft p-3 text-sm font-medium text-danger">
            <p>{error}</p>
            {sourceStatus?.retryable && (
              <button
                type="button"
                disabled={loading}
                onClick={() => void search(state)}
                className="mt-2 rounded-lg border border-danger/30 px-3 py-1.5 text-xs font-bold text-danger transition hover:bg-danger/10 disabled:opacity-60"
              >
                {t("search.retry")}
              </button>
            )}
          </div>
        )}
      </form>

      {results !== null && (
        <div>
          {/* Source notice — only when the official source actually degraded */}
          {sourceStatus && sourceStatus.status === "degraded" && !error && (
            <div className="mb-4 rounded-xl bg-warning-soft p-3 text-sm font-medium text-warning">
              {t("search.sourcePartial")}
            </div>
          )}
          {/* Result meta */}
          <div className="flex flex-wrap items-center justify-between gap-3">
             <p className="text-sm font-semibold text-muted">
               {total !== null &&
                 t(
                   mode === "scan" && scanTruncated
                     ? "search.resultsScanWindow"
                     : "search.results",
                   { count: total.toLocaleString(locale) },
                 )}
               {mode === "upstream" &&
                 total !== null &&
                 total >= SEARCH_SOURCE_LIMIT &&
                 t("search.sourceLimit", {
                   count: SEARCH_SOURCE_LIMIT.toLocaleString(locale),
                 })}
             </p>
            <div className="flex flex-wrap items-center gap-2">
              {mode === "scan" && scanTruncated && (
                <span className="rounded-xl bg-warning-soft px-3 py-2 text-xs font-semibold text-warning">
                  {t("search.scanTruncated")}
                </span>
              )}
              {state.match && !matchAvailable && (
                <Link
                  href="/bewerbung-scanner"
                  className="rounded-xl bg-warning-soft px-3 py-2 text-xs font-bold text-warning"
                >
{t("search.matchUnavailable")}
                </Link>
              )}
            </div>
          </div>

          {/* Results */}
          <div className="mt-4 space-y-4">
            {loading && (
              <div className="rounded-2xl border border-line bg-surface p-10 text-center text-sm text-muted">
                {t("search.loading")}
              </div>
            )}
            {!loading && results.length === 0 && (
              <EmptyState
                icon="search"
                title={t("search.none")}
              />
            )}
            {!loading &&
              results.map((opportunity) => (
                <article
                  key={opportunity.id}
                  className="rounded-2xl border border-line bg-surface p-5"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                         <span className="rounded-lg bg-accent-soft px-2 py-1 text-[10px] font-bold uppercase text-accent">
                           {t(
                             opportunity.goal === "ausbildung"
                               ? "dash.goalAusbildung"
                               : "dash.goalArbeit",
                           )}
                         </span>
                        {opportunity.training_type && (
                          <span className="rounded-lg bg-ai-soft px-2 py-1 text-[10px] font-bold uppercase text-ai">
                            {opportunity.training_type
                              .toLowerCase()
                              .replaceAll("_", " ")}
                          </span>
                        )}
                        {opportunity.salary?.label && (
                          <span className="rounded-lg bg-success-soft px-2 py-1 text-[10px] font-bold text-success">
                            {opportunity.salary.label}
                          </span>
                        )}
                        {opportunity.employment_type && (
                          <span className="rounded-lg bg-surface-2 px-2 py-1 text-[10px] font-bold text-muted">
                            {opportunity.employment_type}
                          </span>
                        )}
                        {opportunity.home_office === true && (
                          <span className="rounded-lg bg-surface-2 px-2 py-1 text-[10px] font-bold text-muted">
                            {t("search.homeOfficeBadge")}
                          </span>
                        )}
                        {opportunity.career_change_friendly === true && (
                          <span className="rounded-lg bg-success-soft px-2 py-1 text-[10px] font-bold text-success">
                            {t("search.careerChanger")}
                          </span>
                        )}
                      </div>
                      <h2 className="mt-3 text-lg font-bold leading-6 text-ink-soft">
                        {opportunity.title}
                      </h2>
                      <p className="mt-1 text-sm text-muted">
                        {opportunity.company_name || t("search.companyNotListed")} ·{" "}
                        {opportunity.location || t("search.locationNotListed")}
                        {opportunity.distance_km !== null &&
                          ` · ${opportunity.distance_km} km`}
                      </p>
                      <p className="mt-1 text-xs text-muted">
                        {[
                          opportunity.profession,
                          formatDay(opportunity.posted_at, locale)
                            ? t("search.posted", {
                                date: formatDay(opportunity.posted_at, locale) ?? "",
                              })
                            : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                      {opportunity.match && (
                        <div className="mt-3 rounded-xl bg-surface-2 p-3">
                          {opportunity.match.status === "complete" ? (
                            <>
                              {opportunity.match.score !== null && (
                                <p className="text-xs font-bold text-accent">
                                  {t("search.match", {
                                    score: opportunity.match.score,
                                  })}
                                </p>
                              )}
                              <ul className="mt-1 space-y-0.5 text-xs text-muted">
                                {opportunity.match.reasons
                                  .slice(0, 3)
                                  .map((line, index) => (
                                    <li key={index}>✓ {line}</li>
                                  ))}
                              </ul>
                            </>
                          ) : (
                            <>
                               <p className="text-xs font-bold text-warning">
                                 {t("search.matchIncomplete")}
                               </p>
                              <ul className="mt-1 space-y-0.5 text-xs text-muted">
                                {opportunity.match.missing_information
                                  .slice(0, 2)
                                  .map((line, index) => (
                                    <li key={index}>△ {line}</li>
                                  ))}
                              </ul>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-3">
                      <Link
                        href={
                          `/opportunities/${encodeURIComponent(opportunity.id)}` +
                          (fromState
                            ? `?from=${encodeURIComponent(fromState)}`
                            : "")
                        }
                        className="rounded-xl bg-navy px-4 py-2 text-xs font-semibold text-white"
                      >
                        {t("search.viewDetails")}
                      </Link>
                      <a
                        href={
                          opportunity.application_url ?? opportunity.source_url
                        }
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs font-bold text-accent"
                      >
                        {t("search.apply")}
                        <Icon name="arrowRight" size={12} className="rtl:-scale-x-100" />
                      </a>
                      <SaveOpportunityButton
                        opportunityKey={opportunity.id}
                        initialSaved={false}
                      />
                    </div>
                  </div>
                </article>
              ))}
          </div>

          {/* Pagination */}
          <div className="mt-6 flex items-center justify-center gap-3">
            <button
              type="button"
              disabled={!hasPrev || loading}
              onClick={() =>
                apply(
                  (current) => ({ ...current, page: current.page - 1 }),
                  false,
                )
              }
              className="rounded-xl bg-surface px-4 py-2.5 text-sm font-semibold text-accent shadow-sm transition hover:bg-background disabled:opacity-40"
            >
              <Icon name="chevronLeft" size={15} className="rtl:hidden" />
              <Icon name="chevronRight" size={15} className="hidden rtl:block" />
              {t("search.previous")}
            </button>
            <span className="text-sm font-semibold text-muted">
              {t("search.page", {
                page: state.page,
                total: Math.max(1, Math.ceil(maxReachable / PAGE_SIZE)),
              })}
            </span>
            <button
              type="button"
              disabled={!hasNext || loading}
              onClick={() =>
                apply(
                  (current) => ({ ...current, page: current.page + 1 }),
                  false,
                )
              }
              className="rounded-xl bg-surface px-4 py-2.5 text-sm font-semibold text-accent shadow-sm transition hover:bg-background disabled:opacity-40"
            >
              {t("search.next")}
              <Icon name="chevronRight" size={15} className="rtl:hidden" />
              <Icon name="chevronLeft" size={15} className="hidden rtl:block" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
