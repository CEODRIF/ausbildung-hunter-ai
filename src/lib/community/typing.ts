import { COMMUNITY_MAX_NAME_LENGTH } from "../community";

/**
 * Community group chat — realtime typing indicator (ephemeral presence).
 *
 * Pure/isomorphic: no React, no DOM, no network — the state machine, the
 * label rules and the outgoing-sender controller are unit-testable in node
 * with an injected scheduler (see tests/community.test.ts).
 *
 * Design:
 *  - `typing_start` / `typing_stop` are broadcast over the EXISTING
 *    per-room realtime channel (event `community_typing`) and, in Phase 2,
 *    the per-conversation DM channel (event `community_dm_typing`).
 *    No new channel per feature, no new table, no DB write, no polling.
 *  - The state is ephemeral client memory only.
 *  - Every peer carries the receive-time of its latest `typing_start`;
 *    peers older than TYPING_TTL_MS are pruned (client-side timers only)
 *    so a closed browser can never leave a stuck indicator.
 *  - The current user's own typing is never part of their own indicator:
 *    broadcasts carry their own identity, and the state machine ignores
 *    events from `selfId` (Supabase's default `self: false` already keeps
 *    own broadcasts from being echoed).
 *  - Trust model: the broadcast `displayName` is UI fallback only. The
 *    component upgrades each typer's name from the RLS-backed
 *    `community_profiles` (ensureAuthor) whenever it is known — the same
 *    pattern messages use. A broadcast is never used for identity,
 *    authorization or persistence.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Broadcast event name. Rides the EXISTING per-room channel
 * (`community-room:<room_id>`); the handler guards on the room id so
 * cross-room events are dropped.
 */
export const TYPING_BROADCAST_EVENT = "community_typing";

/** Phase 2: DM typing rides the per-conversation channel (same guard model). */
export const DM_TYPING_BROADCAST_EVENT = "community_dm_typing";

/** Debounce before a `typing_stop` is sent after the last keystroke. */
export const TYPING_STOP_DELAY_MS = 1600;

/** A peer's typing state expires after this much silence (stale protection). */
export const TYPING_TTL_MS = 4000;

/** Safety cap for the (untrusted) wire userId. */
const TYPING_MAX_USER_ID_LENGTH = 64;

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------

export type TypingBroadcastType = "typing_start" | "typing_stop";

/** Wire payload of one typing broadcast. */
export interface TypingBroadcastPayload {
  type: TypingBroadcastType;
  userId: string;
  displayName: string;
  timestamp: number;
}

/**
 * Validate + normalize an incoming broadcast (untrusted wire data).
 * Returns null for anything malformed — the caller simply ignores it.
 */
export function parseTypingBroadcast(raw: unknown): TypingBroadcastPayload | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const type: TypingBroadcastType | null =
    record.type === "typing_start" || record.type === "typing_stop"
      ? record.type
      : null;
  const userId =
    typeof record.userId === "string" ? record.userId.trim() : "";
  if (type === null || userId.length === 0 || userId.length > TYPING_MAX_USER_ID_LENGTH) {
    return null;
  }
  const displayName =
    typeof record.displayName === "string"
      ? record.displayName.trim().slice(0, COMMUNITY_MAX_NAME_LENGTH)
      : "";
  const timestamp =
    typeof record.timestamp === "number" && Number.isFinite(record.timestamp)
      ? record.timestamp
      : Date.now();
  return { type, userId, displayName, timestamp };
}

// ---------------------------------------------------------------------------
// State machine (incoming side: who are the OTHER typers)
// ---------------------------------------------------------------------------

/** One remote peer currently typing, as seen by this client. */
export interface TypingPeer {
  userId: string;
  /** Name as broadcast by the peer — display fallback only, never trusted. */
  name: string;
  /** Receive time of the latest `typing_start`; drives stale expiry. */
  at: number;
}

export interface TypingState {
  selfId: string;
  peers: Record<string, TypingPeer>;
}

export function createTypingState(selfId: string): TypingState {
  return { selfId, peers: {} };
}

/**
 * Apply one received broadcast to the state (pure — returns the next state,
 * never mutates). Events from `selfId` are ignored: a user never counts
 * themselves. `at` is always the RECEIVE time; each new `typing_start`
 * refreshes the expiry, so a peer that keeps genuinely typing stays visible
 * while a dead peer drops out after TYPING_TTL_MS.
 */
export function applyTypingEvent(
  state: TypingState,
  broadcast: Pick<TypingBroadcastPayload, "type" | "userId" | "displayName">,
  now: number,
): TypingState {
  if (!broadcast.userId || broadcast.userId === state.selfId) return state;
  const peers = { ...state.peers };
  if (broadcast.type === "typing_start") {
    peers[broadcast.userId] = {
      userId: broadcast.userId,
      name: broadcast.displayName,
      at: now,
    };
  } else {
    delete peers[broadcast.userId];
  }
  return { ...state, peers };
}

/** Remove peers whose typing state has expired (now - at >= TTL). Pure. */
export function pruneExpired(state: TypingState, now: number): TypingState {
  let changed = false;
  const peers: Record<string, TypingPeer> = {};
  for (const peer of Object.values(state.peers)) {
    if (now - peer.at < TYPING_TTL_MS) {
      peers[peer.userId] = peer;
    } else {
      changed = true;
    }
  }
  return changed ? { ...state, peers } : state;
}

/**
 * Active peers: pruned, ordered deterministically — oldest start first
 * (the "first"/"second" names are stable for a given burst), ties broken by
 * userId. Returns [] when nobody is (still) typing.
 */
export function selectActiveTypers(state: TypingState, now: number): TypingPeer[] {
  return Object.values(pruneExpired(state, now).peers).sort(
    (a, b) => a.at - b.at || a.userId.localeCompare(b.userId),
  );
}

// ---------------------------------------------------------------------------
// Label rules (i18n via the caller's `t`)
// ---------------------------------------------------------------------------

export type TypingLabelFn = (
  path: string,
  vars?: Record<string, string | number>,
) => string;

/**
 * Build the indicator text for the given resolver names:
 *   0 names  → null (indicator hidden)
 *   1 name   → "{name} is typing…"
 *   2 names  → "{first} and {second} are typing…"
 *   3+ names → "{count} people are typing…" (names never listed)
 * Empty/whitespace names are dropped first (untrusted wire data).
 */
export function buildTypingLabel(
  names: readonly string[],
  t: TypingLabelFn,
): string | null {
  const clean = names.map((n) => n.trim()).filter((n) => n.length > 0);
  if (clean.length === 0) return null;
  if (clean.length === 1) {
    return t("community.typingOne", { name: clean[0] });
  }
  if (clean.length === 2) {
    return t("community.typingTwo", { first: clean[0], second: clean[1] });
  }
  return t("community.typingMany", { count: clean.length });
}

// ---------------------------------------------------------------------------
// Outgoing side (this client's own typing)
// ---------------------------------------------------------------------------

/**
 * Injectable timer so the debounce is deterministic in tests.
 * The handle is `unknown` on purpose (number in the browser,
 * Timeout in node) — callers just pass it back to `cancel`.
 */
export interface TypingScheduler {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

export const defaultScheduler: TypingScheduler = {
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface TypingSenderOptions {
  /** Called for every outgoing event (broadcast). */
  emit: (type: TypingBroadcastType) => void;
  scheduler?: TypingScheduler;
  /** Override the idle debounce (ms) — tests. */
  stopDelayMs?: number;
}

/**
 * Outgoing typing controller for the composer.
 *
 *  - `onInput(true)` emits `typing_start` ONCE per typing burst (on the
 *    not-typing → typing transition), then only re-arms the idle timer.
 *    It never emits per keystroke.
 *  - After `stopDelayMs` (default 1600) of silence, `typing_stop` is sent.
 *  - `onInput(false)` (field became empty) → `typing_stop` immediately.
 *  - `commit()` (successful send / image picked / clear / leave /
 *    unmount / disconnect) → cancel the timer and send `typing_stop`
 *    immediately, if we were typing. Never a no-op stray event.
 *  - `dispose()` → commit + no further events (unmount).
 */
export class TypingSender {
  private typing = false;
  private timer: unknown = null;
  private disposed = false;
  private readonly emit: (type: TypingBroadcastType) => void;
  private readonly scheduler: TypingScheduler;
  private readonly stopDelayMs: number;

  constructor(options: TypingSenderOptions) {
    this.emit = options.emit;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.stopDelayMs = options.stopDelayMs ?? TYPING_STOP_DELAY_MS;
  }

  /** True while a burst is active (start sent, stop not yet). */
  get isTyping(): boolean {
    return this.typing;
  }

  /**
   * Call on EVERY composer change (keypress, paste, IME commit, delete).
   * @param hasText whether the field is non-empty after the change.
   */
  onInput(hasText: boolean): void {
    if (this.disposed) return;
    if (!hasText) {
      // The field became empty → stop immediately.
      this.stopNow();
      return;
    }
    if (!this.typing) {
      this.typing = true;
      // First keystroke of the burst — the ONLY place typing_start is sent.
      this.emit("typing_start");
    }
    this.armStopTimer();
  }

  /**
   * Immediate stop: send/clear/leave/unmount/disconnect. No-op (no event)
   * when not currently typing.
   */
  commit(): void {
    this.stopNow();
  }

  /** Tear down: stop (if typing) and never emit again. */
  dispose(): void {
    this.stopNow();
    this.disposed = true;
  }

  private armStopTimer(): void {
    if (this.timer !== null) this.scheduler.cancel(this.timer);
    this.timer = this.scheduler.schedule(() => {
      this.timer = null;
      this.stopNow();
    }, this.stopDelayMs);
  }

  private stopNow(): void {
    if (this.timer !== null) {
      this.scheduler.cancel(this.timer);
      this.timer = null;
    }
    if (this.typing) {
      this.typing = false;
      this.emit("typing_stop");
    }
  }
}
