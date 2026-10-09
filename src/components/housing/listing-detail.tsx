"use client";

import { useEffect } from "react";
import { useI18n } from "@/lib/i18n";
import { Icon } from "@/components/icon";
import { buttonStyles } from "@/components/ui";
import { formatEur } from "@/lib/housing/affordability";
import type { HousingListing } from "@/lib/housing/types";
import {
  firstSafeImage,
  listingSourceLabel,
  safeHostname,
  VerificationBadge,
  type WebSearchDomain,
} from "./listing-card";

/**
 * INTERNAL detail view for a web-search listing (opened from the card).
 *
 * Shows ALL information the system genuinely obtained for this listing and
 * nothing more:
 *  - every unknown field renders the explicit "Nicht verfügbar" fallback —
 *    the layout is never padded with invented values;
 *  - information from the cited search result / fetched page is presented
 *    as such (provenance note), never as the original portal description;
 *  - the original portal stays one prominent click away.
 *
 * Accessibility: dialog semantics, Escape to close, backdrop click to
 * close, body scroll locked while open, focus moved into the dialog.
 */

const TYPE_KEYS: Record<HousingListing["accommodation_type"], string> = {
  apartment: "housing.typeApartment",
  wg_room: "housing.typeWg",
  furnished: "housing.typeFurnished",
  studio: "housing.typeStudio",
};

function FactValue({ value, suffix }: { value: string | null; suffix?: string }) {
  const { t } = useI18n();
  if (value === null || value === "") {
    return <span className="text-sm font-medium text-faint">{t("housing.webSearch.notAvailable")}</span>;
  }
  return (
    <span className="text-sm font-bold text-ink">
      {value}
      {suffix ? <span className="ms-1 text-xs font-semibold text-muted">{suffix}</span> : null}
    </span>
  );
}

function FactCell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl bg-surface-2 p-3">
      <p className="mb-1 text-[11px] font-bold tracking-wide text-faint uppercase">{label}</p>
      {children}
    </div>
  );
}

/** Tiny "where did this section's values come from" tag (honesty rule:
 *  fetched page ≠ search result — the user must see the difference). */
function ProvenanceLabel({
  p,
  t,
}: {
  p: "page" | "search" | undefined;
  t: (key: string) => string;
}) {
  if (p === undefined) return null;
  return (
    <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-bold text-accent normal-case">
      {p === "page" ? t("housing.webSearch.provenancePageTag") : t("housing.webSearch.provenanceSearchTag")}
    </span>
  );
}

/** Localized text for the machine-readable verification note. */
function verificationNoteText(
  note: HousingListing["verification_notes"],
  t: (key: string) => string,
): string | null {
  switch (note) {
    case "page_fetched":
      return t("housing.webSearch.notePageFetched");
    case "page_unstructured":
      return t("housing.webSearch.notePageUnstructured");
    case "tos_no_fetch":
      return t("housing.webSearch.noteTosNoFetch");
    case "robots_blocked":
      return t("housing.webSearch.noteRobotsBlocked");
    case "fetch_failed":
      return t("housing.webSearch.noteFetchFailed");
    default:
      return null;
  }
}

export function ListingDetailModal({
  listing,
  domains,
  onClose,
}: {
  listing: HousingListing;
  domains: WebSearchDomain[];
  onClose: () => void;
}) {
  const { t, lang } = useI18n();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    document.addEventListener("keydown", onKeyDown);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  const sourceLabel = listingSourceLabel(listing, domains);
  // Server-validated primary photo first; the images[] fallback covers
  // legacy saved snapshots from before image_url existed.
  const image = listing.image_url ?? firstSafeImage(listing.images);

  const warm = listing.rent_warm_eur;
  const cold = listing.rent_cold_eur;
  const additional = listing.additional_costs_eur;
  const deposit = listing.deposit_eur;

  const availableFrom = listing.available_from
    ? new Intl.DateTimeFormat(lang, { day: "2-digit", month: "2-digit", year: "numeric" }).format(
        new Date(`${listing.available_from}T00:00:00`),
      )
    : null;

  const lastChecked = listing.last_checked_at
    ? new Intl.DateTimeFormat(lang, { dateStyle: "medium", timeStyle: "short" }).format(
        new Date(listing.last_checked_at),
      )
    : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={listing.title}
    >
      <button
        className="absolute inset-0 bg-navy/45 backdrop-blur-[2px] dark:bg-black/60"
        aria-label={t("common.close")}
        onClick={onClose}
      />
      <div className="relative z-10 flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-3xl border border-line bg-surface shadow-2xl">
        {/* header */}
        <div className="flex items-start justify-between gap-3 border-b border-line p-5">
          <div className="min-w-0 flex-1">
            <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
              <span className="inline-flex items-center gap-1 rounded-full bg-navy/70 px-2.5 py-1 text-[10px] font-bold text-white">
                <Icon name="globe" size={10} strokeWidth={2.4} />
                {t("housing.webSearch.discovered")}
              </span>
              <VerificationBadge status={listing.verification_status} t={t} />
            </div>
            <h2 className="text-lg font-extrabold leading-snug text-ink">{listing.title}</h2>
            {listing.title_is_fallback && (
              <p className="mt-0.5 text-[11px] text-faint">{t("housing.webSearch.derivedTitle")}</p>
            )}
            <p className="mt-1 flex items-center gap-1 text-sm text-muted">
              <Icon name="home" size={13} strokeWidth={2} className="shrink-0" />
              {listing.city_unverified
                ? listing.city
                  ? `${listing.city} (${t("housing.webSearch.locationUnverified")})`
                  : t("housing.webSearch.locationUnknown")
                : [listing.city, listing.postal_code].filter(Boolean).join(", ") ||
                  t("housing.webSearch.locationUnknown")}
            </p>
          </div>
          <button
            className="shrink-0 rounded-xl p-2 text-faint transition-colors hover:bg-surface-2 hover:text-ink"
            onClick={onClose}
            aria-label={t("common.close")}
          >
            <Icon name="x" size={18} strokeWidth={2} />
          </button>
        </div>

        {/* body */}
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
          {image && (
            <figure>
              {/* eslint-disable-next-line @next/next/no-img-element -- external listing image, fixed aspect */}
              <img
                src={image}
                alt={listing.title}
                className="h-56 w-full rounded-2xl object-cover"
              />
            </figure>
          )}

          {/* prices (per-field provenance: page vs. search result) */}
          <section>
            <h3 className="mb-2 flex items-center gap-2 text-xs font-bold tracking-wide text-faint uppercase">
              {t("housing.webSearch.prices")}
              <ProvenanceLabel p={listing.field_provenance?.rent_warm_eur ?? listing.field_provenance?.rent_cold_eur} t={t} />
            </h3>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <FactCell label={t("housing.webSearch.coldRent")}>
                <FactValue
                  value={cold != null ? formatEur(cold) : null}
                  suffix={cold != null ? t("housing.perMonth") : undefined}
                />
              </FactCell>
              <FactCell label={t("housing.webSearch.additionalCosts")}>
                <FactValue
                  value={additional != null ? formatEur(additional) : null}
                  suffix={additional != null ? t("housing.perMonth") : undefined}
                />
              </FactCell>
              <FactCell label={t("housing.webSearch.warmRent")}>
                <FactValue
                  value={warm != null ? formatEur(warm) : null}
                  suffix={warm != null ? t("housing.perMonth") : undefined}
                />
              </FactCell>
              <FactCell label={t("housing.webSearch.deposit")}>
                <FactValue value={deposit != null ? formatEur(deposit) : null} />
              </FactCell>
            </div>
          </section>

          {/* property facts */}
          <section>
            <h3 className="mb-2 flex items-center gap-2 text-xs font-bold tracking-wide text-faint uppercase">
              {t("housing.webSearch.property")}
              <ProvenanceLabel
                p={listing.field_provenance?.rooms ?? listing.field_provenance?.living_area_sqm}
                t={t}
              />
            </h3>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <FactCell label={t("housing.webSearch.rooms")}>
                <FactValue value={listing.rooms != null ? String(listing.rooms) : null} />
              </FactCell>
              <FactCell label={t("housing.webSearch.area")}>
                <FactValue value={listing.living_area_sqm != null ? String(listing.living_area_sqm) : null} suffix="m²" />
              </FactCell>
              <FactCell label={t("housing.webSearch.propertyType")}>
                <span className="text-sm font-bold text-ink">{t(TYPE_KEYS[listing.accommodation_type])}</span>
              </FactCell>
              <FactCell label={t("housing.webSearch.floor")}>
                <FactValue value={listing.floor ?? null} />
              </FactCell>
            </div>
          </section>

          {/* availability + furnishings */}
          <section className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <FactCell label={t("housing.webSearch.availability")}>
              <FactValue
                value={availableFrom ? `${t("housing.webSearch.from")} ${availableFrom}` : null}
              />
            </FactCell>
            <FactCell label={t("housing.webSearch.furnished")}>
              <span className="text-sm font-bold text-ink">
                {listing.furnished
                  ? t("housing.webSearch.furnishedYes")
                  : t("housing.webSearch.notAvailable")}
              </span>
            </FactCell>
          </section>

          {/* honest provenance note: what we have is search-result data,
              NOT the portal's full description */}
          <p className="flex items-start gap-2 rounded-2xl border border-line-strong bg-surface-2 p-3 text-xs leading-5 text-muted">
            <Icon name="alert" size={13} strokeWidth={2} className="mt-0.5 shrink-0 text-faint" />
            <span>
              {listing.source_type === "page_fetch"
                ? t("housing.webSearch.provenanceFetched")
                : t("housing.webSearch.provenanceSearch")}
              {" "}
              {t("housing.webSearch.confirmNote")}
            </span>
          </p>

          {/* machine-readable verification note (why this level) */}
          {verificationNoteText(listing.verification_notes, t) && (
            <p className="flex items-start gap-2 rounded-2xl bg-surface-2 p-3 text-xs leading-5 text-faint">
              <Icon name="shield" size={13} strokeWidth={2} className="mt-0.5 shrink-0" />
              <span>{verificationNoteText(listing.verification_notes, t)}</span>
            </p>
          )}
        </div>

        {/* source footer */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line p-5">
          <div className="min-w-0 text-xs text-muted">
            <p className="flex items-center gap-1.5 font-bold text-ink-soft">
              <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-bold text-accent">
                {sourceLabel}
              </span>
              <span className="truncate">{safeHostname(listing.listing_url)}</span>
            </p>
            {lastChecked && (
              <p className="mt-1 text-faint">
                {t("housing.webSearch.lastChecked", { date: lastChecked })}
              </p>
            )}
          </div>
          {/* prominent: the user's way out to the original listing (button-
              styled anchor — a <button> may not wrap an <a>) */}
          <a
            href={listing.listing_url}
            target="_blank"
            rel="noopener noreferrer"
            className={`inline-flex h-11 items-center justify-center gap-2 rounded-2xl px-5 text-sm font-semibold ${buttonStyles.primary}`}
          >
            {t("housing.webSearch.openOriginal")}
            <Icon name="external" size={14} strokeWidth={2} />
          </a>
        </div>
      </div>
    </div>
  );
}
