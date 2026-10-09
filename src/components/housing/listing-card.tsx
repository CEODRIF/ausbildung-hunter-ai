"use client";

import { useI18n } from "@/lib/i18n";
import { Icon } from "@/components/icon";
import { formatEur } from "@/lib/housing/affordability";
import { SaveListingButton } from "./save-listing-button";
import type { HousingListing } from "@/lib/housing/types";

interface Props {
  listing: HousingListing;
  saved: boolean;
  selected: boolean;
  onSelect: () => void;
  onSavedChange: (saved: boolean) => void;
}

/**
 * A single normalized listing card. Demo data has no real images, so the
 * media area is a generated placeholder (never a fabricated/hotlinked photo).
 * The whole card is selectable; the save button stops propagation.
 */
export function ListingCard({ listing, saved, selected, onSelect, onSavedChange }: Props) {
  const { t } = useI18n();
  const location = [listing.city, listing.address].filter(Boolean).join(", ");
  const features = listing.features.slice(0, 4);

  return (
    <article
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      className={`group cursor-pointer overflow-hidden rounded-3xl border bg-surface shadow-[var(--shadow-card)] transition-colors ${
        selected ? "border-accent ring-2 ring-accent/20" : "border-line hover:border-line-strong"
      }`}
    >
      {/* media placeholder (no real images in demo data) */}
      <div className="relative aspect-[16/10] bg-gradient-to-br from-accent-soft via-surface-2 to-cyan-soft">
        <div className="flex h-full items-center justify-center text-accent/40">
          <Icon name="home" size={52} strokeWidth={1.4} />
        </div>
        {listing.verified && (
          <span className="absolute start-3 top-3 inline-flex items-center gap-1 rounded-full bg-surface/85 px-2.5 py-1 text-[11px] font-bold text-success shadow-sm backdrop-blur">
            <Icon name="check" size={12} strokeWidth={2.5} />
            {t("housing.verified")}
          </span>
        )}
        <SaveListingButton
          className="absolute end-3 top-3"
          provider={listing.provider}
          sourceId={listing.source_id}
          saved={saved}
          onToggled={onSavedChange}
        />
      </div>

      <div className="space-y-3 p-4">
        <div>
          <h3 className="line-clamp-2 text-sm font-bold text-ink">{listing.title}</h3>
          <p className="mt-1 flex items-center gap-1 text-xs text-muted">
            <Icon name="home" size={12} strokeWidth={2} />
            <span className="truncate">{location || "—"}</span>
            {listing.postal_code && <span className="text-faint">({listing.postal_code})</span>}
          </p>
        </div>

        <div className="flex items-end justify-between gap-2">
          <div>
            {listing.rent_warm_eur != null ? (
              <p className="text-lg font-extrabold text-accent">
                {formatEur(listing.rent_warm_eur)}{" "}
                <span className="text-xs font-semibold text-muted">{t("housing.warm")}</span>
              </p>
            ) : (
              <p className="text-sm text-muted">—</p>
            )}
            {listing.rent_cold_eur != null && listing.additional_costs_eur != null && (
              <p className="mt-0.5 text-xs text-faint">
                {t("housing.rentColdNk", {
                  cold: formatEur(listing.rent_cold_eur),
                  nk: formatEur(listing.additional_costs_eur),
                })}
              </p>
            )}
          </div>
          <div className="flex flex-col items-end gap-1 text-xs text-muted">
            {listing.rooms != null && (
              <span className="inline-flex items-center gap-1">
                <Icon name="home" size={12} strokeWidth={2} /> {listing.rooms}
              </span>
            )}
            {listing.living_area_sqm != null && (
              <span>{listing.living_area_sqm} {t("housing.sqm")}</span>
            )}
          </div>
        </div>

        {features.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {features.map((feature) => (
              <span
                key={feature}
                className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-muted"
              >
                {feature}
              </span>
            ))}
          </div>
        )}

        <div className="flex items-center justify-between border-t border-line pt-3 text-xs">
          <span className="inline-flex items-center gap-1.5 text-faint">
            <span className="rounded bg-surface-2 px-1.5 py-0.5 font-semibold text-muted">
              {t("housing.demoSource")}
            </span>
          </span>
          <a
            href={listing.listing_url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center gap-1 font-semibold text-accent hover:underline"
          >
            {t("housing.externalLink")}
            <Icon name="external" size={12} strokeWidth={2} />
          </a>
        </div>
      </div>
    </article>
  );
}
