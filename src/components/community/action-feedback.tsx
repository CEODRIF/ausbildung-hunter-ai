"use client";

/**
 * Community — the ONE shared interaction-feedback system.
 *
 * Every async Community action renders through these primitives so the UX
 * is identical everywhere (click → immediate acknowledgement <100ms →
 * pending → success/error → natural final state, no frozen-looking UI):
 *
 *   useCommunityAction   — the idle/pending/success/error state machine
 *                          (synchronous pending, double-submit guard,
 *                          500ms "slow" + 3s "stalled" escalation, retry).
 *   CommunityActionButton— labeled button with a STABLE width (idle /
 *                          pending / success labels are stacked, never a
 *                          layout jump) and a 150ms pressed transition.
 *   CommunityIconButton  — icon-only button: pressed feedback, tooltip,
 *                          aria-label, pending spinner in place of the icon.
 *   CommunityToastProvider / useCommunityToast — small non-blocking
 *                          confirmations (deduplicated, bounded, mobile-safe).
 *
 * Design rules (the "no frozen page" contract):
 *  - pending is LOCALIZED: only the clicked button changes; the rest of
 *    the Community stays fully interactive (no page spinners);
 *  - dimensions are reserved (stacked labels / fixed icon box) — no width
 *    jumps, no layout shift;
 *  - 100–160ms transitions only; no bounce, no flashy effects;
 *  - a single icon click never triggers a global state update — the action
 *    state lives in the component that owns it.
 */

import { useEffect, useRef, useState, useSyncExternalStore, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Icon, type IconName } from "@/components/icon";
import { buttonStyles } from "@/components/ui";
import {
  communityToastStore,
  createCommunityAction,
  type CommunityAction,
  type CommunityActionPhase,
} from "@/lib/community/action-core";

// ---------------------------------------------------------------------------
// useCommunityAction — the React wrapper over the pure state machine
// ---------------------------------------------------------------------------

export type UseCommunityAction = CommunityAction;

/**
 * One action state machine per call site (e.g. one per profile card, one
 * per friend row). `run(fn)` is the ONLY way to start work — it sets
 * `pending` synchronously (same frame as the click), ignores double
 * submits, and auto-resets `success` back to `idle`.
 */
export function useCommunityAction(): UseCommunityAction {
  const [state, setState] = useState<{
    phase: CommunityActionPhase;
    slow: boolean;
    stalled: boolean;
    error: unknown;
  }>({ phase: "idle", slow: false, stalled: false, error: null });
  const actionRef = useRef<CommunityAction | null>(null);
  if (actionRef.current === null) {
    actionRef.current = createCommunityAction({
      scheduler: {
        schedule: (cb, ms) => window.setTimeout(cb, ms),
        cancel: (h) => window.clearTimeout(h),
      },
      onChange: (next) => setState(next),
    });
  }
  useEffect(() => {
    const action = actionRef.current;
    return () => action?.dispose();
  }, []);

  const action = actionRef.current as CommunityAction;
  return {
    phase: state.phase,
    slow: state.slow,
    stalled: state.stalled,
    error: state.error,
    run: (fn) => action.run(fn),
    retry: () => action.retry(),
    reset: () => action.reset(),
    dispose: () => action.dispose(),
  };
}

// ---------------------------------------------------------------------------
// Shared press/transition classes (100–160ms, motion-safe)
// ---------------------------------------------------------------------------

/** Immediate pressed acknowledgement for any interactive control. */
export const COMMUNITY_PRESS_CLASS =
  "transition-[transform,opacity,background-color,color,border-color,box-shadow] duration-150 active:scale-[0.97] active:opacity-90";

/** The subtle inline spinner (pending affordance). */
export function ActionSpinner({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent ${className}`}
    />
  );
}

// ---------------------------------------------------------------------------
// CommunityActionButton
// ---------------------------------------------------------------------------

type ActionButtonVariant = keyof typeof buttonStyles;

export interface CommunityActionButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  action: UseCommunityAction;
  /** idle label (e.g. "Add Friend"). */
  label: string;
  /** pending label (e.g. "Adding…"); defaults to the idle label + spinner. */
  pendingLabel?: string;
  /** transient success label (e.g. "Request sent ✓"). */
  successLabel?: string;
  variant?: ActionButtonVariant;
  size?: "sm" | "md" | "lg";
}

const ACTION_BUTTON_SIZES = {
  sm: "h-9 px-3.5 text-xs",
  md: "h-11 px-4 text-sm",
  lg: "h-12 px-5 text-sm",
} as const;

/**
 * The labeled action button. The three labels are STACKED in a grid (only
 * the active one visible) so the button keeps the width of its WIDEST
 * label — Add Friend → Adding… → Request sent never jumps.
 *
 * Clicks are forwarded to `action.run` via the caller's `onClick` (which
 * receives the synchronous pending state the same frame).
 */
export function CommunityActionButton({
  action,
  label,
  pendingLabel,
  successLabel,
  variant = "primary",
  size = "md",
  className = "",
  disabled,
  ...rest
}: CommunityActionButtonProps) {
  const { phase } = action;
  const pending = phase === "pending";
  const success = phase === "success";
  // "error" renders the idle label (recoverable: the next click re-runs the
  // action) — the error itself is surfaced by the caller (inline message /
  // toast), never by a dead-looking button. Same for a success that has no
  // dedicated success label (the label simply stays).
  const idleVisible =
    phase === "idle" ||
    phase === "error" ||
    (phase === "success" && !successLabel);
  // Disabled while pending (the double-submit guard) or by the caller —
  // but pending must NOT look "dead": keep full opacity, show the spinner.
  const isDisabled = disabled || pending;
  const cell = (active: boolean): string =>
    `col-start-1 row-start-1 flex items-center justify-center gap-1.5 whitespace-nowrap ${
      active ? "" : "invisible"
    }`;
  return (
    <button
      type="button"
      disabled={isDisabled}
      aria-busy={pending || undefined}
      className={`inline-flex items-center justify-center rounded-2xl font-semibold ${COMMUNITY_PRESS_CLASS} ${ACTION_BUTTON_SIZES[size]} ${buttonStyles[variant]} disabled:cursor-not-allowed ${
        pending ? "disabled:opacity-100" : "disabled:opacity-50"
      } ${className}`}
      {...rest}
    >
      <span className="relative grid">
        <span className={cell(idleVisible)}>{label}</span>
        <span className={cell(pending)}>
          {pending && <ActionSpinner className="h-3.5 w-3.5" />}
          {pendingLabel ?? label}
        </span>
        {successLabel && (
          <span className={cell(success)}>
            <Icon name="check" size={13} className="shrink-0" />
            {successLabel}
          </span>
        )}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// CommunityIconButton
// ---------------------------------------------------------------------------

export interface CommunityIconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Icon name (rendered via the shared <Icon>). */
  icon: IconName;
  /** aria-label AND desktop tooltip — required for icon-only buttons. */
  label: string;
  iconSize?: number;
  boxSize?: "sm" | "md" | "lg";
  /** Shows the spinner in place of the icon (the pending state). */
  pending?: boolean;
  /** Toggled state (aria-pressed) for mute/active-style icons. */
  active?: boolean;
  danger?: boolean;
}

const ICON_BUTTON_BOXES = {
  sm: "h-8 w-8 rounded-lg",
  md: "h-9 w-9 rounded-xl",
  lg: "h-10 w-10 rounded-xl",
} as const;

/**
 * The icon-only action button: immediate pressed feedback (scale+opacity,
 * 150ms), hover state on desktop, focus-visible ring, tooltip + aria-label
 * on desktop, and a pending spinner that REPLACES the icon inside the same
 * fixed-size box (no dimension change).
 */
export function CommunityIconButton({
  icon,
  label,
  iconSize = 16,
  boxSize = "md",
  pending = false,
  active = false,
  danger = false,
  className = "",
  disabled,
  onClick,
  ...rest
}: CommunityIconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-busy={pending || undefined}
      aria-pressed={active || undefined}
      disabled={disabled || pending}
      onClick={onClick}
      className={`inline-flex shrink-0 items-center justify-center ${ICON_BUTTON_BOXES[boxSize]} ${COMMUNITY_PRESS_CLASS} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:cursor-not-allowed ${
        danger
          ? "text-faint hover:bg-danger-soft/60 hover:text-danger"
          : "text-faint hover:bg-surface-2 hover:text-ink"
      } ${active ? "bg-accent-soft/70 text-accent" : ""} ${
        pending ? "opacity-70" : ""
      } ${className}`}
      {...rest}
    >
      {pending ? <ActionSpinner className="h-4 w-4" /> : <Icon name={icon} size={iconSize} />}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

const TOAST_STORE_SUBSCRIBE = communityToastStore.subscribe;
const TOAST_STORE_GET = communityToastStore.toasts;

export function useCommunityToast() {
  return {
    notify: (options: Parameters<typeof communityToastStore.notify>[0]) =>
      communityToastStore.notify(options),
    dismiss: (id: number) => communityToastStore.dismiss(id),
  };
}

/**
 * The Community toast stack. Mount ONCE per Community shell (the provider
 * is idempotent — a second mount just renders the same store).
 *
 * Placement: bottom-center above the composer on mobile (keyboard-safe,
 * never covers the input), top-right on desktop. Small, non-blocking,
 * short-lived, max 3 visible, duplicates collapsed.
 */
export function CommunityToastProvider({ children }: { children: ReactNode }) {
  const toasts = useSyncExternalStore(TOAST_STORE_SUBSCRIBE, TOAST_STORE_GET, TOAST_STORE_GET);
  return (
    <>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-24 z-[70] flex flex-col items-center gap-2 px-4 sm:inset-x-auto sm:bottom-auto sm:right-4 sm:top-4 sm:items-end"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role={toast.kind === "error" ? "alert" : "status"}
            style={{ animation: "community-toast-in 150ms ease-out" }}
            className={`pointer-events-auto flex w-full max-w-sm items-center gap-2.5 rounded-2xl border px-3.5 py-2.5 shadow-[var(--shadow-card)] ${
              toast.kind === "error"
                ? "border-danger/30 bg-danger-soft text-danger"
                : toast.kind === "success"
                  ? "border-success/30 bg-surface text-ink"
                  : "border-line bg-surface text-ink"
            }`}
          >
            {toast.kind === "success" && (
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-success-soft text-success">
                <Icon name="check" size={11} strokeWidth={2.5} />
              </span>
            )}
            {toast.kind === "error" && (
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-danger/15 text-danger">
                <Icon name="alert" size={11} strokeWidth={2.5} />
              </span>
            )}
            <span className="min-w-0 flex-1 truncate text-xs font-semibold">{toast.text}</span>
            {toast.action && (
              <button
                type="button"
                onClick={() => {
                  toast.action?.run();
                  communityToastStore.dismiss(toast.id);
                }}
                className={`shrink-0 rounded-lg px-2 py-1 text-[11px] font-bold transition-colors ${COMMUNITY_PRESS_CLASS} ${
                  toast.kind === "error" ? "bg-danger text-white hover:bg-danger/90" : "bg-accent-soft text-accent hover:bg-accent-soft/70"
                }`}
              >
                {toast.action.label}
              </button>
            )}
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => communityToastStore.dismiss(toast.id)}
              className={`shrink-0 rounded-md p-1 transition-colors ${COMMUNITY_PRESS_CLASS} ${
                toast.kind === "error" ? "hover:bg-danger/15" : "text-faint hover:bg-surface-2 hover:text-ink"
              }`}
            >
              <Icon name="x" size={11} strokeWidth={2.5} />
            </button>
          </div>
        ))}
      </div>
    </>
  );
}
