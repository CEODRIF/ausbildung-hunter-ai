"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { Pin, Search } from "lucide-react";
import { SaveOpportunityButton } from "@/components/opportunity-save-button";
import { Icon, type IconName } from "@/components/icon";
import { EmptyState } from "@/components/empty-state";
import { Skeleton } from "@/components/ui/feedback";
import {
  SEARCH_SOURCE_LIMIT,
  WORKPLACE_CITIES,
  parseSearchUrlState,
  serializeSearchState,
  type Opportunity,
  type OpportunitySearchResponse,
  type SearchFilterCounts,
  type SearchUrlState,
  type SourceStatus,
} from "@/lib/opportunities/types";
import { useI18n } from "@/lib/i18n";
import { localeForLang } from "@/lib/i18n/core";
import {
  QuotaIndicator,
  makeQuotaLabels,
  quotaDataFromEntitlement,
} from "@/components/quota-indicator";
import type { FeatureEntitlement } from "@/lib/billing/entitlement-service";

interface OpportunitySearchProps {
  defaultGoal: "ausbildung" | "arbeit";
  /** Validated, whitelisted query state from the URL (may be empty). */
  initialUrlState: string;
  /**
   * Canonical `opportunity_search` entitlement (server-derived; a failed
   * read arrives as `lookup_error` → the indicator's honest unknown
   * state). P0 quota audit: this surface previously showed no quota state
   * at all.
   */
  searchEntitlement?: FeatureEntitlement | null;
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

/** "Published since" buckets (cumulative; REAL counts when the server
 *  scanned a window — upstream mode has no counts, never fake numbers). */
const FRESHNESS_OPTIONS = [
  { value: "today", key: "search.freshness.today", countKey: "today" as const },
  { value: "yesterday", key: "search.freshness.yesterday", countKey: "yesterday" as const },
  { value: "1w", key: "search.freshness.week", countKey: "week" as const },
  { value: "2w", key: "search.freshness.twoWeeks", countKey: "twoWeeks" as const },
  { value: "4w", key: "search.freshness.fourWeeks", countKey: "fourWeeks" as const },
] as const;

/** Bounded detail prefetch: at most N rows per loaded result set (hover
 *  intent, idempotent per URL — never a request storm; details consume no
 *  search credits and no quota). */
const MAX_DETAIL_PREFETCHES = 3;

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

/** "YYYY-MM" → localized short month (e.g. "Nov. 2026"). Noon UTC avoids
 *  off-by-one-day at zone boundaries. */
function formatMonth(ym: string, locale: string): string {
  const parsed = new Date(`${ym}-01T12:00:00Z`);
  return Number.isNaN(parsed.getTime())
    ? ym
    : parsed.toLocaleDateString(locale, {
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      });
}

function FilterGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <p className="text-[10px] font-bold tracking-[0.12em] text-faint uppercase">{title}</p>
      <div className="mt-2 space-y-0.5">{children}</div>
    </div>
  );
}

/** Two-letter mark for a company, used as the card avatar. Deterministic and
 *  decorative only — the company name is always rendered next to it. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Compact tab badge ("60.6k") for large totals; exact below 10,000.
 *  Locale-aware decimal formatting. */
function compactCount(n: number, locale: string): string {
  if (n < 10000) return n.toLocaleString(locale);
  const value = Math.round((n / 1000) * 10) / 10;
  return `${value.toLocaleString(locale, { maximumFractionDigits: 1 })}k`;
}

function RadioRow({
  name,
  checked,
  onSelect,
  label,
  count,
  locale,
}: {
  name: string;
  checked: boolean;
  onSelect: () => void;
  label: string;
  count: number | null;
  locale: string;
}) {
  return (
    <label className="flex min-h-9 cursor-pointer items-center gap-2.5 rounded-xl px-2 py-2 text-sm text-ink-soft transition-colors hover:bg-surface-2">
      <input
        type="radio"
        name={name}
        checked={checked}
        onChange={() => onSelect()}
        className="h-4 w-4 accent-accent"
      />
      <span className="min-w-0 flex-1">{label}</span>
      {count !== null && (
        <span className="num shrink-0 text-xs font-semibold text-faint">
          {count.toLocaleString(locale)}
        </span>
      )}
    </label>
  );
}

/** View Details with double-click protection and bounded hover prefetch. */
function ViewDetailsButton({
  href,
  opportunityId,
  openingId,
  onOpen,
  onHoverPrefetch,
  t,
}: {
  href: string;
  opportunityId: string;
  openingId: string | null;
  onOpen: (id: string, href: string) => void;
  onHoverPrefetch: (id: string, href: string) => void;
  t: (path: string, vars?: Record<string, string | number>) => string;
}) {
  const opening = openingId === opportunityId;
  return (
    <button
      type="button"
      disabled={openingId !== null}
      onClick={() => onOpen(opportunityId, href)}
      onPointerEnter={() => onHoverPrefetch(opportunityId, href)}
      onFocus={() => onHoverPrefetch(opportunityId, href)}
      className={`inline-flex min-h-9 items-center rounded-full border px-4 py-2 text-xs font-bold transition-colors disabled:cursor-wait disabled:opacity-60 ${
        opening
          ? "border-accent bg-accent-soft text-accent"
          : "border-accent/45 text-accent hover:border-accent hover:bg-accent-soft"
      }`}
    >
      {opening ? t("search.viewDetailsLoading") : t("search.viewDetails")}
    </button>
  );
}

export function OpportunitySearch({
  defaultGoal,
  initialUrlState,
  searchEntitlement,
}: OpportunitySearchProps) {
  const router = useRouter();
  const pathname = usePathname();
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
  const [filterCounts, setFilterCounts] = useState<SearchFilterCounts | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  /** Non-blocking source-status notice (degraded window) or retryable
   *  failure context (source_status from a structured 502). */
  const [sourceStatus, setSourceStatus] = useState<SourceStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [showMobileFilters, setShowMobileFilters] = useState(false);
  /** Saved-state mirror per card (fed by SaveOpportunityButton's
   *  onSavedChange) — the card's avatar reflects the real saved state. */
  const [savedIds, setSavedIds] = useState<ReadonlySet<string>>(() => new Set());
  const markSaved = useCallback(
    (opportunityId: string) => (saved: boolean) => {
      setSavedIds((prev) => {
        const next = new Set(prev);
        if (saved) next.add(opportunityId);
        else next.delete(opportunityId);
        return next;
      });
    },
    [],
  );
  // View Details double-click guard: the id currently opening (any row
  // stays disabled while one is).
  const [openingId, setOpeningId] = useState<string | null>(null);
  const openingIdRef = useRef<string | null>(null);
  // Bounded prefetch bookkeeping (one entry per hovered row, capped).
  const prefetchedRef = useRef<Set<string>>(new Set());
  const startedRef = useRef(false);
  // Latest state mirror so handlers can compute the next state without side
  // effects inside a setState updater. commitSearch/scheduleSearch update it
  // synchronously (event handlers), and the effect re-syncs after every
  // committed render.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  const searchSeqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A new result set gets a fresh prefetch budget, and leaving the page
  // resets the opening guard.
  useEffect(() => {
    prefetchedRef.current = new Set();
  }, [results]);
  // Release the opening guard once the route actually changed (deferred —
  // covers an aborted transition where this list stays mounted).
  useEffect(() => {
    const timer = setTimeout(() => {
      openingIdRef.current = null;
      setOpeningId(null);
    }, 0);
    return () => clearTimeout(timer);
  }, [pathname]);

  const search = useCallback(async (next: SearchUrlState) => {
    // Every search supersedes the previous one: abort the in-flight request
    // and ignore stale responses — an out-of-order answer from an older
    // query must never overwrite the newest results.
    const seq = ++searchSeqRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
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
      // Work place: curated cities (single city becomes the native source
      // location server-side). Legacy free-text location from old shareable
      // URLs is passed through when no city is selected.
      if (next.cities.length > 0) query.set("cities", next.cities.join(","));
      if (next.location && next.cities.length === 0)
        query.set("location", next.location);
      if (next.radius !== null) query.set("radius", String(next.radius));
      if (next.beginn !== "any") query.set("beginn", next.beginn);
      if (next.freshness !== "any") query.set("freshness", next.freshness);
      if (next.sort !== "relevance") query.set("sort", next.sort);
      if (next.employment !== "any") query.set("employment", next.employment);
      if (next.training_type !== "any")
        query.set("training_type", next.training_type);
      if (next.home_office !== "any")
        query.set("home_office", next.home_office);
      if (next.salary !== "any") query.set("salary", next.salary);
      if (next.contact_email !== "any")
        query.set("email", next.contact_email);
      if (next.distance_max !== null)
        query.set("distance_max", String(next.distance_max));
      const response = await fetch(
        `/api/opportunities/search?${query.toString()}`,
        { signal: controller.signal },
      );
      const data = (await response.json().catch(() => null)) as
        | (OpportunitySearchResponse & {
            error?: string;
            source_status?: SourceStatus;
          })
        | null;
      if (seq !== searchSeqRef.current) return; // superseded
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
      setFilterCounts(data.filter_counts ?? null);
      // Stale-page self-heal: the server may serve a reachable page different
      // from the one requested (out-of-range scan page, or an upstream page
      // beyond the source total). Sync state to the page the rows ACTUALLY
      // belong to — silently, without triggering a new search.
      if (typeof data.page === "number" && data.page !== next.page) {
        const synced = { ...next, page: data.page };
        stateRef.current = synced;
        setState(synced);
        const syncedQs = serializeSearchState(synced);
        router.replace(
          syncedQs ? `/opportunities?${syncedQs}` : "/opportunities",
        );
      }
      // Non-blocking notice only when a source actually degraded.
      const failed = data.sources?.find((s) => s.status !== "ok");
      if (failed) setSourceStatus(failed);
    } catch (searchError) {
      if (controller.signal.aborted || seq !== searchSeqRef.current) return;
      setResults(null);
      setTotal(null);
      setScanTruncated(false);
      setSourceStatus(null);
      setFilterCounts(null);
      setError(
        searchError instanceof Error
          ? searchError.message
          : t("search.error"),
      );
    } finally {
      if (seq === searchSeqRef.current) setLoading(false);
    }
  }, [t, router]);

  const syncUrl = (next: SearchUrlState) => {
    const qs = serializeSearchState(next);
    router.replace(qs ? `/opportunities?${qs}` : "/opportunities");
  };

  /** Filters / submit / pagination: search immediately. */
  const commitSearch = useCallback(
    (mutate: (current: SearchUrlState) => SearchUrlState, resetPage = true) => {
      // A commit supersedes any pending debounced (text-input) search: cancel
      // it, or its stale draft state could fire AFTER this commit and revert
      // the results to the pre-commit query (the "filter didn't work" case).
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      const next = mutate(stateRef.current);
      const final = resetPage ? { ...next, page: 1 } : next;
      stateRef.current = final;
      setState(final);
      syncUrl(final);
      void search(final);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [router, search],
  );

  /** Text inputs: instant local update + ONE debounced search after the
   *  user pauses (400 ms) — never one API request per keystroke.
   *
   * Editing the search terms is a NEW search: the page resets to 1 (exactly
   * like Enter/the Search button). Without this, a user sitting on page 3
   * who edits the keyword would get the new query's (stale) page 3 — which
   * in scan mode can render a reachable-but-empty page. */
  const scheduleSearch = useCallback(
    (mutate: (current: SearchUrlState) => SearchUrlState) => {
      const final = { ...mutate(stateRef.current), page: 1 };
      stateRef.current = final;
      setState(final);
      syncUrl(final);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => void search(final), 400);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [router, search],
  );

  // Restore results for a shared/returned URL on first mount.
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void search(stateRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Cancel in-flight work (pending debounce + open request) on unmount.
  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      abortRef.current?.abort();
    },
    [],
  );

  const isAusbildung = state.goal === "ausbildung";
  const legacyLocation =
    state.location.trim().length > 0 && state.cities.length === 0;
  // Sidebar filter state only — the search terms (keyword/role/company, top
  // form) and the sort order (results toolbar) are NOT filters: "Clear
  // filters" must never wipe what the user typed or the order they chose.
  const activeFilterCount =
    (state.cities.length > 0 ? 1 : 0) +
    (state.freshness !== "any" ? 1 : 0) +
    (state.beginn !== "any" ? 1 : 0) +
    (state.salary !== "any" ? 1 : 0) +
    (state.contact_email !== "any" ? 1 : 0) +
    (state.employment !== "any" ? 1 : 0) +
    (state.training_type !== "any" ? 1 : 0) +
    (state.home_office !== "any" ? 1 : 0) +
    (legacyLocation ? 1 : 0);

  const clearFilters = () =>
    commitSearch((current) => ({
      ...current,
      // Keyword / role / company / sort / goal / match are preserved.
      location: "",
      cities: [],
      radius: null,
      distance_max: null,
      beginn: "any",
      freshness: "any",
      employment: "any",
      training_type: "any",
      home_office: "any",
      salary: "any",
      contact_email: "any",
    }));

  // --- View Details: double-click guard + bounded hover prefetch ----------
  const openDetails = useCallback(
    (opportunityId: string, href: string) => {
      if (openingIdRef.current) return; // a row is already opening
      openingIdRef.current = opportunityId;
      setOpeningId(opportunityId);
      router.push(href);
    },
    [router],
  );
  const hoverPrefetch = useCallback(
    (opportunityId: string, href: string) => {
      if (openingIdRef.current) return;
      if (prefetchedRef.current.size >= MAX_DETAIL_PREFETCHES) return;
      if (prefetchedRef.current.has(opportunityId)) return;
      prefetchedRef.current.add(opportunityId);
      void router.prefetch(href);
    },
    [router],
  );

  const maxReachable =
    mode === "scan" ? (total ?? 0) : Math.min(total ?? 0, SEARCH_SOURCE_LIMIT);
  const hasPrev = state.page > 1;
  const hasNext = state.page * PAGE_SIZE < maxReachable;

  const fromState = serializeSearchState(state);

  return (
    <div className="space-y-5">
      {/* ------------------------------------------------ search hero ---- */}
      {/* Dark premium hero (Bewerby reference): title + one big white search
          bar with the green circular submit + refinement fields. */}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          commitSearch((current) => current);
        }}
        className="relative overflow-hidden rounded-3xl bg-navy p-5 shadow-[var(--shadow-float)] sm:p-8"
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -end-20 -top-28 h-72 w-72 rounded-full bg-accent/25 blur-3xl"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-32 -start-16 h-64 w-64 rounded-full bg-white/5 blur-3xl"
        />
        <div className="relative">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div
              role="group"
              aria-label={t("pages.opportunities.title")}
              className="inline-flex rounded-full bg-white/10 p-1"
            >
              {(["ausbildung", "arbeit"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => commitSearch((current) => ({ ...current, goal: value }))}
                  aria-pressed={state.goal === value}
                  className={
                    state.goal === value
                      ? "rounded-full bg-white px-4 py-2 text-xs font-bold text-ink shadow-sm"
                      : "rounded-full px-4 py-2 text-xs font-semibold text-white/60 transition-colors hover:text-white"
                  }
                >
                  {t(value === "ausbildung" ? "dash.goalAusbildung" : "dash.goalArbeit")}
                </button>
              ))}
            </div>
            <Link
              href="/opportunities/saved"
              className="inline-flex items-center gap-1.5 text-xs font-bold text-white/70 transition-colors hover:text-white"
            >
              <Icon name="bookmark" size={14} />
              {t("pages.opportunitiesSaved.title")}
            </Link>
          </div>

          <h1 className="display-title mt-6 text-3xl text-white sm:text-4xl">
            {t("opp.hero.title")}
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-white/60">
            {t("opp.hero.subtitle")}
          </p>

          {/* Primary query row: one big white bar + the green circular CTA. */}
          <div className="mt-6 flex items-center gap-1.5 rounded-full bg-white p-1.5 shadow-lg">
            <Search
              size={18}
              strokeWidth={2}
              aria-hidden="true"
              className="pointer-events-none ms-3 shrink-0 text-faint"
            />
            <input
              className="h-11 min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-faint"
              placeholder={t("search.ph.keyword")}
              value={state.keyword}
              maxLength={120}
              onChange={(event) =>
                scheduleSearch((current) => ({ ...current, keyword: event.target.value }))
              }
              aria-label={t("search.ph.keyword")}
            />
            <button
              type="submit"
              disabled={loading}
              aria-label={loading ? t("search.searching") : t("search.search")}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent text-white transition-colors hover:bg-accent-deep disabled:cursor-wait disabled:opacity-60"
            >
              <Icon name="arrowRight" size={18} className="rtl:-scale-x-100" />
            </button>
          </div>

          {/* Refinement fields: stacked on phones, side by side from sm. */}
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <input
              className="h-11 w-full rounded-2xl border border-white/15 bg-white/10 px-4 text-sm text-white outline-none transition-colors placeholder:text-white/40 focus:border-accent"
              placeholder={t("search.ph.role")}
              value={state.role}
              maxLength={120}
              onChange={(event) =>
                scheduleSearch((current) => ({ ...current, role: event.target.value }))
              }
              aria-label={t("search.ph.role")}
            />
            <input
              className="h-11 w-full rounded-2xl border border-white/15 bg-white/10 px-4 text-sm text-white outline-none transition-colors placeholder:text-white/40 focus:border-accent"
              placeholder={t("search.ph.company")}
              value={state.company}
              maxLength={160}
              onChange={(event) =>
                scheduleSearch((current) => ({ ...current, company: event.target.value }))
              }
              aria-label={t("search.ph.company")}
            />
          </div>
        </div>
      </form>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[300px_minmax(0,1fr)] lg:items-start lg:gap-6">
        {/* Mobile filter toggle — one wide pill, like the reference. */}
        <div className="lg:hidden">
          <button
            type="button"
            onClick={() => setShowMobileFilters((value) => !value)}
            aria-expanded={showMobileFilters}
            className="flex min-h-12 w-full items-center justify-between gap-2 rounded-2xl border border-line bg-surface px-4 py-3 text-sm font-bold text-ink shadow-[var(--shadow-card)]"
          >
            <span className="flex items-center gap-2">
              {t("opp.filterToggle")}
              {activeFilterCount > 0 && (
                <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1.5 text-[10px] font-bold text-white">
                  {activeFilterCount}
                </span>
              )}
            </span>
            <Icon
              name="chevron"
              size={16}
              className={`text-faint transition-transform ${showMobileFilters ? "rotate-180" : ""}`}
            />
          </button>
        </div>

        {/* Filter panel */}
        <aside
          className={`${
            showMobileFilters ? "block" : "hidden"
          } rounded-3xl border border-line bg-surface shadow-[var(--shadow-card)] lg:sticky lg:top-20 lg:block`}
        >
          <div className="flex items-center justify-between border-b border-line px-5 py-4">
            <span className="text-sm font-bold text-ink">{t("search.filters")}</span>
            <div className="flex items-center gap-3">
              {activeFilterCount > 0 && (
                <button
                  type="button"
                  onClick={clearFilters}
                  className="text-xs font-bold text-accent transition-colors hover:text-accent-deep"
                >
                  {t("search.clear")}
                </button>
              )}
              <button
                type="button"
                onClick={() => setShowMobileFilters(false)}
                aria-label={t("common.close")}
                className="text-faint lg:hidden"
              >
                <Icon name="x" size={16} />
              </button>
            </div>
          </div>
          <div className="space-y-6 p-5">
            {/* Work place */}
            <FilterGroup title={t("search.workplace")}>
              <label className="flex cursor-pointer items-center gap-2 rounded-lg bg-surface-2 px-2 py-2 text-sm font-semibold text-ink-soft">
                <input
                  type="checkbox"
                  checked={state.cities.length === 0 && !legacyLocation}
                  onChange={() =>
                    // "Show all" = no location restriction: clears the city
                    // selection AND any legacy free-text location/radius from
                    // old shareable URLs — never the other filters, and
                    // distance_max too (it is only valid together with a
                    // location, so it cannot outlive the location it bounds).
                    commitSearch((current) => ({
                      ...current,
                      cities: [],
                      location: "",
                      radius: null,
                      distance_max: null,
                    }))
                  }
                  className="h-4 w-4 accent-accent"
                />
                {t("search.showAll")}
              </label>
              <div className="mt-1 max-h-56 space-y-0.5 overflow-y-auto pr-1">
                {WORKPLACE_CITIES.map((city) => {
                  const checked = state.cities.includes(city);
                  return (
                    <label
                      key={city}
                      className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-ink-soft transition hover:bg-surface-2"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() =>
                          commitSearch((current) => ({
                            ...current,
                            cities: checked
                              ? current.cities.filter((c) => c !== city)
                              : [...current.cities, city],
                          }))
                        }
                        className="h-4 w-4 accent-accent"
                      />
                      <span className="min-w-0 flex-1 truncate">{city}</span>
                    </label>
                  );
                })}
              </div>
            </FilterGroup>

            {/* Published since */}
            <FilterGroup title={t("search.publishedSince")}>
              <div className="space-y-0.5">
                <RadioRow
                  name="freshness"
                  checked={state.freshness === "any"}
                  onSelect={() =>
                    commitSearch((current) => ({
                      ...current,
                      freshness: "any",
                    }))
                  }
                  label={t("search.showAll")}
                  count={filterCounts?.freshness.any ?? null}
                  locale={locale}
                />
                {FRESHNESS_OPTIONS.map((option) => (
                  <RadioRow
                    key={option.value}
                    name="freshness"
                    checked={state.freshness === option.value}
                    onSelect={() =>
                      commitSearch((current) => ({
                        ...current,
                        freshness: option.value,
                      }))
                    }
                    label={t(option.key)}
                    count={filterCounts?.freshness[option.countKey] ?? null}
                    locale={locale}
                  />
                ))}
              </div>
            </FilterGroup>

            {/* Beginn */}
            <FilterGroup title={t("search.beginn")}>
              <div className="space-y-0.5">
                <RadioRow
                  name="beginn"
                  checked={state.beginn === "any"}
                  onSelect={() =>
                    commitSearch((current) => ({ ...current, beginn: "any" }))
                  }
                  label={t("search.showAll")}
                  count={filterCounts?.beginn.any ?? null}
                  locale={locale}
                />
                <RadioRow
                  name="beginn"
                  checked={state.beginn === "now"}
                  onSelect={() =>
                    commitSearch((current) => ({ ...current, beginn: "now" }))
                  }
                  label={t("search.fromNowOn")}
                  count={filterCounts?.beginn.from_now ?? null}
                  locale={locale}
                />
                {(filterCounts?.beginn.months ?? []).map((entry) => (
                  <RadioRow
                    key={entry.month}
                    name="beginn"
                    checked={state.beginn === entry.month}
                    onSelect={() =>
                      commitSearch((current) => ({
                        ...current,
                        beginn: entry.month,
                      }))
                    }
                    label={formatMonth(entry.month, locale)}
                    count={entry.count}
                    locale={locale}
                  />
                ))}
              </div>
            </FilterGroup>

            {/* Salary */}
            <FilterGroup
              title={
                isAusbildung ? t("search.trainingSalary") : t("search.salaryLabel")
              }
            >
              <div className="space-y-0.5">
                <RadioRow
                  name="salary"
                  checked={state.salary === "any"}
                  onSelect={() =>
                    commitSearch((current) => ({ ...current, salary: "any" }))
                  }
                  label={t("search.showAll")}
                  count={null}
                  locale={locale}
                />
                <RadioRow
                  name="salary"
                  checked={state.salary === "documented"}
                  onSelect={() =>
                    commitSearch((current) => ({
                      ...current,
                      salary: "documented",
                    }))
                  }
                  label={t("search.salary.documented")}
                  count={null}
                  locale={locale}
                />
                <RadioRow
                  name="salary"
                  checked={state.salary === "missing"}
                  onSelect={() =>
                    commitSearch((current) => ({ ...current, salary: "missing" }))
                  }
                  label={t("search.salary.missing")}
                  count={null}
                  locale={locale}
                />
              </div>
            </FilterGroup>

            {/* Contact email */}
            <FilterGroup title={t("search.contactEmail")}>
              <div className="space-y-0.5">
                <RadioRow
                  name="contactEmail"
                  checked={state.contact_email === "any"}
                  onSelect={() =>
                    commitSearch((current) => ({
                      ...current,
                      contact_email: "any",
                    }))
                  }
                  label={t("search.showAll")}
                  count={null}
                  locale={locale}
                />
                <RadioRow
                  name="contactEmail"
                  checked={state.contact_email === "available"}
                  onSelect={() =>
                    commitSearch((current) => ({
                      ...current,
                      contact_email: "available",
                    }))
                  }
                  label={t("search.emailAvailable")}
                  count={null}
                  locale={locale}
                />
              </div>
            </FilterGroup>

            {/* Employment / training type */}
            <FilterGroup title={t("search.employment.any")}>
              <select
                className="w-full rounded-2xl border border-line bg-surface px-3 py-2.5 text-sm text-ink shadow-sm outline-none focus:border-accent focus:ring-4 focus:ring-accent/10"
                value={state.employment}
                onChange={(event) =>
                  commitSearch((current) => ({
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
                  className="mt-3 w-full rounded-xl border border-line bg-surface px-3 py-2.5 text-sm text-ink outline-none focus:border-accent"
                  value={state.training_type}
                  onChange={(event) =>
                    commitSearch((current) => ({
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
            </FilterGroup>

            {/* Legacy location from an old shareable URL (not editable) */}
            {legacyLocation && (
              <div className="flex items-center justify-between gap-2 rounded-xl bg-surface-2 px-3 py-2 text-xs font-medium text-muted">
                <span className="min-w-0 truncate">
                  {t("search.locationChip", {
                    value:
                      state.radius !== null
                        ? `${state.location} (${state.radius} km)`
                        : state.location,
                  })}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    commitSearch((current) => ({
                      ...current,
                      location: "",
                      radius: null,
                      distance_max: null,
                    }))
                  }
                  className="shrink-0 font-bold text-accent hover:text-accent-deep"
                  aria-label={t("search.clear")}
                >
                  ✕
                </button>
              </div>
            )}
          </div>
        </aside>

        {/* Results column */}
        <div className="min-w-0">
          {/* Source notice — only when the official source actually degraded */}
          {sourceStatus && sourceStatus.status === "degraded" && !error && (
            <div className="mb-4 rounded-2xl bg-warning-soft px-4 py-3 text-sm font-medium text-warning">
              {t("search.sourcePartial")}
            </div>
          )}

          {error && (
            <div className="mb-4 rounded-2xl bg-danger-soft px-4 py-3 text-sm font-medium text-danger">
              <p>{error}</p>
              {sourceStatus?.retryable && (
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => void search(stateRef.current)}
                  className="mt-2 rounded-xl border border-danger/30 bg-surface px-3 py-1.5 text-xs font-bold text-danger transition hover:bg-danger/10 disabled:opacity-60"
                >
                  {t("search.retry")}
                </button>
              )}
            </div>
          )}

          {/* ------------------------------------ result summary -------- */}
          {results !== null && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <p className="flex items-baseline gap-2">
                  {total !== null && (
                    <span className="num text-3xl font-extrabold tracking-tight text-ink">
                      {total.toLocaleString(locale)}
                    </span>
                  )}
                  <span className="text-sm font-semibold text-muted">
                    {mode === "scan" && scanTruncated
                      ? t("search.resultsScanWindow", {
                          count: (total ?? 0).toLocaleString(locale),
                        })
                      : t("opp.resultsWord")}
                  </span>
                </p>

                <div className="flex flex-wrap items-center gap-2">
                  {searchEntitlement ? (
                    <QuotaIndicator
                      data={quotaDataFromEntitlement(searchEntitlement)}
                      unit={t("quota.unitSearches")}
                      resetLabel={t("quota.resetsDaily")}
                      labels={makeQuotaLabels(t)}
                      upgradeHint={t("quota.upgrade")}
                    />
                  ) : null}
                  {mode === "scan" && scanTruncated && (
                    <span className="rounded-full bg-warning-soft px-3 py-1.5 text-[11px] font-semibold text-warning">
                      {t("search.scanTruncated")}
                    </span>
                  )}
                </div>
              </div>

              {mode === "upstream" && total !== null && total >= SEARCH_SOURCE_LIMIT && (
                <p className="text-xs text-faint">
                  {t("search.sourceLimit", {
                    count: SEARCH_SOURCE_LIMIT.toLocaleString(locale),
                  })}
                </p>
              )}

              <div className="flex flex-wrap items-center gap-2">
                {/* Application type. Only options the backend genuinely
                    supports are offered: "All" and "Email" (the existing
                    contact_email filter). There is no server-side "form"
                    filter, so no third tab is invented. */}
                <div
                  role="group"
                  aria-label={t("opp.typeLabel")}
                  className="inline-flex items-center gap-1 rounded-full border border-line bg-surface p-1"
                >
                  {(
                    [
                      { value: "any", label: t("opp.all"), icon: "grid" as IconName },
                      { value: "available", label: t("opp.email"), icon: "mail" as IconName },
                    ] as const
                  ).map((tab) => {
                    const active =
                      tab.value === "any"
                        ? state.contact_email === "any"
                        : state.contact_email === "available";
                    return (
                      <button
                        key={tab.value}
                        type="button"
                        aria-pressed={active}
                        onClick={() =>
                          commitSearch((current) => ({
                            ...current,
                            contact_email: tab.value,
                          }))
                        }
                        className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-bold transition-colors ${
                          active
                            ? "bg-navy text-white"
                            : "text-muted hover:text-ink"
                        }`}
                      >
                        <Icon name={tab.icon} size={13} />
                        {tab.label}
                        {/* The badge carries the REAL current total — no
                            per-type counts exist in the response, so no
                            fabricated number is shown on the Email tab. */}
                        {tab.value === "any" && total !== null && (
                          <span
                            className={`num rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
                              active
                                ? "bg-white/20 text-white"
                                : "bg-surface-2 text-faint"
                            }`}
                          >
                            {compactCount(total, locale)}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>

                {state.match && !matchAvailable && (
                  <Link
                    href="/bewerbung-scanner"
                    className="rounded-full bg-warning-soft px-3 py-1.5 text-[11px] font-bold text-warning"
                  >
                    {t("search.matchUnavailable")}
                  </Link>
                )}

                <select
                  className="h-9 rounded-full border border-line bg-surface px-3 text-xs font-bold text-ink outline-none transition-colors focus:border-accent"
                  value={state.sort}
                  onChange={(event) =>
                    commitSearch((current) => ({
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
                      disabled={
                        (option.value === "match" && !state.match) ||
                        (option.value === "distance" && !state.location)
                      }
                    >
                      {t(option.key)}
                    </option>
                  ))}
                </select>

                <label className="flex h-9 cursor-pointer items-center gap-2 rounded-full border border-line bg-surface px-3 text-xs font-semibold text-muted">
                  <input
                    type="checkbox"
                    checked={state.match}
                    onChange={(event) =>
                      commitSearch((current) => ({
                        ...current,
                        match: event.target.checked,
                        sort:
                          event.target.checked || current.sort !== "match"
                            ? current.sort
                            : "relevance",
                      }))
                    }
                    className="h-3.5 w-3.5 accent-accent"
                  />
                  {t("search.matchToggle")}
                </label>
              </div>
            </div>
          )}

          {/* Results */}
          <div
            className={`mt-4 space-y-4 transition-opacity ${
              loading && results !== null && results.length > 0
                ? "pointer-events-none opacity-50"
                : ""
            }`}
          >
            {loading && (results === null || results.length === 0) && (
              <div
                className="space-y-3"
                role="status"
                aria-label={t("search.loading")}
              >
                {[0, 1, 2].map((index) => (
                  <div
                    key={index}
                    className="surface-elevated rounded-3xl p-5"
                  >
                    <div className="flex gap-2">
                      <Skeleton className="h-5 w-16 rounded-full" />
                      <Skeleton className="h-5 w-24 rounded-full" />
                    </div>
                    <Skeleton className="mt-4 h-6 w-2/3" />
                    <Skeleton className="mt-2 h-4 w-1/2" />
                    <Skeleton className="mt-4 h-9 w-36 rounded-2xl" />
                  </div>
                ))}
              </div>
            )}
            {!loading && results !== null && results.length === 0 && (
              <EmptyState icon="search" title={t("search.none")} />
            )}
            {results?.map((opportunity) => {
              const detailHref =
                `/opportunities/${encodeURIComponent(opportunity.id)}` +
                (fromState ? `?from=${encodeURIComponent(fromState)}` : "");
              const company = opportunity.company_name || t("search.companyNotListed");
              const isSaved = savedIds.has(opportunity.id);
              const meta = [
                formatDay(opportunity.posted_at, locale)
                  ? t("search.posted", { date: formatDay(opportunity.posted_at, locale) ?? "" })
                  : null,
                formatDay(opportunity.valid_from, locale)
                  ? t("search.start", { date: formatDay(opportunity.valid_from, locale) ?? "" })
                  : null,
              ]
                .filter(Boolean)
                .join(" · ");

              return (
                <article
                  key={opportunity.id}
                  className="group relative rounded-3xl border border-line bg-surface p-4 shadow-[var(--shadow-card)] transition-[transform,box-shadow,border-color] duration-300 hover:-translate-y-0.5 hover:border-accent/30 hover:shadow-[var(--shadow-float)] sm:p-5"
                >
                  {/* Bookmark floats in the corner so the company row and the
                      German job title get the full card width. */}
                  <div className="absolute end-3 top-3 z-10">
                    <SaveOpportunityButton
                      opportunityKey={opportunity.id}
                      initialSaved={false}
                      compact
                      onSavedChange={markSaved(opportunity.id)}
                    />
                  </div>
                  {/* Avatar: company initials — turns into the saved-state
                      brand gradient with a bookmark icon (reference look). */}
                  <div className="flex min-w-0 items-center gap-3.5 pe-12">
                    <span
                      aria-hidden="true"
                      className={`flex h-13 w-13 shrink-0 items-center justify-center rounded-2xl transition-colors duration-300 ${
                        isSaved ? "text-white" : "bg-accent-soft text-accent"
                      }`}
                      style={isSaved ? { backgroundImage: "var(--gradient-neon)" } : undefined}
                    >
                      {isSaved ? (
                        <Icon name="bookmark" size={20} />
                      ) : (
                        <span className="text-sm font-extrabold">{initials(company)}</span>
                      )}
                    </span>
                    <p className="min-w-0 truncate text-sm font-bold text-ink">{company}</p>
                  </div>
                  <h2 className="mt-2.5 break-words text-[15px] font-semibold leading-6 text-ink transition-colors group-hover:text-accent sm:text-base">
                    {opportunity.title}
                  </h2>

                  <div className="mt-3 flex flex-wrap items-center gap-1.5">
                    {/* Application-type indicators first (reference: "Online
                        form" chip) — derived from real per-opportunity data. */}
                    {opportunity.application_url && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-accent">
                        <Icon name="file" size={11} />
                        {t("opp.typeOnline")}
                      </span>
                    )}
                    {opportunity.contact?.email && (
                      <span className="inline-flex items-center gap-1 rounded-full border border-line-strong bg-surface px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-muted">
                        <Icon name="mail" size={11} />
                        {t("opp.typeEmail")}
                      </span>
                    )}
                    {opportunity.profession && (
                      <span className="rounded-full border border-line-strong bg-surface px-2.5 py-1 text-[10px] font-bold text-muted">
                        {opportunity.profession}
                      </span>
                    )}
                    {opportunity.salary?.label && (
                      <span className="rounded-full bg-success-soft px-2.5 py-1 text-[10px] font-bold text-success">
                        {opportunity.salary.label}
                      </span>
                    )}
                    {opportunity.employment_type && (
                      <span className="rounded-full bg-surface-2 px-2.5 py-1 text-[10px] font-bold text-muted">
                        {opportunity.employment_type}
                      </span>
                    )}
                    {opportunity.home_office === true && (
                      <span className="rounded-full bg-surface-2 px-2.5 py-1 text-[10px] font-bold text-muted">
                        {t("search.homeOfficeBadge")}
                      </span>
                    )}
                    {opportunity.career_change_friendly === true && (
                      <span className="rounded-full bg-success-soft px-2.5 py-1 text-[10px] font-bold text-success">
                        {t("search.careerChanger")}
                      </span>
                    )}
                    {opportunity.training_type &&
                      !(
                        opportunity.goal === "ausbildung" &&
                        opportunity.training_type === "AUSBILDUNG"
                      ) && (
                        <span className="rounded-full bg-ai-soft px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-ai">
                          {opportunity.training_type.toLowerCase().replaceAll("_", " ")}
                        </span>
                      )}
                  </div>

                  <div className="mt-4 flex flex-wrap items-end justify-between gap-3 border-t border-line pt-3">
                    <div className="min-w-0">
                      <p className="flex items-center gap-1.5 text-xs font-semibold text-ink-soft">
                        <Pin size={13} strokeWidth={2} aria-hidden="true" className="shrink-0 text-faint" />
                        <span className="truncate">
                          {opportunity.location || t("search.locationNotListed")}
                        </span>
                        {opportunity.distance_km !== null && (
                          <span className="shrink-0 text-faint">· {opportunity.distance_km} km</span>
                        )}
                      </p>
                      {meta && <p className="mt-1 truncate text-[11px] text-faint">{meta}</p>}
                    </div>

                    <div className="flex shrink-0 items-center gap-1.5">
                      <a
                        href={opportunity.application_url ?? opportunity.source_url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex min-h-9 items-center gap-1 rounded-full px-3 py-2 text-xs font-bold text-ink-soft transition-colors hover:bg-surface-2 hover:text-ink"
                      >
                        {t("search.apply")}
                        <Icon name="arrowRight" size={12} className="rtl:-scale-x-100" />
                      </a>
                      <ViewDetailsButton
                        href={detailHref}
                        opportunityId={opportunity.id}
                        openingId={openingId}
                        onOpen={openDetails}
                        onHoverPrefetch={hoverPrefetch}
                        t={t}
                      />
                    </div>
                  </div>

                  {opportunity.match && (
                    <div className="mt-3 rounded-2xl bg-surface-2 p-3.5">
                      {opportunity.match.status === "complete" ? (
                        <>
                          {opportunity.match.score !== null && (
                            <p className="text-xs font-bold text-accent">
                              {t("search.match", { score: opportunity.match.score })}
                            </p>
                          )}
                          <ul className="mt-1 space-y-0.5 text-xs text-muted">
                            {opportunity.match.reasons.slice(0, 3).map((line, index) => (
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
                            {opportunity.match.missing_information.slice(0, 2).map((line, index) => (
                              <li key={index}>△ {line}</li>
                            ))}
                          </ul>
                        </>
                      )}
                    </div>
                  )}
                </article>
              );
            })}
          </div>

          {/* Pagination */}
          {results !== null && results.length > 0 && (
            <div className="mt-6 flex items-center justify-center gap-2">
              <button
                type="button"
                disabled={!hasPrev || loading}
                onClick={() =>
                  commitSearch((current) => ({ ...current, page: current.page - 1 }), false)
                }
                aria-label={t("search.previous")}
                className="inline-flex h-11 items-center gap-1.5 rounded-full border border-line bg-surface px-4 text-sm font-bold text-ink transition-colors hover:border-accent/40 hover:text-accent disabled:opacity-40"
              >
                <Icon name="chevronLeft" size={15} className="rtl:hidden" />
                <Icon name="chevronRight" size={15} className="hidden rtl:block" />
                <span className="hidden sm:inline">{t("search.previous")}</span>
              </button>
              <span className="num rounded-full bg-surface-2 px-4 py-2.5 text-xs font-bold text-muted">
                {t("search.page", {
                  page: state.page,
                  total: Math.max(1, Math.ceil(maxReachable / PAGE_SIZE)),
                })}
              </span>
              <button
                type="button"
                disabled={!hasNext || loading}
                onClick={() =>
                  commitSearch((current) => ({ ...current, page: current.page + 1 }), false)
                }
                aria-label={t("search.next")}
                className="inline-flex h-11 items-center gap-1.5 rounded-full border border-line bg-surface px-4 text-sm font-bold text-ink transition-colors hover:border-accent/40 hover:text-accent disabled:opacity-40"
              >
                <span className="hidden sm:inline">{t("search.next")}</span>
                <Icon name="chevronRight" size={15} className="rtl:hidden" />
                <Icon name="chevronLeft" size={15} className="hidden rtl:block" />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
