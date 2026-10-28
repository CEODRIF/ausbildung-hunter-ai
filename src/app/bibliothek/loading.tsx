import { LoadingState } from "@/components/ui";

/**
 * Partial-loading fallback (client navigation): shown while the dynamic
 * listing resolves. Full-page loads start with the server-rendered header
 * (LibraryShell is part of page.tsx), so this is intentionally compact.
 */
export default function BibliothekLoading() {
  return (
    <main className="min-h-screen bg-background text-ink">
      <div className="relative mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-14 lg:px-10">
        <div className="flex items-center justify-center py-24">
          <LoadingState />
        </div>
      </div>
    </main>
  );
}
