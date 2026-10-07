/**
 * Community — realtime core behaviour (PURE / isomorphic primitives).
 *
 * Drives the REAL primitives (event batcher, channel registry, reconnect
 * tracker) with a deterministic fake scheduler and a fake client:
 *
 *  - the ≤500ms coalescing contract (leading-edge immediate, fixed trailing
 *    window — a CEILING, not a poll);
 *  - NO global 500ms polling: with no events, nothing ever flushes;
 *  - one live channel per stable name, ref-counted (no duplicate
 *    subscriptions, no orphaned channels);
 *  - the one-shot missed-event window (disconnect → resubscribe = exactly
 *    ONE targeted resync; CONNECTING is neutral).
 */
import { describe, expect, it } from "vitest";
import {
  createChannelRegistry,
  createEventBatcher,
  createReconnectTracker,
  RT_STATUS_CHANNEL_ERROR,
  RT_STATUS_CLOSED,
  RT_STATUS_SUBSCRIBED,
  RT_STATUS_TIMED_OUT,
  type RealtimeLikeChannel,
  type RealtimeLikeClient,
} from "@/lib/community/realtime-core";

// ---------------------------------------------------------------------------
// Deterministic fake scheduler (manual time)
// ---------------------------------------------------------------------------

function makeScheduler() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    schedule(fn: () => void, ms: number): number {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    cancel(id: number): void {
      timers.delete(id);
    },
    /** Advance virtual time, firing due timers in order. */
    advance(ms: number): void {
      const target = now + ms;
      for (;;) {
        let earliest: { id: number; at: number } | null = null;
        for (const [id, t] of timers) {
          if (t.at <= target && (!earliest || t.at < earliest.at)) {
            earliest = { id, at: t.at };
          }
        }
        if (!earliest) {
          now = target;
          return;
        }
        now = earliest.at;
        const t = timers.get(earliest.id) as { fn: () => void };
        timers.delete(earliest.id);
        t.fn();
      }
    },
    pending: () => timers.size,
  };
}

// ---------------------------------------------------------------------------
// 1. Event batcher (the ≤500ms coalescing contract)
// ---------------------------------------------------------------------------

describe("event batcher — leading-edge immediate + ≤500ms coalescing", () => {
  it("a single event is delivered IMMEDIATELY (synchronously, no 500ms wait)", () => {
    const sched = makeScheduler();
    const batches: number[][] = [];
    const b = createEventBatcher<number>({
      scheduler: sched,
      onFlush: (batch) => batches.push([...batch]),
    });
    b.push(1);
    expect(batches).toEqual([[1]]); // same task — effectively instant
    // Only the transient burst-window closer remains (it fires no flush):
    expect(sched.pending()).toBe(1);
    sched.advance(500);
    expect(sched.pending()).toBe(0);
    expect(batches).toEqual([[1]]); // nothing extra was ever delivered
  });

  it("a burst coalesces: first event immediate, the rest flush in ONE batch ≤500ms later", () => {
    const sched = makeScheduler();
    const batches: number[][] = [];
    const b = createEventBatcher<number>({
      scheduler: sched,
      onFlush: (batch) => batches.push([...batch]),
    });
    b.push(1); // leading edge — delivered now
    b.push(2); // second event of the burst — opens the coalescing window
    b.push(3); // joins the pending batch
    expect(batches).toEqual([[1]]);
    // Two transient timers: the trailing flush + the burst-window closer.
    expect(sched.pending()).toBe(2);
    sched.advance(499);
    expect(batches).toEqual([[1]]); // not yet
    sched.advance(1);
    expect(batches).toEqual([[1], [2, 3]]); // ONE flush for the whole burst
    expect(sched.pending()).toBe(0);
  });

  it("the 500ms window is FIXED (never reset by further events — a ceiling, not a target)", () => {
    const sched = makeScheduler();
    const batches: number[][] = [];
    const b = createEventBatcher<number>({
      scheduler: sched,
      onFlush: (batch) => batches.push([...batch]),
    });
    b.push(1); // leading edge at t=0
    b.push(2); // queue window opens: flush due at t=500
    sched.advance(300);
    b.push(3); // joins the SAME window — does not push the deadline to t=800
    sched.advance(200); // t=500
    expect(batches).toEqual([[1], [2, 3]]); // flushed at the original deadline
  });

  it("NO events → NO flush at any time (the 500ms is coalescing, not polling)", () => {
    const sched = makeScheduler();
    let flushed = 0;
    const b = createEventBatcher<number>({
      scheduler: sched,
      onFlush: () => {
        flushed += 1;
      },
    });
    sched.advance(10_000);
    expect(flushed).toBe(0);
    expect(sched.pending()).toBe(0);
    expect(b.hasPending).toBe(false);
  });

  it("flush() force-delivers the queued tail (teardown)", () => {
    const sched = makeScheduler();
    const batches: number[][] = [];
    const b = createEventBatcher<number>({
      scheduler: sched,
      onFlush: (batch) => batches.push([...batch]),
    });
    b.push(1);
    b.push(2);
    b.flush();
    expect(batches).toEqual([[1], [2]]);
    expect(sched.pending()).toBe(0);
  });

  it("dispose() cancels the pending trailing flush and goes silent", () => {
    const sched = makeScheduler();
    const batches: number[][] = [];
    const b = createEventBatcher<number>({
      scheduler: sched,
      onFlush: (batch) => batches.push([...batch]),
    });
    b.push(1);
    b.push(2);
    b.dispose();
    expect(sched.pending()).toBe(0);
    sched.advance(10_000);
    expect(batches).toEqual([[1]]); // the trailing flush never fired
    b.push(3); // post-dispose pushes are ignored
    expect(batches).toEqual([[1]]);
  });
});

// ---------------------------------------------------------------------------
// 2. Channel registry (one live channel per stable name, ref-counted)
// ---------------------------------------------------------------------------

function makeFakeChannel(): RealtimeLikeChannel {
  const self = {
    on() {
      return self;
    },
    subscribe: () => ({}),
    send: async () => undefined,
  };
  return self as unknown as RealtimeLikeChannel;
}

function makeFakeClient() {
  const created: string[] = [];
  const removed: RealtimeLikeChannel[] = [];
  const client: RealtimeLikeClient = {
    channel(name: string) {
      created.push(name);
      return makeFakeChannel();
    },
    removeChannel(ch: RealtimeLikeChannel) {
      removed.push(ch);
      return Promise.resolve();
    },
  };
  return { client, created, removed };
}

describe("channel registry — no duplicate subscriptions, no orphaned channels", () => {
  it("the first acquire creates the channel; a second acquire for the same name reuses it", () => {
    const reg = createChannelRegistry();
    const { client, created } = makeFakeClient();
    const a = reg.acquire(client, "community-room:room-1");
    const b = reg.acquire(client, "community-room:room-1");
    expect(created).toEqual(["community-room:room-1"]); // created ONCE
    expect(a.channel).toBe(b.channel); // the SAME live channel
    expect(reg.refs("community-room:room-1")).toBe(2);
    expect(reg.has("community-room:room-1")).toBe(true);
  });

  it("different targets create separate channels", () => {
    const reg = createChannelRegistry();
    const { client, created } = makeFakeClient();
    reg.acquire(client, "community-room:room-1");
    reg.acquire(client, "community-dm:dm-9");
    expect(created).toEqual(["community-room:room-1", "community-dm:dm-9"]);
    expect(reg.activeNames().sort()).toEqual(["community-dm:dm-9", "community-room:room-1"]);
  });

  it("release removes the channel only when the LAST ref goes", () => {
    const reg = createChannelRegistry();
    const { client, removed } = makeFakeClient();
    reg.acquire(client, "community-room:room-1");
    reg.acquire(client, "community-room:room-1");
    reg.release(client, "community-room:room-1");
    expect(removed).toHaveLength(0); // still one ref — no churn
    expect(reg.has("community-room:room-1")).toBe(true);
    reg.release(client, "community-room:room-1");
    expect(removed).toHaveLength(1); // last ref → removeChannel
    expect(reg.has("community-room:room-1")).toBe(false);
    expect(reg.refs("community-room:room-1")).toBe(0);
  });

  it("a re-acquire after full release joins a FRESH channel (re-subscribe)", () => {
    const reg = createChannelRegistry();
    const { client, created, removed } = makeFakeClient();
    const first = reg.acquire(client, "community-dm:dm-9");
    reg.release(client, "community-dm:dm-9");
    const second = reg.acquire(client, "community-dm:dm-9");
    expect(created).toHaveLength(2);
    expect(removed).toHaveLength(1);
    expect(second.channel).not.toBe(first.channel);
  });

  it("a foreign client cannot steal a live channel", () => {
    const reg = createChannelRegistry();
    const a = makeFakeClient();
    const b = makeFakeClient();
    reg.acquire(a.client, "community-room:room-1");
    expect(() => reg.acquire(b.client, "community-room:room-1")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 3. Reconnect tracker (missed-event window → ONE targeted resync)
// ---------------------------------------------------------------------------

describe("reconnect tracker — one-shot missed-event window", () => {
  it("a clean SUBSCRIBED reports connected and NO missed sync", () => {
    const events: string[] = [];
    const t = createReconnectTracker({
      onMissedSync: () => events.push("missed"),
      onConnection: (s) => events.push(s),
    });
    t.handleStatus(RT_STATUS_SUBSCRIBED);
    expect(events).toEqual(["connected"]);
    expect(t.missedWindow).toBe(false);
  });

  it("CONNECTING is neutral — no state flip, no missed window (no banner flash on load)", () => {
    const events: string[] = [];
    const t = createReconnectTracker({
      onMissedSync: () => events.push("missed"),
      onConnection: (s) => events.push(s),
    });
    t.handleStatus("CONNECTING");
    expect(events).toEqual([]);
    expect(t.missedWindow).toBe(false);
    // …and the first real status still resolves to connected:
    t.handleStatus(RT_STATUS_SUBSCRIBED);
    expect(events).toEqual(["connected"]);
  });

  it("a repeated failure reports disconnected exactly ONCE", () => {
    const events: string[] = [];
    const t = createReconnectTracker({
      onConnection: (s) => events.push(s),
    });
    t.handleStatus(RT_STATUS_TIMED_OUT);
    t.handleStatus(RT_STATUS_TIMED_OUT);
    t.handleStatus(RT_STATUS_CLOSED);
    expect(events).toEqual(["disconnected"]);
  });

  it("recovery after a gap fires onMissedSync exactly ONCE (one targeted resync)", () => {
    const events: string[] = [];
    const t = createReconnectTracker({
      onMissedSync: () => events.push("missed"),
      onConnection: (s) => events.push(s),
    });
    t.handleStatus(RT_STATUS_SUBSCRIBED);
    t.handleStatus(RT_STATUS_TIMED_OUT);
    t.handleStatus(RT_STATUS_SUBSCRIBED);
    expect(events).toEqual(["connected", "disconnected", "connected", "missed"]);
    expect(t.missedWindow).toBe(false);
  });

  it("a second recovery without a new gap does NOT fire a second missed sync", () => {
    const events: string[] = [];
    const t = createReconnectTracker({
      onMissedSync: () => events.push("missed"),
      onConnection: (s) => events.push(s),
    });
    t.handleStatus(RT_STATUS_TIMED_OUT);
    t.handleStatus(RT_STATUS_SUBSCRIBED);
    t.handleStatus(RT_STATUS_SUBSCRIBED);
    t.handleStatus(RT_STATUS_SUBSCRIBED);
    expect(events.filter((e) => e === "missed")).toHaveLength(1);
  });

  it("CLOSED and CHANNEL_ERROR open a missed window too", () => {
    for (const status of [RT_STATUS_CLOSED, RT_STATUS_CHANNEL_ERROR] as const) {
      const events: string[] = [];
      const t = createReconnectTracker({
        onMissedSync: () => events.push("missed"),
        onConnection: (s) => events.push(s),
      });
      t.handleStatus(status);
      t.handleStatus(RT_STATUS_SUBSCRIBED);
      expect(events).toEqual(["disconnected", "connected", "missed"]);
    }
  });

  it("reset() forgets the cycle (channel teardown)", () => {
    const events: string[] = [];
    const t = createReconnectTracker({
      onMissedSync: () => events.push("missed"),
      onConnection: (s) => events.push(s),
    });
    t.handleStatus(RT_STATUS_TIMED_OUT);
    t.reset(); // unmount during the gap
    t.handleStatus(RT_STATUS_SUBSCRIBED);
    expect(events).toEqual(["disconnected", "connected"]); // no stale missed sync
  });
});
