import Link from "next/link";
import { getServerT } from "@/lib/i18n/server";
import { Icon } from "@/components/icon";
import { DemoBanner } from "@/components/housing/demo-banner";
import { HousingSearch } from "@/components/housing/housing-search";

export const dynamic = "force-dynamic";

interface ToolCard {
  href: string;
  icon: "chart" | "shield" | "book";
  titleKey: string;
  bodyKey: string;
}

const TOOL_CARDS: ToolCard[] = [
  { href: "/wohnen/kostenrechner", icon: "chart", titleKey: "housing.calcTitle", bodyKey: "housing.calcSubtitle" },
  { href: "/wohnen/miet-check", icon: "shield", titleKey: "housing.scamTitle", bodyKey: "housing.scamSubtitle" },
  { href: "/wohnen/tipps", icon: "book", titleKey: "housing.nav.tipps", bodyKey: "housing.tip1Body" },
];

export default async function WohnenPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const t = await getServerT();
  // A saved/shared search arrives as `?q=<json>` (from "Meine Suchen"); the
  // raw string is forwarded as a prop and sanitized client-side.
  const rawQ = (await searchParams).q;
  const initialQuery = typeof rawQ === "string" ? rawQ : undefined;

  return (
    <div className="px-4 py-6 sm:px-6 lg:px-10">
      <div className="mx-auto max-w-6xl">
        {/* hero */}
        <div className="mb-6 flex flex-col gap-4 rounded-3xl border border-line bg-surface p-5 shadow-[var(--shadow-card)] sm:flex-row sm:items-center sm:justify-between sm:p-6">
          <div className="flex items-start gap-4">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-accent-soft text-accent">
              <Icon name="home" size={26} strokeWidth={1.6} />
            </span>
            <div>
              <h1 className="text-xl font-extrabold text-ink sm:text-2xl">
                {t("housing.heroTitle")}
              </h1>
              <p className="mt-1 max-w-2xl text-sm text-muted">{t("housing.heroSubtitle")}</p>
            </div>
          </div>
          <Link
            href="/wohnen/tipps"
            className="inline-flex shrink-0 items-center gap-2 rounded-2xl border border-line-strong bg-surface px-4 py-3 text-sm font-semibold text-ink-soft transition-colors hover:bg-surface-2"
          >
            {t("housing.guideCta")}
            <Icon name="arrowRight" size={15} strokeWidth={2} />
          </Link>
        </div>

        {/* tool cards */}
        <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
          {TOOL_CARDS.map((card) => (
            <Link
              key={card.href}
              href={card.href}
              className="group flex items-start gap-3 rounded-3xl border border-line bg-surface p-4 shadow-[var(--shadow-card)] transition-colors hover:border-line-strong"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-accent-soft text-accent">
                <Icon name={card.icon} size={20} strokeWidth={1.7} />
              </span>
              <div className="min-w-0">
                <p className="flex items-center gap-1 text-sm font-bold text-ink">
                  {t(card.titleKey)}
                  <Icon
                    name="arrowRight"
                    size={14}
                    strokeWidth={2}
                    className="text-faint transition-transform group-hover:translate-x-0.5"
                  />
                </p>
                <p className="mt-0.5 line-clamp-2 text-xs text-muted">{t(card.bodyKey)}</p>
              </div>
            </Link>
          ))}
        </div>

        <div className="mb-5">
          <DemoBanner />
        </div>

        <HousingSearch initialQuery={initialQuery} />
      </div>
    </div>
  );
}
