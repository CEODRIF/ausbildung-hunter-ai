import { getServerT } from "@/lib/i18n/server";
import { Icon } from "@/components/icon";
import { DemoBanner } from "@/components/housing/demo-banner";
import { HousingSearch } from "@/components/housing/housing-search";

export const dynamic = "force-dynamic";

export default async function MoebliertPage() {
  const t = await getServerT();
  return (
    <div className="px-4 py-6 sm:px-6 lg:px-10">
      <div className="mx-auto max-w-6xl">
        <div className="mb-5 flex items-start gap-4 rounded-3xl border border-line bg-surface p-5 shadow-[var(--shadow-card)] sm:p-6">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-accent-soft text-accent">
            <Icon name="image" size={24} strokeWidth={1.6} />
          </span>
          <div>
            <h1 className="text-xl font-extrabold text-ink sm:text-2xl">
              {t("housing.page.moebliert.title")}
            </h1>
            <p className="mt-1 max-w-2xl text-sm text-muted">{t("housing.page.moebliert.subtitle")}</p>
          </div>
        </div>
        <div className="mb-5">
          <DemoBanner />
        </div>
        <HousingSearch preset={{ furnished_only: true }} />
      </div>
    </div>
  );
}
