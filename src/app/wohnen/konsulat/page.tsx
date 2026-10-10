import { getServerT } from "@/lib/i18n/server";
import { ConsulateExplorer } from "@/components/guides/consulate-explorer";

/**
 * "Dokumente für den Konsulatstermin" — per-mission document requirements
 * from the official German-mission pages (data in src/lib/guides/
 * consulate-docs.ts, each entry linked to its verified source with a
 * last-reviewed date). No universal list: the UI always shows what the
 * specific mission publishes.
 */
export default async function KonsulatPage() {
  const t = await getServerT();
  return (
    <div className="mx-auto max-w-3xl">
      <p className="text-sm leading-relaxed text-muted">{t("guides.konsulat.intro")}</p>
      <div className="mt-5">
        <ConsulateExplorer />
      </div>
    </div>
  );
}
