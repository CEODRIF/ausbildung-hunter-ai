import { getServerT } from "@/lib/i18n/server";
import { LoadingState } from "@/components/ui";

/**
 * Partial-loading fallback (client navigation): rendered INSIDE the shared
 * AppShell (bibliothek/layout.tsx), so only the content column is
 * stand-in — same shape as the page's own chrome.
 */
export default async function BibliothekLoading() {
  const t = await getServerT();
  return (
    <div className="relative mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-10">
      <p className="text-sm leading-relaxed text-muted">{t("library.intro")}</p>
      <div className="flex items-center justify-center py-24">
        <LoadingState />
      </div>
    </div>
  );
}
