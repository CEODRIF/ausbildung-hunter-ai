/**
 * Community — the unified 1-second polling synchronization layer.
 *
 * Behavioral tests for the pure poll loop (injected scheduler — the same
 * deterministic fake-scheduler style as the realtime-core tests) plus source
 * pins that lock the architecture: ONE centralized implementation, exactly
 * 1000ms, no overlapping requests, no full-page refresh, targeted
 * per-surface endpoints, and change detection before every setState.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  COMMUNITY_POLL_INTERVAL_MS,
  startCommunityPollLoop,
  type CommunityPollLoopOptions,
} from "@/lib/community/community-polling";

const read = (p: string): string => readFileSync(join(process.cwd(), p), "utf8");

/** Let the loop's `.catch().finally()` microtask chain settle. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

// ---------------------------------------------------------------------------
// Deterministic fake scheduler: one "advance" = exactly one 1000ms tick
// ---------------------------------------------------------------------------

interface LoopFixture {
  loop: ReturnType<typeof startCommunityPollLoop>;
  calls: number[]; // tick index at which each fetcher pass started
  signals: AbortSignal[];
  resolvers: Array<() => void>;
  rejectors: Array<(error: unknown) => void>;
  fireTick: () => void;
  setHidden: (hidden: boolean) => void;
  stopFlag: () => boolean;
}

function makeLoop(
  behavior?: "pending" | "fast" | "flaky",
): LoopFixture {
  let tickIndex = 0;
  let hidden = false;
  let timerCancelled = false;
  const calls: number[] = [];
  const signals: AbortSignal[] = [];
  const resolvers: Array<() => void> = [];
  const rejectors: Array<(error: unknown) => void> = [];

  const opts: CommunityPollLoopOptions = {
    intervalMs: COMMUNITY_POLL_INTERVAL_MS,
    fetcher: (signal) => {
      calls.push(tickIndex);
      signals.push(signal);
      if (behavior === "fast") {
        return Promise.resolve();
      }
      // "pending" (default) / "flaky": stay in flight until the test
      // resolves or rejects the promise explicitly.
      return new Promise<void>((resolve, reject) => {
        resolvers.push(resolve);
        rejectors.push(reject);
      });
    },
    isHidden: () => hidden,
    schedule: () => {
      return { kind: "interval" };
    },
    cancel: () => {
      timerCancelled = true;
    },
  };

  const loop = startCommunityPollLoop(opts);
  return {
    loop,
    calls,
    signals,
    resolvers,
    rejectors,
    fireTick: () => {
      tickIndex += 1; // exactly one 1000ms of wall time passes
      loop.tick();
    },
    setHidden: (h: boolean) => {
      hidden = h;
    },
    stopFlag: () => timerCancelled,
  };
}

// ---------------------------------------------------------------------------
// The interval + no-overlap contract (spec §4, §5)
// ---------------------------------------------------------------------------

describe("community poll loop — interval & overlap contract", () => {
  it("the normal interval is EXACTLY 1000ms (one constant, all devices)", () => {
    expect(COMMUNITY_POLL_INTERVAL_MS).toBe(1000);
    const src = read("src/lib/community/community-polling.ts");
    expect(src).toContain("export const COMMUNITY_POLL_INTERVAL_MS = 1000;");
    // The hook schedules with that constant — no other interval literal.
    expect(src).toContain("intervalMs: COMMUNITY_POLL_INTERVAL_MS,");
  });

  it("never overlaps: T=0 starts, T=1000 & T=2000 skip, T=3000 next cycle", async () => {
    const f = makeLoop("pending");
    f.loop.tick(); // immediate first sync (t=0) → request starts, stays in flight
    expect(f.calls).toHaveLength(1);

    f.fireTick(); // t=1000: previous request still running → SKIP
    f.fireTick(); // t=2000: still running → SKIP
    expect(f.calls).toHaveLength(1);

    f.resolvers[0](); // t≈2500: request finishes
    await settle();

    f.fireTick(); // t=3000: next normal cycle → request #2
    expect(f.calls).toHaveLength(2);
  });

  it("a fast request never blocks the next cycle", async () => {
    const f = makeLoop("fast");
    f.loop.tick(); // immediate
    await settle();
    f.fireTick();
    await settle();
    f.fireTick();
    await settle();
    expect(f.calls).toHaveLength(3); // one pass per tick, all completed
  });

  it("pauses while the tab is hidden and runs ONE immediate sync on return", () => {
    const f = makeLoop("fast");
    f.setHidden(true);
    f.fireTick(); // hidden → skipped (no network while suspended)
    f.fireTick();
    expect(f.calls).toHaveLength(0);

    f.setHidden(false);
    f.loop.tick(); // the visibility-return sync (exactly what the hook fires)
    expect(f.calls).toHaveLength(1);
  });

  it("stop() cancels the timer AND aborts the in-flight request (unmount)", async () => {
    const f = makeLoop("pending");
    f.loop.tick();
    f.loop.stop();
    expect(f.stopFlag()).toBe(true);
    expect(f.signals[0].aborted).toBe(true);
    // A tick after unmount must do nothing.
    f.fireTick();
    expect(f.calls).toHaveLength(1);
  });

  it("a failed poll keeps the UI: the next normal cycle retries", async () => {
    const f = makeLoop("flaky");
    f.loop.tick(); // call #1
    f.rejectors[0](new Error("network down"));
    await settle();
    f.fireTick(); // next cycle → call #2 (no throw escaped the loop)
    expect(f.calls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// ONE centralized implementation (spec §1, §20 source proof)
// ---------------------------------------------------------------------------

describe("unified polling architecture (source pins)", () => {
  it("the poller itself never refreshes the page or router", () => {
    const src = read("src/lib/community/community-polling.ts");
    expect(src).not.toContain("location.reload");
    expect(src).not.toContain("window.location");
    expect(src).not.toContain("router.refresh");
    // Repeating timer + visibility pause + abort-on-unmount all in ONE file.
    expect(src).toContain("window.setInterval(fn, ms)");
    expect(src).toContain('document.visibilityState !== "visible"');
    expect(src).toContain("abort?.abort()");
  });

  it("every live surface polls through useCommunityPolling — no second system", () => {
    const surfaces = [
      "src/components/community/room-chat.tsx",
      "src/components/community/dm-chat.tsx",
      "src/components/community/dm-inbox.tsx",
      "src/components/community/friends-view.tsx",
      "src/components/community/notifications-view.tsx",
      "src/components/community/community-shell.tsx",
      "src/components/community/community-home.tsx",
      "src/components/community/question-detail.tsx",
    ];
    for (const file of surfaces) {
      expect(read(file)).toContain("useCommunityPolling({");
    }
  });

  it("no accidental 500ms polling and no per-component data-poll timers", () => {
    const dir = "src/components/community";
    const files = readdirSync(join(process.cwd(), dir)).filter((f) => f.endsWith(".tsx"));
    for (const file of files) {
      const src = read(`${dir}/${file}`);
      // Never a 500ms (or any sub-second) repeating poll.
      expect(src).not.toMatch(/setInterval\([^)]*,\s*500\s*\)/);
      expect(src).not.toMatch(/setInterval\([^)]*,\s*100\s*\)/);
      // Data polling lives ONLY in the shared hook; the only timers a chat
      // may own are the local typing-state prune (never touches the network).
      const intervals = src.match(/setInterval\(/g) ?? [];
      if (file === "room-chat.tsx" || file === "dm-chat.tsx") {
        expect(intervals).toHaveLength(1); // the typing prune only
        expect(src).toContain("TYPING_PRUNE_INTERVAL_MS");
      } else {
        expect(intervals).toHaveLength(0);
      }
    }
  });

  it("polls are TARGETED: only the mounted surface's own data (spec §12, §13)", () => {
    expect(read("src/components/community/room-chat.tsx")).toContain(
      "`/api/community/messages?room=${encodeURIComponent(room.slug)}&poll=1`",
    );
    expect(read("src/components/community/dm-chat.tsx")).toContain(
      "`/api/community/dm/${conversation.id}?poll=1`",
    );
    expect(read("src/components/community/dm-inbox.tsx")).toContain(
      '"/api/community/dm?poll=1"',
    );
    expect(read("src/components/community/friends-view.tsx")).toContain(
      '"/api/community/friends?poll=1"',
    );
    expect(read("src/components/community/notifications-view.tsx")).toContain(
      '"/api/community/notifications?poll=1"',
    );
    expect(read("src/components/community/community-shell.tsx")).toContain(
      '"/api/community/badges?poll=1"',
    );
    expect(read("src/components/community/community-home.tsx")).toContain(
      '"/api/community/home?poll=1"',
    );
    expect(read("src/components/community/question-detail.tsx")).toContain(
      "`/api/community/questions/${questionId}/answers?poll=1`",
    );
  });

  it("every poll fetcher has an overlap guard + change detection (spec §5, §6)", () => {
    // Overlap guards (skip, never stack) in every surface fetcher:
    expect(read("src/components/community/room-chat.tsx")).toContain(
      "if (resyncInFlight.current) return; // overlap guard: skip, don't stack",
    );
    expect(read("src/components/community/dm-chat.tsx")).toContain(
      "if (resyncInFlight.current) return; // overlap guard: skip, don't stack",
    );
    expect(read("src/components/community/dm-inbox.tsx")).toContain(
      "if (refetching.current) return; // overlap guard: skip, don't stack",
    );
    expect(read("src/components/community/friends-view.tsx")).toContain(
      "if (refetching.current) return; // overlap guard: skip, don't stack",
    );
    expect(read("src/components/community/notifications-view.tsx")).toContain(
      "if (pollInFlight.current) return; // overlap guard: skip, don't stack",
    );
    expect(read("src/components/community/community-shell.tsx")).toContain(
      "if (badgesResyncInFlight.current) return; // overlap guard: skip, don't stack",
    );
    expect(read("src/components/community/community-home.tsx")).toContain(
      "if (pollInFlight.current) return; // overlap guard: skip, don't stack",
    );
    expect(read("src/components/community/question-detail.tsx")).toContain(
      "if (answersPollInFlight.current) return; // overlap guard: skip, don't stack",
    );

    // Change detection: an unchanged payload must cause zero setState.
    expect(read("src/components/community/room-chat.tsx")).toContain("if (!changed) return;");
    expect(read("src/components/community/dm-chat.tsx")).toContain("if (!changed) return;");
    expect(read("src/components/community/dm-inbox.tsx")).toContain(
      "JSON.stringify(next) === JSON.stringify(conversationsRef.current)",
    );
    expect(read("src/components/community/friends-view.tsx")).toContain(
      "JSON.stringify(candidate) === JSON.stringify(prev)",
    );
    expect(read("src/components/community/notifications-view.tsx")).toContain(
      "JSON.stringify(merged) === JSON.stringify(prev)",
    );
    expect(read("src/components/community/community-shell.tsx")).toContain(
      "prev.dms === b.dms",
    );
    expect(read("src/components/community/community-home.tsx")).toContain(
      "JSON.stringify(prev) === JSON.stringify(next)",
    );
    expect(read("src/components/community/question-detail.tsx")).toContain(
      "JSON.stringify(prev) === JSON.stringify(nextAnswers)",
    );
  });

  it("polling reuses the CANONICAL merge (dedup + optimistic reconcile, spec §8, §9)", () => {
    // Both chats converge poll + realtime + optimistic rows through the same
    // id-keyed merge with preferIncoming (server row replaces the
    // optimistic twin — no duplicate bubbles).
    expect(read("src/components/community/room-chat.tsx")).toContain(
      "mergeCommunityMessages(prev, data.items, { preferIncoming: true })",
    );
    expect(read("src/components/community/dm-chat.tsx")).toContain(
      "mergeCommunityMessages(prev, data.messages, { preferIncoming: true })",
    );
    // Dedup by stable id: the known-id set gates new-row accounting.
    expect(read("src/components/community/dm-chat.tsx")).toContain(
      "const before = new Set(knownIds.current);",
    );
    // The notifications poll dedupes by id inside its merge.
    expect(read("src/components/community/notifications-view.tsx")).toContain(
      "const prevById = new Map(prev.map((n) => [n.id, n] as const));",
    );
  });

  it("realtime stays as the fast path alongside the poll (spec §9, §16)", () => {
    // The shared realtime hooks are untouched and still registered in every
    // surface — the poll ADDS the guarantee, it does not replace the stream.
    expect(read("src/components/community/room-chat.tsx")).toContain("useRoomRealtime(room.id, {");
    expect(read("src/components/community/dm-chat.tsx")).toContain("useDMRealtime(conversation.id, {");
    expect(read("src/components/community/dm-inbox.tsx")).toContain("useConversationListRealtime(me.userId, {");
    expect(read("src/components/community/friends-view.tsx")).toContain("useFriendshipsRealtime(me.userId, {");
    expect(read("src/components/community/community-shell.tsx")).toContain("useNotificationsRealtime(me.userId, {");
  });
});
