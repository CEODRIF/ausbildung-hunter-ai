import Link from "next/link";
import { redirect } from "next/navigation";

import { Card } from "@/components/ui";
import { getCurrentUserAndProfile } from "@/lib/auth";
import {
  COMMERCIAL_PLAN_IDS,
  COMMERCIAL_PLANS,
  FEATURE_QUOTA_KIND,
  canonicalCommercialPlanId,
  type CommercialPlanId,
} from "@/lib/billing/commercial-plans";
import {
  ALL_FEATURE_IDS,
  getBillingStatus,
  type BillingStatus,
} from "@/lib/billing/entitlement-service";
import {
  getPaymentHistory,
  type GetPaymentHistoryResult,
} from "@/lib/billing/payment-history";
import { localeForLang, type TranslateVars } from "@/lib/i18n/core";
import { getServerT, getRequestLang } from "@/lib/i18n/server";

import { TrialActivationForm } from "./trial-activation-form";

export const dynamic = "force-dynamic";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-line pb-2.5">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-xs font-semibold text-ink-soft">{value}</dd>
    </div>
  );
}

/** Plain (non-component) helper: remaining time until the persisted period
 *  end, measured with the server clock (fresh per request — the page is
 *  force-dynamic, so no client cache is involved). The impure `Date.now()`
 *  lives HERE, outside the component body, so render stays pure under
 *  react-hooks/purity (same pattern as describePlanCell in
 *  admin/users/page.tsx and the campaign page's isFuture helper). */
function remainingLabel(
  t: (path: string, vars?: TranslateVars) => string,
  endMs: number | null,
): string {
  if (endMs === null) return "—";
  const ms = Math.max(0, endMs - Date.now());
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return t("billing.offers.remainingDays", { days });
  const hours = Math.max(1, Math.ceil(ms / 3_600_000));
  return t("billing.offers.remainingHours", { hours });
}

/**
 * Billing & plans — `/settings/billing`.
 *
 * Everything plan-related is SERVER-derived:
 *  - `getBillingStatus` performs one subscription lookup plus per-feature
 *    meter reads (never N+1 subscription lookups).
 *  - The offer cards are built from the typed plan catalogue — prices,
 *    durations, and limits are never client-supplied.
 *  - Trial activation goes through the `activateTrial` server action and
 *    upgrades through the mock checkout; the browser can express intent
 *    only, never grant itself entitlements.
 *
 * States:
 *  - loading   : `loading.tsx` sibling (shimmer skeleton).
 *  - error     : `getBillingStatus` threw → warning card; the static offer
 *                list stays visible, usage + trial CTA are hidden
 *                (fail closed).
 *  - empty     : no subscription row ("none") → free plan state, trial CTA
 *                available unless already used.
 *  - expired   : status `expired`/`canceled` → status chip + period dates,
 *                upgrade CTA on the paid offer cards.
 */
export default async function BillingSettingsPage() {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active")
    redirect("/login");

  const [t, lang] = await Promise.all([getServerT(), getRequestLang()]);
  const locale = localeForLang(lang);

  let billing: BillingStatus | null;
  try {
    billing = await getBillingStatus(user.id);
  } catch {
    billing = null; // degraded view below
  }

  // Read-only payment/subscription history (persisted rows only — the
  // facade never invents a transaction; failure = explicit unavailable
  // note, never empty-by-assumption).
  let history: GetPaymentHistoryResult;
  try {
    history = await getPaymentHistory(user.id);
  } catch {
    history = { ok: false, error: "failed" };
  }

  const priceUsd = (cents: number) =>
    `$${(cents / 100).toLocaleString(locale, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;

  const formatDate = (ms: number | null) =>
    ms !== null ? new Date(ms).toLocaleDateString(locale) : "—";

  const durationLabel = (planId: CommercialPlanId) => {
    const duration = COMMERCIAL_PLANS[planId].duration;
    switch (duration.kind) {
      case "fixed_hours":
        return t("billing.offers.durationHours", { hours: duration.hours });
      case "fixed_days":
        return t("billing.offers.durationDays", { days: duration.days });
      case "calendar_month":
        return t("billing.offers.durationCalendarMonth");
      default:
        return "—";
    }
  };

  const statusKey =
    billing?.status === "active"
      ? "statusActive"
      : billing?.status === "canceled"
        ? "statusCanceled"
        : billing?.status === "expired"
          ? "statusExpired"
          : "statusNone";

  // The commercial offer the user's ACTIVE subscription displays as —
  // server-resolved from the persisted row: plus → premium_10d,
  // pro → premium_monthly, commercial ids → themselves, else null.
  // This is the ONLY source that marks an offer card "current" (never
  // client selection or cached state).
  const canonicalPlan =
    billing !== null && billing.status === "active"
      ? canonicalCommercialPlanId(billing.planId)
      : null;

  const hasActivePaidPlan =
    canonicalPlan === "premium_10d" || canonicalPlan === "premium_monthly";

  const hasMeteredUsage =
    billing !== null &&
    ALL_FEATURE_IDS.some((fid) => {
      const kind = FEATURE_QUOTA_KIND[fid];
      if (kind === "none" || kind === "static_mb") return false;
      const entitlement = billing.features[fid];
      return (
        entitlement !== undefined &&
        entitlement.limit !== null &&
        entitlement.limit !== 0
      );
    });

  const usageCell = (fid: (typeof ALL_FEATURE_IDS)[number]) => {
    const entitlement = billing!.features[fid];
    if (!entitlement) return <span className="text-xs text-muted">—</span>;
    const kind = FEATURE_QUOTA_KIND[fid];
    if (kind === "none")
      return (
        <span className="text-xs text-muted">{t("billing.usage.noLimit")}</span>
      );
    if (kind === "static_mb")
      return (
        <span className="text-xs font-semibold text-ink-soft">
          {entitlement.limit !== null ? `${entitlement.limit} MB` : "—"}
        </span>
      );
    if (entitlement.limit === null)
      return (
        <span className="text-xs text-muted">{t("billing.usage.noLimit")}</span>
      );
    if (entitlement.limit === 0)
      return (
        <span className="text-xs text-muted">
          {t("billing.usage.disabled")}
        </span>
      );
    if (entitlement.reason === "lookup_error")
      return <span className="text-xs text-muted">—</span>;

    const percent =
      entitlement.limit > 0
        ? Math.min(
            100,
            Math.round((entitlement.used / entitlement.limit) * 100),
          )
        : 0;
    const resetKey =
      entitlement.resetsAt === null
        ? "noReset"
        : kind === "per_day"
          ? "resetsDaily"
          : "resetsOnExpiry";

    return (
      <div>
        <div className="flex items-center justify-between gap-3 text-xs">
          <span className="font-semibold text-ink-soft">
            {t("billing.usage.usedOf", {
              used: entitlement.used,
              limit: entitlement.limit,
            })}
          </span>
          <span className="text-faint">{t(`billing.usage.${resetKey}`)}</span>
        </div>
        <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-surface-2">
          <div
            className="h-full rounded-full bg-accent"
            style={{ width: `${percent}%` }}
          />
        </div>
        <p className="mt-1 text-[11px] text-faint">
          {t("billing.usage.remaining")}: {entitlement.remaining ?? 0}
        </p>
      </div>
    );
  };

  return (
    <div className="px-4 py-6 sm:px-6 lg:px-10">
      <div className="mx-auto max-w-3xl">
        {billing === null ? (
          <Card className="mb-5 border-warning/25 bg-warning-soft p-5">
            <p className="text-sm font-bold text-warning">
              {t("billing.offers.errorTitle")}
            </p>
            <p className="mt-1 text-xs leading-5 text-warning">
              {t("billing.offers.errorBody")}
            </p>
            <Link
              href="/settings/billing"
              className="mt-2 inline-block text-xs font-semibold text-warning underline"
            >
              {t("billing.offers.retry")}
            </Link>
          </Card>
        ) : billing.mockPaymentsEnabled ? (
          <Card className="mb-5 border-warning/25 bg-warning-soft p-5">
            <p className="text-sm font-bold text-warning">
              {t("billing.checkout.demoBanner")}
            </p>
            <p className="mt-1 text-xs leading-5 text-warning">
              {t("billing.checkout.simulatedNotice")}
            </p>
          </Card>
        ) : (
          <Card className="mb-5 border-line p-5">
            <p className="text-sm leading-5 text-muted">
              {t("billing.checkout.inertNotice")}
            </p>
          </Card>
        )}

        {billing !== null && (
          <Card className="p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.1em] text-faint">
                  {t("billing.currentPlan.title")}
                </p>
                <p className="mt-1 text-2xl font-bold text-ink">
                  {billing.planLabel}
                </p>
              </div>
              <span
                className={`rounded-lg px-2.5 py-1 text-xs font-bold ${
                  billing.status === "active"
                    ? "bg-success-soft text-success"
                    : "bg-surface-2 text-muted"
                }`}
              >
                {t(`billing.currentPlan.${statusKey}`)}
              </span>
            </div>

            <dl className="mt-6 space-y-3 text-sm">
              <Row
                label={t("billing.currentPlan.periodStart")}
                value={formatDate(billing.periodStartMs)}
              />
              <Row
                label={t("billing.currentPlan.periodEnd")}
                value={formatDate(billing.periodEndMs)}
              />
              <Row
                label={t("billing.currentPlan.remaining")}
                value={
                  billing.status === "active"
                    ? remainingLabel(t, billing.periodEndMs)
                    : "—"
                }
              />
              <Row
                label={t("billing.currentPlan.provider")}
                value={
                  billing.provider === "mock"
                    ? t("billing.currentPlan.providerMock")
                    : (billing.provider ?? "—")
                }
              />
              <Row
                label={t("billing.currentPlan.trial")}
                value={
                  billing.trialUsed
                    ? t("billing.currentPlan.trialUsed")
                    : t("billing.currentPlan.trialNotUsed")
                }
              />
            </dl>

            {billing.lookupFailed ? (
              <p className="mt-4 text-xs leading-5 text-warning">
                {t("billing.currentPlan.lookupFailed")}
              </p>
            ) : billing.provider === "mock" && billing.status === "active" ? (
              <p className="mt-4 text-xs leading-5 text-muted">
                {t("billing.currentPlan.mockNotice")}
              </p>
            ) : null}

            <div className="mt-5 flex items-center justify-between gap-4 border-t border-line pt-4">
              <span className="text-xs text-muted">
                {t("billing.currentPlan.upgradeTitle")}
              </span>
              <Link
                href="/settings/billing/checkout?plan=premium_10d"
                className="text-xs font-semibold text-accent hover:underline"
              >
                {t("billing.currentPlan.upgradeLink")}
              </Link>
            </div>
          </Card>
        )}

        <section className="mt-5">
          <h2 className="text-xs font-bold uppercase tracking-[0.1em] text-faint">
            {t("billing.offers.sectionTitle")}
          </h2>
          <div className="mt-3 grid gap-4 lg:grid-cols-3">
            {COMMERCIAL_PLAN_IDS.map((planId) => {
              const plan = COMMERCIAL_PLANS[planId];
              // Server-derived only: the persisted row's plan (plus →
              // premium_10d, pro → premium_monthly) while active.
              const isCurrent = canonicalPlan === planId;
              return (
                <Card
                  key={planId}
                  className={`flex flex-col p-5 ${
                    isCurrent ? "border-success ring-1 ring-success/30" : ""
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <h3 className="text-base font-bold text-ink">
                        {plan.marketing.title}
                      </h3>
                      <p className="mt-1 text-xs leading-5 text-muted">
                        {plan.marketing.tagline}
                      </p>
                    </div>
                    {isCurrent && (
                      <span className="shrink-0 rounded-lg bg-success-soft px-2 py-0.5 text-[10px] font-bold text-success">
                        {t("billing.offers.yourActivePlan")}
                      </span>
                    )}
                  </div>

                  <p className="mt-4 text-2xl font-bold text-ink">
                    {plan.priceCents === 0
                      ? t("billing.offers.freePrice")
                      : priceUsd(plan.priceCents)}
                  </p>
                  <p className="mt-0.5 text-xs text-muted">
                    {durationLabel(planId)}
                  </p>

                  {isCurrent && billing !== null && (
                    // Actual persisted period (never client state):
                    // start, end and remaining time of the active plan.
                    <div className="mt-3 space-y-0.5 rounded-lg bg-surface-2 px-3 py-2 text-[11px] leading-5">
                      <p className="text-muted">
                        {t("billing.currentPlan.periodStart")}:{" "}
                        <span className="font-semibold text-ink-soft">
                          {formatDate(billing.periodStartMs)}
                        </span>
                      </p>
                      <p className="text-muted">
                        {t("billing.currentPlan.periodEnd")}:{" "}
                        <span className="font-semibold text-ink-soft">
                          {formatDate(billing.periodEndMs)}
                        </span>
                      </p>
                      <p className="text-muted">
                        {t("billing.offers.remaining")}:{" "}
                        <span className="font-semibold text-success">
                          {remainingLabel(t, billing.periodEndMs)}
                        </span>
                      </p>
                    </div>
                  )}

                  <ul className="mt-4 flex-1 space-y-1.5">
                    {plan.marketing.bullets.map((bullet) => (
                      <li
                        key={bullet}
                        className="text-xs leading-5 text-ink-soft"
                      >
                        • {bullet}
                      </li>
                    ))}
                  </ul>

                  <div className="mt-5">
                    {planId === "trial" ? (
                      billing === null ||
                      billing.lookupFailed ? null : isCurrent ? null : !billing.trialUsed ? (
                        <TrialActivationForm />
                      ) : hasActivePaidPlan ? (
                        <p className="text-xs leading-5 text-muted">
                          {t("billing.trial.resultPaidActive")}
                        </p>
                      ) : (
                        <p className="text-xs leading-5 text-muted">
                          {t("billing.trial.resultTrialUsed")}
                        </p>
                      )
                    ) : isCurrent ? (
                      // Non-purchasing "current plan" state: the active
                      // offer is highlighted, never re-purchasable from
                      // its own card.
                      <div
                        aria-disabled="true"
                        className="block h-11 rounded-xl bg-success-soft text-center text-sm font-semibold leading-[2.75rem] text-success"
                      >
                        {t("billing.offers.current")}
                      </div>
                    ) : (
                      <Link
                        href={`/settings/billing/checkout?plan=${planId}`}
                        className="block h-11 rounded-xl border border-accent text-center text-sm font-semibold leading-[2.75rem] text-accent hover:bg-accent hover:text-white"
                      >
                        {t("billing.offers.choose")}
                      </Link>
                    )}
                  </div>
                </Card>
              );
            })}
          </div>
        </section>

        {(() => {
          const h = history.ok ? history.history : null;
          const onlineStatusKey = (s: string) =>
            s === "succeeded"
              ? "statusSucceeded"
              : s === "failed"
                ? "statusFailed"
                : s === "canceled"
                  ? "statusCanceled"
                  : s === "expired"
                    ? "statusExpired"
                    : "statusPending";
          const manualActionKey = (a: string) =>
            a === "reactivate_subscription"
              ? "actionReactivate"
              : a === "cancel_subscription"
                ? "actionCancel"
                : "actionGrant";
          return (
            <section className="mt-6">
              <Card className="p-6">
                <h2 className="text-xs font-bold uppercase tracking-[0.1em] text-faint">
                  {t("billing.history.title")}
                </h2>
                {h === null ? (
                  <p className="mt-3 text-xs leading-5 text-muted">
                    {t("billing.history.unavailable")}
                  </p>
                ) : (
                  <>
                    {!h.providerConfigured && (
                      <p className="mt-3 text-xs leading-5 text-muted">
                        {t("billing.history.noProvider")}
                      </p>
                    )}
                    <h3 className="mt-5 text-xs font-bold uppercase tracking-[0.08em] text-faint">
                      {t("billing.history.onlineTitle")}
                    </h3>
                    {h.onlinePayments.length === 0 ? (
                      <p className="mt-2 text-xs leading-5 text-muted">
                        {t("billing.history.onlineEmpty")}
                      </p>
                    ) : (
                      <ul className="mt-2 space-y-2">
                        {h.onlinePayments.map((p) => (
                          <li
                            key={p.id}
                            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line px-3 py-2"
                          >
                            <span className="text-xs font-semibold text-ink-soft">
                              {p.planId} · {priceUsd(p.amountCents)} ·{" "}
                              {t("billing.history.simulated")}
                            </span>
                            <span className="text-xs text-muted">
                              {t(
                                `billing.history.${onlineStatusKey(p.status)}`,
                              )}{" "}
                              · {formatDate(p.createdAtMs)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                    <h3 className="mt-5 text-xs font-bold uppercase tracking-[0.08em] text-faint">
                      {t("billing.history.manualTitle")}
                    </h3>
                    {h.manualGrants.length === 0 ? (
                      <p className="mt-2 text-xs leading-5 text-muted">
                        {t("billing.history.manualEmpty")}
                      </p>
                    ) : (
                      <ul className="mt-2 space-y-2">
                        {h.manualGrants.map((g, i) => (
                          <li
                            key={`${g.createdAtMs}-${i}`}
                            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line px-3 py-2"
                          >
                            <span className="text-xs font-semibold text-ink-soft">
                              {t(
                                `billing.history.${manualActionKey(g.action)}`,
                              )}
                              {g.plan
                                ? ` — ${g.plan}${
                                    g.periodDays !== null
                                      ? ` · ${t("billing.history.periodDays", { days: g.periodDays })}`
                                      : ""
                                  }`
                                : ""}
                            </span>
                            <span className="text-xs text-muted">
                              {formatDate(g.createdAtMs)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </Card>
            </section>
          );
        })()}
        {billing !== null && !billing.lookupFailed && (
          <section className="mt-6">
            <Card className="p-6">
              <h2 className="text-xs font-bold uppercase tracking-[0.1em] text-faint">
                {t("billing.usage.title")}
              </h2>
              {hasMeteredUsage ? (
                <dl className="mt-4 space-y-4">
                  {ALL_FEATURE_IDS.map((fid) => (
                    <div
                      key={fid}
                      className="grid gap-1 sm:grid-cols-[190px_1fr] sm:items-center sm:gap-4"
                    >
                      <dt className="text-xs text-muted">
                        {t(`billing.featureNames.${fid}`)}
                      </dt>
                      <dd>{usageCell(fid)}</dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p className="mt-3 text-xs leading-5 text-muted">
                  {t("billing.offers.usageEmpty")}
                </p>
              )}
              <p className="mt-5 text-xs leading-5 text-muted">
                {t("account.footnote1")}{" "}
                <Link
                  href="/settings/usage"
                  className="font-semibold text-accent"
                >
                  {t("account.linkUsage")}
                </Link>{" "}
                {t("account.footnote2")}{" "}
                <Link
                  href="/settings/data"
                  className="font-semibold text-accent"
                >
                  {t("account.linkData")}
                </Link>
                .
              </p>
            </Card>
          </section>
        )}
      </div>
    </div>
  );
}
