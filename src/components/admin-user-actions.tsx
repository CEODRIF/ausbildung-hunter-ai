"use client";

import { useState } from "react";
import { useI18n } from "@/lib/i18n";

export type AdminUserRow = {
  id: string;
  email: string;
  is_admin: boolean;
  subscription: { plan: string; status: string } | null;
};

type Result = { kind: "ok" | "error"; message: string } | null;

interface PendingAction {
  action: string;
  /** i18n key of the button label — shown in the confirmation so the
   *  administrator sees exactly which action on which user they approve. */
  labelKey: string;
  extra: { plan?: string; periodDays?: number };
}

/** Client-side action buttons for the admin table. The ACTOR identity is
 *  never sent: the API route derives it from the authenticated session.
 *  Only the action + documented parameters travel in the body (strict
 *  schema on the server).
 *
 *  Two-step confirmation: EVERY access-changing action first shows an
 *  inline confirmation naming the TARGET user's e-mail and the action;
 *  only the explicit second click fires the request. This guards against
 *  acting on the wrong row (wrong-user subscriptions must be resolved
 *  deliberately — never by accident, and never by automatic reassignment). */
export function AdminUserActions({
  actorId,
  row,
}: {
  actorId: string;
  row: AdminUserRow;
}) {
  const { t } = useI18n();
  const [result, setResult] = useState<Result>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingAction | null>(null);

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
                    : t("admin.actionFailed", {
                        error: data.error ?? String(response.status),
                      }),
            },
      );
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
    className = "",
  ) => (
    <button
      type="button"
      className={`${button} ${className}`}
      disabled={busy}
      onClick={() => {
        setResult(null);
        setPending({ action, labelKey, extra });
      }}
    >
      {t(labelKey)}
    </button>
  );

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {actionButton("set_plan", "admin.plus30", { plan: "plus", periodDays: 30 })}
        {actionButton("set_plan", "admin.pro30", { plan: "pro", periodDays: 30 })}
        {row.subscription && row.subscription.status === "active" &&
          actionButton("cancel_subscription", "admin.cancelSub", {})}
        {row.subscription && row.subscription.status !== "active" &&
          actionButton("reactivate_subscription", "admin.reactivate", {
            plan: "plus",
            periodDays: 30,
          })}
        {row.is_admin ? (
          row.id === actorId ? (
            <span className="text-[10px] font-semibold text-faint">
              {t("admin.you")}
            </span>
          ) : (
            actionButton("revoke_admin", "admin.revokeAdmin", {}, "text-danger")
          )
        ) : (
          actionButton("grant_admin", "admin.grantAdmin", {}, "text-ai")
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
