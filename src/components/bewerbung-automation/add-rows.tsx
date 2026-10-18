"use client";

/**
 * Step 1 — adding REAL company rows to the current campaign.
 *
 * The campaign only holds the rows it was created with (or an import
 * replaces) — this control grows it: the chosen batch of EMPTY pending rows
 * is written to `bew_applications` by the server action (one atomic insert,
 * seq continuing after the last row, counters recomputed), so the new rows
 * are first-class citizens of the series: editable, importable-over,
 * validated and sendable exactly like the seeded rows.
 *
 * The ONLY maximum is the genuine 100-per-campaign platform cap: the batch
 * is clamped to the remaining room here AND re-clamped by the server
 * (CAMPAIGN_FULL when nothing is left). Empty rows stay incomplete until
 * they carry a name and a valid e-mail (the existing validity rule).
 *
 * Memoized: re-renders only when its own props change.
 */
import { memo, useEffect, useState } from "react";
import { BEW_MAX_COUNT } from "@/lib/bewerbung-automation";
import { Button } from "@/components/ui";
import { Icon } from "@/components/icon";

interface Props {
  /** Campaign rows currently on file (ALL statuses — they hold a seq slot). */
  total: number;
  /** Locked (send in flight, terminal campaign, or series being created). */
  disabled: boolean;
  /** A row-add round trip is in flight (the parent owns it). */
  busy: boolean;
  /** Add the batch (already clamped ≥1). The parent surfaces errors. */
  onAdd: (count: number) => Promise<void>;
  t: (k: string, v?: Record<string, string | number>) => string;
}

export const AddRowsControl = memo(function AddRowsControl({
  total,
  disabled,
  busy,
  onAdd,
  t,
}: Props) {
  const room = Math.max(0, BEW_MAX_COUNT - total);
  const full = room <= 0;

  /* Batch size draft (the −/+ and direct entry both feed it). */
  const [draft, setDraft] = useState<string>("10");
  const [error, setError] = useState<string | null>(null);

  /* When the room shrinks (rows added elsewhere / import), keep the batch
     inside it so the stepper never offers an impossible value. */
  useEffect(() => {
    if (!full) setDraft((d) => (Number(d) > room ? String(room) : d));
  }, [room, full]);

  const step = (delta: number) => {
    if (full || disabled || busy) return;
    const cur = Math.trunc(Number(draft));
    const next = Math.min(room, Math.max(1, (Number.isFinite(cur) ? cur : 1) + delta));
    setDraft(String(next));
    setError(null);
  };

  const submit = () => {
    if (full || disabled || busy) return;
    const n = Math.trunc(Number(draft));
    if (!Number.isFinite(n) || n < 1) {
      setError(t("bewauto.countError"));
      return;
    }
    setError(null);
    void onAdd(Math.min(n, room)); // the server re-clamps (CAMPAIGN_FULL)
  };

  if (full) {
    return (
      <div
        role="group"
        aria-label={t("bewauto.addRowsLabel")}
        title={t("bewauto.addRowsHint")}
        className="flex flex-wrap items-center gap-x-3 gap-y-2"
      >
        <span className="text-sm font-semibold text-ink-soft">
          {t("bewauto.addRowsLabel")}
        </span>
        <span aria-live="polite" className="text-xs text-faint">
          {t("bewauto.addRowsFull")}
        </span>
      </div>
    );
  }

  return (
    <div
      role="group"
      aria-label={t("bewauto.addRowsLabel")}
      title={t("bewauto.addRowsHint")}
      className="flex flex-wrap items-center gap-x-3 gap-y-2"
    >
      <span className="text-sm font-semibold text-ink-soft">
        {t("bewauto.addRowsLabel")}
      </span>
      <div className="flex items-center overflow-hidden rounded-2xl border border-line-strong bg-surface">
        <button
          type="button"
          onClick={() => step(-1)}
          disabled={disabled || busy}
          aria-label={t("bewauto.addRowsDecreaseAria")}
          className="h-9 w-9 shrink-0 text-base font-bold text-ink-soft transition hover:bg-surface-2 hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
        >
          −
        </button>
        <input
          type="number"
          inputMode="numeric"
          min={1}
          max={room}
          step={1}
          value={draft}
          disabled={disabled}
          aria-label={t("bewauto.addRowsBatchAria")}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "bew-add-rows-error" : undefined}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
          }}
          className={`h-9 w-14 bg-transparent text-center text-sm font-semibold text-ink outline-none disabled:cursor-not-allowed disabled:opacity-50 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none ${
            error ? "text-danger" : ""
          }`}
        />
        <button
          type="button"
          onClick={() => step(1)}
          disabled={disabled || busy}
          aria-label={t("bewauto.addRowsIncreaseAria")}
          className="h-9 w-9 shrink-0 text-base font-bold text-ink-soft transition hover:bg-surface-2 hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
        >
          +
        </button>
      </div>
      <Button
        type="button"
        size="sm"
        disabled={disabled || busy || Boolean(error)}
        aria-busy={busy || undefined}
        onClick={submit}
      >
        {busy ? (
          <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
        ) : (
          <Icon name="plus" size={14} />
        )}
        {t("bewauto.addRowsButton")}
      </Button>
      {error && (
        <span
          id="bew-add-rows-error"
          role="alert"
          className="text-xs font-medium text-danger"
        >
          {error}
        </span>
      )}
    </div>
  );
});
