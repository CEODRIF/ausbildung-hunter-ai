import Link from "next/link";
import { getServerT } from "@/lib/i18n/server";
import { Card } from "@/components/ui";
import { Icon } from "@/components/icon";

/**
 * The shared non-fatal, retryable state for the Phase 2 social pages —
 * same contract as the Phase 1 community pages: a database hiccup renders
 * THIS card, never the global error boundary.
 */
export async function SocialUnavailable() {
  const t = await getServerT();
  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center px-4 py-10 text-center sm:px-6">
      <Card className="w-full">
        <div className="flex flex-col items-center gap-3 p-6 sm:p-8">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-danger-soft text-danger">
            <Icon name="alert" size={22} />
          </span>
          <h2 className="text-lg font-bold text-ink">{t("common.error")}</h2>
          <p className="text-sm leading-6 text-muted">{t("common.errorHint")}</p>
          <Link
            href="/community"
            className="mt-1 text-sm font-semibold text-accent underline underline-offset-4"
          >
            {t("common.retry")}
          </Link>
        </div>
      </Card>
    </div>
  );
}
