"use client";

import { useI18n } from "@/lib/i18n";
import { Icon } from "@/components/icon";

/**
 * Dismissible demo-data banner. Every Wohnen surface that shows listings
 * renders this so demo data is never mistaken for real offers. It is purely
 * presentational (no state persistence) and labelled clearly.
 */
export function DemoBanner() {
  const { t } = useI18n();
  return (
    <div
      role="note"
      className="flex items-start gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300"
    >
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-amber-500/20 text-amber-600 dark:text-amber-300">
        <Icon name="alert" size={14} strokeWidth={2} />
      </span>
      <div className="min-w-0">
        <p className="font-bold">{t("housing.demoBanner")}</p>
        <p className="mt-0.5 text-amber-700/80 dark:text-amber-300/80">
          {t("housing.demoNote")}
        </p>
      </div>
    </div>
  );
}
