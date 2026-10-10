import Link from "next/link";
import { getServerT } from "@/lib/i18n/server";
import { Icon, type IconName } from "@/components/icon";

/**
 * Section landing page ("Ratgeber & Rechner") — replaces the former housing
 * overview. Four cards, one per new tool/guide; all labels come from the
 * guides.land i18n block (de/en/fr/ar).
 */
export default async function RatgeberLandingPage() {
  const t = await getServerT();
  const cards: Array<{ href: string; icon: IconName; titleKey: string; descKey: string }> = [
    { href: "/wohnen/gehalt", icon: "chart", titleKey: "guides.land.c1Title", descKey: "guides.land.c1Desc" },
    {
      href: "/wohnen/neu-in-deutschland",
      icon: "globe",
      titleKey: "guides.land.c2Title",
      descKey: "guides.land.c2Desc",
    },
    {
      href: "/wohnen/nach-dem-vertrag",
      icon: "file",
      titleKey: "guides.land.c3Title",
      descKey: "guides.land.c3Desc",
    },
    {
      href: "/wohnen/konsulat",
      icon: "idCard",
      titleKey: "guides.land.c4Title",
      descKey: "guides.land.c4Desc",
    },
  ];
  return (
    <div className="mx-auto max-w-4xl">
      <p className="text-sm leading-relaxed text-muted">{t("guides.land.intro")}</p>
      <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
        {cards.map((c) => (
          <Link
            key={c.href}
            href={c.href}
            className="surface-elevated group rounded-3xl p-5 transition-transform duration-200 hover:-translate-y-0.5 sm:p-6"
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-accent-soft text-accent">
              <Icon name={c.icon} size={20} />
            </span>
            <h2 className="mt-3 text-base font-bold tracking-tight text-ink">{t(c.titleKey)}</h2>
            <p className="mt-1.5 text-sm leading-relaxed text-muted">{t(c.descKey)}</p>
            <span className="mt-3 inline-flex items-center gap-1 text-xs font-bold text-accent">
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
