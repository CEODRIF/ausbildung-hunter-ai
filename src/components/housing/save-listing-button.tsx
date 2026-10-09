"use client";

import { useState } from "react";
import { useI18n } from "@/lib/i18n";
import { Icon } from "@/components/icon";

interface Props {
  provider: string;
  sourceId: string;
  /** Current saved state (controlled by the parent). */
  saved: boolean;
  /** Called with the new saved state after a successful toggle. */
  onToggled: (saved: boolean) => void;
  className?: string;
}

/**
 * Heart/bookmark toggle that saves or removes a listing via /api/housing/save.
 * Optimistic-free: state flips only after the API confirms, so a 401/429 never
 * leaves the UI lying.
 */
export function SaveListingButton({ provider, sourceId, saved, onToggled, className = "" }: Props) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);

  async function toggle() {
    if (busy) return;
    setBusy(true);
    try {
      const method = saved ? "DELETE" : "POST";
      const res = await fetch("/api/housing/save", {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "listing", provider, sourceId }),
      });
      if (!res.ok) return;
      onToggled(!saved);
    } finally {
      setBusy(false);
    }
  }

  const label = saved ? t("housing.saved") : t("housing.save");
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        void toggle();
      }}
      disabled={busy}
      aria-pressed={saved}
      aria-label={label}
      title={label}
      className={`flex h-9 w-9 items-center justify-center rounded-full border backdrop-blur transition-colors disabled:opacity-60 ${
        saved
          ? "border-accent/40 bg-accent-soft text-accent"
          : "border-line-strong bg-surface/80 text-muted hover:text-ink"
      } ${className}`}
    >
      <Icon name={saved ? "check" : "bookmark"} size={17} strokeWidth={2} />
    </button>
  );
}
