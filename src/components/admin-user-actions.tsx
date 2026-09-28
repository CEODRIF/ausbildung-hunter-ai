"use client";

import { useState } from "react";

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
          ? { kind: "ok", message: data.message ?? "Done." }
          : {
              kind: "error",
              message:
                data.error === "self_revoke_blocked"
                  ? "You cannot revoke your own admin rights."
                  : data.error === "no_subscription"
                    ? "No subscription exists for this user."
                    : `Action failed (${data.error ?? response.status}).`,
            },
      );
    } catch {
      setResult({ kind: "error", message: "Network error — please retry." });
    } finally {
      setBusy(false);
    }
  };

  const button =
    "rounded-lg border border-[#dbe3ef] bg-white px-2.5 py-1.5 text-xs font-semibold text-[#1d3458] hover:bg-[#f5f8ff] disabled:opacity-50";

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <button
        type="button"
        className={button}
        disabled={busy}
        onClick={() => call("set_plan", { plan: "plus", periodDays: 30 })}
      >
        Plus · 30d
      </button>
      <button
        type="button"
        className={button}
        disabled={busy}
        onClick={() => call("set_plan", { plan: "pro", periodDays: 30 })}
      >
        Pro · 30d
      </button>
      {row.subscription && row.subscription.status === "active" && (
        <button
          type="button"
          className={button}
          disabled={busy}
          onClick={() => call("cancel_subscription")}
        >
          Cancel sub
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
          Reactivate
        </button>
      )}
      {row.is_admin ? (
        row.id === actorId ? (
          <span className="text-[10px] font-semibold text-[#a0adbd]">you</span>
        ) : (
          <button
            type="button"
            className={`${button} text-[#c0392b]`}
            disabled={busy}
            onClick={() => call("revoke_admin")}
          >
            Revoke admin
          </button>
        )
      ) : (
        <button
          type="button"
          className={`${button} text-[#805ad5]`}
          disabled={busy}
          onClick={() => call("grant_admin")}
        >
          Grant admin
        </button>
      )}
      {result && (
        <span
          className={`text-xs font-semibold ${
            result.kind === "ok" ? "text-[#1b9b70]" : "text-[#c0392b]"
          }`}
          role="status"
        >
          {result.message}
        </span>
      )}
    </div>
  );
}
