"use client";

import { ErrorState } from "@/components/ui";
import { useI18n } from "@/lib/i18n";

export default function NewApplicationError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="px-4 py-12 sm:px-6 lg:px-10">
      <div className="mx-auto max-w-xl">
        <ErrorState
          title={t("pageErrors.appTitle")}
          description={t("pageErrors.appBody")}
          onRetry={reset}
        />
      </div>
    </div>
  );
}
