"use client";

import { useState } from "react";
import { useI18n } from "@/lib/i18n";

interface SaveOpportunityButtonProps {
  opportunityKey: string;
  initialSaved: boolean;
}

export function SaveOpportunityButton({
  opportunityKey,
  initialSaved,
}: SaveOpportunityButtonProps) {
  const { t } = useI18n();
  const [saved, setSaved] = useState(initialSaved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/opportunities/save", {
        method: saved ? "DELETE" : "POST",
        headers: { "content-type": "application/json" },
        // Only the key travels to the server — all data is derived there.
        body: JSON.stringify({ opportunityKey }),
      });
      if (!response.ok) throw new Error();
      setSaved((value) => !value);
    } catch {
      setError(t("account.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={toggle}
        disabled={busy}
        aria-pressed={saved}
        className={
          saved
            ? "rounded-xl bg-success-soft px-4 py-2 text-xs font-bold text-success transition hover:bg-success-soft disabled:opacity-60"
            : "rounded-xl bg-accent-soft px-4 py-2 text-xs font-bold text-accent transition hover:bg-accent-soft disabled:opacity-60"
        }
      >
        {busy
          ? t("account.saving")
          : saved
            ? t("account.savedRemove")
            : t("account.saveOpportunity")}
      </button>
      {error && (
        <span className="text-[11px] font-semibold text-danger">
          {error}
        </span>
      )}
    </span>
  );
}
