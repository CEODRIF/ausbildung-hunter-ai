"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Check, ChevronDown, Info, Mail } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { useAutoBewerb } from "./shared";

/**
 * Step 6 — the ONE global sending-account selector (for the whole batch).
 *
 * Lists the user's ACTUAL connected e-mail accounts (workspace data — never
 * hardcoded, never fictional; no provider credentials are rendered, only the
 * verified address + provider identity). Selecting an account is persisted
 * immediately through the existing Step 6 settings action (the same payload
 * the explicit Save uses); the dispatch pipeline then uses that single
 * account for every company in the batch.
 */

/** Provider identity marks (small, decorative; the address is the data). */
export function ProviderGlyph({ provider, size = 18 }: { provider: string; size?: number }) {
  if (provider === "gmail") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="shrink-0 rounded-[5px]">
        <rect width="24" height="24" rx="5" fill="#ffffff" />
        <path fill="#4285F4" d="M6.5 9.5v7h2.9v-5.05L6.5 9.5z" />
        <path fill="#EA4335" d="M17.5 9.5v7h-2.9v-5.05l2.9-1.95z" />
        <path fill="#FBBC05" d="M9.4 9.5v2.15L12 13.55V9.5l-2.6 2z" />
        <path fill="#34A853" d="M14.6 9.5 12 11.5v2.05l2.6-1.9z" />
      </svg>
    );
  }
  if (provider === "outlook") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="shrink-0 rounded-[5px]">
        <rect width="24" height="24" rx="5" fill="#0F6CBD" />
        <path fill="#ffffff" d="M5.5 8.5h7.2l1.3 1.3L18.5 8.5v8h-13z" />
        <circle cx="12" cy="12.6" r="2.5" fill="#0F6CBD" />
        <circle cx="12" cy="12.6" r="1.3" fill="#ffffff" />
      </svg>
    );
  }
  return (
    <span
      style={{ width: size, height: size }}
      className="flex shrink-0 items-center justify-center rounded-[5px] border border-line bg-surface-2"
    >
      <Mail size={size * 0.62} className="text-muted" strokeWidth={1.8} />
    </span>
  );
}

export function SendingAccountSelect({
  accountId,
  onAccountChange,
  saving,
}: {
  accountId: string;
  onAccountChange: (id: string) => void;
  /** True while the selection is being persisted (disables re-selection). */
  saving: boolean;
}) {
  const { ws } = useAutoBewerb();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const accounts = ws.emailAccounts;
  const selected = accounts.find((a) => a.id === accountId) ?? null;

  // Close on outside click / Escape — no modal chrome.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="flex flex-col gap-3 border-t border-line pt-4 md:flex-row md:items-center md:gap-4">
      <span className="flex shrink-0 items-center gap-2 text-sm font-semibold text-ink">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent-soft/60">
          <Mail size={15} className="text-accent" strokeWidth={1.9} />
        </span>
        {t("autoBewerb.sendingAccountLabel")}
        <Info size={13} className="text-faint" aria-label={t("autoBewerb.sendingAccountInfo")} />
      </span>

      <div className="relative min-w-0 flex-1" ref={rootRef}>
        {accounts.length === 0 ? (
          // Honest empty state — the existing connect action, no simulation:
          <div className="rounded-xl border border-dashed border-line-strong bg-surface-2/40 px-4 py-3 text-xs leading-5 text-muted">
            {t("autoBewerb.emailAccountNoneBody")}{" "}
            <Link href="/settings/email" className="font-semibold text-accent underline underline-offset-2">
              {t("autoBewerb.emailAccountNoneCta")}
            </Link>
          </div>
        ) : (
          <>
            <button
              type="button"
              aria-expanded={open}
              aria-haspopup="listbox"
              aria-label={t("autoBewerb.sendingAccountLabel")}
              onClick={() => setOpen((o) => !o)}
              disabled={saving}
              className={`flex h-11 w-full items-center justify-between gap-2 rounded-xl border px-3 text-sm font-medium outline-none transition-colors disabled:opacity-60 ${
                selected ? "border-accent bg-accent-soft/25 text-ink" : "border-line-strong bg-surface text-ink hover:border-accent focus:border-accent"
              }`}
            >
              <span className="flex min-w-0 items-center gap-2.5">
                {selected ? (
                  <>
                    <ProviderGlyph provider={selected.provider} />
                    <span className="truncate">{selected.email}</span>
                    {selected.requires_reconnect && (
                      <span className="shrink-0 text-xs font-semibold text-warning">— {t("autoBewerb.accountReconnect")}</span>
                    )}
                  </>
                ) : (
                  <span className="font-normal text-muted">{t("autoBewerb.selectAccount")}</span>
                )}
              </span>
              <ChevronDown size={15} className={`shrink-0 text-muted transition-transform ${open ? "rotate-180" : ""}`} />
            </button>
            {open && (
              <ul
                role="listbox"
                aria-label={t("autoBewerb.sendingAccountLabel")}
                className="absolute inset-x-0 top-full z-30 mt-1.5 max-h-64 overflow-auto rounded-xl border border-line-strong bg-surface-2 p-1 shadow-[0_16px_40px_-12px_rgba(0,0,0,0.5)]"
              >
                {accounts.map((a) => (
                  <li key={a.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={a.id === accountId}
                      disabled={a.requires_reconnect || saving}
                      onClick={() => {
                        setOpen(false);
                        onAccountChange(a.id);
                      }}
                      className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-start text-sm text-ink-soft transition-colors hover:bg-surface/70 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <ProviderGlyph provider={a.provider} />
                      <span className="min-w-0 flex-1 truncate font-medium">{a.email}</span>
                      {a.requires_reconnect && (
                        <span className="shrink-0 text-xs font-semibold text-warning">{t("autoBewerb.accountReconnect")}</span>
                      )}
                      {a.id === accountId && <Check size={15} className="shrink-0 text-accent" strokeWidth={2.5} />}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  );
}
