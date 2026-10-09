import { getServerT } from "@/lib/i18n/server";
import { Icon } from "@/components/icon";
import type { IconName } from "@/components/icon";

export const dynamic = "force-dynamic";

const TIPS: Array<{ icon: IconName; titleKey: string; bodyKey: string }> = [
  { icon: "home", titleKey: "housing.tip1Title", bodyKey: "housing.tip1Body" },
  { icon: "file", titleKey: "housing.tip2Title", bodyKey: "housing.tip2Body" },
  { icon: "chart", titleKey: "housing.tip3Title", bodyKey: "housing.tip3Body" },
  { icon: "shield", titleKey: "housing.tip4Title", bodyKey: "housing.tip4Body" },
];

export default async function TippsPage() {
  const t = await getServerT();
  return (
    <div className="px-4 py-6 sm:px-6 lg:px-10">
      <div className="mx-auto max-w-3xl">
        <div className="mb-6 flex items-start gap-4 rounded-3xl border border-line bg-surface p-5 shadow-[var(--shadow-card)] sm:p-6">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-accent-soft text-accent">
            <Icon name="book" size={24} strokeWidth={1.6} />
          </span>
          <div>
            <h1 className="text-xl font-extrabold text-ink sm:text-2xl">
              {t("housing.page.tipps.title")}
            </h1>
            <p className="mt-1 max-w-2xl text-sm text-muted">{t("housing.page.tipps.subtitle")}</p>
          </div>
        </div>

        <div className="space-y-4">
          {TIPS.map((tip) => (
            <div
              key={tip.titleKey}
              className="flex items-start gap-4 rounded-3xl border border-line bg-surface p-5 shadow-[var(--shadow-card)]"
            >
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-accent-soft text-accent">
                <Icon name={tip.icon} size={22} strokeWidth={1.6} />
              </span>
              <div>
                <h2 className="text-base font-bold text-ink">{t(tip.titleKey)}</h2>
                <p className="mt-1.5 text-sm leading-6 text-ink-soft">{t(tip.bodyKey)}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
