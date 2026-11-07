import Link from "next/link";
import { getServerT } from "@/lib/i18n/server";
import { Icon, type IconName } from "@/components/icon";

/**
 * Section landing page ("Ratgeber & Rechner") — replaces the former housing
 * overview. One card (the salary calculator); all labels come from the
 * guides.land i18n block (de/en/fr/ar).
 */
export default async function RatgeberLandingPage() {
  const t = await getServerT();
  const cards: Array<{ href: string; icon: IconName; titleKey: string; descKey: string }> = [
    { href: "/wohnen/gehalt", icon: "chart", titleKey: "guides.land.c1Title", descKey: "guides.land.c1Desc" },
  ];
  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6 lg:px-10">
      <p className="text-sm leading-relaxed text-muted">{t("guides.land.intro")}</p>

      <div className="mt-6 grid grid-cols-1 gap-5">
        {cards.map((c) => (
          <Link
            key={c.href}
            href={c.href}
            className="surface-elevated group flex flex-col gap-5 rounded-3xl p-6 shadow-[var(--shadow-card)] transition duration-200 hover:-translate-y-0.5 hover:shadow-[var(--shadow-float)] sm:flex-row sm:items-center sm:p-7"
          >
            <span
              aria-hidden="true"
              className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl text-white shadow-[var(--shadow-card)]"
              style={{ background: "var(--gradient-neon)" }}
            >
              <Icon name={c.icon} size={24} />
            </span>
            <span className="min-w-0 flex-1">
              <h2 className="text-lg font-bold tracking-tight text-ink">
                {t(c.titleKey)}
              </h2>
              <p className="mt-1.5 text-sm leading-relaxed text-muted">
                {t(c.descKey)}
              </p>
            </span>
            <span className="inline-flex shrink-0 items-center gap-2 self-start rounded-2xl border border-line-strong px-4 py-2.5 text-xs font-bold text-ink-soft transition-colors group-hover:border-accent group-hover:text-accent sm:self-center">
              {t("guides.land.open")}
              <span
                aria-hidden
                className="transition-transform duration-200 group-hover:translate-x-0.5 rtl:-scale-x-100 rtl:group-hover:-translate-x-0.5"
              >
                →
              </span>
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
