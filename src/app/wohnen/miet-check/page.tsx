import { getServerT } from "@/lib/i18n/server";
import { Icon } from "@/components/icon";
import { ScamCheck } from "@/components/housing/scam-check";

export const dynamic = "force-dynamic";

/**
 * Miet-Check. A `?text=` deep link (e.g. from a listing detail) is read
 * server-side and forwarded as a prop — no client URL parsing.
 */
export default async function MietCheckPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const t = await getServerT();
  const raw = (await searchParams).text;
  const initialText = typeof raw === "string" ? raw : "";

  return (
    <div className="px-4 py-6 sm:px-6 lg:px-10">
      <div className="mx-auto max-w-4xl">
        <div className="mb-6 flex items-start gap-4 rounded-3xl border border-line bg-surface p-5 shadow-[var(--shadow-card)] sm:p-6">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-danger-soft text-danger">
            <Icon name="shield" size={24} strokeWidth={1.6} />
          </span>
          <div>
            <h1 className="text-xl font-extrabold text-ink sm:text-2xl">{t("housing.scamTitle")}</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted">{t("housing.scamSubtitle")}</p>
          </div>
        </div>
        <ScamCheck initialText={initialText} />
      </div>
    </div>
  );
}
