"use client";

import { useEffect } from "react";
import { useI18n } from "@/lib/i18n";

/** Route-level error boundary for /opportunities/[id]: a clear, localized
 *  "unable to load" state with a no-reload retry (reset re-runs the page). */
export default function OpportunityDetailsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const { t } = useI18n();
  useEffect(() => {
    // Structured log only — the digest keeps the boundary stable.
    console.error(
      "[opportunities/detail] failed to load:",
      error.digest ? `digest=${error.digest}` : error.message,
    );
  }, [error]);

  return (
    <div className="px-4 py-6 sm:px-6 lg:px-10">
      <div className="mx-auto max-w-3xl">
        <div className="mt-8 rounded-2xl border border-line bg-surface p-10 text-center">
          <h2 className="text-xl font-bold text-ink">
            {t("account.detailFailed")}
          </h2>
          <p className="mt-3 text-sm leading-6 text-muted">
            {t("account.detailFailedNote")}
          </p>
          <button
            type="button"
            onClick={() => reset()}
            className="mt-5 rounded-xl bg-accent px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-accent-deep"
          >
            {t("account.detailRetry")}
          </button>
        </div>
      </div>
    </div>
  );
}
