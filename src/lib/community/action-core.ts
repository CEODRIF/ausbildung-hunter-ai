/**
 * Community — the ONE shared interaction-feedback core (PURE / isomorphic).
 *
 * Every async Community action (add/accept/decline/cancel/remove friend,
 * open chat, send message, reaction, edit, delete, pin, report, block,
 * mute, mark-as-read, search, load-more, …) runs through the same explicit
 * state machine:
 *
 *   idle → pending → success → (auto-reset) idle
 *            ↘ error → retry → pending …
 *
 * Guarantees (the "did my click work?" contract):
 *  - the pending state is set SYNCHRONOUSLY on run() — the visual
 *    acknowledgement happens on the same frame as the click, never after
 *    the network responds;
 *  - a second run() while pending is IGNORED (no duplicate requests);
 *  - success is transient (auto-resets after `successResetMs`);
 *  - error persists until the next run/retry/reset (recoverable);
 *  - retry() re-runs the SAME captured action (no new duplicate work);
 *  - `slow` flips on after 500ms pending, `stalled` after 3s — the UI can
 *    escalate the pending affordance without any polling.
 *
 * The toast store is a module-level bus (same pattern as the notification
 * bus): small, deduplicated, bounded, auto-dismissing — for explicit
 * confirmations only (never for trivial UI interactions).
 *
 * No React, no DOM: timers are injected (tests run a fake scheduler).
 */

import type { RealtimeScheduler } from "./realtime-core";

// ---------------------------------------------------------------------------
// Action state machine
// ---------------------------------------------------------------------------

export type CommunityActionPhase = "idle" | "pending" | "success" | "error";

export interface CommunityActionState {
  phase: CommunityActionPhase;
  /** pending for more than slowAfterMs (make the spinner obvious). */
  slow: boolean;
  /** pending for more than stalledAfterMs ("still working…" hint). */
  stalled: boolean;
  /** The last error (null after success / reset). */
  error: unknown;
}

export interface CommunityActionOptions {
  scheduler?: RealtimeScheduler;
  /** success → idle after this (default 1500ms). */
  successResetMs?: number;
  /** pending → slow after this (default 500ms). */
  slowAfterMs?: number;
  /** pending → stalled after this (default 3000ms). */
  stalledAfterMs?: number;
  onChange?: (state: CommunityActionState) => void;
}

export interface CommunityAction extends CommunityActionState {
  /**
   * Run an async action. Returns the promise's value, or `undefined` when
   * the run was IGNORED because another run is already pending (the
   * double-submit guard — callers render the pending state for both).
   */
  run<T>(fn: () => Promise<T>): Promise<T | undefined>;
  /** Re-run the last captured action (after an error). */
  retry(): Promise<unknown | undefined>;
  /** Back to idle (cancels pending timers, keeps no error). */
  reset(): void;
  dispose(): void;
}

const DEFAULT_SUCCESS_RESET_MS = 1500;
const DEFAULT_SLOW_AFTER_MS = 500;
const DEFAULT_STALLED_AFTER_MS = 3000;

export function createCommunityAction(
  options: CommunityActionOptions = {},
): CommunityAction {
  const scheduler = options.scheduler;
  const successResetMs = options.successResetMs ?? DEFAULT_SUCCESS_RESET_MS;
  const slowAfterMs = options.slowAfterMs ?? DEFAULT_SLOW_AFTER_MS;
  const stalledAfterMs = options.stalledAfterMs ?? DEFAULT_STALLED_AFTER_MS;

  let phase: CommunityActionPhase = "idle";
  let slow = false;
  let stalled = false;
  let error: unknown = null;
  let lastFn: (() => Promise<unknown>) | null = null;
  let disposed = false;
  let slowTimer: number | null = null;
  let stalledTimer: number | null = null;
  let resetTimer: number | null = null;

  const emit = () => {
    if (!disposed) options.onChange?.({ phase, slow, stalled, error });
  };

  const clearPendingTimers = () => {
    if (slowTimer !== null && scheduler) scheduler.cancel(slowTimer);
    if (stalledTimer !== null && scheduler) scheduler.cancel(stalledTimer);
    slowTimer = null;
    stalledTimer = null;
  };

  const clearResetTimer = () => {
    if (resetTimer !== null && scheduler) scheduler.cancel(resetTimer);
    resetTimer = null;
  };

  const action: CommunityAction = {
    get phase() {
      return phase;
    },
    get slow() {
      return slow;
    },
    get stalled() {
      return stalled;
    },
    get error() {
      return error;
    },

    run<T>(fn: () => Promise<T>): Promise<T | undefined> {
      if (phase === "pending") {
        // Double-submit guard: the first click already owns the action.
        return Promise.resolve(undefined);
      }
      lastFn = fn as () => Promise<unknown>;
      phase = "pending";
      slow = false;
      stalled = false;
      error = null;
      clearResetTimer();
      if (scheduler) {
        clearPendingTimers();
        slowTimer = scheduler.schedule(() => {
          slow = true;
          emit();
        }, slowAfterMs);
        stalledTimer = scheduler.schedule(() => {
          stalled = true;
          emit();
        }, stalledAfterMs);
      }
      emit();

      return fn().then(
        (value) => {
          clearPendingTimers();
          phase = "success";
          slow = false;
          stalled = false;
          emit();
          if (scheduler) {
            resetTimer = scheduler.schedule(() => {
              resetTimer = null;
              phase = "idle";
              emit();
            }, successResetMs);
          }
          return value;
        },
        (err) => {
          clearPendingTimers();
          phase = "error";
          slow = false;
          stalled = false;
          error = err;
          emit();
          throw err;
        },
      );
    },

    async retry(): Promise<unknown | undefined> {
      if (phase === "pending" || lastFn === null) return undefined;
      try {
        await action.run(lastFn);
        return undefined;
      } catch {
        return undefined; // the error state was set by run()
      }
    },

    reset() {
      clearPendingTimers();
      clearResetTimer();
      if (phase !== "idle") {
        phase = "idle";
        slow = false;
        stalled = false;
        error = null;
        emit();
      }
    },

    dispose() {
      disposed = true;
      clearPendingTimers();
      clearResetTimer();
    },
  };

  return action;
}

// ---------------------------------------------------------------------------
// Toast store (module-level bus, like the notification bus)
// ---------------------------------------------------------------------------

export type CommunityToastKind = "success" | "error" | "info";

export interface CommunityToastEntry {
  id: number;
  kind: CommunityToastKind;
  text: string;
  /** Optional actionable button (e.g. "Retry"). */
  action: { label: string; run: () => void } | null;
  dedupeKey: string | null;
}

export interface CommunityToastOptions {
  kind?: CommunityToastKind;
  text: string;
  action?: { label: string; run: () => void } | null;
  /** Same key shown again within the dedupe window → no new toast. */
  dedupeKey?: string;
  /** Override the auto-dismiss duration (ms). */
  durationMs?: number;
}

export interface CommunityToastStore {
  notify(options: CommunityToastOptions): void;
  dismiss(id: number): void;
  /** All currently visible toasts (snapshot). */
  toasts(): readonly CommunityToastEntry[];
  subscribe(listener: () => void): () => void;
  /** Test seam. */
  clear(): void;
}

const TOAST_MAX_VISIBLE = 3;
const TOAST_DEDUPE_WINDOW_MS = 2000;
const TOAST_DURATION_MS: Record<CommunityToastKind, number> = {
  success: 2600,
  info: 2600,
  error: 4200,
};

export function createToastStore(scheduler?: RealtimeScheduler): CommunityToastStore {
  let toasts: CommunityToastEntry[] = [];
  let nextId = 1;
  const listeners = new Set<() => void>();
  const timers = new Map<number, number>();
  const lastDedupe = new Map<string, { at: number; entryId: number }>();

  const emitChange = () => {
    for (const listener of listeners) listener();
  };

  const now = () => Date.now();

  const dismiss = (id: number) => {
    const timer = timers.get(id);
    if (timer !== undefined && scheduler) scheduler.cancel(timer);
    timers.delete(id);
    toasts = toasts.filter((t) => t.id !== id);
    for (const [key, last] of lastDedupe) {
      if (last.entryId === id) lastDedupe.delete(key);
    }
    emitChange();
  };

  return {
    notify({ kind = "info", text, action = null, dedupeKey, durationMs }) {
      const duration = durationMs ?? TOAST_DURATION_MS[kind];
      // Deduplicate repeated identical events (never stack dozens).
      if (dedupeKey) {
        const last = lastDedupe.get(dedupeKey);
        if (last && now() - last.at < TOAST_DEDUPE_WINDOW_MS) {
          const existing = toasts.find((t) => t.id === last.entryId);
          if (existing) {
            // Refresh the dismiss timer for the already-visible toast.
            const timer = timers.get(existing.id);
            if (timer !== undefined && scheduler) scheduler.cancel(timer);
            timers.set(
              existing.id,
              scheduler ? scheduler.schedule(() => dismiss(existing.id), duration) : 0,
            );
          }
          return; // no new toast
        }
        lastDedupe.set(dedupeKey, { at: now(), entryId: nextId });
      }
      const entry: CommunityToastEntry = {
        id: nextId++,
        kind,
        text,
        action,
        dedupeKey: dedupeKey ?? null,
      };
      toasts = [...toasts.slice(-(TOAST_MAX_VISIBLE - 1)), entry];
      if (scheduler) {
        timers.set(
          entry.id,
          scheduler.schedule(() => dismiss(entry.id), duration),
        );
      }
      emitChange();
    },
    dismiss,
    toasts: () => toasts,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    clear() {
      for (const t of toasts) dismiss(t.id);
      lastDedupe.clear();
    },
  };
}

/** The ONE Community toast store (all surfaces share it). */
export const communityToastStore = createToastStore();
