"use client";

/**
 * Trial CTA (client component, useActionState).
 *
 * The form submits NO identity data — the server action resolves the user
 * from the session (`supabase.auth.getUser()`) and re-checks every
 * eligibility rule (one trial per account, no active paid plan) inside
 * `activateTrial`. The states rendered here are display-only; a client that
 * tampers with them cannot grant anything.
 */

import { useActionState } from "react";

import { useI18n } from "@/lib/i18n";

import { activateTrialAction } from "./actions";

export function TrialActivationForm() {
  const { t } = useI18n();
  const [state, formAction, pending] = useActionState(
    activateTrialAction,
    { status: "idle" },
  );

  const message =
    state.status === "success"
      ? { tone: "text-success", text: t("billing.trial.resultActivated") }
      : state.status === "trial_used"
        ? { tone: "text-warning", text: t("billing.trial.resultTrialUsed") }
        : state.status === "paid_active"
          ? { tone: "text-warning", text: t("billing.trial.resultPaidActive") }
          : state.status === "failed" || state.status === "unauthorized"
            ? { tone: "text-danger", text: t("billing.trial.error") }
            : null;

  return (
    <form action={formAction}>
      <button
        type="submit"
        disabled={pending}
        className="h-11 w-full rounded-xl bg-accent px-4 text-sm font-semibold text-white hover:bg-accent-deep disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? t("billing.trial.ctaPending") : t("billing.trial.cta")}
      </button>
      {message && (
        <p className={`mt-2 text-xs font-semibold leading-5 ${message.tone}`}>
          {message.text}
        </p>
      )}
    </form>
  );
}
