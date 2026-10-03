"use client";

/**
 * Deckblatt AI — Coming Soon.
 *
 * Shown instead of the generator while the feature is parked (see
 * `@/lib/deckblatt/availability`). It is deliberately inert: no data fetching,
 * no quota read, no provider call — opening `/deckblatt` must not start (or
 * even prepare) a generation.
 *
 * Design notes:
 *  - Built only from the app's existing primitives (GlassCard / GlowOrb / Icon /
 *    Button) and design tokens, so it matches the dark theme, typography,
 *    spacing, borders, radii and shadows of every other page with no new
 *    dependency and no new CSS.
 *  - All copy comes from the dictionary (de/en/fr/ar) — nothing is hardcoded.
 *  - Logical properties (start/end) and `rtl:` variants keep it mirrored for
 *    Arabic, and the layout is a single responsive column so it works on
 *    desktop and mobile identically.
 */
import Link from "next/link";
import { useI18n } from "@/lib/i18n";
import { Button } from "@/components/ui";
import { Icon } from "@/components/icon";
import { GlassCard, GlowOrb } from "@/components/ui/surfaces";

export function DeckblattComingSoon() {
  const { t } = useI18n();

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-10 sm:px-6 sm:py-16">
      <GlassCard
        as="section"
        variant="surface-elevated"
        aria-label={t("deckblatt.comingSoonTitle")}
        className="relative overflow-hidden px-6 py-12 text-center sm:px-10 sm:py-14"
      >
        {/* Decorative depth only — matches the app's soft glow language. */}
        <GlowOrb className="-top-20 -end-20 h-44 w-44" tone="accent" />
        <GlowOrb className="-bottom-24 -start-24 h-48 w-48" tone="blue" />

        <div className="relative flex flex-col items-center gap-4">
          <span className="flex h-16 w-16 items-center justify-center rounded-[22px] bg-accent-soft text-accent shadow-[0_10px_24px_-10px_rgba(var(--glow-accent-rgb),0.45)]">
            <Icon name="image" size={28} strokeWidth={1.6} />
          </span>

          <span className="inline-flex items-center gap-2 rounded-full border border-line-strong bg-surface/70 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-accent">
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-accent" />
            {t("deckblatt.comingSoonBadge")}
          </span>

          <h2 className="text-2xl font-bold tracking-[-0.03em] text-ink sm:text-3xl">
            {t("deckblatt.comingSoonTitle")}
          </h2>

          <p className="max-w-md text-sm leading-6 text-ink-soft sm:text-base">
            {t("deckblatt.comingSoonMessage")}
          </p>

          <p className="max-w-md text-xs leading-5 text-muted sm:text-sm">
            {t("deckblatt.comingSoonNote")}
          </p>

          <Link href="/dashboard" className="mt-3 w-full sm:w-auto">
            <Button size="md" className="w-full sm:w-auto">
              <Icon name="arrowLeft" size={16} className="rtl:rotate-180" />
              {t("deckblatt.comingSoonBackToDashboard")}
            </Button>
          </Link>
        </div>
      </GlassCard>
    </div>
  );
}
