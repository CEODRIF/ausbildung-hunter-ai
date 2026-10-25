import Link from "next/link";
import { redirect } from "next/navigation";
import { Card } from "@/components/ui";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { getUsageSnapshot } from "@/lib/email-campaigns";
import { getServerT } from "@/lib/i18n/server";
import { QuotaIndicator, makeQuotaLabels } from "@/components/quota-indicator";

export const dynamic = "force-dynamic";
export default async function UsageSettingsPage() {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active")
    redirect("/login");
  const usage = await getUsageSnapshot(user.id);
  const t = await getServerT();
  return (
    <div className="px-4 py-6 sm:px-6 lg:px-10">
      <div className="mx-auto max-w-3xl">
        <p className="text-sm leading-6 text-muted">
          {t("account.usageNote1")}
          <Link href="/settings/billing" className="font-semibold text-accent">
            {t("account.usageNoteLinkBilling")}
          </Link>
          {t("account.usageNote2")}
          <Link href="/settings/data" className="font-semibold text-accent">
            {t("account.usageNoteLinkData")}
          </Link>
          .
        </p>
        <Card className="mt-4 p-6">
          {/* Shared green quota indicator (P0 quota audit): same component
              and state rules as all other quota surfaces. The stats below
              stay as the detailed numbers (same server-derived source). */}
          <div className="mb-5">
            <QuotaIndicator
              variant="bar"
              data={{
                used: usage.emails_sent,
                limit: usage.daily_limit,
                remaining: usage.remaining,
              }}
              unit={t("quota.unitEmails")}
              resetLabel={t("quota.resetsDaily")}
              labels={makeQuotaLabels(t)}
              upgradeHint={t("quota.upgrade")}
            />
          </div>
          <div className="grid gap-5 sm:grid-cols-3">
            <Stat
              label={t("account.dailyLimit")}
              value={String(usage.daily_limit)}
              suffix={t("account.emailsUnit")}
            />
            <Stat
              label={t("account.sentToday")}
              value={String(usage.emails_sent)}
              suffix={t("account.emailsUnit")}
            />
            <Stat
              label={t("account.remaining")}
              value={String(usage.remaining)}
              suffix={t("account.emailsUnit")}
            />
          </div>
        </Card>
      </div>
    </div>
  );
}
function Stat({
  label,
  value,
  suffix,
}: {
  label: string;
  value: string;
  suffix: string;
}) {
  return (
    <div className="rounded-xl bg-surface-2 p-4">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-2 text-2xl font-bold text-ink">
        {value}{" "}
        <span className="text-xs font-semibold text-muted">{suffix}</span>
      </p>
    </div>
  );
}
