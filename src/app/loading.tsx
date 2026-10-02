import { Search } from "lucide-react";
import { LoadingState } from "@/components/ui";
import { Skeleton } from "@/components/ui/feedback";
import { getServerT } from "@/lib/i18n/server";

/**
 * Global route transition loading state — the premium skeleton contract:
 * a glass card with the brand mark, shimmer lines and metric placeholders.
 * Pure CSS shimmer only (no timers, no fake data).
 */
export default async function Loading() {
  const t = await getServerT();
  return (
    <div className="flex min-h-[70vh] items-center justify-center px-4 py-10">
      <div
        className="w-full max-w-md"
        role="status"
        aria-label={t("common.loading")}
      >
        <div className="glass rounded-3xl p-6 sm:p-7">
          <div className="flex items-center gap-3.5">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-[var(--gradient-neon)] text-white shadow-[0_10px_24px_-8px_rgba(var(--glow-accent-rgb),0.55)]">
              <Search size={22} strokeWidth={1.9} />
            </span>
            <div className="min-w-0 flex-1 space-y-2.5">
              <Skeleton className="h-4 w-1/2 rounded-full" />
              <Skeleton className="h-3 w-3/4 rounded-full" />
            </div>
          </div>
          <div className="mt-6 space-y-3">
            <Skeleton className="h-3.5 w-full rounded-full" />
            <Skeleton className="h-3.5 w-11/12 rounded-full" />
            <Skeleton className="h-3.5 w-4/6 rounded-full" />
          </div>
          <div className="mt-6 grid grid-cols-3 gap-3">
            <Skeleton className="h-16 rounded-2xl" />
            <Skeleton className="h-16 rounded-2xl" />
            <Skeleton className="h-16 rounded-2xl" />
          </div>
        </div>
        <div className="mt-5 flex justify-center">
          <LoadingState label={t("common.loading")} />
        </div>
      </div>
    </div>
  );
}
