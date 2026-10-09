"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { Icon } from "@/components/icon";
import { Button } from "@/components/ui";
import { formatEur } from "@/lib/housing/affordability";
import type { HousingListing, HousingSearchParams } from "@/lib/housing/types";

/**
 * On-demand live web search for housing listings.
 *
 * Deliberately SEPARATE from the (demo) fixture search above it:
 *  - It only runs on an explicit user click — never automatically (cost
 *    control: every run spends a small paid search call).
 *  - It reuses the CURRENT filter values of the main search.
 *  - Every result carries its ORIGINAL source link, a verification badge
 *    ("Seite geprüft" only when a fetched page supplied structured facts,
 *    "Aus Suchtreffer" for explicit snippet facts, "Nur entdeckt" otherwise)
 *    and a last-checked timestamp. Unknown fields are shown as "—", never
 *    invented.
 *  - The Bing attribution line is ALWAYS rendered below web results
 *    (Grounding with Bing enterprise terms: search results must be indicated
 *    and references displayed to the end user).
 */

type Mode = "web" | "targeted";
type Status =
  | "ok"
  | "not_configured"
  | "tool_blocked"
  | "endpoint_unavailable"
  | "rate_limited"
  | "daily_budget_exhausted"
  | "provider_error"
  | "timeout";

interface WebSearchDomain {
  domain: string;
  label: string;
  fetchable: boolean;
}

interface WebSearchOutcome {
  status: Status;
  message: string | null;
  provider: "azure" | "tavily" | null;
  mode: Mode;
  listings: HousingListing[];
  citations: Array<{ url: string; title: string }>;
  queries: string[];
  stats: { searchCalls: number; pagesFetched: number; bingRequests: number | null };
  warnings: string[];
  cached: boolean;
  fetchedAt: string;
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

function domainLabel(domain: string, domains: WebSearchDomain[]): string {
  return domains.find((d) => d.domain === domain)?.label ?? domain;
}

export function HousingWebSearch({ params }: { params: HousingSearchParams }) {
  const { t } = useI18n();
  const [domains, setDomains] = useState<WebSearchDomain[]>([]);
  const [mode, setMode] = useState<Mode>("web");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [phase, setPhase] = useState<"idle" | "loading" | "done">("idle");
  const [outcome, setOutcome] = useState<WebSearchOutcome | null>(null);
  const [httpError, setHttpError] = useState<Status | null>(null);

  // The allowlist is served by the API (single source of truth, server-side).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/housing/web-search/domains");
        if (!res.ok) return;
        const data = (await res.json()) as { domains?: WebSearchDomain[] };
        if (cancelled || !data.domains) return;
        setDomains(data.domains);
        // Default: all reviewed websites selected.
        setSelected(new Set(data.domains.map((d) => d.domain)));
      } catch {
        /* non-fatal: targeted mode simply shows no picker */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const run = useCallback(async () => {
    setPhase("loading");
    setHttpError(null);
    try {
      const res = await fetch("/api/housing/web-search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode,
          params: pickParams(params),
          ...(mode === "targeted" && selected.size > 0 ? { domains: [...selected] } : {}),
        }),
      });
      if (res.status === 429) {
        setPhase("done");
        setHttpError("rate_limited");
        return;
      }
      if (!res.ok) {
        setPhase("done");
        setHttpError("provider_error");
        return;
      }
      const data = (await res.json()) as WebSearchOutcome;
      setPhase("done");
      setOutcome(data);
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
  const listings = outcome?.status === "ok" ? outcome.listings : [];
  const hasWarnings =
    outcome?.status === "ok" &&
    outcome.warnings.some((w) =>
      ["fetch_failed", "robots_blocked", "robots_unknown", "unsafe_url_skipped", "expired_listing_discarded"].some(
        (prefix) => w.startsWith(prefix),
      ),
    );

  const stateKey:
    | "stateNotConfigured"
    | "stateToolBlocked"
    | "stateEndpoint"
    | "stateRateLimited"
    | "stateDailyBudget"
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
            : status === "daily_budget_exhausted"
              ? "stateDailyBudget"
              : status === "timeout"
                ? "stateTimeout"
                : status === "provider_error"
                  ? "stateProviderError"
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
        <Button size="sm" disabled={phase === "loading"} onClick={() => void run()}>
          {phase === "loading" ? (
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
          ) : (
            <Icon name="search" size={14} strokeWidth={2} />
          )}
          {phase === "loading" ? t("housing.webSearch.running") : t("housing.webSearch.run")}
        </Button>
        <p className="text-[11px] text-faint">{t("housing.webSearch.costNote")}</p>
      </div>

      {/* results */}
      {phase === "done" && (
        <div className="mt-5 space-y-3">
          {stateKey && (
            <div className="flex items-start gap-3 rounded-2xl border border-line-strong bg-surface-2 p-4 text-sm text-muted">
              <Icon name="alert" size={16} strokeWidth={2} className="mt-0.5 shrink-0 text-faint" />
              <div className="flex-1">
                <p>{t(`housing.webSearch.${stateKey}`)}</p>
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

              {hasWarnings && (
                <p className="flex items-start gap-1.5 rounded-2xl bg-surface-2 p-3 text-xs text-muted">
                  <Icon name="alert" size={13} strokeWidth={2} className="mt-0.5 shrink-0 text-faint" />
                  {t("housing.webSearch.warningPartial")}
                </p>
              )}

              {listings.length === 0 ? (
                <div className="flex flex-col items-center justify-center rounded-3xl border border-dashed border-line-strong bg-surface/60 p-10 text-center">
                  <Icon name="search" size={28} strokeWidth={1.5} className="text-faint" />
                  <p className="mt-3 text-sm font-semibold text-ink">{t("housing.webSearch.empty")}</p>
                  <p className="mt-1 text-xs text-muted">{t("housing.webSearch.emptyHint")}</p>
                </div>
              ) : (
                <ul className="space-y-3">
                  {listings.map((l) => {
                    const sourceDomain = safeHostname(l.listing_url);
                    const label = domainLabel(sourceDomain, domains);
                    return (
                      <li
                        key={l.source_id}
                        className="rounded-2xl border border-line bg-surface p-4 transition-colors hover:border-line-strong"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <a
                              href={l.listing_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-sm font-bold text-ink hover:text-accent hover:underline"
                            >
                              <span className="truncate">{l.title}</span>
                              <Icon name="external" size={13} strokeWidth={2} className="shrink-0" />
                            </a>
                            <p className="mt-0.5 text-xs text-muted">
                              <Icon name="home" size={12} strokeWidth={2} className="me-1 inline" />
                              {[l.city, l.postal_code].filter(Boolean).join(", ") || "—"}
                            </p>
                          </div>
                          <VerificationBadge status={l.verification_status} t={t} />
                        </div>

                        <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-soft">
                          {l.rent_warm_eur != null && (
                            <Fact>
                              {formatEur(l.rent_warm_eur)} {t("housing.webSearch.observed")} ·{" "}
                              {t("housing.warm")}
                            </Fact>
                          )}
                          {l.rent_warm_eur == null && l.rent_cold_eur != null && (
                            <Fact>
                              {formatEur(l.rent_cold_eur)} {t("housing.webSearch.observed")} ·{" "}
                              {t("housing.rentCold")}
                            </Fact>
                          )}
                          {l.rooms != null && (
                            <Fact>
                              {l.rooms} {t("housing.searchRooms")}
                            </Fact>
                          )}
                          {l.living_area_sqm != null && (
                            <Fact>
                              {l.living_area_sqm} {t("housing.sqm")}
                            </Fact>
                          )}
                          {l.available_from && <Fact>{t("housing.webSearch.from")}: {l.available_from}</Fact>}
                        </div>

                        <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-2.5">
                          <div className="flex items-center gap-2 text-[11px] text-faint">
                            <span className="rounded-full bg-surface-2 px-2 py-0.5 font-semibold text-muted">
                              {label}
                            </span>
                            <span>{t("housing.webSearch.lastChecked", { date: formatTimestamp(l.last_checked_at) })}</span>
                          </div>
                          <a
                            href={l.listing_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 rounded-xl border border-line-strong px-2.5 py-1.5 text-xs font-semibold text-ink-soft transition-colors hover:bg-surface-2"
                          >
                            {t("housing.webSearch.external")}
                            <Icon name="external" size={12} strokeWidth={2} />
                          </a>
                        </div>
                      </li>
                    );
                  })}
                </ul>
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
    </section>
  );
}

function VerificationBadge({
  status,
  t,
}: {
  status?: HousingListing["verification_status"];
  t: (key: string) => string;
}) {
  if (status === "verified") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-success-soft px-2.5 py-1 text-[11px] font-bold text-success">
        <Icon name="check" size={12} strokeWidth={2.5} />
        {t("housing.webSearch.verified")}
      </span>
    );
  }
  if (status === "partially_verified") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-accent-soft px-2.5 py-1 text-[11px] font-bold text-accent">
        <Icon name="search" size={11} strokeWidth={2.2} />
        {t("housing.webSearch.partial")}
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-surface-2 px-2.5 py-1 text-[11px] font-bold text-muted">
      {t("housing.webSearch.unverified")}
    </span>
  );
}

function Fact({ children }: { children: React.ReactNode }) {
  return <span className="font-semibold">{children}</span>;
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}
