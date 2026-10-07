/**
 * Community — the shared interaction-feedback system (Phase 2 UX contract).
 *
 * Behaviour tests for the pure core (`createCommunityAction`, the toast
 * store) with a deterministic fake scheduler, plus source pins for the
 * React glue (stable-width stacked labels, aria-busy, press feedback, the
 * one toast store shared by every surface).
 *
 * Proofs covered:
 *  - async actions give IMMEDIATE visual feedback (pending is synchronous);
 *  - double-submit protection (a second click while pending is ignored —
 *    no duplicate requests, no stuck button);
 *  - pending actions CANNOT stay stuck (slow at 500ms, stalled at 3s,
 *    success auto-resets, error is recoverable via retry);
 *  - toasts are deduplicated, bounded and auto-dismissing.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCommunityAction,
  createToastStore,
  type CommunityActionState,
  type CommunityToastStore,
} from "@/lib/community/action-core";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const readSrc = (relative: string) => readFileSync(resolve(root, relative), "utf8");

// ---------------------------------------------------------------------------
// Deterministic fake scheduler
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

/** A promise whose fate the test controls. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ---------------------------------------------------------------------------
// 1. The action state machine
// ---------------------------------------------------------------------------

describe("createCommunityAction — the 'did my click work?' contract", () => {
  it("the pending state is set SYNCHRONOUSLY on run() (same-frame acknowledgement)", () => {
    const d = deferred<void>();
    const stateBox: { current: CommunityActionState | null } = { current: null };
    const action = createCommunityAction({
      onChange: (s) => {
        stateBox.current = s;
      },
    });
    // No scheduler → no timers needed for this proof.
    const p = action.run(() => d.promise);
    // Synchronously (before the microtask resolves): pending is ALREADY on.
    expect(action.phase).toBe("pending");
    expect(stateBox.current?.phase).toBe("pending");
    expect(p).toBeInstanceOf(Promise);
    d.resolve();
    void p;
    action.dispose();
  });

  it("success: pending → success → (auto-reset 1500ms) → idle", async () => {
    const sched = makeScheduler();
    const seen: string[] = [];
    const action = createCommunityAction({ scheduler: sched, onChange: (s) => seen.push(s.phase) });
    const p = action.run(async () => "ok");
    await p;
    expect(action.phase).toBe("success");
    sched.advance(1499);
    expect(action.phase).toBe("success");
    sched.advance(1);
    expect(action.phase).toBe("idle");
    expect(seen).toEqual(["pending", "success", "idle"]);
    action.dispose();
  });

  it("error: pending → error (kept until the next run/retry); retry re-runs the SAME action", async () => {
    const sched = makeScheduler();
    let runs = 0;
    const action = createCommunityAction({ scheduler: sched });
    const first = action.run(async () => {
      runs += 1;
      if (runs === 1) throw new Error("boom"); // fails once, then recovers
      return "recovered";
    });
    await expect(first).rejects.toThrow("boom"); // the caller still sees the error
    expect(action.phase).toBe("error");
    expect(action.error).toBeInstanceOf(Error);
    // Retry re-runs the captured action (not a new duplicate from the UI):
    const retry = action.retry();
    expect(action.phase).toBe("pending"); // pending again, synchronously
    await retry; // retry swallows — the state machine owns the outcome
    expect(runs).toBe(2); // the SAME fn, exactly once per attempt
    expect(action.phase).toBe("success");
    action.dispose();
  });

  it("DOUBLE-SUBMIT: a second run while pending is IGNORED (no duplicate request)", async () => {
    const d = deferred<number>();
    let executions = 0;
    const action = createCommunityAction();
    const first = action.run(async () => {
      executions += 1;
      return d.promise;
    });
    // A second click while pending:
    const second = await action.run(async () => {
      executions += 1;
      return 2;
    });
    expect(second).toBeUndefined(); // ignored — the caller renders pending
    expect(executions).toBe(1); // NO duplicate request
    d.resolve(1);
    await first;
    expect(executions).toBe(1);
    action.dispose();
  });

  it("a pending action CANNOT stay stuck: slow after 500ms, stalled after 3s", async () => {
    const sched = makeScheduler();
    const seen: { phase: string; slow: boolean; stalled: boolean }[] = [];
    const d = deferred<void>();
    const action = createCommunityAction({
      scheduler: sched,
      onChange: (s) => seen.push({ phase: s.phase, slow: s.slow, stalled: s.stalled }),
    });
    const p = action.run(() => d.promise);
    sched.advance(499);
    expect(action.slow).toBe(false);
    sched.advance(1); // t=500 → the affordance escalates
    expect(action.slow).toBe(true);
    sched.advance(2499);
    expect(action.stalled).toBe(false);
    sched.advance(1); // t=3000 → the 'still working…' hint
    expect(action.stalled).toBe(true);
    // Recovery clears both flags:
    d.resolve();
    await p; // let the settlement microtask run
    expect(action.phase).toBe("success");
    expect(action.slow).toBe(false);
    expect(action.stalled).toBe(false);
    expect(seen.some((s) => s.phase === "pending" && s.slow)).toBe(true);
    expect(seen.some((s) => s.phase === "pending" && s.stalled)).toBe(true);
    action.dispose();
  });

  it("reset() returns to idle and clears the pending timers", () => {
    const sched = makeScheduler();
    const d = deferred<void>();
    const action = createCommunityAction({ scheduler: sched });
    void action.run(() => d.promise);
    expect(action.phase).toBe("pending");
    action.reset();
    expect(action.phase).toBe("idle");
    expect(sched.pending()).toBe(0); // no slow/stalled timers left
    d.resolve();
    action.dispose();
  });

  it("dispose() silences the action (no onChange after unmount)", () => {
    const seen: string[] = [];
    const d = deferred<void>();
    const action = createCommunityAction({ onChange: (s) => seen.push(s.phase) });
    const p = action.run(() => d.promise);
    action.dispose();
    d.resolve();
    void p;
    // The settled emit is suppressed after dispose:
    expect(seen).toEqual(["pending"]);
  });

  it("success timers are replaced, not stacked, across consecutive runs", async () => {
    const sched = makeScheduler();
    const action = createCommunityAction({ scheduler: sched });
    await action.run(async () => 1);
    expect(sched.pending()).toBe(1); // exactly one reset timer in the air
    sched.advance(1500); // first run reset to idle
    expect(action.phase).toBe("idle");
    expect(sched.pending()).toBe(0);
    await action.run(async () => 2);
    sched.advance(1500); // second run reset to idle — ONE reset timer again
    expect(action.phase).toBe("idle");
    expect(sched.pending()).toBe(0);
    action.dispose();
  });
});

// ---------------------------------------------------------------------------
// 2. The toast store (deduplicated, bounded, auto-dismissing)
// ---------------------------------------------------------------------------

describe("toast store — explicit confirmations only", () => {
  let store: CommunityToastStore;
  let sched: ReturnType<typeof makeScheduler>;

  afterEach(() => {
    store.clear();
  });

  it("notify shows a toast; success auto-dismisses after 2600ms, error after 4200ms", () => {
    sched = makeScheduler();
    store = createToastStore(sched);
    store.notify({ kind: "success", text: "Done" });
    expect(store.toasts()).toHaveLength(1);
    sched.advance(2599);
    expect(store.toasts()).toHaveLength(1);
    sched.advance(1);
    expect(store.toasts()).toHaveLength(0);

    store.notify({ kind: "error", text: "Failed" });
    sched.advance(4199);
    expect(store.toasts()).toHaveLength(1);
    sched.advance(1);
    expect(store.toasts()).toHaveLength(0);
  });

  it("the same dedupeKey within 2s does NOT stack a second toast (timer refreshed)", () => {
    sched = makeScheduler();
    store = createToastStore(sched);
    store.notify({ kind: "success", text: "Muted: #general", dedupeKey: "room-mute" });
    sched.advance(1000);
    store.notify({ kind: "success", text: "Muted: #general", dedupeKey: "room-mute" });
    expect(store.toasts()).toHaveLength(1); // still ONE toast
    // The refreshed timer dismisses 2600ms after the SECOND notify (t=3600):
    sched.advance(2599); // t=3599
    expect(store.toasts()).toHaveLength(1);
    sched.advance(1); // t=3600
    expect(store.toasts()).toHaveLength(0);
  });

  it("after the dedupe window the same key MAY toast again", () => {
    sched = makeScheduler();
    store = createToastStore(sched);
    store.notify({ kind: "info", text: "First", dedupeKey: "k" });
    sched.advance(2600); // the first toast auto-dismissed (dedupe window 2000 also elapsed)
    store.notify({ kind: "info", text: "Again", dedupeKey: "k" });
    expect(store.toasts()).toHaveLength(1);
    expect(store.toasts()[0].text).toBe("Again");
  });

  it("at most 3 toasts visible (the oldest is evicted)", () => {
    sched = makeScheduler();
    store = createToastStore(sched);
    store.notify({ kind: "info", text: "1" });
    store.notify({ kind: "info", text: "2" });
    store.notify({ kind: "info", text: "3" });
    store.notify({ kind: "info", text: "4" });
    expect(store.toasts().map((t) => t.text)).toEqual(["2", "3", "4"]);
  });

  it("dismiss() cancels the auto-dismiss timer (no timer leak)", () => {
    sched = makeScheduler();
    store = createToastStore(sched);
    store.notify({ kind: "success", text: "Bye" });
    expect(sched.pending()).toBe(1);
    const [toast] = store.toasts();
    store.dismiss(toast.id);
    expect(store.toasts()).toHaveLength(0);
    expect(sched.pending()).toBe(0); // timer cancelled
    sched.advance(10_000);
    expect(store.toasts()).toHaveLength(0);
  });

  it("subscribe() fires on notify and dismiss (the view re-renders from the bus)", () => {
    sched = makeScheduler();
    store = createToastStore(sched);
    let changes = 0;
    const unsub = store.subscribe(() => {
      changes += 1;
    });
    store.notify({ kind: "info", text: "Hi" });
    expect(changes).toBe(1);
    const [toast] = store.toasts();
    store.dismiss(toast.id);
    expect(changes).toBe(2);
    unsub();
    store.notify({ kind: "info", text: "Gone" });
    expect(changes).toBe(2); // no more notifications
  });

  it("toasts can carry an action (e.g. 'Retry')", () => {
    sched = makeScheduler();
    store = createToastStore(sched);
    let ran = 0;
    store.notify({ kind: "error", text: "Failed", action: { label: "Retry", run: () => (ran += 1) } });
    const [toast] = store.toasts();
    expect(toast.action?.label).toBe("Retry");
    toast.action?.run();
    expect(ran).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3. React glue (source pins — the node env has no renderer)
// ---------------------------------------------------------------------------

describe("action-feedback React glue (source contract)", () => {
  const src = readSrc("src/components/community/action-feedback.tsx");
  const profileCard = readSrc("src/components/community/profile-card.tsx");

  it("the hook drives the pure core (one action instance per button, disposed on unmount)", () => {
    expect(src).toContain("createCommunityAction(");
    expect(src).toContain("onChange: (next) => setState(next)");
    expect(src).toContain("return () => action?.dispose();");
  });

  it("the button stacks its labels in a grid (stable width — no layout jump)", () => {
    expect(src).toContain('className="relative grid"');
    expect(src).toContain("col-start-1 row-start-1");
    expect(src).toContain("invisible");
  });

  it("pending is exposed to a11y and never looks dead (spinner, full opacity)", () => {
    expect(src).toContain("aria-busy={pending || undefined}");
    expect(src).toContain("pending && <ActionSpinner");
    expect(src).toContain('pending ? "disabled:opacity-100" : "disabled:opacity-50"');
  });

  it("press acknowledgement is the shared 150ms motion-safe class", () => {
    expect(src).toContain("active:scale-[0.97]");
    expect(src).toContain("duration-150");
  });

  it("the profile card actions all route through the shared hook (no ad-hoc pending state)", () => {
    expect(profileCard).toContain("useCommunityAction()");
    expect(profileCard).toContain("<CommunityActionButton");
    // One action state machine per card (not per button — the card-level
    // run() guards every button in the card):
    expect(profileCard).toContain("run(actionKind)");
  });

  it("the toast provider + store are the ONE shared bus (no per-view toast state)", () => {
    expect(src).toContain("communityToastStore");
    const shell = readSrc("src/components/community/community-shell.tsx");
    expect(shell).toContain("CommunityToastProvider");
  });
});
