import Link from "next/link";
import { redirect } from "next/navigation";

import { Card } from "@/components/ui";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { getMockCheckout } from "@/lib/billing/mock-checkout";
import { getBillingStatus } from "@/lib/billing/entitlement-service";
import { getServerT, getRequestLang } from "@/lib/i18n/server";
import { localeForLang } from "@/lib/i18n/core";

export const dynamic = "force-dynamic";

type SuccessPageProps = {
  searchParams: Promise<{ checkout?: string }>;
};

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-line pb-2.5">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-xs font-semibold text-ink-soft">{value}</dd>
    </div>
  );
}

/**
 * Mock checkout result — `/settings/billing/checkout/success`.
 *
 * This page NEVER activates a plan: it only reads the stored server-side
 * transaction (user-scoped SELECT, mock rows only) and the current
 * entitlement state. Visiting the URL with an arbitrary or guessed
 * checkout id shows "not found" — a success URL alone grants nothing.
 */
export default async function CheckoutSuccessPage({
  searchParams,
}: SuccessPageProps) {
  const params = await searchParams;
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active")
    redirect("/login");

  const checkoutId = typeof params.checkout === "string" ? params.checkout : "";

  const [record, billing, t, lang] = await Promise.all([
    getMockCheckout(user.id, checkoutId),
    getBillingStatus(user.id),
    getServerT(),
    getRequestLang(),
  ]);
  const locale = localeForLang(lang);

  const fmtDate = (ms: number | null) =>
    ms === null
      ? "—"
      : new Date(ms).toLocaleDateString(locale, {
          year: "numeric",
          month: "short",
          day: "numeric",
        });
  const fmtDateTime = (ms: number | null) =>
    ms === null
      ? "—"
      : new Date(ms).toLocaleString(locale, {
          year: "numeric",
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });

  // Resolve the panel. Any failed read (not_found, invalid_input, or a DB
  // error) renders the neutral not-found panel — never a success state.
  const notFound = !record.ok;
  const panel = notFound
    ? {
        tone: "neutral" as const,
        title: t("billing.success.notFoundTitle"),
        body: t("billing.success.notFoundBody"),
      }
    : (() => {
        switch (record.checkout.status) {
          case "succeeded":
            return {
              tone: "success" as const,
              title: t("billing.success.succeededTitle"),
              body: t("billing.success.succeededBody"),
            };
          case "pending":
            return {
              tone: "neutral" as const,
              title: t("billing.success.pendingTitle"),
              body: t("billing.success.pendingBody"),
            };
          case "failed":
            return {
              tone: "error" as const,
              title: t("billing.success.failedTitle"),
              body: t("billing.success.failedBody"),
            };
          case "canceled":
            return {
              tone: "neutral" as const,
              title: t("billing.success.canceledTitle"),
              body: t("billing.success.canceledBody"),
            };
          case "expired":
            return {
              tone: "error" as const,
              title: t("billing.success.expiredTitle"),
              body: t("billing.success.expiredBody"),
            };
        }
      })();

  const statusKey =
    billing.status === "active"
      ? "statusActive"
      : billing.status === "canceled"
        ? "statusCanceled"
        : billing.status === "expired"
          ? "statusExpired"
          : "statusNone";

  return (
    <div className="px-4 py-6 sm:px-6 lg:px-10">
      <div className="mx-auto max-w-3xl">
        <div className="mb-6 flex items-center justify-between gap-4">
          <h1 className="text-2xl font-bold text-ink">
            {t("billing.success.pageTitle")}
          </h1>
          <Link
            href="/settings/billing"
            className="text-xs font-semibold text-accent hover:underline"
          >
            {t("billing.success.backToBilling")}
          </Link>
        </div>

        {/* This is a mock transaction — the label is shown on every panel. */}
        <Card className="mb-5 border-warning/25 bg-warning-soft p-5">
          <p className="text-sm font-bold text-warning">
            {t("billing.success.mockLabel")}
          </p>
          <p className="mt-1 text-xs leading-5 text-warning">
            {t("billing.success.mockDisclaimer")}
          </p>
        </Card>

        <Card
          className={`p-6 ${
            panel.tone === "success"
              ? "border-success/25 bg-success-soft"
              : panel.tone === "error"
                ? "border-danger/25 bg-danger-soft"
                : ""
          }`}
        >
          <h2
            className={`text-lg font-bold ${
              panel.tone === "success"
                ? "text-success"
                : panel.tone === "error"
                  ? "text-danger"
                  : "text-ink"
            }`}
          >
            {panel.title}
          </h2>
          <p className="mt-1 text-sm leading-6 text-ink-soft">{panel.body}</p>
        </Card>

        {!notFound && (
          <Card className="mt-5 p-6">
            <dl className="space-y-3 text-sm">
              <Row
                label={t("billing.success.amount")}
                value={`$${(record.checkout.amountCents / 100).toLocaleString(
                  locale,
                  { minimumFractionDigits: 2, maximumFractionDigits: 2 },
                )} USD (mock)`}
              />
              <Row
                label={t("billing.success.expiresAt")}
                value={fmtDateTime(record.checkout.expiresAtMs)}
              />
            </dl>
          </Card>
        )}

        <Card className="mt-5 p-6">
          <p className="text-xs font-bold uppercase tracking-[0.1em] text-faint">
            {t("billing.success.currentPlan")}
          </p>
          <dl className="mt-4 space-y-3 text-sm">
            <Row
              label={t("billing.success.plan")}
              value={
                billing.lookupFailed
                  ? t("billing.currentPlan.lookupFailed")
                  : billing.planLabel
              }
            />
            <Row
              label={t("billing.success.status")}
              value={billing.lookupFailed ? "—" : t(`billing.currentPlan.${statusKey}`)}
            />
            <Row
              label={t("billing.success.provider")}
              value={
                billing.provider === null
                  ? "—"
                  : billing.provider === "mock"
                    ? t("billing.success.providerMock")
                    : billing.provider
              }
            />
            <Row
              label={t("billing.success.periodStart")}
              value={fmtDate(billing.periodStartMs)}
            />
            <Row
              label={t("billing.success.periodEnd")}
              value={fmtDate(billing.periodEndMs)}
            />
          </dl>
          {billing.lookupFailed && (
            <p className="mt-3 text-xs leading-5 text-danger">
              {t("billing.currentPlan.lookupFailed")}
            </p>
          )}
        </Card>
      </div>
    </div>
  );
}
