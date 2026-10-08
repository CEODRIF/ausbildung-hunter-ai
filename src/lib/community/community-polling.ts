"use client";

import { useEffect, useRef } from "react";

/**
 * Community — the ONE centralized 1-second server-polling system.
 *
 * This is the single polling infrastructure for every live Community
 * surface (rooms, DMs, conversation list, friends, notifications, home
 * feeds, question answers, shell badges). Realtime events remain the fast
 * path (instant updates); the 1s poll is the SYNCHRONIZATION GUARANTEE
 * that converges client state with the server on every device
 * (desktop, mobile, tablet, iOS, Android — the same interval).
 *
 * Contract (locked by tests/community-polling.test.ts):
 * - normal interval is EXACTLY 1000ms — never 500ms, never "mobile-only"
 * - NEVER overlapping: if the previous request is still in flight, the
 *   tick is SKIPPED (T=0 starts, T=1000 skips, T=2000 next cycle)
 * - paused while the tab is hidden (battery/network); ONE immediate sync
 *   when it becomes visible, then the loop resumes
 * - NO full-page refresh: this module never reloads the page or triggers a
 *   router refresh
 * - failures keep the existing UI state; the next normal cycle retries
 * - unmount stops the timer and aborts the in-flight request
 *
 * Every poll fetcher is responsible for its own change detection: fetch,
 * compare with current state, and only call setState on real change
 * (dedup by stable id inside the merge helpers — the same canonical
 * dedup the realtime handlers use).
 */

export const COMMUNITY_POLL_INTERVAL_MS = 1000;

export interface CommunityPollLoopOptions {
  /** Normal interval — keep COMMUNITY_POLL_INTERVAL_MS (1000). */
  intervalMs: number;
  /** One poll cycle: fetch + diff + targeted setState (abortable). */
  fetcher: (signal: AbortSignal) => Promise<unknown> | unknown;
  /** True while the page/tab is hidden → ticks are skipped (pause). */
  isHidden?: () => boolean;
  /** Starts a repeating timer (injectable for tests). */
  schedule: (fn: () => void, ms: number) => unknown;
  /** Stops the repeating timer (injectable for tests). */
  cancel: (handle: unknown) => void;
}

export interface CommunityPollLoop {
  /** Run one synchronization pass right now (guard-aware). */
  tick: () => void;
  /** Stop the timer and abort the in-flight request (unmount). */
  stop: () => void;
}

/**
 * The pure poll loop (no React, no window — fully testable with an
 * injected scheduler). One repeating 1000ms timer whose callback:
 * skips when hidden, skips when a request is still in flight, otherwise
 * runs exactly one fetcher pass with a fresh AbortSignal.
 */
export function startCommunityPollLoop(
  options: CommunityPollLoopOptions,
): CommunityPollLoop {
  let inFlight = false;
  let stopped = false;
  let handle: unknown = null;
  let abort: AbortController | null = null;

  const tick = () => {
    if (stopped) return;
    if (options.isHidden?.()) return; // hidden tab: pause (resume syncs once)
    if (inFlight) return; // overlap guard: never two identical polls in flight
    inFlight = true;
    abort = new AbortController();
    const signal = abort.signal;
    Promise.resolve(options.fetcher(signal))
      .catch(() => {
        /* keep existing state; the next normal cycle retries */
      })
      .finally(() => {
        inFlight = false;
        abort = null;
      });
  };

  const stop = () => {
    stopped = true;
    if (handle !== null) {
      options.cancel(handle);
      handle = null;
    }
    abort?.abort(); // unmount: cancel the in-flight request
    abort = null;
  };

  handle = options.schedule(tick, options.intervalMs);
  return { tick, stop };
}

export interface UseCommunityPollingOptions {
  /**
   * Stable identity of the polled surface — the loop restarts on change
   * (room switch, conversation switch, user-scoped "inbox:<id>", "home").
   */
  key: string;
  /** One poll cycle: fetch + diff + targeted setState. */
  fetcher: (signal: AbortSignal) => Promise<unknown> | unknown;
  /** While false, ticks are skipped (surface disabled/unavailable). */
  enabled?: boolean;
}

/**
 * The unified 1-second poll for a MOUNTED Community surface.
 *
 * - one immediate synchronization pass on mount (and on `key` change)
 * - then EXACTLY every COMMUNITY_POLL_INTERVAL_MS (1000ms), all devices
 * - paused while the tab is hidden; one immediate sync on return
 * - unmount: timer cleared + in-flight request aborted
 *
 * Only mounted surfaces poll — the effect lives in the surface component,
 * so e.g. opening Room A polls only Room A's newest page, never every
 * room/DM/endpoint (targeted requests, bounded server load).
 */
export function useCommunityPolling({
  key,
  fetcher,
  enabled = true,
}: UseCommunityPollingOptions): void {
  const fetcherRef = useRef(fetcher);
  const enabledRef = useRef(enabled);

  // Latest callbacks without restarting the 1s loop on every render.
  useEffect(() => {
    fetcherRef.current = fetcher;
    enabledRef.current = enabled;
  });

  useEffect(() => {
    const loop = startCommunityPollLoop({
      intervalMs: COMMUNITY_POLL_INTERVAL_MS,
      fetcher: (signal) =>
        enabledRef.current ? fetcherRef.current(signal) : undefined,
      isHidden: () =>
        typeof document !== "undefined" &&
        document.visibilityState !== "visible",
      schedule: (fn, ms) => window.setInterval(fn, ms),
      cancel: (handle) => window.clearInterval(handle as number),
    });
    loop.tick(); // immediate first sync (skipped automatically if hidden)
    const onVisibilityChange = () => {
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "visible"
      ) {
        loop.tick(); // return to visible: ONE sync, then the loop resumes
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      loop.stop();
    };
  }, [key]);
}
