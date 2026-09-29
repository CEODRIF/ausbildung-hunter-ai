"use client";
import { ErrorState } from "@/components/ui";
import { useI18n } from "@/lib/i18n";

export default function AIError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex min-h-[60vh] items-center justify-center p-5">
      <div className="w-full max-w-md">
        <ErrorState
          title={t("pageErrors.aiTitle")}
          description={t("pageErrors.aiBody")}
          onRetry={reset}
        />
      </div>
    </div>
  );
}
