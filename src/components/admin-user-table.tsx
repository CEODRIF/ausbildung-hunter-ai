import { Card } from "@/components/ui";
import {
  AdminUserActions,
  type AdminUserRow,
} from "@/components/admin-user-actions";
import { AdminAuditLog } from "@/components/admin-audit-log";
import type { AdminUserListRow } from "@/lib/billing/admin-users";

/**
 * Presentational table for /admin/users — rendered by the page (which owns
 * the double server-side gate + listAdminUsers). Pure layout; the row data
 * is the trusted, server-derived list (AdminUserListRow).
 */

type T = (path: string, vars?: Record<string, string | number>) => string;

export function AdminUserTable({
  t,
  locale,
  users,
  actorId,
}: {
  t: T;
  locale: string;
  users: AdminUserListRow[];
  actorId: string;
}) {
  return (
    <Card className="mt-6 overflow-hidden rounded-3xl shadow-[var(--shadow-card)]">
      {users.length === 0 ? (
        <p className="px-6 py-12 text-center text-sm text-muted">
          {t("admin.noMatch")}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-start text-sm">
            <thead>
              <tr className="border-b border-line bg-surface-2/60 text-[11px] uppercase tracking-[0.08em] text-faint">
                <th className="px-5 py-3.5 text-start">{t("admin.user")}</th>
                <th className="px-5 py-3.5 text-start">{t("admin.goal")}</th>
                <th className="px-5 py-3.5 text-start">{t("admin.plan")}</th>
                <th className="px-5 py-3.5 text-start">{t("admin.today")}</th>
                <th className="px-5 py-3.5 text-start">{t("admin.role")}</th>
                <th className="px-5 py-3.5 text-start">{t("admin.actions")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {users.map((row) => (
                <tr
                  key={row.id}
                  className="transition-colors hover:bg-surface-2/40"
                >
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-3">
                      <span
                        aria-hidden="true"
                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-bold text-accent"
                      >
                        {(row.full_name || row.email)
                          .split(/\s+/)
                          .map((p) => p[0])
                          .slice(0, 2)
                          .join("")
                          .toUpperCase()}
                      </span>
                      <div className="min-w-0">
                        <p className="truncate font-semibold text-ink-soft">
                          {row.full_name}
                        </p>
                        <p className="truncate text-xs text-muted" dir="ltr">
                          {row.email}
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className="px-5 py-3.5 text-xs text-muted">
                    {row.selected_goal ?? "—"}
                  </td>
                  <td className="px-5 py-3.5">
                    {describePlanCell(row.subscription, t, locale)}
                  </td>
                  <td className="px-5 py-3.5">
                    <span className="rounded-lg bg-surface-2 px-2 py-1 text-xs font-semibold text-ink-soft">
                      {row.usage_today.emails_sent} /{" "}
                      {row.usage_today.ai_requests}
                    </span>
                  </td>
                  <td className="px-5 py-3.5">
                    {row.is_admin ? (
                      <span className="rounded-md bg-ai-soft px-1.5 py-0.5 text-[10px] font-bold text-ai">
                        {t("admin.adminBadge")}
                      </span>
                    ) : (
                      <span className="text-xs text-muted">
                        {t("admin.userRole")}
                      </span>
                    )}
                  </td>
                  <td className="px-5 py-3.5">
                    <div className="flex items-start gap-2">
                      <AdminUserActions actorId={actorId} row={row} />
                      <AdminAuditLog userId={row.id} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/** Canonical subscription state cell — computed SERVER-side from the
 *  trusted row (never client state): plan + source (admin grants are
 *  labeled as such, never as payments) + effective state (active until /
 *  canceled / expired, with the relevant date) + the trial window for
 *  trial rows (start = the one-shot activation stamp). */
function describePlanCell(
  sub: AdminUserRow["subscription"],
  t: T,
  locale: string,
) {
  if (!sub) {
    return <span className="text-xs text-muted">{t("admin.noPlan")}</span>;
  }
  const now = Date.now();
  const fmt = (iso: string) => new Date(iso).toLocaleDateString(locale);
  const endIso = sub.current_period_end;
  const endMs = endIso ? Date.parse(endIso) : null;
  let state: string;
  if (sub.plan === "free") {
    // The permanent Free plan was removed (2026-10-24, PR #72 revision): a
    // historical `free` row grants NOTHING and is no longer a valid plan —
    // the account is subject to the plan-selection gate. Show it as "no
    // plan" rather than a live free tier.
    state = t("admin.noPlan");
  } else if (sub.status === "canceled") {
    state = t("admin.stateCanceled", {
      date: sub.canceled_at ? fmt(sub.canceled_at) : "—",
    });
  } else if (
    sub.status === "expired" ||
    (sub.status === "active" && endMs !== null && endMs <= now)
  ) {
    state = t("admin.stateExpired", { date: endIso ? fmt(endIso) : "—" });
  } else {
    state = t("admin.stateActiveUntil", { date: endIso ? fmt(endIso) : "—" });
  }
  const adminGrant = sub.provider === "manual" && sub.plan !== "trial";
  return (
    <div className="flex flex-col">
      <span className="text-xs font-semibold text-ink-soft">
        {sub.plan}
        {adminGrant && (
          <span className="text-ai"> · {t("admin.grantedByAdmin")}</span>
        )}
      </span>
      <span className="text-[11px] text-muted">{state}</span>
      {sub.plan === "trial" && sub.trial_activated_at && endIso && (
        <span className="text-[11px] text-muted">
          {t("admin.trialRange", {
            start: fmt(sub.trial_activated_at),
            end: fmt(endIso),
          })}
        </span>
      )}
    </div>
  );
}
