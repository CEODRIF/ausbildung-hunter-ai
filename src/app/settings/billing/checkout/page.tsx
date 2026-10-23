import Link from "next/link";
import { redirect } from "next/navigation";

import { Card } from "@/components/ui";
import { getCurrentUserAndProfile } from "@/lib/auth";
import {
  FEATURE_QUOTA_KIND,
  getCommercialPlan,
  type CommercialPlanId,
  type FeatureId,
  type QuotaKind,
} from "@/lib/billing/commercial-plans";
import { mockPaymentsEnabled } from "@/lib/billing/entitlement-service";
import { getServerT, getRequestLang } from "@/lib/i18n/server";
import { localeForLang } from "@/lib/i18n/core";

import { MockCheckoutForm } from "./mock-checkout-form";

export const dynamic = "force-dynamic";

type CheckoutPageProps = {
  searchParams: Promise<{ plan?: string }>;
};

/** Curated key limits shown on the checkout summary (spec §8). */
const KEY_FEATURES: FeatureId[] = [
  "automation",
  "ai_assistant",
  "cover_letter",
  "email_drafts",
  "opportunity_search",
];

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-line pb-2.5">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-xs font-semibold text-ink-soft">{value}</dd>
    </div>
  );
}

/**
 * Mock checkout — `/settings/billing/checkout`.
 *
 * The plan, price, duration, and limits shown here all come from the typed
 * server plan catalogue. The browser may request a plan id via query param,
 * but the price is never client-supplied. In production the mock gate is
 * off and the form renders inert (no entitlement activation possible).
 */
export default async function CheckoutPage({ searchParams }: CheckoutPageProps) {
  const params = await searchParams;
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active")
    redirect("/login");

  const requested = typeof params.plan === "string" ? params.plan : undefined;
  let planId: CommercialPlanId;
  if (requested === undefined) {
    planId = "premium_10d";
  } else if (requested === "premium_10d" || requested === "premium_monthly") {
    planId = requested;
  } else {
    // Unknown, non-commercial, or trial plans have no checkout route.
    redirect("/settings/billing");
  }

  const plan = getCommercialPlan(planId);
  const mockEnabled = mockPaymentsEnabled();

  const [t, lang] = await Promise.all([getServerT(), getRequestLang()]);
  const locale = localeForLang(lang);

  const priceUsd = (cents: number) =>
    `$${(cents / 100).toLocaleString(locale, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;

  let durationLabel: string;
  switch (plan.duration.kind) {
    case "fixed_days":
      durationLabel = t("billing.checkout.durationFixedDays", {
        days: plan.duration.days,
      });
      break;
    case "calendar_month":
      durationLabel = t("billing.checkout.durationCalendarMonth");
      break;
    default:
      durationLabel = "—";
  }

  const formatLimit = (
    limit: number | null | undefined,
    kind: QuotaKind,
  ): string => {
    if (limit === null || limit === undefined || kind === "none")
      return t("billing.checkout.unlimited");
    if (limit === 0) return t("billing.checkout.disabled");
    switch (kind) {
      case "per_day":
        return t("billing.checkout.perDay", { value: limit });
      case "per_cycle":
        return t("billing.checkout.perCycle", { value: limit });
      case "items":
        return t("billing.checkout.items", { value: limit });
      case "static_mb":
        return t("billing.checkout.mb", { value: limit });
      default:
        return t("billing.checkout.unlimited");
    }
  };

  return (
    <div className="px-4 py-6 sm:px-6 lg:px-10">
      <div className="mx-auto max-w-3xl">
        <div className="mb-6 flex items-center justify-between gap-4">
          <h1 className="text-2xl font-bold text-ink">
            {t("billing.checkout.pageTitle")}
          </h1>
          <Link
            href="/settings/billing"
            className="text-xs font-semibold text-accent hover:underline"
          >
            {t("billing.checkout.backToBilling")}
          </Link>
        </div>

        {mockEnabled ? (
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

        <Card className="p-6">
          <p className="text-xs font-bold uppercase tracking-[0.1em] text-faint">
            {t("billing.checkout.summaryTitle")}
          </p>
          <h2 className="mt-1 text-xl font-bold text-ink">
            {plan.marketing.title}
          </h2>
          <p className="mt-1 text-sm text-muted">{plan.marketing.tagline}</p>

          <dl className="mt-5 space-y-3 text-sm">
            <Row
              label={t("billing.checkout.priceLabel")}
              value={priceUsd(plan.priceCents)}
            />
            <Row
              label={t("billing.checkout.durationLabel")}
              value={durationLabel}
            />
            <div className="border-b border-line pb-2.5">
              <dt className="text-xs font-bold uppercase tracking-[0.1em] text-faint">
                {t("billing.checkout.keyLimits")}
              </dt>
            </div>
            {KEY_FEATURES.map((fid) => (
              <Row
                key={fid}
                label={t(`billing.featureNames.${fid}`)}
                value={formatLimit(
                  plan.featureLimits[fid],
                  FEATURE_QUOTA_KIND[fid],
                )}
              />
            ))}
            <div className="flex items-center justify-between gap-4 pt-1">
              <dt className="text-xs font-bold text-ink">
                {t("billing.checkout.totalDue")}
              </dt>
              <dd className="text-lg font-bold text-ink">
                {priceUsd(plan.priceCents)}
              </dd>
            </div>
          </dl>
        </Card>

        <MockCheckoutForm planId={planId} enabled={mockEnabled} />
      </div>
    </div>
  );
}
