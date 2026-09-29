import Link from "next/link";
import { redirect } from "next/navigation";
import { Card } from "@/components/ui";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { getEntitlements } from "@/lib/billing/entitlements";
import { getBillingProvider } from "@/lib/billing/provider";
import { getUsageSnapshot } from "@/lib/email-campaigns";
import { getServerT, getRequestLang } from "@/lib/i18n/server";
import { localeForLang } from "@/lib/i18n/core";

export const dynamic = "force-dynamic";

/** Phase 10 — billing status (server-derived). Nothing about the plan or
 *  entitlements is accepted from the browser. */
export default async function BillingSettingsPage() {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active")
    redirect("/login");

  const [entitlements, usage, t, lang] = await Promise.all([
    getEntitlements(user.id),
    getUsageSnapshot(user.id).catch(() => null),
    getServerT(),
    getRequestLang(),
  ]);
  const locale = localeForLang(lang);
  const provider = getBillingProvider();
  const hasSubscription = entitlements.subscription !== null;
  const isCurrent =
    entitlements.source === "subscription" &&
    entitlements.subscription?.status === "active";

  const formatDate = (value: string | null) =>
    value ? new Date(value).toLocaleDateString(locale) : "—";

  return (
    <div className="px-4 py-6 sm:px-6 lg:px-10">
      <div className="mx-auto max-w-3xl">
        {!provider.configured && (
          <Card className="mb-5 border-warning/25 bg-warning-soft p-5">
            <p className="text-sm font-bold text-warning">
              {t("account.providerNotConfiguredTitle")}
            </p>
            <p className="mt-1 text-xs leading-5 text-warning">
              {t("account.providerNotConfiguredBody")}
            </p>
          </Card>
        )}

        <Card className="p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.1em] text-faint">
                {t("account.currentPlan")}
              </p>
              <p className="mt-1 text-2xl font-bold text-ink">
                {entitlements.planLabel}
              </p>
            </div>
            <span
              className={`rounded-lg px-2.5 py-1 text-xs font-bold ${
                isCurrent
                  ? "bg-success-soft text-success"
                  : "bg-surface-2 text-muted"
              }`}
            >
              {isCurrent
                ? t("account.activeSubscription")
                : entitlements.source === "default"
                  ? t("account.defaultFree")
                  : t("account.subscriptionStatus", {
                      status: entitlements.subscription?.status ?? "",
                    })}
            </span>
          </div>

          <dl className="mt-6 space-y-3 text-sm">
            <Row
              label={t("account.planBaseEmails")}
              value={String(entitlements.emailsPerDay)}
            />
            <Row
              label={t("account.planBaseAi")}
              value={String(entitlements.aiPerDay)}
            />
            {usage && (
              <>
                <Row
                  label={t("account.effectiveLimit")}
                  value={`${usage.daily_limit} ${t("account.emailsWord")}`}
                />
                <Row
                  label={t("account.sentToday")}
                  value={t("account.ofLimit", {
                    sent: usage.emails_sent,
                    limit: usage.daily_limit,
                  })}
                />
              </>
            )}
          </dl>
          <p className="mt-4 text-xs leading-5 text-muted">
            {t("account.footnote1")}
            <Link
              href="/settings/usage"
              className="font-semibold text-accent"
            >
              {t("account.linkUsage")}
            </Link>{" "}
            {t("account.footnote2")}
            <Link
              href="/settings/data"
              className="font-semibold text-accent"
            >
              {t("account.linkData")}
            </Link>
            .
          </p>
        </Card>

        {hasSubscription && entitlements.subscription && (
          <Card className="mt-5 p-6">
            <p className="text-xs font-bold uppercase tracking-[0.1em] text-faint">
              {t("account.subscription")}
            </p>
            <dl className="mt-4 space-y-3 text-sm">
              <Row
                label={t("account.plan")}
                value={entitlements.subscription.plan}
              />
              <Row
                label={t("account.status")}
                value={entitlements.subscription.status}
              />
              <Row
                label={t("account.provider")}
                value={entitlements.subscription.provider}
              />
              <Row
                label={t("account.periodStart")}
                value={formatDate(
                  entitlements.subscription.current_period_start,
                )}
              />
              <Row
                label={t("account.periodEnd")}
                value={formatDate(entitlements.subscription.current_period_end)}
              />
              {entitlements.subscription.canceled_at && (
                <Row
                  label={t("account.canceledAt")}
                  value={formatDate(entitlements.subscription.canceled_at)}
                />
              )}
            </dl>
          </Card>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-line pb-2.5">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-xs font-semibold text-ink-soft">{value}</dd>
    </div>
  );
}
