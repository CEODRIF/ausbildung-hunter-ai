"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { SaveOpportunityButton } from "@/components/opportunity-save-button";
import {
  SEARCH_SOURCE_LIMIT,
  parseSearchUrlState,
  serializeSearchState,
  type Opportunity,
  type OpportunitySearchResponse,
  type SearchUrlState,
} from "@/lib/opportunities/types";

interface OpportunitySearchProps {
  defaultGoal: "ausbildung" | "arbeit";
  /** Validated, whitelisted query state from the URL (may be empty). */
  initialUrlState: string;
}

const PAGE_SIZE = 20;

const SORT_OPTIONS: Array<{ value: SearchUrlState["sort"]; label: string }> = [
  { value: "relevance", label: "Most relevant" },
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "salary", label: "Highest salary first" },
  { value: "distance", label: "Closest distance first" },
  { value: "match", label: "Best match for me" },
];

const FRESHNESS_OPTIONS = [
  { value: "any", label: "Any time" },
  { value: "today", label: "Published today" },
  { value: "14d", label: "Last 14 days" },
  { value: "30d", label: "Last 30 days" },
] as const;

function formatDay(iso: string | null): string | null {
  if (!iso) return null;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime())
    ? null
    : parsed.toLocaleDateString("en-GB", {
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
  const [state, setState] = useState<SearchUrlState>(() =>
    parseSearchUrlState(initialUrlState, defaultGoal),
  );
  const [results, setResults] = useState<Opportunity[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [scanTruncated, setScanTruncated] = useState(false);
  const [mode, setMode] = useState<"upstream" | "scan" | null>(null);
  const [matchAvailable, setMatchAvailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const startedRef = useRef(false);

  const search = useCallback(async (next: SearchUrlState) => {
    setLoading(true);
    setError(null);
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
      const data = (await response.json()) as OpportunitySearchResponse & {
        error?: string;
      };
      if (!response.ok)
        throw new Error(data.error || "The opportunity search failed.");
      setResults(data.results);
      setTotal(data.total);
      setScanTruncated(data.scan_truncated);
      setMode(data.mode);
      setMatchAvailable(data.match_available);
    } catch (searchError) {
      setResults(null);
      setTotal(null);
      setScanTruncated(false);
      setError(
        searchError instanceof Error
          ? searchError.message
          : "The opportunity search failed.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

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
        className="rounded-2xl border border-[#e7ecf3] bg-white p-5 sm:p-6"
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
                  ? "rounded-lg bg-[#10203b] px-4 py-2 text-xs font-bold text-white"
                  : "rounded-lg bg-[#f2f4f8] px-4 py-2 text-xs font-semibold text-[#71819a]"
              }
            >
              {value === "ausbildung" ? "Ausbildung" : "Arbeit"}
            </button>
          ))}
        </div>

        {/* Primary row */}
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <input
            className="rounded-xl border border-[#e7ecf3] px-4 py-3 text-sm text-[#10203b] outline-none focus:border-[#2f6fed] sm:col-span-2"
            placeholder="Keyword (e.g. mechatronics, marketing)"
            value={state.keyword}
            maxLength={120}
            onChange={(event) =>
              apply(
                (current) => ({ ...current, keyword: event.target.value }),
                false,
              )
            }
            aria-label="Keyword"
          />
          <input
            className="rounded-xl border border-[#e7ecf3] px-4 py-3 text-sm text-[#10203b] outline-none focus:border-[#2f6fed]"
            placeholder="City, PLZ or Bundesland"
            value={state.location}
            maxLength={120}
            onChange={(event) =>
              apply(
                (current) => ({ ...current, location: event.target.value }),
                false,
              )
            }
            aria-label="Location"
          />
          <input
            className="rounded-xl border border-[#e7ecf3] px-4 py-3 text-sm text-[#10203b] outline-none focus:border-[#2f6fed]"
            placeholder="Radius km (5–100, optional)"
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
            aria-label="Radius in km"
          />
        </div>

        {/* Filters row */}
        <div className="mt-3 grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <select
            className="rounded-xl border border-[#e7ecf3] bg-white px-3 py-3 text-sm text-[#10203b] outline-none focus:border-[#2f6fed]"
            value={state.freshness}
            onChange={(event) =>
              apply((current) => ({
                ...current,
                freshness: event.target.value as SearchUrlState["freshness"],
              }))
            }
            aria-label="Publication date"
          >
            {FRESHNESS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <select
            className="rounded-xl border border-[#e7ecf3] bg-white px-3 py-3 text-sm text-[#10203b] outline-none focus:border-[#2f6fed]"
            value={state.sort}
            onChange={(event) =>
              apply((current) => ({
                ...current,
                sort: event.target.value as SearchUrlState["sort"],
              }))
            }
            aria-label="Sort"
          >
            {SORT_OPTIONS.map((option) => (
              <option
                key={option.value}
                value={option.value}
                disabled={option.value === "match" && !state.match}
              >
                {option.label}
              </option>
            ))}
          </select>
          <select
            className="rounded-xl border border-[#e7ecf3] bg-white px-3 py-3 text-sm text-[#10203b] outline-none focus:border-[#2f6fed]"
            value={state.employment}
            onChange={(event) =>
              apply((current) => ({
                ...current,
                employment: event.target.value as SearchUrlState["employment"],
              }))
            }
            aria-label="Working time"
          >
            <option value="any">Working time: any</option>
            <option value="full_time">Full-time</option>
            <option value="part_time">Part-time</option>
          </select>
          {isAusbildung && (
            <select
              className="rounded-xl border border-[#e7ecf3] bg-white px-3 py-3 text-sm text-[#10203b] outline-none focus:border-[#2f6fed]"
              value={state.training_type}
              onChange={(event) =>
                apply((current) => ({
                  ...current,
                  training_type: event.target
                    .value as SearchUrlState["training_type"],
                }))
              }
              aria-label="Training type"
            >
              <option value="any">Training type: any</option>
              <option value="AUSBILDUNG">Vocational training</option>
              <option value="DUALES_STUDIUM">Dual study</option>
            </select>
          )}
          {isAusbildung && (
            <select
              className="rounded-xl border border-[#e7ecf3] bg-white px-3 py-3 text-sm text-[#10203b] outline-none focus:border-[#2f6fed]"
              value={state.home_office}
              onChange={(event) =>
                apply((current) => ({
                  ...current,
                  home_office: event.target
                    .value as SearchUrlState["home_office"],
                }))
              }
              aria-label="Home office"
            >
              <option value="any">Home office: any</option>
              <option value="yes">Home office possible</option>
            </select>
          )}
          <select
            className="rounded-xl border border-[#e7ecf3] bg-white px-3 py-3 text-sm text-[#10203b] outline-none focus:border-[#2f6fed]"
            value={state.salary_documented ? "1" : "0"}
            onChange={(event) =>
              apply((current) => ({
                ...current,
                salary_documented: event.target.value === "1",
              }))
            }
            aria-label="Documented salary"
          >
            <option value="0">Salary: any</option>
            <option value="1">Documented salary only</option>
          </select>
        </div>

        {/* Secondary row */}
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <input
            className="rounded-xl border border-[#e7ecf3] px-4 py-3 text-sm text-[#10203b] outline-none focus:border-[#2f6fed]"
            placeholder="Role / occupation (e.g. Kaufmann)"
            value={state.role}
            maxLength={120}
            onChange={(event) =>
              apply(
                (current) => ({ ...current, role: event.target.value }),
                false,
              )
            }
            aria-label="Role"
          />
          <input
            className="rounded-xl border border-[#e7ecf3] px-4 py-3 text-sm text-[#10203b] outline-none focus:border-[#2f6fed]"
            placeholder="Company (optional)"
            value={state.company}
            maxLength={160}
            onChange={(event) =>
              apply(
                (current) => ({ ...current, company: event.target.value }),
                false,
              )
            }
            aria-label="Company"
          />
          {hasLocation && (
            <input
              className="rounded-xl border border-[#e7ecf3] px-4 py-3 text-sm text-[#10203b] outline-none focus:border-[#2f6fed]"
              placeholder="Max distance km (optional)"
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
              aria-label="Maximum distance in km"
            />
          )}
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-sm font-medium text-[#546783]">
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
              className="h-4 w-4 accent-[#2f6fed]"
            />
            Show my match score
          </label>
          <div className="flex items-center gap-2">
            {hasActiveFilters && (
              <button
                type="button"
                onClick={clearFilters}
                className="rounded-xl bg-[#f2f4f8] px-4 py-2.5 text-xs font-semibold text-[#546783] transition hover:bg-[#e7ecf3]"
              >
                Clear filters
              </button>
            )}
            <button
              type="submit"
              disabled={loading}
              className="rounded-xl bg-[#2f6fed] px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-[#2456c4] disabled:opacity-60"
            >
              {loading ? "Searching…" : "Search"}
            </button>
          </div>
        </div>

        {error && (
          <p className="mt-4 rounded-xl bg-[#fdeee8] p-3 text-sm font-medium text-[#b4543c]">
            {error}
          </p>
        )}
      </form>

      {results !== null && (
        <div>
          {/* Result meta */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm font-semibold text-[#546783]">
              {total !== null &&
                (mode === "scan"
                  ? scanTruncated
                    ? `${total} matches in the scanned source window`
                    : `${total} matches`
                  : `${total} result${total === 1 ? "" : "s"}`)}
              {mode === "upstream" &&
                total !== null &&
                total >= SEARCH_SOURCE_LIMIT &&
                ` (source exposes the first ${SEARCH_SOURCE_LIMIT.toLocaleString("en-GB")})`}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              {mode === "scan" && scanTruncated && (
                <span className="rounded-xl bg-[#fff4e5] px-3 py-2 text-xs font-semibold text-[#a3611c]">
                  Bounded source scan — refine filters to narrow the results
                </span>
              )}
              {state.match && !matchAvailable && (
                <Link
                  href="/bewerbung-scanner"
                  className="rounded-xl bg-[#fff4e5] px-3 py-2 text-xs font-bold text-[#a3611c]"
                >
                  Match not available yet — run the Bewerbung Scanner to enable
                  matching
                </Link>
              )}
            </div>
          </div>

          {/* Results */}
          <div className="mt-4 space-y-4">
            {loading && (
              <div className="rounded-2xl border border-[#e7ecf3] bg-white p-10 text-center text-sm text-[#8290a4]">
                Loading opportunities…
              </div>
            )}
            {!loading && results.length === 0 && (
              <div className="rounded-2xl border border-dashed border-[#dfe6f0] bg-white p-10 text-center text-sm text-[#8290a4]">
                No opportunities matched these filters.
              </div>
            )}
            {!loading &&
              results.map((opportunity) => (
                <article
                  key={opportunity.id}
                  className="rounded-2xl border border-[#e7ecf3] bg-white p-5"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-lg bg-[#edf3ff] px-2 py-1 text-[10px] font-bold uppercase text-[#2f6fed]">
                          {opportunity.goal === "ausbildung"
                            ? "Ausbildung"
                            : "Arbeit"}
                        </span>
                        {opportunity.training_type && (
                          <span className="rounded-lg bg-[#f0e9fb] px-2 py-1 text-[10px] font-bold uppercase text-[#6b46c1]">
                            {opportunity.training_type
                              .toLowerCase()
                              .replaceAll("_", " ")}
                          </span>
                        )}
                        {opportunity.salary?.label && (
                          <span className="rounded-lg bg-[#e8f5ee] px-2 py-1 text-[10px] font-bold text-[#177a55]">
                            {opportunity.salary.label}
                          </span>
                        )}
                        {opportunity.employment_type && (
                          <span className="rounded-lg bg-[#f2f4f8] px-2 py-1 text-[10px] font-bold text-[#546783]">
                            {opportunity.employment_type}
                          </span>
                        )}
                        {opportunity.home_office === true && (
                          <span className="rounded-lg bg-[#f2f4f8] px-2 py-1 text-[10px] font-bold text-[#546783]">
                            Home office
                          </span>
                        )}
                        {opportunity.career_change_friendly === true && (
                          <span className="rounded-lg bg-[#f0fdf4] px-2 py-1 text-[10px] font-bold text-[#16a34a]">
                            Career changer
                          </span>
                        )}
                      </div>
                      <h2 className="mt-3 text-lg font-bold leading-6 text-[#1d3458]">
                        {opportunity.title}
                      </h2>
                      <p className="mt-1 text-sm text-[#71819a]">
                        {opportunity.company_name || "Company not listed"} ·{" "}
                        {opportunity.location || "Location not listed"}
                        {opportunity.distance_km !== null &&
                          ` · ${opportunity.distance_km} km`}
                      </p>
                      <p className="mt-1 text-xs text-[#8290a4]">
                        {[
                          opportunity.profession,
                          formatDay(opportunity.posted_at)
                            ? `Posted ${formatDay(opportunity.posted_at)}`
                            : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                      {opportunity.match && (
                        <div className="mt-3 rounded-xl bg-[#f7faff] p-3">
                          <p className="text-xs font-bold text-[#2f6fed]">
                            Match: {opportunity.match.match_score}%
                          </p>
                          <ul className="mt-1 space-y-0.5 text-xs text-[#546783]">
                            {opportunity.match.explanation
                              .slice(0, 3)
                              .map((line, index) => (
                                <li key={index}>{line}</li>
                              ))}
                          </ul>
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
                        className="rounded-xl bg-[#10203b] px-4 py-2 text-xs font-semibold text-white"
                      >
                        View details
                      </Link>
                      <a
                        href={
                          opportunity.application_url ?? opportunity.source_url
                        }
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs font-bold text-[#2f6fed]"
                      >
                        Apply →
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
              className="rounded-xl bg-white px-4 py-2.5 text-sm font-semibold text-[#2f6fed] shadow-sm transition hover:bg-[#f6f8fb] disabled:opacity-40"
            >
              ← Previous
            </button>
            <span className="text-sm font-semibold text-[#546783]">
              Page {state.page}
              {maxReachable > 0 &&
                ` of ${Math.max(1, Math.ceil(maxReachable / PAGE_SIZE))}`}
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
              className="rounded-xl bg-white px-4 py-2.5 text-sm font-semibold text-[#2f6fed] shadow-sm transition hover:bg-[#f6f8fb] disabled:opacity-40"
            >
              Next →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
