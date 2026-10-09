"use client";

import { useState } from "react";
import { useI18n } from "@/lib/i18n";
import { Icon } from "@/components/icon";
import { formatEur } from "@/lib/housing/affordability";
import type { HousingListing } from "@/lib/housing/types";

/**
 * Professional web-search listing card for the Wohnen surface.
 *
 * Design language: same tokens as the rest of /wohnen (rounded-3xl,
 * border-line, bg-surface, shadow-card, accent colors) — the card is the
 * professional version of the previous plain result row.
 *
 * Honesty rules (rendered, not just enforced server-side):
 *  - Every displayed value came from the server; unknown fields render the
 *    explicit "Nicht verfügbar" fallback — never a placeholder number.
 *  - The badge says the listing was DISCOVERED via web search. It never
 *    implies independent verification of availability.
 *  - Clicking opens the INTERNAL detail view (onOpen) — the user is never
 *    merely thrown at the external portal; the portal link remains as an
 *    explicit, labelled action.
 *  - Images only when the pipeline legitimately obtained one (fetched
 *    page JSON-LD); otherwise a neutral placeholder.
 */

export interface WebSearchDomain {
  domain: string;
  label: string;
  fetchable: boolean;
}

/**
 * The first image URL that is safe to render in an <img>: http(s) and
 * syntactically valid. http:// is deliberately excluded on an https app
 * (mixed content would block it in the browser and render a broken tile).
 */
export function firstSafeImage(images: string[] | null | undefined): string | null {
  for (const img of images ?? []) {
    if (typeof img !== "string" || img === "") continue;
    try {
      const u = new URL(img);
      if (u.protocol === "https:") return img;
    } catch {
      /* ignore */
    }
  }
  return null;
}

export function safeHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Portal name: model-reported label > reviewed allowlist label > hostname. */
export function listingSourceLabel(
  listing: HousingListing,
  domains: WebSearchDomain[],
): string {
  if (listing.source_label) return listing.source_label;
  const host = safeHostname(listing.listing_url);
  const known = domains.find(
    (d) => host === d.domain || host.endsWith(`.${d.domain}`),
  );
  return known?.label ?? host;
}

function formatDate(iso: string, lang: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(lang, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(d);
}

/**
 * Verification badge — three honest states:
 *  - verified           (green):  we FETCHED the page and parsed structured
 *                                 facts (fetchable-policy domains only)
 *  - partially_verified (accent): facts stated in the cited search result
 *  - unverified         (neutral): only discovered (URL + title)
 * Never a claim of independent/portal-side verification.
 */
export function VerificationBadge({
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

export function ListingCard({
  listing,
  sourceLabel,
  onOpen,
}: {
  listing: HousingListing;
  sourceLabel: string;
  onOpen: (listing: HousingListing) => void;
}) {
  const { t, lang } = useI18n();
  const [imgFailed, setImgFailed] = useState(false);
  const image = firstSafeImage(listing.images);

  const rentMain =
    listing.rent_warm_eur != null
      ? { value: listing.rent_warm_eur, label: t("housing.warm") }
      : listing.rent_cold_eur != null
        ? { value: listing.rent_cold_eur, label: t("housing.rentCold") }
        : null;
  const rentSecondary =
    listing.rent_warm_eur != null && listing.rent_cold_eur != null
      ? { value: listing.rent_cold_eur, label: t("housing.rentCold") }
      : null;

  const meta: string[] = [];
  if (listing.rooms != null) meta.push(`${listing.rooms} ${t("housing.searchRooms")}`);
  if (listing.living_area_sqm != null) meta.push(`${listing.living_area_sqm} ${t("housing.sqm")}`);
  if (listing.available_from) meta.push(`${t("housing.webSearch.from")} ${formatDate(listing.available_from, lang)}`);

  return (
    <article
      role="button"
      tabIndex={0}
      aria-label={`${listing.title} – ${t("housing.webSearch.viewDetails")}`}
      onClick={() => onOpen(listing)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(listing);
        }
      }}
      className="group flex cursor-pointer flex-col overflow-hidden rounded-3xl border border-line bg-surface shadow-[var(--shadow-card)] transition-colors hover:border-line-strong focus:outline-none focus-visible:ring-4 focus-visible:ring-accent/20"
    >
      {/* image or neutral placeholder */}
      <div className="relative h-40 shrink-0 bg-gradient-to-br from-surface-2 to-surface">
        {image && !imgFailed ? (
          // eslint-disable-next-line @next/next/no-img-element -- external listing image, sized via CSS
          <img
            src={image}
            alt=""
            loading="lazy"
            onError={() => setImgFailed(true)}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-faint">
            <Icon name="home" size={36} strokeWidth={1.3} />
          </div>
        )}
        <span className="absolute top-2.5 start-2.5 inline-flex items-center gap-1 rounded-full bg-navy/70 px-2.5 py-1 text-[10px] font-bold text-white backdrop-blur-sm">
          <Icon name="globe" size={10} strokeWidth={2.4} />
          {t("housing.webSearch.discovered")}
        </span>
        {listing.furnished && (
          <span className="absolute top-2.5 end-2.5 inline-flex items-center gap-1 rounded-full bg-surface/85 px-2.5 py-1 text-[10px] font-bold text-ink backdrop-blur-sm">
            <Icon name="check" size={10} strokeWidth={2.4} />
            {t("housing.webSearch.furnished")}
          </span>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-2.5 p-4">
        <div className="flex items-start justify-between gap-2">
          <h3
            className={`line-clamp-2 text-sm font-bold ${
              listing.title_is_fallback ? "text-ink-soft" : "text-ink"
            } group-hover:text-accent`}
            title={
              listing.title_is_fallback
                ? t("housing.webSearch.derivedTitle")
                : undefined
            }
          >
            {listing.title}
          </h3>
        </div>

        <p className="flex items-center gap-1 text-xs text-muted">
          <Icon name="home" size={12} strokeWidth={2} className="shrink-0" />
          <span className="truncate">
            {listing.city_unverified
              ? listing.city
                ? `${listing.city} (${t("housing.webSearch.locationUnverified")})`
                : t("housing.webSearch.locationUnknown")
              : [listing.city, listing.postal_code].filter(Boolean).join(", ") ||
                t("housing.webSearch.locationUnknown")}
          </span>
        </p>

        {/* rent — the card's primary fact */}
        <p className="text-base font-extrabold text-accent">
          {rentMain ? (
            <>
              {formatEur(rentMain.value)}
              <span className="ms-1.5 text-xs font-semibold text-muted">{rentMain.label}</span>
              {rentSecondary && (
                <span className="ms-2 text-xs font-semibold text-faint">
                  {rentSecondary.label} {formatEur(rentSecondary.value)}
                </span>
              )}
            </>
          ) : (
            <span className="text-sm font-semibold text-faint">
              {t("housing.webSearch.notAvailable")}
            </span>
          )}
        </p>

        {meta.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {meta.map((m) => (
              <span
                key={m}
                className="rounded-full bg-surface-2 px-2.5 py-1 text-[11px] font-semibold text-ink-soft"
              >
                {m}
              </span>
            ))}
          </div>
        )}

        {/* footer: source + verification + external link */}
        <div className="mt-auto flex items-center justify-between gap-2 border-t border-line pt-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-bold text-accent">
              {sourceLabel}
            </span>
            <VerificationBadge status={listing.verification_status} t={t} />
          </div>
          <a
            href={listing.listing_url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            aria-label={`${t("housing.webSearch.openOriginal")}: ${sourceLabel}`}
            className="inline-flex shrink-0 items-center gap-1 rounded-xl border border-line-strong px-2.5 py-1.5 text-xs font-semibold text-ink-soft transition-colors hover:bg-surface-2"
          >
            {t("housing.externalLink")}
            <Icon name="external" size={12} strokeWidth={2} />
          </a>
        </div>
      </div>
    </article>
  );
}
