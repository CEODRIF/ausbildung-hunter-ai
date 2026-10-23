"use client";

/**
 * Mock checkout form (client component, useActionState).
 *
 * Phase machine:
 *  1. select  — start the mock checkout (hidden plan_id + per-mount
 *     idempotency key).
 *  2. pending — three independent simulate forms (success / failed /
 *     canceled), all posting the server-side checkout id.
 *  3. result  — on a server-confirmed success the user is routed to the
 *     success page, which re-reads the server transaction state.
 *
 * When `enabled` is false (production / mock gate off) every control is
 * inert — no submission can reach the activation path.
 */

import Link from "next/link";
import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { useI18n } from "@/lib/i18n";
import type { CommercialPlanId } from "@/lib/billing/commercial-plans";
import {
  simulateMockPaymentAction,
  startMockCheckoutAction,
  type MockSimulateActionState,
  type MockStartActionState,
} from "../actions";

const SIMULATE_OUTCOMES = [
  { value: "success", labelKey: "simulateSuccess", primary: true },
  { value: "failed", labelKey: "simulateFailed", primary: false },
  { value: "canceled", labelKey: "simulateCanceled", primary: false },
] as const;

const SIM_ERROR_STATUSES: readonly string[] = [
  "unauthorized",
  "invalid_input",
  "mock_payments_disabled",
  "not_found",
  "terminal",
  "expired",
  "payment_failed",
  "canceled",
  "failed",
];

const START_ERROR_STATUSES: readonly string[] = [
  "unauthorized",
  "invalid_input",
  "mock_payments_disabled",
  "invalid_plan",
  "failed",
];

type SimulateActionState = MockSimulateActionState;

export function MockCheckoutForm({
  planId,
  enabled,
}: {
  planId: CommercialPlanId;
  enabled: boolean;
}) {
  const { t } = useI18n();
  const router = useRouter();

  const [startState, startForm, startPending] = useActionState<
    MockStartActionState,
    FormData
  >(startMockCheckoutAction, { status: "idle" });
  const [simState, simForm, simPending] = useActionState<
    SimulateActionState,
    FormData
  >(simulateMockPaymentAction, { status: "idle" });

  // Per-mount idempotency key: duplicate submissions resume the SAME
  // checkout row. Generated after mount (crypto.randomUUID is unavailable
  // during SSR) to avoid a hydration mismatch.
  const [idempotencyKey, setIdempotencyKey] = useState("");
  useEffect(() => {
    if (idempotencyKey === "") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setIdempotencyKey(crypto.randomUUID());
    }
  }, [idempotencyKey]);

  const pendingCheckout =
    startState.status === "created" || startState.status === "existing"
      ? startState
      : null;

  const succeeded =
    simState.status === "succeeded" || simState.status === "already_succeeded";

  useEffect(() => {
    if (
      simState.status === "succeeded" ||
      simState.status === "already_succeeded"
    ) {
      // The success page reads the server transaction state itself —
      // the URL alone grants nothing.
      router.push(
        `/settings/billing/checkout/success?checkout=${simState.checkoutId}`,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [simState.status]);

  const simError = !succeeded
    ? SIM_ERROR_STATUSES.includes(simState.status)
      ? simState.status
      : null
    : null;
  const startError =
    pendingCheckout === null && START_ERROR_STATUSES.includes(startState.status)
      ? startState.status
      : null;

  return (
    <div className="mt-5">
      {pendingCheckout === null ? (
        <form action={startForm} className="flex flex-wrap items-center gap-3">
          <input type="hidden" name="plan_id" value={planId} />
          <input type="hidden" name="idempotency_key" value={idempotencyKey} />
          <button
            type="submit"
            disabled={!enabled || startPending || idempotencyKey === ""}
            className="h-11 rounded-xl bg-accent px-5 text-sm font-semibold text-white hover:bg-accent-deep disabled:cursor-not-allowed disabled:opacity-50"
          >
            {startPending ? t("billing.checkout.startPending") : t("billing.checkout.startButton")}
          </button>
          <Link
            href="/settings/billing"
            className="text-xs font-semibold text-accent hover:underline"
          >
            {t("billing.checkout.backToBilling")}
          </Link>
          {startError && (
            <p className="w-full text-xs font-semibold text-danger">
              {t(`billing.errors.${startError}`)}
            </p>
          )}
        </form>
      ) : (
        <div className="rounded-2xl border border-line bg-surface p-5">
          <p className="text-sm font-bold text-ink">
            {t("billing.checkout.pendingTitle")}
          </p>
          <p className="mt-1 text-xs leading-5 text-muted">
            {t("billing.checkout.pendingNotice")}
          </p>
          {pendingCheckout.status === "existing" && (
            <p className="mt-2 text-xs font-semibold text-warning">
              {t("billing.checkout.duplicateNotice")}
            </p>
          )}

          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            {SIMULATE_OUTCOMES.map(({ value, labelKey, primary }) => (
              <form action={simForm} key={value}>
                <input
                  type="hidden"
                  name="checkout_id"
                  value={pendingCheckout.checkoutId}
                />
                <input type="hidden" name="outcome" value={value} />
                <button
                  type="submit"
                  disabled={!enabled || simPending}
                  className={`h-11 w-full rounded-xl px-4 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${
                    primary
                      ? "bg-accent text-white hover:bg-accent-deep"
                      : "border border-line bg-surface-2 text-ink-soft hover:bg-surface"
                  }`}
                >
                  {t(`billing.checkout.${labelKey}`)}
                </button>
              </form>
            ))}
          </div>

          {(startError || simError) && (
            <div className="mt-4">
              <p className="text-xs font-semibold text-danger">
                {t(`billing.errors.${simError ?? startError}`)}
              </p>
              <Link
                href="/settings/billing"
                className="mt-2 inline-block text-xs font-semibold text-accent hover:underline"
              >
                {t("billing.checkout.backToBilling")}
              </Link>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
