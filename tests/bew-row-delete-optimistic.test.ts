/**
 * Bewerbung Automation — optimistic company-row deletion (instant UI).
 *
 * PRODUCTION SYMPTOM
 *   The red X works, but the row only disappears after the ownership-checked
 *   server exclusion AND a full view refresh answered — the click feels dead
 *   for a second or more.
 *
 * DESIGN UNDER TEST (src/components/bewerbung-automation/row-state.ts)
 *   The delete flow is a pure, order-verified orchestrator
 *   (`deleteCompanyRow`) over tiny reducer steps:
 *
 *     claim (synchronous ref guard) → begin (UI hides the row NOW)
 *       → exclude (the server action, in the BACKGROUND)
 *         ├─ success: confirm → dropDraft → ONE refresh (best-effort)
 *         │           → retire (the view now owns visibility) → onSuccess
 *         └─ failure: fail (row restored in place, latest values intact) → onError
 *
 *   The component wires these to its state setters; everything the user sees
 *   (visible list, entry count, duplicate flags) derives from the reduced
 *   state — never from the server round trip.
 *
 * No real e-mail, no real Supabase, no browser: deferred promises stand in
 * for the network, and the visible-list derivation mirrors the component's
 * `visibleRows` memo exactly.
 */
import { describe, expect, it, vi } from "vitest";
import {
  beginRowDelete,
  confirmRowDelete,
  deleteCompanyRow,
  EMPTY_ROW_DELETE_STATE,
  failRowDelete,
  filterActiveRows,
  pruneRowDeleteState,
  retireRowDelete,
  rowValues,
  type CompanyRowView,
  type RowDeleteDeps,
  type RowDeleteState,
} from "@/components/bewerbung-automation/row-state";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function row(seq: number, over: Partial<CompanyRowView> = {}): CompanyRowView {
  return {
    id: `app-${seq}`,
    seq,
    companyName: "",
    companyEmail: "",
    contactName: null,
    companyAddress: null,
    status: "pending",
    error_code: null,
    ...over,
  };
}

const ALL_ROWS: CompanyRowView[] = [
  row(1, { companyName: "A", companyEmail: "a@a.de" }),
  row(2, { companyName: "B", companyEmail: "b@b.de" }),
  row(3, { companyName: "C", companyEmail: "c@c.de" }),
];

/** The component's visible-list derivation (active rows minus hidden). */
function visible(rows: CompanyRowView[], state: RowDeleteState): CompanyRowView[] {
  return filterActiveRows(rows).filter((a) => !state.hidden.has(a.id));
}

/**
 * Drives `deleteCompanyRow` with a DEFERRED server promise so each test can
 * assert the UI state at the exact moment between click and network answer.
 * Every dep call is recorded in `calls` (order matters).
 */
function makeHarness(appId = "app-2") {
  let state = EMPTY_ROW_DELETE_STATE;
  const calls: string[] = [];
  const inFlight = new Set<string>();
  let resolveExclude!: () => void;
  let rejectExclude!: (e: Error) => void;
  const excludePromise = new Promise<void>((res, rej) => {
    resolveExclude = () => res();
    rejectExclude = (e) => rej(e);
  });
  const exclude = vi.fn(() => excludePromise);
  const refresh = vi.fn(async () => {
    calls.push("refresh");
  });
  const deps: RowDeleteDeps = {
    appId,
    seq: 2,
    claim: (id) => {
      if (inFlight.has(id)) return false;
      inFlight.add(id);
      calls.push(`claim:${id}`);
      return true;
    },
    release: (id) => {
      inFlight.delete(id);
      calls.push(`release:${id}`);
    },
    begin: (id) => {
      state = beginRowDelete(state, id);
      calls.push(`begin:${id}`);
    },
    confirm: (id) => {
      state = confirmRowDelete(state, id);
      calls.push(`confirm:${id}`);
    },
    retire: (id) => {
      state = retireRowDelete(state, id);
      calls.push(`retire:${id}`);
    },
    fail: (id) => {
      state = failRowDelete(state, id);
      calls.push(`fail:${id}`);
    },
    dropDraft: (id) => calls.push(`dropDraft:${id}`),
    exclude,
    refresh,
    onSuccess: (seq) => calls.push(`onSuccess:${seq}`),
    onError: (e) => calls.push(`onError:${e instanceof Error ? e.message : String(e)}`),
  };
  return {
    state: () => state,
    calls,
    deps,
    resolveExclude,
    rejectExclude,
    exclude,
    refresh,
    inFlight,
  };
}

/* ------------------------------------------------------------------ *
 * A. Reducer steps — the pure state machine
 * ------------------------------------------------------------------ */

describe("row delete state: reducer steps", () => {
  it("begin hides the row immediately and marks it pending; a duplicate begin is a no-op", () => {
    const after = beginRowDelete(EMPTY_ROW_DELETE_STATE, "app-2");
    expect(after.hidden.has("app-2")).toBe(true);
    expect(after.pending.has("app-2")).toBe(true);
    // Same reference: a second begin for a pending row changes nothing.
    expect(beginRowDelete(after, "app-2")).toBe(after);
    // A different row can be deleted in parallel.
    const both = beginRowDelete(after, "app-1");
    expect(both.hidden.has("app-1")).toBe(true);
    expect(both.hidden.has("app-2")).toBe(true);
  });

  it("confirm keeps the row hidden and only clears the pending flag", () => {
    const s = confirmRowDelete(beginRowDelete(EMPTY_ROW_DELETE_STATE, "app-2"), "app-2");
    expect(s.hidden.has("app-2")).toBe(true);
    expect(s.pending.has("app-2")).toBe(false);
    // Confirming a row that is not pending is a no-op (same reference).
    expect(confirmRowDelete(s, "app-2")).toBe(s);
  });

  it("fail restores the row (clears pending AND hidden)", () => {
    const s = failRowDelete(beginRowDelete(EMPTY_ROW_DELETE_STATE, "app-2"), "app-2");
    expect(s.hidden.has("app-2")).toBe(false);
    expect(s.pending.has("app-2")).toBe(false);
    expect(failRowDelete(s, "app-2")).toBe(s);
  });

  it("prune NEVER un-hides a present row (stale views can't flicker it back); it only retires rows gone from the view", () => {
    const s = beginRowDelete(EMPTY_ROW_DELETE_STATE, "app-2");
    // The view still shows the row (stale, pre-refresh) → the entry stays.
    expect(pruneRowDeleteState(s, ALL_ROWS)).toBe(s);
    // Confirmed but the post-confirmation refresh has not landed yet →
    // still stays hidden against the stale view.
    const confirmed = confirmRowDelete(s, "app-2");
    expect(pruneRowDeleteState(confirmed, ALL_ROWS)).toBe(confirmed);
    // Only a row that is GONE from the view entirely retires defensively.
    const pruned = pruneRowDeleteState(s, [row(1), row(3)]);
    expect(pruned).not.toBe(s);
    expect(pruned.hidden.has("app-2")).toBe(false);
  });

  it("a restored excluded row reappears: retire at success hands visibility to the view", () => {
    // Success = confirm + retire → no hidden entry remains…
    const after = retireRowDelete(
      confirmRowDelete(beginRowDelete(EMPTY_ROW_DELETE_STATE, "app-2"), "app-2"),
      "app-2",
    );
    expect(after.hidden.size).toBe(0);
    expect(after.pending.size).toBe(0);
    // …so when the user later RESTORES the row from the review step, a view
    // that reports it active simply renders it — nothing keeps it hidden.
    expect(visible(ALL_ROWS, after).map((r) => r.id)).toEqual(["app-1", "app-2", "app-3"]);
    // And in the meantime the view shows it excluded → hidden by the filter.
    const excludedView = [row(1), row(2, { status: "excluded" }), row(3)];
    expect(visible(excludedView, after).map((r) => r.id)).toEqual(["app-1", "app-3"]);
  });
});

/* ------------------------------------------------------------------ *
 * B. The orchestrator — click → network → confirm/restore, in order
 * ------------------------------------------------------------------ */

describe("deleteCompanyRow: the optimistic flow", () => {
  it("hides the row immediately — without waiting for the server response", async () => {
    const h = makeHarness();
    const task = deleteCompanyRow(h.deps); // the click — do NOT await the network

    // Synchronously after the click, the row is already gone from the list
    // even though the server promise has not resolved yet.
    expect(h.state().hidden.has("app-2")).toBe(true);
    expect(h.state().pending.has("app-2")).toBe(true);
    expect(h.calls).toEqual(["claim:app-2", "begin:app-2"]);
    expect(h.exclude).toHaveBeenCalledTimes(1);
    expect(visible(ALL_ROWS, h.state()).map((r) => r.id)).toEqual(["app-1", "app-3"]);

    // …and only now does the confirmation path run.
    h.resolveExclude();
    await task;
    expect(h.calls).toContain("confirm:app-2");
    expect(h.calls).toContain("retire:app-2");
    // The refreshed view reflects the exclusion — the row is gone there too.
    const freshView = [row(1), row(2, { status: "excluded" }), row(3)];
    expect(visible(freshView, h.state()).map((r) => r.id)).toEqual(["app-1", "app-3"]);
  });

  it("a slow server response does not delay the visual deletion", async () => {
    const h = makeHarness();
    const task = deleteCompanyRow(h.deps);

    // t=0: the entry count drops 3 → 2 on the click itself.
    expect(visible(ALL_ROWS, h.state()).length).toBe(2);

    // t=30ms: the network is still in flight — the row is STILL hidden
    // (nothing re-shows it, no spinner-freeze, no wait).
    await sleep(30);
    expect(h.calls).not.toContain("confirm:app-2");
    expect(visible(ALL_ROWS, h.state()).map((r) => r.id)).toEqual(["app-1", "app-3"]);

    // The (slow) server finally answers → the row stays removed: in the
    // refreshed view (the row is now durably excluded) and with the
    // optimistic entry retired — the view owns visibility from here on.
    h.resolveExclude();
    await task;
    const freshView = [row(1), row(2, { status: "excluded" }), row(3)];
    expect(visible(freshView, h.state()).map((r) => r.id)).toEqual(["app-1", "app-3"]);
    expect(h.state().pending.has("app-2")).toBe(false);
    expect(h.state().hidden.has("app-2")).toBe(false);
  });

  it("a failed request restores the row in its original position with its latest edits", async () => {
    const h = makeHarness();
    const task = deleteCompanyRow(h.deps);
    h.rejectExclude(new Error("SAVE_FAILED"));
    await task;

    // Restored — in its ORIGINAL position (index 1 of 3).
    const list = visible(ALL_ROWS, h.state());
    expect(list.map((r) => r.id)).toEqual(["app-1", "app-2", "app-3"]);

    // The row's draft was NOT dropped → the latest field values survive.
    expect(h.calls).not.toContain("dropDraft:app-2");
    const drafts: Record<string, { companyName: string; companyEmail: string; contactName: string; companyAddress: string }> = {
      "app-2": { companyName: "B (edits)", companyEmail: "b-edited@b.de", contactName: "Frau X", companyAddress: "Str. 1" },
    };
    const v = rowValues(drafts, ALL_ROWS, "app-2")!;
    expect(v.companyName).toBe("B (edits)");
    expect(v.companyEmail).toBe("b-edited@b.de");

    // The error is surfaced, the row is released → a retry can start.
    expect(h.calls).toEqual([
      "claim:app-2",
      "begin:app-2",
      "fail:app-2",
      "onError:SAVE_FAILED",
      "release:app-2",
    ]);
    expect(h.inFlight.has("app-2")).toBe(false);
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("double-clicking the same row cannot trigger duplicate requests", async () => {
    const h = makeHarness();
    const a = deleteCompanyRow(h.deps); // first click
    const b = deleteCompanyRow(h.deps); // second click, before the first answered

    // The synchronous claim rejects the second start — exactly one claim,
    // one begin, one network request.
    expect(h.exclude).toHaveBeenCalledTimes(1);
    expect(h.calls.filter((c) => c === "begin:app-2")).toHaveLength(1);
    expect(h.calls.filter((c) => c === "claim:app-2")).toHaveLength(1);

    h.resolveExclude();
    await Promise.all([a, b]);
    expect(h.exclude).toHaveBeenCalledTimes(1);
    expect(h.calls.filter((c) => c === "dropDraft:app-2")).toHaveLength(1);
  });

  it("other rows and their field values remain unchanged", async () => {
    const h = makeHarness();
    const task = deleteCompanyRow(h.deps);

    // While in flight: only the middle row disappears.
    expect(visible(ALL_ROWS, h.state()).map((r) => r.id)).toEqual(["app-1", "app-3"]);
    // The other rows' drafts are never touched.
    expect(h.calls).not.toContain("dropDraft:app-1");
    expect(h.calls).not.toContain("dropDraft:app-3");

    h.resolveExclude();
    await task;

    // After success: ONLY the deleted row's draft is dropped.
    expect(h.calls.filter((c) => c === "dropDraft:app-2")).toHaveLength(1);
    expect(h.calls).not.toContain("dropDraft:app-1");
    expect(h.calls).not.toContain("dropDraft:app-3");
  });

  it("in-flight sending protections still work (the engine rejects, the row is restored)", async () => {
    const h = makeHarness();
    const task = deleteCompanyRow(h.deps);
    // queued/sending rows are locked server-side (BEW_IN_FLIGHT) →
    // the exclusion throws APPLICATION_LOCKED and NOTHING is mutated.
    h.rejectExclude(new Error("APPLICATION_LOCKED"));
    await task;

    expect(h.state().hidden.has("app-2")).toBe(false); // row restored
    expect(h.calls).toContain("onError:APPLICATION_LOCKED");
    expect(h.calls).not.toContain("dropDraft:app-2");
    expect(h.calls).not.toContain("refresh");
    expect(h.calls).not.toContain("retire:app-2");
    expect(h.exclude).toHaveBeenCalledTimes(1);
  });

  it("the success path runs confirm → dropDraft → ONE refresh → onSuccess, in that order", async () => {
    const h = makeHarness();
    const task = deleteCompanyRow(h.deps);
    h.resolveExclude();
    await task;

    expect(h.calls).toEqual([
      "claim:app-2",
      "begin:app-2",
      "confirm:app-2",
      "dropDraft:app-2",
      "refresh",
      "retire:app-2",
      "onSuccess:2",
      "release:app-2",
    ]);
    expect(h.refresh).toHaveBeenCalledTimes(1);

    // Retired: the view owns the row's visibility now (excluded → hidden
    // by the row filter; restored later → reappears on its own, Part A).
    expect(h.state().hidden.has("app-2")).toBe(false);
    expect(h.state().pending.has("app-2")).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * C. Component wiring (static contract, same style as the sibling suite)
 * ------------------------------------------------------------------ */

describe("companies-step wiring: the click path is synchronous", () => {
  it("uses the ref claim + deleteCompanyRow, and derives count/table/duplicates from visibleRows", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(
      join(process.cwd(), "src/components/bewerbung-automation/companies-step.tsx"),
      "utf8",
    );
    // Synchronous double-click guard (a state check could batch two clicks).
    expect(src).toContain("inFlightDeletes");
    expect(src).toMatch(/if \(inFlightDeletes\.current\.has\(id\)\) return false;/);
    // The click kicks the pure orchestrator; the server action is a DEP of it.
    expect(src).toMatch(/void deleteCompanyRow\(/);
    expect(src).toContain("begin: (id) => setDeleteState((s) => beginRowDelete(s, id))");
    expect(src).toContain("confirm: (id) => setDeleteState((s) => confirmRowDelete(s, id))");
    expect(src).toContain("retire: (id) => setDeleteState((s) => retireRowDelete(s, id))");
    expect(src).toContain("fail: (id) => setDeleteState((s) => failRowDelete(s, id))");
    // The button is disabled while ITS row is pending (per-row, not global).
    expect(src).toContain("deleteView.pending.has(app.id)");
    // Count, table and duplicate check all read the visible rows.
    expect(src).toContain("({visibleRows.length})");
    expect(src).toMatch(/visibleRows\.map\(\(app\)[\s\S]{0,800}?key=\{app\.id\}/);
    expect(src).toContain("for (const a of visibleRows)");
    // The old blocking flow (shared busy + await before any UI change) is gone.
    expect(src).not.toContain("void deleteRow(app)");
    expect(src).not.toMatch(/setBusy\(true\);\s*\n\s*await bewExcludeApplication/);
  });
});
