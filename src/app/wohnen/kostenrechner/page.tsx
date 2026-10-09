import { getServerT } from "@/lib/i18n/server";
import { Icon } from "@/components/icon";
import { AffordabilityCalculator } from "@/components/housing/affordability-calculator";

export const dynamic = "force-dynamic";

export default async function KostenrechnerPage() {
  const t = await getServerT();
  return (
    <div className="px-4 py-6 sm:px-6 lg:px-10">
      <div className="mx-auto max-w-4xl">
        <div className="mb-6 flex items-start gap-4 rounded-3xl border border-line bg-surface p-5 shadow-[var(--shadow-card)] sm:p-6">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-accent-soft text-accent">
            <Icon name="chart" size={24} strokeWidth={1.6} />
          </span>
          <div>
            <h1 className="text-xl font-extrabold text-ink sm:text-2xl">{t("housing.calcTitle")}</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted">{t("housing.calcSubtitle")}</p>
          </div>
        </div>
        <AffordabilityCalculator />
      </div>
    </div>
  );
}
