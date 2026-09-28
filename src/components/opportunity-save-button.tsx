"use client";

import { useState } from "react";

interface SaveOpportunityButtonProps {
  opportunityKey: string;
  initialSaved: boolean;
}

export function SaveOpportunityButton({
  opportunityKey,
  initialSaved,
}: SaveOpportunityButtonProps) {
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
      setError("Could not update your saved list right now.");
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
        className={
          saved
            ? "rounded-xl bg-[#e8f5ee] px-4 py-2 text-xs font-bold text-[#177a55] transition hover:bg-[#d8efe3] disabled:opacity-60"
            : "rounded-xl bg-[#edf3ff] px-4 py-2 text-xs font-bold text-[#2f6fed] transition hover:bg-[#dce9ff] disabled:opacity-60"
        }
      >
        {busy ? "Saving…" : saved ? "✓ Saved — remove" : "Save opportunity"}
      </button>
      {error && (
        <span className="text-[11px] font-semibold text-[#b4543c]">
          {error}
        </span>
      )}
    </span>
  );
}
