"use client";

import { useState } from "react";
import { localeForLang } from "@/lib/i18n/core";
import { useI18n } from "@/lib/i18n";

interface AuditEntry {
  created_at: string;
  action: string;
  plan: string | null;
  period_days: number | null;
  reason: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

type LoadState =
  | { kind: "closed" }
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "open"; entries: AuditEntry[] };

/** Per-row "Audit" button: opens a READ-ONLY view of the target user's
 *  administrative change history (actor actions only — the endpoint is
 *  admin-gated server-side and returns at most 50 entries, newest first).
 *  Every entry shows the action, plan/duration, reason and the
 *  before→after plan state recorded atomically with the change. */
export function AdminAuditLog({ userId }: { userId: string }) {
  const { t, lang } = useI18n();
  const [state, setState] = useState<LoadState>({ kind: "closed" });
  const locale = localeForLang(lang);

  const open = async () => {
    if (state.kind === "open") {
      setState({ kind: "closed" });
      return;
    }
    setState({ kind: "loading" });
    try {
      const res = await fetch(`/api/admin/users/${userId}/audit?limit=20`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { entries: AuditEntry[] };
      setState({ kind: "open", entries: data.entries ?? [] });
    } catch {
      setState({ kind: "error" });
    }
  };

  const stateOf = (s: Record<string, unknown> | null): string => {
    if (!s || s.plan === null || s.plan === undefined) return "—";
    return `${String(s.plan)} · ${String(s.status ?? "?")}`;
  };

  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={open}
        className="self-start rounded-lg border border-line-strong bg-surface px-2.5 py-1.5 text-xs font-semibold text-ink-soft hover:bg-surface-2"
      >
        {t("admin.audit")}
      </button>
      {state.kind === "loading" && (
        <p className="text-xs text-muted">{t("admin.auditLoading")}</p>
      )}
      {state.kind === "error" && (
        <p className="text-xs font-semibold text-danger">
          {t("admin.auditError")}
        </p>
      )}
      {state.kind === "open" && (
        <div className="max-h-72 overflow-y-auto rounded-lg border border-line bg-surface-2 p-2">
          {state.entries.length === 0 ? (
            <p className="px-1 py-2 text-xs text-muted">
              {t("admin.auditEmpty")}
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {state.entries.map((e, i) => (
                <li key={i} className="text-xs">
                  <p className="font-semibold text-ink-soft">
                    {e.action}
                    {e.plan ? ` · ${e.plan}` : ""}
                    {e.period_days ? ` · ${e.period_days}d` : ""}
                    {e.reason ? ` (${e.reason})` : ""}
                  </p>
                  <p className="text-muted">
                    {new Date(e.created_at).toLocaleString(locale)} ·{" "}
                    {t("admin.auditTransition", {
                      before: stateOf(e.before),
                      after: stateOf(e.after),
                    })}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
