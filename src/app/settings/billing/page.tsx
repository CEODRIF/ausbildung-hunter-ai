import Link from "next/link";
import { redirect } from "next/navigation";
import { Card } from "@/components/ui";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { getEntitlements } from "@/lib/billing/entitlements";
import { getBillingProvider } from "@/lib/billing/provider";
import { getUsageSnapshot } from "@/lib/email-campaigns";

export const dynamic = "force-dynamic";

/** Phase 10 — billing status (server-derived). Nothing about the plan or
 *  entitlements is accepted from the browser. */
export default async function BillingSettingsPage() {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active")
    redirect("/login");

  const [entitlements, usage] = await Promise.all([
    getEntitlements(user.id),
    getUsageSnapshot(user.id).catch(() => null),
  ]);
  const provider = getBillingProvider();
  const hasSubscription = entitlements.subscription !== null;
  const isCurrent =
    entitlements.source === "subscription" &&
    entitlements.subscription?.status === "active";

  const formatDate = (value: string | null) =>
    value ? new Date(value).toLocaleDateString("de-DE") : "—";

  return (
    <main className="min-h-screen bg-[#f6f8fb] px-5 py-8 sm:px-8 lg:px-10">
      <div className="mx-auto max-w-3xl">
        <Link
          href="/dashboard"
          className="text-sm font-semibold text-[#2f6fed]"
        >
          ← Back to dashboard
        </Link>
        <div className="mt-8">
          <p className="text-sm font-semibold text-[#2f6fed]">Settings</p>
          <h1 className="mt-2 text-3xl font-bold tracking-[-0.04em] text-[#10203b]">
            Billing
          </h1>
          <p className="mt-2 text-sm text-[#71819a]">
            Plan and entitlements are calculated server-side.
          </p>
        </div>

        {!provider.configured && (
          <Card className="mt-8 border-[#f0d9b5] bg-[#fff8ef] p-5">
            <p className="text-sm font-bold text-[#a3611c]">
              Billing provider not configured
            </p>
            <p className="mt-1 text-xs leading-5 text-[#8a6a3b]">
              No payment provider is connected. Plans are currently managed
              manually by an administrator. The webhook endpoint answers 501
              until a provider is configured.
            </p>
          </Card>
        )}

        <Card className="mt-5 p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.1em] text-[#8b9ab0]">
                Current plan
              </p>
              <p className="mt-1 text-2xl font-bold text-[#10203b]">
                {entitlements.planLabel}
              </p>
            </div>
            <span
              className={`rounded-lg px-2.5 py-1 text-xs font-bold ${
                isCurrent
                  ? "bg-[#eaf8f3] text-[#1b9b70]"
                  : "bg-[#f4f7fc] text-[#546783]"
              }`}
            >
              {isCurrent
                ? "Active subscription"
                : entitlements.source === "default"
                  ? "Default (Free)"
                  : `Subscription ${entitlements.subscription?.status ?? ""}`}
            </span>
          </div>

          <dl className="mt-6 space-y-3 text-sm">
            <Row
              label="Plan base — emails/day"
              value={String(entitlements.emailsPerDay)}
            />
            <Row
              label="Plan base — AI requests/day"
              value={String(entitlements.aiPerDay)}
            />
            {usage && (
              <>
                <Row
                  label="Effective email limit today (incl. upgrades)"
                  value={`${usage.daily_limit} emails`}
                />
                <Row
                  label="Emails sent today"
                  value={`${usage.emails_sent} of ${usage.daily_limit}`}
                />
              </>
            )}
          </dl>
          <p className="mt-4 text-xs leading-5 text-[#8290a4]">
            Invitation-code quota upgrades apply on top of the plan base.
            Details:{" "}
            <Link
              href="/settings/usage"
              className="font-semibold text-[#2f6fed]"
            >
              Usage &amp; limits
            </Link>{" "}
            · Export your data or delete your account under{" "}
            <Link
              href="/settings/data"
              className="font-semibold text-[#2f6fed]"
            >
              Data &amp; privacy
            </Link>
            .
          </p>
        </Card>

        {hasSubscription && entitlements.subscription && (
          <Card className="mt-5 p-6">
            <p className="text-xs font-bold uppercase tracking-[0.1em] text-[#8b9ab0]">
              Subscription
            </p>
            <dl className="mt-4 space-y-3 text-sm">
              <Row label="Plan" value={entitlements.subscription.plan} />
              <Row label="Status" value={entitlements.subscription.status} />
              <Row
                label="Provider"
                value={entitlements.subscription.provider}
              />
              <Row
                label="Period start"
                value={formatDate(
                  entitlements.subscription.current_period_start,
                )}
              />
              <Row
                label="Period end"
                value={formatDate(entitlements.subscription.current_period_end)}
              />
              {entitlements.subscription.canceled_at && (
                <Row
                  label="Canceled at"
                  value={formatDate(entitlements.subscription.canceled_at)}
                />
              )}
            </dl>
          </Card>
        )}
      </div>
    </main>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-[#f0f3f7] pb-2.5">
      <dt className="text-xs text-[#8492a7]">{label}</dt>
      <dd className="text-xs font-semibold text-[#1d3458]">{value}</dd>
    </div>
  );
}
