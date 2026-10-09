"use client";

import { useI18n } from "@/lib/i18n";
import { Icon } from "@/components/icon";
import { Input } from "@/components/ui";
import { PriceRange } from "./price-range";
import { formatEur } from "@/lib/housing/affordability";
import type { HousingSearchParams } from "@/lib/housing/types";

interface Props {
  params: HousingSearchParams;
  onChange: (patch: Partial<HousingSearchParams>) => void;
  onReset: () => void;
}

const RADIUS_OPTIONS = [5, 10, 20, 30, 50];
const ROOM_OPTIONS: Array<number | "all"> = ["all", 1, 2, 3];

function selectClass() {
  return "h-12 w-full appearance-none rounded-2xl border border-line-strong bg-surface px-3.5 text-sm text-ink outline-none transition focus:border-accent focus:ring-4 focus:ring-accent/10";
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm text-ink-soft">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 rounded accent-accent"
      />
      {label}
    </label>
  );
}

/**
 * The Wohnen filter panel. Fully controlled by the parent (HousingSearch),
 * which owns the params object and triggers the debounced search.
 */
export function HousingFilters({ params, onChange, onReset }: Props) {
  const { t } = useI18n();
  const maxWarm = params.max_warm_rent ?? 3000;

  return (
    <div className="rounded-3xl border border-line bg-surface p-4 shadow-[var(--shadow-card)] sm:p-5">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="sm:col-span-2 lg:col-span-1">
          <Input
            label={t("housing.searchCity")}
            placeholder={t("housing.searchCityPlaceholder")}
            value={params.city}
            onChange={(e) => onChange({ city: e.target.value })}
            leading={<Icon name="home" size={16} strokeWidth={1.8} />}
          />
        </div>

        <label className="block">
          <span className="mb-2 block text-sm font-semibold text-ink-soft">
            {t("housing.searchRadius")}
          </span>
          <select
            className={selectClass()}
            value={params.radius_km}
            onChange={(e) => onChange({ radius_km: Number(e.target.value) })}
          >
            {RADIUS_OPTIONS.map((r) => (
              <option key={r} value={r}>
                {r} {t("housing.km")}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="mb-2 block text-sm font-semibold text-ink-soft">
            {t("housing.searchType")}
          </span>
          <select
            className={selectClass()}
            value={params.accommodation_type}
            onChange={(e) =>
              onChange({
                accommodation_type: e.target.value as HousingSearchParams["accommodation_type"],
              })
            }
          >
            <option value="all">{t("housing.typeAll")}</option>
            <option value="apartment">{t("housing.typeApartment")}</option>
            <option value="wg_room">{t("housing.typeWg")}</option>
            <option value="furnished">{t("housing.typeFurnished")}</option>
            <option value="studio">{t("housing.typeStudio")}</option>
          </select>
        </label>

        <label className="block">
          <span className="mb-2 block text-sm font-semibold text-ink-soft">
            {t("housing.searchRooms")}
          </span>
          <select
            className={selectClass()}
            value={String(params.rooms)}
            onChange={(e) =>
              onChange({
                rooms: e.target.value === "all" ? "all" : Number(e.target.value),
              })
            }
          >
            <option value="all">{t("housing.roomsAll")}</option>
            {ROOM_OPTIONS.filter((r) => r !== "all").map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* price */}
      <div className="mt-5">
        <span className="mb-2 block text-sm font-semibold text-ink-soft">
          {t("housing.searchMaxWarm")}
        </span>
        <PriceRange
          value={maxWarm}
          min={0}
          max={3000}
          step={50}
          onChange={(v) => onChange({ max_warm_rent: v >= 3000 ? null : v })}
          format={(v) => formatEur(v)}
        />
      </div>

      {/* move-in + area */}
      <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="mb-2 block text-sm font-semibold text-ink-soft">
            {t("housing.searchMoveIn")}
          </span>
          <input
            type="date"
            value={params.available_before ?? ""}
            onChange={(e) => onChange({ available_before: e.target.value || null })}
            className="h-12 w-full rounded-2xl border border-line-strong bg-surface px-3.5 text-sm text-ink outline-none transition focus:border-accent focus:ring-4 focus:ring-accent/10"
          />
        </label>
        <label className="block">
          <span className="mb-2 block text-sm font-semibold text-ink-soft">
            {t("housing.searchArea")}
          </span>
          <div className="relative">
            <input
              type="number"
              min={0}
              value={params.min_area_sqm ?? ""}
              onChange={(e) =>
                onChange({
                  min_area_sqm: e.target.value === "" ? null : Number(e.target.value),
                })
              }
              placeholder="0"
              className="h-12 w-full rounded-2xl border border-line-strong bg-surface px-3.5 text-sm text-ink outline-none transition focus:border-accent focus:ring-4 focus:ring-accent/10"
            />
            <span className="pointer-events-none absolute end-3.5 top-1/2 -translate-y-1/2 text-xs text-faint">
              {t("housing.sqm")}
            </span>
          </div>
        </label>
      </div>

      {/* toggles + reset */}
      <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-3">
        <Toggle
          label={t("housing.filterFurnished")}
          checked={params.furnished_only}
          onChange={(v) => onChange({ furnished_only: v })}
        />
        <Toggle
          label={t("housing.filterWg")}
          checked={params.wg_suitable_only}
          onChange={(v) => onChange({ wg_suitable_only: v })}
        />
        <Toggle
          label={t("housing.filterPets")}
          checked={params.pets_allowed_only}
          onChange={(v) => onChange({ pets_allowed_only: v })}
        />
        <Toggle
          label={t("housing.filterVerified")}
          checked={params.verified_only}
          onChange={(v) => onChange({ verified_only: v })}
        />
        <button
          type="button"
          onClick={onReset}
          className="ms-auto inline-flex items-center gap-1.5 text-sm font-semibold text-muted transition-colors hover:text-ink"
        >
          <Icon name="arrowLeft" size={14} strokeWidth={2} />
          {t("housing.resetFilters")}
        </button>
      </div>
    </div>
  );
}
