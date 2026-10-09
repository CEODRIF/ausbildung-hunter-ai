"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { Icon } from "@/components/icon";
import { Button } from "@/components/ui";
import { isVerifiedListing } from "@/lib/housing/types";
import type { HousingListing, HousingSearchParams } from "@/lib/housing/types";
import { ListingCard, listingSourceLabel, type WebSearchDomain } from "./listing-card";
import { ListingDetailModal } from "./listing-detail";

/**
 * On-demand live web search for housing listings (Azure AI Foundry
 * `web_search` — the ONLY listing source on this surface, no demo data).
 *
 *  - Runs only on explicit user click (cost control: each run spends up to
 *    two paid search calls) and reuses the current filter values.
 *  - Results render as professional cards; clicking a card opens the
 *    INTERNAL detail view with everything we genuinely obtained.
 *  - Every result carries its original source link, an honest provenance
 *    badge (never a false "verified" claim) and a last-checked timestamp.
 *  - The Bing attribution line is ALWAYS rendered below web results
 *    (Grounding with Bing enterprise terms).
 *  - Filters that can be evaluated from the data are applied consistently
 *    after the search (see applyClientFilters); values the search cannot
 *    determine are kept, never faked — and the UI says which filters are
 *    only advisory (provenance note).
 */

type Mode = "web" | "targeted";
type Status =
  | "ok"
  | "not_configured"
  | "tool_blocked"
  | "endpoint_unavailable"
  | "rate_limited"
  | "daily_quota_exhausted"
  | "quota_unavailable"
  | "provider_error"
  | "timeout";

/** The user's per-day search allowance (server-side source of truth). */
interface QuotaInfo {
  limit: number;
  used: number;
  remaining: number;
  /** Europe/Berlin calendar day ("YYYY-MM-DD"). */
  usageDate: string;
  /** ISO instant of the next reset (next Berlin midnight). */
  resetsAt: string;
}

interface SearchFunnel {
  providerCalls: number;
  webSearchCalls: number;
  rawCandidates: number;
  uniqueCandidates: number;
  invalidUrls: number;
  searchPagesRejected: number;
  cityMismatches: number;
  duplicateResults: number;
  offAllowlist: number;
  jsonItems: number;
  jsonMatched: number;
  fabricatedRejected: number;
  detailsEnriched: number;
  validListings: number;
  displayedListings: number;
  elapsedMs: number;
}

interface WebSearchOutcome {
  status: Status;
  message: string | null;
  provider: "azure" | null;
  mode: Mode;
  listings: HousingListing[];
  citations: Array<{ url: string; title: string }>;
  queries: string[];
  stats: { searchCalls: number; pagesFetched: number; bingRequests: number | null };
  funnel: SearchFunnel;
  warnings: string[];
  cached: boolean;
  fetchedAt: string;
  quota: QuotaInfo | null;
}

/** The subset of the filter set the web-search API accepts. */
function pickParams(p: HousingSearchParams): Record<string, unknown> {
  return {
    city: p.city,
    postal_code: p.postal_code,
    radius_km: p.radius_km,
    max_warm_rent: p.max_warm_rent,
    accommodation_type: p.accommodation_type,
    rooms: p.rooms,
    min_area_sqm: p.min_area_sqm,
    available_before: p.available_before,
  };
}

/**
 * Client-side filter application AFTER the search — consistent, and honest
 * about what the data allows:
 *  - boolean toggles exclude listings that are DEFINITIVELY non-matching
 *    (furnished=false, wg_suitable=false, pets_allowed!==true, unverified);
 *  - numeric caps exclude listings whose KNOWN value violates them; a
 *    listing whose rent/rooms/area the search did not determine is KEPT
 *    (unknown is not a violation) — the detail view shows "Nicht verfügbar".
 * Pure + exported for tests.
 */
export function applyClientFilters(
  listings: HousingListing[],
  params: Pick<
    HousingSearchParams,
    | "furnished_only"
    | "wg_suitable_only"
    | "pets_allowed_only"
    | "verified_only"
    | "max_warm_rent"
    | "rooms"
    | "min_area_sqm"
    | "available_before"
  >,
): HousingListing[] {
  return listings.filter((l) => {
    if (params.furnished_only && !l.furnished) return false;
    if (params.wg_suitable_only && !l.wg_suitable) return false;
    if (params.pets_allowed_only && l.pets_allowed !== true) return false;
    if (params.verified_only && !isVerifiedListing(l)) return false;
    if (params.max_warm_rent != null && l.rent_warm_eur != null && l.rent_warm_eur > params.max_warm_rent) {
      return false;
    }
    if (params.rooms !== "all" && l.rooms != null && l.rooms !== params.rooms) return false;
    if (params.min_area_sqm != null && l.living_area_sqm != null && l.living_area_sqm < params.min_area_sqm) {
      return false;
    }
    if (
      params.available_before &&
      l.available_from != null &&
      l.available_from > params.available_before
    ) {
      return false;
    }
    return true;
  });
}

export function HousingWebSearch({ params }: { params: HousingSearchParams }) {
  const { t, lang } = useI18n();
  const [domains, setDomains] = useState<WebSearchDomain[]>([]);
  const [mode, setMode] = useState<Mode>("web");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [phase, setPhase] = useState<"idle" | "loading" | "done">("idle");
  const [outcome, setOutcome] = useState<WebSearchOutcome | null>(null);
  const [httpError, setHttpError] = useState<Status | null>(null);
  const [quota, setQuota] = useState<QuotaInfo | null>(null);
  const [openListing, setOpenListing] = useState<HousingListing | null>(null);
  /** Seconds to wait before a retry after a 429 (server retry-after). */
  const [rateLimitWait, setRateLimitWait] = useState<number | null>(null);

  // The allowlist and the per-user daily quota are served by the API (single
  // source of truth, server-side — the browser can never inflate its own
  // allowance).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [res, quotaRes] = await Promise.all([
          fetch("/api/housing/web-search/domains"),
          fetch("/api/housing/web-search"),
        ]);
        if (res.ok) {
          const data = (await res.json()) as { domains?: WebSearchDomain[] };
          if (!cancelled && data.domains) {
            setDomains(data.domains);
            // Default: all reviewed websites selected.
            setSelected(new Set(data.domains.map((d) => d.domain)));
          }
        }
        if (quotaRes.ok) {
          const q = (await quotaRes.json()) as { quota?: QuotaInfo | null };
          if (!cancelled && q.quota) setQuota(q.quota);
        }
      } catch {
        /* non-fatal: the run path re-checks everything server-side */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const run = useCallback(async () => {
    setPhase("loading");
    setHttpError(null);
    setOpenListing(null);
    try {
      // Idempotency key for THIS run: an accidental duplicate/resend with
      // the same id is never charged twice server-side; a genuinely new
      // search gets a new id.
      const requestId = crypto.randomUUID();
      const res = await fetch("/api/housing/web-search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode,
          params: pickParams(params),
          ...(mode === "targeted" && selected.size > 0 ? { domains: [...selected] } : {}),
          request_id: requestId,
        }),
      });
      if (res.status === 429) {
        const ra = Number(res.headers.get("retry-after") ?? "0");
        setRateLimitWait(Number.isFinite(ra) && ra > 0 ? ra : null);
        setPhase("done");
        setHttpError("rate_limited");
        return;
      }
      setRateLimitWait(null);
      if (!res.ok) {
        setPhase("done");
        setHttpError("provider_error");
        return;
      }
      const data = (await res.json()) as WebSearchOutcome;
      setPhase("done");
      setOutcome(data);
      if (data.quota) setQuota(data.quota);
    } catch {
      setPhase("done");
      setHttpError("provider_error");
    }
  }, [mode, params, selected]);

  const toggleDomain = (d: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(d)) next.delete(d);
      else next.add(d);
      return next;
    });
  };

  const status: Status | null = httpError ?? outcome?.status ?? null;
  const rawListings = useMemo(
    () => (outcome?.status === "ok" ? outcome.listings : []),
    [outcome],
  );
  // Consistent post-search filter application (honest: unknown values kept).
  const listings = useMemo(() => applyClientFilters(rawListings, params), [rawListings, params]);
  const filteredOut = rawListings.length - listings.length;

  const hasWarnings =
    outcome?.status === "ok" &&
    outcome.warnings.some((w) =>
      [
        "fetch_failed",
        "robots_blocked",
        "robots_unknown",
        "unsafe_url_skipped",
        "expired_listing_discarded",
        "second_call_failed",
        "json_truncated_salvaged",
      ].some((prefix) => w.startsWith(prefix)),
    );

  const stateKey:
    | "stateNotConfigured"
    | "stateToolBlocked"
    | "stateEndpoint"
    | "stateRateLimited"
    | "stateDailyQuota"
    | "stateQuotaUnavailable"
    | "stateProviderError"
    | "stateTimeout"
    | null =
    status === "not_configured"
      ? "stateNotConfigured"
      : status === "tool_blocked"
        ? "stateToolBlocked"
        : status === "endpoint_unavailable"
          ? "stateEndpoint"
          : status === "rate_limited"
            ? "stateRateLimited"
            : status === "daily_quota_exhausted"
              ? "stateDailyQuota"
              : status === "quota_unavailable"
                ? "stateQuotaUnavailable"
                : status === "timeout"
                  ? "stateTimeout"
                  : status === "provider_error"
                    ? "stateProviderError"
                    : null;

  /** Server-declared reset time (next Berlin midnight), formatted for display. */
  const resetsAt = quota?.resetsAt ?? outcome?.quota?.resetsAt ?? null;
  const resetTime = formatResetsAt(resetsAt, lang);
  const quotaExhausted = quota !== null && quota.remaining <= 0;

  /** Count-only funnel diagnostics: something was dropped, so say so. */
  const funnel = outcome?.funnel;
  const funnelDropped =
    (funnel?.duplicateResults ?? 0) +
      (funnel?.searchPagesRejected ?? 0) +
      (funnel?.offAllowlist ?? 0) +
      (funnel?.invalidUrls ?? 0) +
      (funnel?.fabricatedRejected ?? 0) +
      (funnel?.cityMismatches ?? 0) >
    0;

  /** Concrete cause for an empty result set, when the funnel proves one
   *  (task: never a generic empty message when the evidence says why). */
  const emptyCause =
    outcome?.status === "ok" && rawListings.length === 0
      ? funnel && funnel.cityMismatches > 0
        ? t("housing.webSearch.emptyCityMismatch", { n: funnel.cityMismatches })
        : funnel && (funnel.uniqueCandidates ?? 0) > 0
          ? t("housing.webSearch.emptyFiltered", {
              n: funnel.uniqueCandidates,
              pages: funnel.searchPagesRejected,
              dups: funnel.duplicateResults,
            })
          : funnel && (funnel.webSearchCalls ?? 0) === 0
            ? t("housing.webSearch.emptyNoSearchCall")
            : null
      : null;

  return (
    <section className="rounded-3xl border border-line bg-surface p-5 shadow-[var(--shadow-card)]">
      {/* header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-accent-soft text-accent">
            <Icon name="globe" size={19} strokeWidth={1.7} />
          </span>
          <div>
            <h2 className="text-sm font-bold text-ink">{t("housing.webSearch.title")}</h2>
            <p className="mt-0.5 max-w-xl text-xs text-muted">{t("housing.webSearch.subtitle")}</p>
          </div>
        </div>

        {/* mode switch */}
        <div className="flex rounded-2xl border border-line-strong bg-surface-2 p-1">
          {(["web", "targeted"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`rounded-xl px-3 py-1.5 text-xs font-semibold transition-colors ${
                mode === m ? "bg-surface text-accent shadow-sm" : "text-muted hover:text-ink"
              }`}
            >
              {m === "web" ? t("housing.webSearch.modeWeb") : t("housing.webSearch.modeTargeted")}
            </button>
          ))}
        </div>
      </div>

      {mode === "targeted" && domains.length > 0 && (
        <div className="mt-4">
          <p className="mb-2 text-xs font-bold tracking-wide text-faint uppercase">
            {t("housing.webSearch.domainsTitle")}
          </p>
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
            {domains.map((d) => (
              <label
                key={d.domain}
                className={`flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-xs transition-colors ${
                  selected.has(d.domain)
                    ? "border-accent/40 bg-accent-soft"
                    : "border-line bg-surface hover:bg-surface-2"
                }`}
              >
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-(--glow-accent)"
                  checked={selected.has(d.domain)}
                  onChange={() => toggleDomain(d.domain)}
                />
                <span className="min-w-0 flex-1 truncate font-semibold text-ink" title={d.domain}>
                  {d.label}
                </span>
                <span className="shrink-0 text-[10px] font-medium text-faint">
                  {d.fetchable ? t("housing.webSearch.hintFetchable") : t("housing.webSearch.hintSearchOnly")}
                </span>
              </label>
            ))}
          </div>
        </div>
      )}

      {/* run control */}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          disabled={phase === "loading" || quotaExhausted}
          onClick={() => void run()}
        >
          {phase === "loading" ? (
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
          ) : (
            <Icon name="search" size={14} strokeWidth={2} />
          )}
          {phase === "loading" ? t("housing.webSearch.running") : t("housing.webSearch.run")}
        </Button>
        <p className="text-[11px] text-faint">{t("housing.webSearch.costNote")}</p>
        {quota &&
          (quota.remaining > 0 ? (
            <p className="text-[11px] font-semibold text-ink-soft">
              {t("housing.webSearch.remainingToday", {
                remaining: quota.remaining,
                limit: quota.limit,
              })}
            </p>
          ) : (
            <p className="rounded-xl bg-warning-soft px-2.5 py-1 text-[11px] font-semibold text-warning">
              {t("housing.webSearch.quotaExhausted", {
                limit: quota.limit,
                time: resetTime,
              })}
            </p>
          ))}
      </div>

      {/* results */}
      {phase === "done" && (
        <div className="mt-5 space-y-3">
          {stateKey && (
            <div className="flex items-start gap-3 rounded-2xl border border-line-strong bg-surface-2 p-4 text-sm text-muted">
              <Icon name="alert" size={16} strokeWidth={2} className="mt-0.5 shrink-0 text-faint" />
              <div className="flex-1">
                <p>
                  {stateKey === "stateDailyQuota"
                    ? t("housing.webSearch.stateDailyQuota", { time: resetTime })
                    : t(`housing.webSearch.${stateKey}`)}
                </p>
                {status === "rate_limited" && rateLimitWait !== null && (
                  <p className="mt-1 text-xs text-faint">
                    {t("housing.webSearch.rateLimitHint", { seconds: rateLimitWait })}
                  </p>
                )}
                {status === "rate_limited" || status === "provider_error" || status === "timeout" ? (
                  <Button variant="secondary" size="sm" className="mt-2" onClick={() => void run()}>
                    {t("common.retry")}
                  </Button>
                ) : null}
              </div>
            </div>
          )}

          {status === "ok" && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-bold text-ink">
                  {t("housing.webSearch.results", { n: listings.length })}
                  {outcome?.cached && <span className="ms-2 text-xs font-medium text-faint">{t("housing.webSearch.cached")}</span>}
                </p>
                {outcome && outcome.stats.pagesFetched > 0 && (
                  <p className="text-[11px] text-faint">
                    {t("housing.webSearch.checkedCount", { n: outcome.stats.pagesFetched })}
                  </p>
                )}
              </div>

              {filteredOut > 0 && (
                <p className="rounded-2xl bg-surface-2 p-3 text-xs text-muted">
                  {t("housing.webSearch.matchesFilters", { shown: listings.length, total: rawListings.length })}
                </p>
              )}

              {hasWarnings && (
                <p className="flex items-start gap-1.5 rounded-2xl bg-surface-2 p-3 text-xs text-muted">
                  <Icon name="alert" size={13} strokeWidth={2} className="mt-0.5 shrink-0 text-faint" />
                  {t("housing.webSearch.warningPartial")}
                </p>
              )}

              {listings.length === 0 && rawListings.length > 0 ? (
                <div className="flex flex-col items-center justify-center rounded-3xl border border-dashed border-line-strong bg-surface/60 p-10 text-center">
                  <Icon name="search" size={28} strokeWidth={1.5} className="text-faint" />
                  <p className="mt-3 max-w-md text-sm font-semibold text-ink">
                    {t("housing.webSearch.filtersEmpty", { total: rawListings.length })}
                  </p>
                </div>
              ) : listings.length === 0 ? (
                <div className="flex flex-col items-center justify-center rounded-3xl border border-dashed border-line-strong bg-surface/60 p-10 text-center">
                  <Icon name="search" size={28} strokeWidth={1.5} className="text-faint" />
                  <p className="mt-3 max-w-md text-sm font-semibold text-ink">
                    {t("housing.webSearch.empty")}
                  </p>
                  {emptyCause && (
                    <p className="mt-2 max-w-md text-xs text-muted">{emptyCause}</p>
                  )}
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                    {listings.map((l) => (
                      <ListingCard
                        key={l.source_id}
                        listing={l}
                        sourceLabel={listingSourceLabel(l, domains)}
                        onOpen={setOpenListing}
                      />
                    ))}
                  </div>

                  {/* safe count-only diagnostics when results were dropped */}
                  {funnelDropped && funnel && (
                    <p className="text-[11px] text-faint">
                      {t("housing.webSearch.funnel", {
                        shown: funnel.displayedListings,
                        retrieved: funnel.uniqueCandidates,
                      })}
                    </p>
                  )}
                </>
              )}

              {/* honest provider-coverage limitation */}
              {rawListings.length > 0 && (
                <p className="text-[11px] leading-5 text-faint">{t("housing.webSearch.coverageNote")}</p>
              )}

              {/* Required attribution: these are internet search results. */}
              <p className="flex items-start gap-1.5 rounded-2xl bg-surface-2 p-3 text-[11px] leading-5 text-faint">
                <Icon name="globe" size={12} strokeWidth={2} className="mt-0.5 shrink-0" />
                {t("housing.webSearch.attribution")}
              </p>
            </>
          )}
        </div>
      )}

      {/* internal detail view */}
      {openListing && (
        <ListingDetailModal
          listing={openListing}
          domains={domains}
          onClose={() => setOpenListing(null)}
        />
      )}
    </section>
  );
}

/** The quota resets at the next Europe/Berlin midnight (server-anchored);
 *  format that wall-clock time in the user's UI language. */
function formatResetsAt(iso: string | null, lang: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat(lang, {
    timeZone: "Europe/Berlin",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}
