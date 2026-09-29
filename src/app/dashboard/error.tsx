"use client";

import { ErrorState } from "@/components/ui";
import { useI18n } from "@/lib/i18n";

export default function DashboardError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="mx-auto max-w-2xl px-5 py-12 sm:px-8">
      <ErrorState
        title={t("pageErrors.dashTitle")}
        description={t("pageErrors.dashBody")}
        onRetry={reset}
      />
    </div>
  );
}
