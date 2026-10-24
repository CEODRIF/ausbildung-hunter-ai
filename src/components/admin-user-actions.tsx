"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n";

export type AdminUserRow = {
  id: string;
  email: string;
  is_admin: boolean;
  subscription: {
    plan: string;
    status: string;
    provider: string | null;
    current_period_start: string | null;
    current_period_end: string | null;
    canceled_at: string | null;
    trial_activated_at: string | null;
  } | null;
};

type Result = { kind: "ok" | "error"; message: string } | null;

interface PendingAction {
  action: string;
  /** i18n key of the button label — shown in the confirmation so the
   *  administrator sees exactly which action on which user they approve. */
  labelKey: string;
  /** Detail line (plan + duration / current plan) — the confirmation must
   *  identify target e-mail, plan, duration AND the exact action. */
  detailKey?: string;
  detailVars?: Record<string, string | number>;
  extra: { plan?: string; periodDays?: number };
}

/** Client-side action buttons for the admin table. The ACTOR identity is
 *  never sent: the API route derives it from the authenticated session.
 *  Only the action + documented parameters travel in the body (strict
 *  schema on the server; the server also re-validates plan and duration).
 *
 *  Two-step confirmation: EVERY access-changing action first shows an
 *  inline confirmation naming the TARGET user's e-mail, the action AND
 *  its details (plan + duration); only the explicit second click fires
 *  the request (exactly one — the busy guard blocks repeats). This guards
 *  against acting on the wrong row (wrong-user subscriptions must be
 *  resolved deliberately — never by accident, and never by automatic
 *  reassignment).
 *
 *  Reactivation reuses the user's PREVIOUS plan when it was a plus/pro
 *  grant (otherwise the historic default: plus). */
export function AdminUserActions({
  actorId,
  row,
}: {
  actorId: string;
  row: AdminUserRow;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [result, setResult] = useState<Result>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingAction | null>(null);

  const previousPlan =
    row.subscription?.plan === "plus" || row.subscription?.plan === "pro"
      ? row.subscription.plan
      : "plus";

  const call = async (
    action: string,
    extra: { plan?: string; periodDays?: number } = {},
  ) => {
    setBusy(true);
    setResult(null);
    try {
      const response = await fetch(`/api/admin/users/${row.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, ...extra }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
      };
      setResult(
        response.ok
          ? { kind: "ok", message: data.message ?? t("admin.done") }
          : {
              kind: "error",
              message:
                data.error === "self_revoke_blocked"
                  ? t("admin.selfRevoke")
                  : data.error === "no_subscription"
                    ? t("admin.noSubscription")
                    : data.error === "rpc_unavailable"
                      ? t("admin.rpcUnavailable")
                      : data.error === "audit_failed"
                        ? t("admin.auditFailed")
                        : t("admin.actionFailed", {
                            error: data.error ?? String(response.status),
                          }),
            },
      );
      if (response.ok) {
        // Re-render the server data: the table must reflect the new
        // canonical subscription state immediately (no stale row).
        router.refresh();
      }
    } catch {
      setResult({ kind: "error", message: t("admin.networkError") });
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (!pending) return;
    const action = pending;
    setPending(null);
    await call(action.action, action.extra);
  };

  const button =
    "rounded-lg border border-line-strong bg-surface px-2.5 py-1.5 text-xs font-semibold text-ink-soft hover:bg-surface-2 disabled:opacity-50";

  const actionButton = (
    action: string,
    labelKey: string,
    extra: { plan?: string; periodDays?: number },
    detailKey?: string,
    detailVars?: Record<string, string | number>,
    className = "",
  ) => (
    <button
      type="button"
      className={`${button} ${className}`}
      disabled={busy}
      onClick={() => {
        setResult(null);
        setPending({ action, labelKey, extra, detailKey, detailVars });
      }}
    >
      {t(labelKey)}
    </button>
  );

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {actionButton(
          "set_plan",
          "admin.plus30",
          { plan: "plus", periodDays: 30 },
          "admin.detailPlan",
          { plan: "Plus", days: 30 },
        )}
        {actionButton(
          "set_plan",
          "admin.pro30",
          { plan: "pro", periodDays: 30 },
          "admin.detailPlan",
          { plan: "Pro", days: 30 },
        )}
        {row.subscription &&
          row.subscription.status === "active" &&
          actionButton(
            "cancel_subscription",
            "admin.cancelSub",
            {},
            "admin.detailCancel",
            { plan: row.subscription.plan },
          )}
        {row.subscription &&
          row.subscription.status !== "active" &&
          actionButton(
            "reactivate_subscription",
            "admin.reactivate",
            { plan: previousPlan, periodDays: 30 },
            "admin.detailPlan",
            { plan: previousPlan === "pro" ? "Pro" : "Plus", days: 30 },
          )}
        {row.is_admin ? (
          row.id === actorId ? (
            <span className="text-[10px] font-semibold text-faint">
              {t("admin.you")}
            </span>
          ) : (
            actionButton(
              "revoke_admin",
              "admin.revokeAdmin",
              {},
              undefined,
              undefined,
              "text-danger",
            )
          )
        ) : (
          actionButton(
            "grant_admin",
            "admin.grantAdmin",
            {},
            undefined,
            undefined,
            "text-ai",
          )
        )}
        {result && (
          <span
            className={`text-xs font-semibold ${
              result.kind === "ok" ? "text-success" : "text-danger"
            }`}
            role="status"
          >
            {result.message}
          </span>
        )}
      </div>
      {pending && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-warning/40 bg-warning-soft px-3 py-2">
          <span className="text-xs font-semibold text-warning">
            {t("admin.confirmBody", {
              email: row.email,
              action: t(pending.labelKey),
            })}
            {pending.detailKey && (
              <span className="block font-normal">
                {t("admin.confirmDetail", {
                  detail: t(pending.detailKey, pending.detailVars ?? {}),
                })}
              </span>
            )}
          </span>
          <button
            type="button"
            className="rounded-lg bg-warning px-2.5 py-1 text-xs font-bold text-white disabled:opacity-50"
            disabled={busy}
            onClick={confirm}
          >
            {t("admin.confirmYes")}
          </button>
          <button
            type="button"
            className={button}
            disabled={busy}
            onClick={() => setPending(null)}
          >
            {t("admin.confirmNo")}
          </button>
        </div>
      )}
    </div>
  );
}
