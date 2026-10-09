"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { Icon } from "@/components/icon";
import { Button, Modal } from "@/components/ui";
import { HousingFilters } from "./housing-filters";
import { ListingCard } from "./listing-card";
import { SaveListingButton } from "./save-listing-button";
import { ApplicationAssistant } from "./application-assistant";
import { formatEur } from "@/lib/housing/affordability";
import {
  DEFAULT_HOUSING_SEARCH,
  isVerifiedListing,
  type HousingListing,
  type HousingSearchParams,
  type HousingSearchResult,
} from "@/lib/housing/types";

interface Props {
  /** Preset filters (e.g. WG rooms or furnished) for the themed sub-pages. */
  preset?: Partial<HousingSearchParams>;
  /**
   * A shared/saved search passed as a JSON string (the `?q=` URL param, read
   * server-side by the page and forwarded as a prop — no client URL parsing,
   * so SSR and hydration always agree).
   */
  initialQuery?: string;
  /** When true (default) the filter panel is shown. */
  showFilters?: boolean;
}

type Phase = "loading" | "done" | "error";

function listingKey(l: HousingListing): string {
  return `${l.provider}:${l.source_id}`;
}

const QUERY_KEYS: (keyof HousingSearchParams)[] = [
  "city",
  "postal_code",
  "radius_km",
  "accommodation_type",
  "max_warm_rent",
  "rooms",
  "available_before",
  "min_area_sqm",
  "furnished_only",
  "wg_suitable_only",
  "pets_allowed_only",
  "verified_only",
  "sort",
];

/** Pick only known, typed keys from a parsed `?q=` payload (never trust the URL). */
function sanitizeQuery(q: unknown): Partial<HousingSearchParams> {
  if (!q || typeof q !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const key of QUERY_KEYS) {
    if (key in (q as Record<string, unknown>)) {
      out[key] = (q as Record<string, unknown>)[key];
    }
  }
  return out as Partial<HousingSearchParams>;
}

function SkeletonCard() {
  return (
    <div className="animate-pulse overflow-hidden rounded-3xl border border-line bg-surface">
      <div className="aspect-[16/10] bg-surface-2" />
      <div className="space-y-2 p-4">
        <div className="h-4 w-3/4 rounded bg-surface-2" />
        <div className="h-3 w-1/2 rounded bg-surface-2" />
        <div className="h-5 w-1/3 rounded bg-surface-2" />
      </div>
    </div>
  );
}

/**
 * The core Wohnen search experience: filters → (debounced) API search → result
 * cards → a detail panel with the tools (save, application, scam check, external
 * link). Fully client-driven; the server only serves the normalized results.
 */
export function HousingSearch({ preset, initialQuery, showFilters = true }: Props) {
  const { t } = useI18n();
  const [params, setParams] = useState<HousingSearchParams>(() => {
    // A shared/saved search (`?q=` JSON) wins over the preset. Sanitized so
    // only known, typed keys are applied — the URL is never trusted wholesale.
    if (initialQuery) {
      try {
        return {
          ...DEFAULT_HOUSING_SEARCH,
          ...(preset ?? {}),
          ...sanitizeQuery(JSON.parse(initialQuery)),
        };
      } catch {
        /* malformed q — fall back to the preset */
      }
    }
    return { ...DEFAULT_HOUSING_SEARCH, ...(preset ?? {}) };
  });
  const [results, setResults] = useState<HousingSearchResult | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [selected, setSelected] = useState<HousingListing | null>(null);
  const [savedIds, setSavedIds] = useState<Set<string>>(() => new Set());
  const [appOpen, setAppOpen] = useState(false);
  const [descExpanded, setDescExpanded] = useState(false);
  const runIdRef = useRef(0);

  // Debounced search: runs on mount and whenever params change.
  useEffect(() => {
    const id = ++runIdRef.current;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch("/api/housing/search", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(params),
        });
        if (id !== runIdRef.current) return;
        if (!res.ok) {
          setPhase("error");
          return;
        }
        const data = (await res.json()) as HousingSearchResult;
        if (id !== runIdRef.current) return;
        setResults(data);
        setPhase("done");
      } catch {
        if (id !== runIdRef.current) return;
        setPhase("error");
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [params]);

  // Load the user's existing saves so the hearts render correctly.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/housing/save");
        if (!res.ok) return;
        const data = (await res.json()) as { listings?: Array<{ provider: string; source_listing_id: string }> };
        if (cancelled || !data.listings) return;
        setSavedIds(new Set(data.listings.map((l) => `${l.provider}:${l.source_listing_id}`)));
      } catch {
        /* non-fatal */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const patch = useCallback((p: Partial<HousingSearchParams>) => {
    setParams((prev) => ({ ...prev, ...p }));
  }, []);
  const reset = useCallback(() => {
    setParams({ ...DEFAULT_HOUSING_SEARCH, ...(preset ?? {}) });
  }, [preset]);

  const onSavedChange = useCallback((key: string, saved: boolean) => {
    setSavedIds((prev) => {
      const next = new Set(prev);
      if (saved) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const listings = results?.listings ?? [];

  return (
    <div className="space-y-5">
      {showFilters && <HousingFilters params={params} onChange={patch} onReset={reset} />}

      {/* results header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-bold text-ink">
          {phase === "done" && results ? t("housing.results", { n: results.total }) : t("housing.loading")}
        </h2>
        <label className="flex items-center gap-2 text-sm text-muted">
          <Icon name="chart" size={14} strokeWidth={1.8} />
          <select
            className="h-9 rounded-xl border border-line-strong bg-surface px-2.5 text-sm text-ink outline-none focus:border-accent"
            value={params.sort}
            onChange={(e) => patch({ sort: e.target.value as HousingSearchParams["sort"] })}
          >
            <option value="newest">{t("housing.sortNewest")}</option>
            <option value="price_asc">{t("housing.sortPriceAsc")}</option>
            <option value="price_desc">{t("housing.sortPriceDesc")}</option>
          </select>
        </label>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        {/* results list */}
        <div className="space-y-4 lg:col-span-2">
          {phase === "error" && (
            <div className="rounded-2xl border border-danger/30 bg-danger-soft p-5 text-sm text-danger">
              {t("housing.error")}
              <Button variant="secondary" size="sm" className="mt-3" onClick={reset}>
                {t("common.retry")}
              </Button>
            </div>
          )}

          {phase !== "error" && (
            <>
              {phase === "loading" && !results ? (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <SkeletonCard key={i} />
                  ))}
                </div>
              ) : listings.length === 0 ? (
                <div className="flex flex-col items-center justify-center rounded-3xl border border-dashed border-line-strong bg-surface p-10 text-center">
                  <Icon name="search" size={30} strokeWidth={1.5} className="text-faint" />
                  <p className="mt-3 text-sm font-semibold text-ink">{t("housing.noResults")}</p>
                  <p className="mt-1 text-xs text-muted">{t("housing.noResultsHint")}</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {listings.map((listing) => (
                    <ListingCard
                      key={listingKey(listing)}
                      listing={listing}
                      saved={savedIds.has(listingKey(listing))}
                      selected={selected?.source_id === listing.source_id}
                      onSelect={() => {
                        setSelected(listing);
                        setDescExpanded(false);
                      }}
                      onSavedChange={(saved) => onSavedChange(listingKey(listing), saved)}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {/* detail panel */}
        <div className="lg:col-span-1">
          {selected ? (
            <div className="space-y-4 rounded-3xl border border-line bg-surface p-5 shadow-[var(--shadow-card)] lg:sticky lg:top-20">
              <div>
                {isVerifiedListing(selected) ? (
                  // Green "verified" only for genuine LIVE data backed by the
                  // provider integration — never for demo fixtures.
                  <span className="mb-2 inline-flex items-center gap-1 rounded-full bg-success-soft px-2.5 py-1 text-[11px] font-bold text-success">
                    <Icon name="check" size={12} strokeWidth={2.5} />
                    {t("housing.verified")}
                  </span>
                ) : selected.data_status === "demo" ? (
                  <span className="mb-2 inline-flex items-center gap-1 rounded-full bg-surface-2 px-2.5 py-1 text-[11px] font-bold text-muted">
                    <Icon name="image" size={12} strokeWidth={2} />
                    {t("housing.demoSource")}
                  </span>
                ) : null}
                <h3 className="text-lg font-bold text-ink">{selected.title}</h3>
                <p className="mt-1 flex items-center gap-1 text-sm text-muted">
                  <Icon name="home" size={13} strokeWidth={2} />
                  {[selected.city, selected.address, selected.postal_code]
                    .filter(Boolean)
                    .join(", ")}
                </p>
              </div>

              <div className="rounded-2xl bg-surface-2 p-4">
                <p className="text-2xl font-extrabold text-accent">
                  {selected.rent_warm_eur != null ? formatEur(selected.rent_warm_eur) : "—"}
                  {selected.rent_warm_eur != null && (
                    <span className="ms-1 text-sm font-semibold text-muted">{t("housing.warm")}</span>
                  )}
                </p>
                {selected.rent_cold_eur != null && selected.additional_costs_eur != null && (
                  <p className="mt-1 text-xs text-faint">
                    {t("housing.rentColdNk", {
                      cold: formatEur(selected.rent_cold_eur),
                      nk: formatEur(selected.additional_costs_eur),
                    })}
                  </p>
                )}
                <dl className="mt-3 grid grid-cols-2 gap-y-2 text-sm">
                  {selected.rooms != null && (
                    <Detail label={t("housing.searchRooms")} value={String(selected.rooms)} />
                  )}
                  {selected.living_area_sqm != null && (
                    <Detail label={t("housing.searchArea")} value={`${selected.living_area_sqm} ${t("housing.sqm")}`} />
                  )}
                  {selected.deposit_eur != null && (
                    <Detail label={t("housing.deposit")} value={formatEur(selected.deposit_eur)} />
                  )}
                  {selected.available_from && (
                    <Detail
                      label={t("housing.availableFrom")}
                      value={selected.available_from}
                    />
                  )}
                </dl>
              </div>

              {selected.features.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {selected.features.map((f) => (
                    <span
                      key={f}
                      className="rounded-full bg-surface-2 px-2.5 py-1 text-xs font-medium text-muted"
                    >
                      {f}
                    </span>
                  ))}
                </div>
              )}

              {selected.description && (
                <div>
                  <p className="mb-1 text-xs font-bold tracking-wide text-faint uppercase">
                    {t("housing.description")}
                  </p>
                  <p className="text-sm leading-6 text-ink-soft">
                    {descExpanded ? selected.description : `${selected.description.slice(0, 180)}${selected.description.length > 180 ? "…" : ""}`}
                    <button
                      type="button"
                      onClick={() => setDescExpanded((v) => !v)}
                      className="ms-1.5 font-semibold text-accent hover:underline"
                    >
                      {descExpanded ? t("housing.showLess") : t("housing.showMore")}
                    </button>
                  </p>
                </div>
              )}

              <div className="flex items-center gap-2">
                <SaveListingButton
                  className="h-10 w-10"
                  provider={selected.provider}
                  sourceId={selected.source_id}
                  saved={savedIds.has(listingKey(selected))}
                  onToggled={(saved) => onSavedChange(listingKey(selected), saved)}
                />
                <Button
                  variant="secondary"
                  size="sm"
                  className="flex-1"
                  onClick={() =>
                    void navigator.clipboard?.writeText(selected.listing_url).catch(() => {})
                  }
                >
                  <Icon name="globe" size={14} strokeWidth={1.8} />
                  {t("housing.share")}
                </Button>
              </div>

              <div className="space-y-2">
                <a
                  href={selected.listing_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex h-11 w-full items-center justify-center gap-2 rounded-2xl font-semibold text-white shadow-[0_8px_22px_rgba(var(--glow-accent-rgb),0.3)] transition-colors bg-accent hover:bg-accent-deep"
                >
                  {t("housing.toLandlord")}
                  <Icon name="external" size={15} strokeWidth={2} />
                </a>
                <div className="grid grid-cols-2 gap-2">
                  <Button variant="secondary" size="sm" onClick={() => setAppOpen(true)}>
                    <Icon name="send" size={14} strokeWidth={1.8} />
                    {t("nav.bewerbungen")}
                  </Button>
                  <a
                    href={`/wohnen/miet-check?text=${encodeURIComponent(
                      `${selected.title}\n${selected.description ?? ""}`,
                    )}`}
                    className="flex h-9 items-center justify-center gap-1.5 rounded-xl border border-line-strong bg-surface px-3.5 text-xs font-semibold text-ink-soft transition-colors hover:bg-surface-2"
                  >
                    <Icon name="shield" size={14} strokeWidth={1.8} />
                    {t("housing.nav.mietCheck")}
                  </a>
                </div>
              </div>

              {selected.data_status === "demo" && (
                <p className="flex items-center gap-1.5 text-[11px] text-faint">
                  <Icon name="alert" size={12} strokeWidth={2} />
                  {t("housing.demoBanner")}
                </p>
              )}
            </div>
          ) : (
            <div className="flex h-full min-h-48 flex-col items-center justify-center rounded-3xl border border-dashed border-line-strong bg-surface/60 p-6 text-center">
              <Icon name="home" size={30} strokeWidth={1.5} className="text-faint" />
              <p className="mt-3 text-sm text-muted">{t("housing.noResultsHint")}</p>
            </div>
          )}
        </div>
      </div>

      <Modal
        open={appOpen && Boolean(selected)}
        onClose={() => setAppOpen(false)}
        title={t("housing.appTitle")}
      >
        {selected && <ApplicationAssistant listing={selected} />}
      </Modal>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="col-span-1">
      <dt className="text-[11px] text-faint">{label}</dt>
      <dd className="font-semibold text-ink">{value}</dd>
    </div>
  );
}
