/**
 * Community — the ONE shared realtime core (PURE / isomorphic).
 *
 * Every Community surface (public rooms, DMs, the conversation list, the
 * friends view, the shell notification bus) builds its subscriptions on
 * these three primitives instead of hand-rolling channel boilerplate:
 *
 *   1. createEventBatcher — coalesces rapid realtime events.
 *      LEADING-EDGE IMMEDIATE: the first event of a burst is delivered
 *      synchronously (a normal new message is effectively instant, never
 *      held for 500ms). Events that arrive before the previous flush
 *      settles are queued and delivered in ONE batch, at most
 *      `maxMs` (default 500) after the first queued event. This is the
 *      "0.5s maximum UI synchronization window" — a ceiling on burst
 *      coalescing, not a delay applied to every message.
 *
 *   2. createChannelRegistry — at most ONE live Supabase channel per
 *      stable channel name, reference-counted. Two components needing the
 *      same conversation share the channel; the channel is removed only
 *      when the last consumer releases it. React strict-mode double
 *      effects (mount → cleanup → mount) are safe by construction.
 *
 *   3. createReconnectTracker — detects the disconnect → resubscribe
 *      window so each surface performs exactly ONE targeted
 *      synchronization (resync of the recent window / summaries) after a
 *      missed event window — never a periodic poll.
 *
 * No React, no DOM, no timers of the setInterval kind: everything here is
 * event-driven, and every timer is injectable (tests run a fake
 * scheduler). The surfaces stay interval-free except the sanctioned
 * local-only timers (typing-state prune, presence heartbeat).
 */

// ---------------------------------------------------------------------------
// Injected scheduler (tests + production both go through this)
// ---------------------------------------------------------------------------

export interface RealtimeScheduler {
  schedule(callback: () => void, ms: number): number;
  cancel(handle: number): void;
}

export const browserScheduler: RealtimeScheduler = {
  schedule: (callback, ms) => window.setTimeout(callback, ms),
  cancel: (handle) => window.clearTimeout(handle),
};

// ---------------------------------------------------------------------------
// Structural realtime types (kept minimal so the core stays isomorphic and
// the tests can drive it with a fake client)
// ---------------------------------------------------------------------------

export interface RealtimeLikeChannel {
  on(
    kind: "postgres_changes" | "broadcast" | "presence",
    spec: Record<string, unknown>,
    // `payload: any` on purpose: the core is structural, and each surface
    // validates its own wire data (parse* guards) before applying it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    callback: (payload: any) => void,
  ): RealtimeLikeChannel;
  subscribe(statusCallback?: (status: string) => void): unknown;
  send(payload: Record<string, unknown>): Promise<unknown>;
}

export interface RealtimeLikeClient {
  channel(name: string): RealtimeLikeChannel;
  removeChannel(channel: RealtimeLikeChannel): unknown;
}

/** The session slice the JWT handshake needs (join must carry the token). */
export interface RealtimeLikeSession {
  access_token: string;
}

/**
 * The auth slice the shared layer drives (structural — the supabase client
 * satisfies it, the tests can fake it).
 */
export interface RealtimeLikeAuth {
  initialize(): Promise<unknown>;
  getSession(): Promise<{ data: { session: RealtimeLikeSession | null } }>;
  onAuthStateChange(
    callback: (event: string, session: RealtimeLikeSession | null) => void,
  ): { data: { subscription: { unsubscribe(): void } } };
}

/** The realtime transport slice (token attachment before join). */
export interface RealtimeLikeRealtime {
  setAuth(token: string): Promise<unknown>;
}

/** The channel status values this core reacts to (Supabase Realtime). */
export const RT_STATUS_SUBSCRIBED = "SUBSCRIBED";
export const RT_STATUS_TIMED_OUT = "TIMED_OUT";
export const RT_STATUS_CLOSED = "CLOSED";
export const RT_STATUS_CHANNEL_ERROR = "CHANNEL_ERROR";

// ---------------------------------------------------------------------------
// 1. Event batcher (leading-edge immediate + trailing ≤ maxMs coalescing)
// ---------------------------------------------------------------------------

export interface EventBatcherOptions<E> {
  /** Maximum ms a queued (non-leading) event waits before its flush. 500. */
  maxMs?: number;
  scheduler?: RealtimeScheduler;
  onFlush: (batch: readonly E[]) => void;
}

export interface EventBatcher<E> {
  push(event: E): void;
  /** Force-deliver whatever is queued (used on teardown). */
  flush(): void;
  /** True when a flush is waiting on the trailing timer. */
  readonly hasPending: boolean;
  dispose(): void;
}

/**
 * The coalescing contract:
 *  - the FIRST event of a burst is delivered IMMEDIATELY (synchronously in
 *    the same task the socket delivered it — well under the 100–200ms
 *    target);
 *  - every event arriving while a batch is waiting for its trailing flush
 *    joins that batch;
 *  - the trailing flush fires at most `maxMs` after the FIRST queued event
 *    of the batch (the window is fixed, never reset by further events —
 *    "at most 500ms" is a hard ceiling, not a moving target);
 *  - `dispose()` cancels the pending trailing flush.
 */
export function createEventBatcher<E>(options: EventBatcherOptions<E>): EventBatcher<E> {
  const maxMs = options.maxMs ?? 500;
  const scheduler = options.scheduler ?? browserScheduler;
  let queued: E[] | null = null;
  let timer: number | null = null;
  // Open for `maxMs` after a leading-edge delivery: the NEXT push within the
  // window is the second event of a burst and opens the coalescing window
  // (a lone message more than maxMs after the previous one is instant again).
  let burstWindow: number | null = null;
  let disposed = false;

  const closeBurstWindow = () => {
    if (burstWindow !== null) {
      scheduler.cancel(burstWindow);
      burstWindow = null;
    }
  };

  const deliver = () => {
    if (queued === null) return;
    const batch = queued;
    queued = null;
    if (timer !== null) {
      scheduler.cancel(timer);
      timer = null;
    }
    closeBurstWindow();
    options.onFlush(batch);
  };

  return {
    push(event) {
      if (disposed) return;
      if (queued !== null) {
        // A batch is already waiting for its trailing flush — join it (the
        // window is FIXED to the first queued event; no new timer).
        queued.push(event);
        return;
      }
      if (burstWindow !== null) {
        // Second event of a burst: open the coalescing window — the trailing
        // flush fires at most maxMs after THIS event (further events join).
        queued = [event];
        timer = scheduler.schedule(deliver, maxMs);
        return;
      }
      // Leading edge: deliver now — a normal single message is instant.
      options.onFlush([event]);
      burstWindow = scheduler.schedule(() => {
        burstWindow = null;
      }, maxMs);
    },
    flush: deliver,
    get hasPending() {
      return queued !== null;
    },
    dispose() {
      disposed = true;
      if (timer !== null) {
        scheduler.cancel(timer);
        timer = null;
      }
      closeBurstWindow();
      queued = null;
    },
  };
}

// ---------------------------------------------------------------------------
// 2. Channel registry (one live channel per stable name, ref-counted)
// ---------------------------------------------------------------------------

export interface ChannelRegistryEntry {
  client: RealtimeLikeClient;
  channel: RealtimeLikeChannel;
  refs: number;
}

export interface ChannelRegistry {
  acquire(client: RealtimeLikeClient, name: string): ChannelRegistryEntry;
  release(client: RealtimeLikeClient, name: string): void;
  has(name: string): boolean;
  refs(name: string): number;
  activeNames(): string[];
}

export function createChannelRegistry(): ChannelRegistry {
  const live = new Map<string, ChannelRegistryEntry>();
  return {
    acquire(client, name) {
      const entry = live.get(name);
      if (entry) {
        if (entry.client !== client) {
          throw new Error(
            `[community-realtime] channel "${name}" is already owned by a different client`,
          );
        }
        entry.refs += 1;
        return entry;
      }
      const fresh: ChannelRegistryEntry = { client, channel: client.channel(name), refs: 1 };
      live.set(name, fresh);
      return fresh;
    },
    release(client, name) {
      const entry = live.get(name);
      if (!entry) return;
      entry.refs -= 1;
      if (entry.refs <= 0) {
        live.delete(name);
        void entry.client.removeChannel(entry.channel);
      }
    },
    has: (name) => live.has(name),
    refs: (name) => live.get(name)?.refs ?? 0,
    activeNames: () => [...live.keys()],
  };
}

/** The ONE registry every Community surface shares (no duplicate channels). */
export const communityChannelRegistry = createChannelRegistry();

// ---------------------------------------------------------------------------
// 3. Reconnect tracker (missed-event window → ONE targeted resync)
// ---------------------------------------------------------------------------

export type CommunityConnectionState = "connected" | "disconnected";

export interface ReconnectTrackerOptions {
  /** Fires exactly once per disconnect → resubscribe cycle. */
  onMissedSync?: () => void;
  onConnection?: (state: CommunityConnectionState) => void;
}

export interface ReconnectTracker {
  /** Feed channel status transitions. */
  handleStatus(status: string): void;
  /** True while a missed window is pending (before the next SUBSCRIBED). */
  readonly missedWindow: boolean;
  /** Forget the current cycle (channel teardown). */
  reset(): void;
}

/**
 * Supabase Realtime re-joins the channel after a socket drop and re-fires
 * SUBSCRIBED. Events between the drop and the re-join were missed — the
 * tracker reports that window exactly once so the surface runs ONE
 * targeted synchronization (recent-window resync / summary refetch).
 */
export function createReconnectTracker(options: ReconnectTrackerOptions = {}): ReconnectTracker {
  let sawDisconnected = false;
  return {
    handleStatus(status) {
      if (status === RT_STATUS_SUBSCRIBED) {
        options.onConnection?.("connected");
        if (sawDisconnected) {
          sawDisconnected = false;
          options.onMissedSync?.();
        }
      } else if (
        status === RT_STATUS_TIMED_OUT ||
        status === RT_STATUS_CLOSED ||
        status === RT_STATUS_CHANNEL_ERROR
      ) {
        if (!sawDisconnected) {
          sawDisconnected = true;
          options.onConnection?.("disconnected");
        }
      }
    },
    get missedWindow() {
      return sawDisconnected;
    },
    reset() {
      sawDisconnected = false;
    },
  };
}
