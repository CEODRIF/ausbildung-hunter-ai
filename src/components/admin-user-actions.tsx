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

/** Client-side action buttons for the admin table. The ACTOR identity is
 *  never sent: the API route derives it from the authenticated session.
 *  Only the action + documented parameters travel in the body (strict
 *  schema on the server). */
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

  const button =
    "rounded-lg border border-line-strong bg-surface px-2.5 py-1.5 text-xs font-semibold text-ink-soft hover:bg-surface-2 disabled:opacity-50";

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <button
        type="button"
        className={button}
        disabled={busy}
        onClick={() => call("set_plan", { plan: "plus", periodDays: 30 })}
      >
        {t("admin.plus30")}
      </button>
      <button
        type="button"
        className={button}
        disabled={busy}
        onClick={() => call("set_plan", { plan: "pro", periodDays: 30 })}
      >
        {t("admin.pro30")}
      </button>
      {row.subscription && row.subscription.status === "active" && (
        <button
          type="button"
          className={button}
          disabled={busy}
          onClick={() => call("cancel_subscription")}
        >
          {t("admin.cancelSub")}
        </button>
      )}
      {row.subscription && row.subscription.status !== "active" && (
        <button
          type="button"
          className={button}
          disabled={busy}
          onClick={() =>
            call("reactivate_subscription", { plan: "plus", periodDays: 30 })
          }
        >
          {t("admin.reactivate")}
        </button>
      )}
      {row.is_admin ? (
        row.id === actorId ? (
          <span className="text-[10px] font-semibold text-faint">
            {t("admin.you")}
          </span>
        ) : (
          <button
            type="button"
            className={`${button} text-danger`}
            disabled={busy}
            onClick={() => call("revoke_admin")}
          >
            {t("admin.revokeAdmin")}
          </button>
        )
      ) : (
        <button
          type="button"
          className={`${button} text-ai`}
          disabled={busy}
          onClick={() => call("grant_admin")}
        >
          {t("admin.grantAdmin")}
        </button>
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
  );
}
