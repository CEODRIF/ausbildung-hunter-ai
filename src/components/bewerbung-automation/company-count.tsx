"use client";

/**
 * Step 1 — user-controlled company TARGET (the desired series size).
 *
 * The target is the campaign's persisted `requested_count` (the "goal"),
 * NOT a row quota: changing it never creates, fills or deletes application
 * rows — the user enters companies manually or by import, and the gap line
 * below the stepper always shows the ACTUAL number entered vs the target.
 *
 * Controls:
 *   − / +  — bounded by the two GENUINE limits: 1 (the minimum a series
 *            needs) and BEW_MAX_COUNT (the platform daily cap / DB CHECK —
 *            the buttons disable there and the cap hint explains why);
 *   input  — direct numeric entry. Every intermediate value is validated
 *            with the SAME pure rule the server applies (validateCompanyCount);
 *            valid integers commit immediately, empty / negative / fractional
 *            values are flagged inline and never persisted, and blurring an
 *            invalid field reverts the display to the last persisted target.
 *
 * Memoized: it re-renders only when its own props change (the wizard's
 * other steps and rows are unaffected by a target change).
 */
import { memo, useCallback, useEffect, useState } from "react";
import {
  BEW_MAX_COUNT,
  BEW_MIN_COUNT,
  clampCompanyCount,
  validateCompanyCount,
} from "@/lib/bewerbung-automation";
import { Icon } from "@/components/icon";

interface Props {
  /** Persisted target (view.campaign.requested_count). */
  target: number;
  /** Actual companies currently entered (the active rows in the table). */
  actual: number;
  /** Locked (send in flight, terminal campaign, or series being created). */
  disabled: boolean;
  /** A target persist is in flight (the parent owns the round trip). */
  busy: boolean;
  /**
   * Persist a new target. Resolves with the server-confirmed value, or null
   * on failure (the parent has already rolled the view back and shown the
   * localized error — the stepper itself stays quiet).
   */
  onCommit: (count: number) => Promise<number | null>;
  t: (k: string, v?: Record<string, string | number>) => string;
}

export const CompanyCountStepper = memo(function CompanyCountStepper({
  target,
  actual,
  disabled,
  busy,
  onCommit,
  t,
}: Props) {
  /* Defensive: pre-migration / legacy rows may carry 0 — clamp for display. */
  const safeTarget = clampCompanyCount(target);
  /* null = show the persisted target; a string = the user is typing. */
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /* Convergence: once the typed text equals the persisted target (a
     successful commit of exactly this value), drop the draft so the
     display is driven by the prop again (refreshes, rollbacks, …). */
  useEffect(() => {
    if (draft !== null && draft === String(safeTarget)) setDraft(null);
  }, [draft, safeTarget]);

  /* Buttons: commit once (a write in flight already carries a value — the
     buttons are disabled meanwhile). */
  const commit = useCallback(
    (count: number) => {
      if (disabled || busy || count === safeTarget) return;
      void onCommit(count);
    },
    [disabled, busy, safeTarget, onCommit],
  );

  /* Direct entry: every VALID integer commits immediately — even while a
     previous write is in flight (the parent coalesces: the latest intent
     wins, nothing is lost). Invalid input is flagged inline and NEVER
     persisted; the input itself stays editable until blur reverts it. */
  const onInput = (value: string) => {
    setDraft(value);
    if (disabled) return;
    const check = validateCompanyCount(value);
    if (check.ok) {
      setError(null);
      if (check.value !== safeTarget) void onCommit(check.value);
    } else {
      setError(
        check.error === "too-large"
          ? t("bewauto.countMaxHint")
          : t("bewauto.countError"),
      );
    }
  };

  /* Blur: whatever the text is now, the display returns to the last
     PERSISTED target (valid input already committed; invalid input was
     never persisted — reverting is the safe, visible outcome). */
  const onBlurred = () => {
    setDraft(null);
    setError(null);
  };

  const atMin = safeTarget <= BEW_MIN_COUNT;
  const atMax = safeTarget >= BEW_MAX_COUNT;

  return (
    <div
      role="group"
      aria-label={t("bewauto.countTargetLabel")}
      title={t("bewauto.countTargetHint")}
      className="flex flex-wrap items-center gap-x-3 gap-y-2"
    >
      <span className="text-sm font-semibold text-ink-soft">
        {t("bewauto.countTargetLabel")}
      </span>
      <div className="flex items-center overflow-hidden rounded-2xl border border-line-strong bg-surface">
        <button
          type="button"
          onClick={() => commit(clampCompanyCount(safeTarget - 1))}
          disabled={disabled || busy || atMin}
          aria-label={t("bewauto.countDecreaseAria")}
          className="h-9 w-9 shrink-0 text-base font-bold text-ink-soft transition hover:bg-surface-2 hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
        >
          −
        </button>
        <input
          type="number"
          inputMode="numeric"
          min={BEW_MIN_COUNT}
          max={BEW_MAX_COUNT}
          step={1}
          value={draft ?? String(safeTarget)}
          /* `busy` deliberately does NOT disable the input: direct entry
             must stay typeable while a previous write settles (coalescing). */
          disabled={disabled}
          aria-label={t("bewauto.countInputAria")}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "bew-count-target-error" : undefined}
          onChange={(e) => onInput(e.target.value)}
          onBlur={onBlurred}
          className={`h-9 w-14 bg-transparent text-center text-sm font-semibold text-ink outline-none disabled:cursor-not-allowed disabled:opacity-50 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none ${
            error ? "text-danger" : ""
          }`}
        />
        <button
          type="button"
          onClick={() => commit(clampCompanyCount(safeTarget + 1))}
          disabled={disabled || busy || atMax}
          aria-label={t("bewauto.countIncreaseAria")}
          className="h-9 w-9 shrink-0 text-base font-bold text-ink-soft transition hover:bg-surface-2 hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
        >
          +
        </button>
      </div>

      <div aria-live="polite" className="flex min-w-0 flex-wrap items-center gap-2">
        {error ? (
          <span
            id="bew-count-target-error"
            role="alert"
            className="text-xs font-medium text-danger"
          >
            {error}
          </span>
        ) : actual === safeTarget ? (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-success">
            <Icon name="check" size={13} />
            {t("bewauto.targetReached")}
          </span>
        ) : (
          <span className="text-xs font-medium text-muted">
            {t("bewauto.enteredOf", { entered: actual, target: safeTarget })}
          </span>
        )}
        {atMax && !disabled && !error && (
          <span className="text-xs text-faint">{t("bewauto.countMaxHint")}</span>
        )}
      </div>
    </div>
  );
});
