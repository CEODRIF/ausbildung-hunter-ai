/**
 * Bewerbung Automation — per-row optimistic SAVE regression suite.
 *
 * Requirements pinned here (`row-state.ts` is pure, so they are verified
 * EXACTLY):
 *   1. The UI responds to the FIRST click: the indicator + optimistic row
 *      patch are applied synchronously, before the server round trip
 *      resolves.
 *   2. Success: the SERVER row is authoritative — it is applied at confirm
 *      time, the draft is dropped, a transient "Saved" chip is shown. On the
 *      normal path NO full-view resync happens (that was the latency).
 *   3. Failure: the optimistic patch is rolled back to the exact pre-save
 *      field set and the user's draft is PRESERVED (the edits survive).
 *   4. A null result (the row vanished elsewhere) is reported as NOT_FOUND
 *      with the same rollback.
 *   5. Double-click: a second click on the same row while one save is in
 *      flight is a no-op — exactly ONE network call.
 *   6. Concurrent saves to different rows are independent: each patch
 *      touches only its own row.
 *
 * Plus a static source contract (same style as the sibling suites) pinning
 * the companies-step.tsx wiring: per-row indicators, no step-wide busy lock
 * on the save path, no full-view refetch after a save, memoized rows.
 */
import { describe, expect, it } from "vitest";

import {
  EMPTY_ROW_SAVE_STATE,
  beginRowSave,
  clearRowSaved,
  confirmRowSave,
  failRowSave,
  optimisticSaveFields,
  saveCompanyRow,
  snapshotFromRow,
  snapshotSaveFields,
  type RowSaveDeps,
  type RowSaveFields,
} from "@/components/bewerbung-automation/row-state";
import type { CompanyRecord } from "@/components/bewerbung-automation/types";
import { buildSubject } from "@/lib/bewerbung-automation";

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const VALUES: CompanyRecord = {
  companyName: "Neue Firma AG",
  companyEmail: "talent@neue-firma.de",
  contactName: "Max Mustermann",
  companyAddress: "Musterstraße 1",
  positionTitle: "Ausbildung Kaufmann",
  positionBrief: "",
  employerFacts: "",
};

/** The persisted (pre-save) fields of the row being edited. */
function preSaveFields(): RowSaveFields {
  return {
    company_name: "Muster GmbH",
    company_email: "jobs@muster.de",
    contact_name: null,
    company_address: null,
    subject: "an alter Betreff",
    status: "generated",
    body_html: "<p>old letter</p>",
    body_text: "old letter",
    error_code: null,
    error_message: null,
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

function defer<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Rec {
  /** Ordered call log: "claim:x", "begin:x", "apply:x", "confirm:x", … */
  calls: string[];
  applied: Array<{ id: string; fields: RowSaveFields }>;
}

function makeDeps(
  over: {
    appId?: string;
    seq?: number;
    update?: () => Promise<RowSaveFields | null>;
    resync?: () => Promise<void>;
    claim?: (id: string) => boolean;
    /** Return values for successive `apply` calls (default: all true). */
    applyReturns?: boolean[];
  } = {},
): {
  deps: RowSaveDeps;
  rec: Rec;
  gate: Deferred<RowSaveFields | null>;
  counts: { update: number; resync: number };
} {
  const rec: Rec = { calls: [], applied: [] };
  const gate = defer<RowSaveFields | null>();
  const counts = { update: 0, resync: 0 };
  let applyCall = 0;
  const deps: RowSaveDeps = {
    appId: over.appId ?? "app-1",
    seq: over.seq ?? 1,
    values: VALUES,
    purpose: "ausbildung",
    snapshot: preSaveFields(),
    claim: (id) => {
      rec.calls.push(`claim:${id}`);
      return over.claim ? over.claim(id) : true;
    },
    release: (id) => rec.calls.push(`release:${id}`),
    begin: (id) => rec.calls.push(`begin:${id}`),
    confirm: (id) => rec.calls.push(`confirm:${id}`),
    fail: (id) => rec.calls.push(`fail:${id}`),
    apply: (id, fields) => {
      rec.calls.push(`apply:${id}`);
      rec.applied.push({ id, fields });
      return over.applyReturns ? over.applyReturns[applyCall++] ?? true : true;
    },
    dropDraft: (id) => rec.calls.push(`dropDraft:${id}`),
    update: over.update ?? (() => {
      counts.update += 1;
      return gate.promise;
    }),
    resync: async () => {
      counts.resync += 1;
      rec.calls.push("resync");
      if (over.resync) await over.resync();
    },
    onSaved: (seq) => rec.calls.push(`onSaved:${seq}`),
    onError: (e) => rec.calls.push(`onError:${(e as Error).message}`),
  };
  return { deps, rec, gate, counts };
}

/* ------------------------------------------------------------------ *
 * A. RowSaveState reducer transitions
 * ------------------------------------------------------------------ */

describe("RowSaveState reducer", () => {
  it("begin adds the row to pending; a second begin for the SAME row is a same-reference no-op", () => {
    const s1 = beginRowSave(EMPTY_ROW_SAVE_STATE, "a");
    expect(s1.pending.has("a")).toBe(true);
    expect(s1.saved.size).toBe(0);
    expect(beginRowSave(s1, "a")).toBe(s1);
  });

  it("begin supersedes a previous \"Saved\" chip (re-save)", () => {
    let s = confirmRowSave(beginRowSave(EMPTY_ROW_SAVE_STATE, "a"), "a");
    expect(s.saved.has("a")).toBe(true);
    s = beginRowSave(s, "a");
    expect(s.pending.has("a")).toBe(true);
    expect(s.saved.has("a")).toBe(false);
  });

  it("confirm moves pending -> saved; confirm for a non-pending row is a no-op", () => {
    const s = confirmRowSave(beginRowSave(EMPTY_ROW_SAVE_STATE, "a"), "a");
    expect(s.pending.has("a")).toBe(false);
    expect(s.saved.has("a")).toBe(true);
    expect(confirmRowSave(s, "zz")).toBe(s);
  });

  it("fail clears only ITS indicator; other rows' saved chips stay", () => {
    let s = beginRowSave(EMPTY_ROW_SAVE_STATE, "a");
    s = beginRowSave(s, "b");
    s = confirmRowSave(s, "b");
    s = failRowSave(s, "a");
    expect(s.pending.has("a")).toBe(false);
    expect(s.saved.has("b")).toBe(true);
    expect(failRowSave(s, "zz")).toBe(s);
  });

  it("clearRowSaved retires only its chip; same-reference no-op when absent", () => {
    const s = confirmRowSave(beginRowSave(EMPTY_ROW_SAVE_STATE, "a"), "a");
    const s2 = clearRowSaved(s, "a");
    expect(s2.saved.size).toBe(0);
    expect(clearRowSaved(s2, "a")).toBe(s2);
  });

  it("different rows can be pending at the same time (concurrent saves allowed)", () => {
    let s = beginRowSave(EMPTY_ROW_SAVE_STATE, "a");
    s = beginRowSave(s, "b");
    expect([...s.pending].sort()).toEqual(["a", "b"]);
  });
});

/* ------------------------------------------------------------------ *
 * B. Field shaping
 * ------------------------------------------------------------------ */

describe("optimisticSaveFields", () => {
  it("sends the edited values, recomputes the subject with the campaign purpose, resets the letter", () => {
    const f = optimisticSaveFields(VALUES, "ausbildung");
    expect(f.company_name).toBe(VALUES.companyName);
    expect(f.company_email).toBe(VALUES.companyEmail);
    expect(f.contact_name).toBe(VALUES.contactName);
    expect(f.company_address).toBe(VALUES.companyAddress);
    expect(f.subject).toBe(buildSubject("ausbildung", VALUES.companyName));
    // The letter is invalidated by a company change (server-side semantics,
    // shown to the user honestly).
    expect(f.status).toBe("pending");
    expect(f.body_html).toBe("");
    expect(f.body_text).toBe("");
    expect(f.error_code).toBeNull();
    expect(f.error_message).toBeNull();
  });

  it("empty company name => empty subject (never invented); empty contact => null", () => {
    const f = optimisticSaveFields({ ...VALUES, companyName: "", contactName: "" }, "arbeit");
    expect(f.subject).toBe("");
    expect(f.contact_name).toBeNull();
  });
});

describe("snapshots", () => {
  it("snapshotSaveFields copies the row's persisted fields (mutation-safe)", () => {
    const base = preSaveFields();
    const snap = snapshotSaveFields(base);
    snap.company_name = "MUTATED";
    expect(snap.company_name).toBe("MUTATED");
    // The rollback target is a copy: the original fields are untouched.
    expect(base.company_name).toBe("Muster GmbH");
    expect(snapshotSaveFields(base).company_name).toBe("Muster GmbH");
  });

  it("snapshotFromRow maps a raw DTO row and does NOT include the position fields", () => {
    const dto = {
      company_name: "X",
      company_email: "x@x.de",
      contact_name: null,
      company_address: null,
      subject: "s",
      status: "pending",
      body_html: "",
      body_text: "",
      error_code: null,
      error_message: null,
      position_title: "P",
    };
    const snap = snapshotFromRow(dto);
    expect(snap).toEqual({
      company_name: "X",
      company_email: "x@x.de",
      contact_name: null,
      company_address: null,
      subject: "s",
      status: "pending",
      body_html: "",
      body_text: "",
      error_code: null,
      error_message: null,
    });
    expect("position_title" in snap).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * C. saveCompanyRow — the optimistic save flow
 * ------------------------------------------------------------------ */

describe("saveCompanyRow", () => {
  it("applies the indicator + optimistic patch SYNCHRONOUSLY, before the server answer", async () => {
    const { deps, rec, gate } = makeDeps();
    const done = saveCompanyRow(deps); // NOT awaited yet
    // Everything below ran before the network round trip could answer.
    expect(rec.calls).toEqual(["claim:app-1", "begin:app-1", "apply:app-1"]);
    const opt = rec.applied[0].fields;
    expect(opt.status).toBe("pending");
    expect(opt.body_html).toBe("");
    expect(opt.subject).toBe(buildSubject("ausbildung", VALUES.companyName));
    gate.resolve(preSaveFields());
    await done;
  });

  it("success: the SERVER row is applied authoritatively, the draft is dropped, NO resync", async () => {
    const { deps, rec, gate } = makeDeps();
    const done = saveCompanyRow(deps);
    const serverRow: RowSaveFields = {
      ...preSaveFields(),
      company_name: "Neue Firma AG",
      company_email: "talent@neue-firma.de",
      subject: "Bewerbung: Neue Firma AG",
      status: "pending",
      body_html: "",
      body_text: "",
      position_title: "Ausbildung Kaufmann",
    };
    gate.resolve(serverRow);
    await done;
    expect(rec.calls).toEqual([
      "claim:app-1",
      "begin:app-1",
      "apply:app-1", // optimistic
      "apply:app-1", // server row
      "confirm:app-1",
      "dropDraft:app-1",
      "onSaved:1",
      "release:app-1",
    ]);
    // The confirmation is the SERVER's row (same reference — not a re-read).
    expect(rec.applied[1].fields).toBe(serverRow);
    expect(rec.calls).not.toContain("resync");
  });

  it("success with a vanished row (campaign switched mid-flight): ONE best-effort resync, still confirmed", async () => {
    const { deps, rec, gate, counts } = makeDeps({
      applyReturns: [true, false], // optimistic applied, server row NOT present in the view
    });
    const done = saveCompanyRow(deps);
    gate.resolve(preSaveFields());
    await done;
    expect(counts.resync).toBe(1); // exactly one best-effort resync
    expect(rec.calls).toContain("confirm:app-1");
    expect(rec.calls).toContain("onSaved:1");
    expect(rec.calls).toContain("release:app-1");
  });

  it("a failing resync is non-fatal (the save itself succeeded)", async () => {
    const { deps, rec, gate, counts } = makeDeps({
      applyReturns: [true, false],
      resync: async () => {
        throw new Error("RESYNC_FAILED");
      },
    });
    const done = saveCompanyRow(deps);
    gate.resolve(preSaveFields());
    await expect(done).resolves.toBeUndefined(); // the throw is swallowed
    expect(counts.resync).toBe(1);
    expect(rec.calls).toContain("onSaved:1");
    expect(rec.calls).toContain("release:app-1");
  });

  it("failure: rolls back the optimistic patch, PRESERVES the draft, surfaces the error", async () => {
    const { deps, rec, gate } = makeDeps();
    const done = saveCompanyRow(deps);
    gate.reject(new Error("SAVE_FAILED"));
    await done;
    expect(rec.calls).toEqual([
      "claim:app-1",
      "begin:app-1",
      "apply:app-1", // optimistic
      "apply:app-1", // rollback
      "fail:app-1",
      "onError:SAVE_FAILED",
      "release:app-1",
    ]);
    // Rollback restores the EXACT pre-save field set.
    expect(rec.applied[1].fields).toEqual(preSaveFields());
    expect(rec.calls).not.toContain("dropDraft:app-1"); // the user's draft survives
    expect(rec.calls).not.toContain("onSaved:1");
    expect(rec.calls).not.toContain("confirm:app-1");
  });

  it("null result (row deleted elsewhere): NOT_FOUND, rollback, no draft drop", async () => {
    const { deps, rec, gate } = makeDeps();
    const done = saveCompanyRow(deps);
    gate.resolve(null);
    await done;
    expect(rec.calls).toContain("onError:NOT_FOUND");
    expect(rec.calls).toContain("fail:app-1");
    expect(rec.calls).not.toContain("dropDraft:app-1");
    expect(rec.applied[1].fields).toEqual(preSaveFields());
  });

  it("double-click: the second call is a no-op — exactly ONE network call", async () => {
    let claimAttempts = 0;
    const { deps, rec, gate, counts } = makeDeps({
      claim: () => ++claimAttempts === 1,
    });
    const first = saveCompanyRow(deps);
    const second = saveCompanyRow(deps); // duplicate click while in flight
    // The second click hit the guard (the second claim was REJECTED) and
    // started nothing: no second begin, no second apply, no second request.
    expect(counts.update).toBe(1);
    expect(rec.calls).toEqual([
      "claim:app-1",
      "begin:app-1",
      "apply:app-1",
      "claim:app-1", // rejected by the in-flight guard
    ]);
    gate.resolve(preSaveFields());
    await Promise.all([first, second]);
    expect(counts.update).toBe(1);
    expect(claimAttempts).toBe(2);
  });

  it("concurrent saves to different rows: each row is patched only with ITS OWN fields", async () => {
    const A = makeDeps({ appId: "row-a", seq: 3 });
    const B = makeDeps({ appId: "row-b", seq: 4 });
    const pa = saveCompanyRow(A.deps);
    const pb = saveCompanyRow(B.deps);
    // Both are in flight at the same time (no step-wide lock).
    expect(A.rec.calls).toContain("begin:row-a");
    expect(B.rec.calls).toContain("begin:row-b");
    A.gate.resolve({ ...preSaveFields(), company_name: "A saved" });
    await pa;
    // B is still in flight — A's confirmation did not touch it.
    expect(B.rec.calls.filter((c) => c.startsWith("confirm"))).toEqual([]);
    B.gate.resolve({ ...preSaveFields(), company_name: "B saved" });
    await pb;
    for (const { id } of A.rec.applied) expect(id).toBe("row-a");
    for (const { id } of B.rec.applied) expect(id).toBe("row-b");
    expect(A.rec.calls).toContain("confirm:row-a");
    expect(A.rec.calls).toContain("onSaved:3");
    expect(B.rec.calls).toContain("confirm:row-b");
    expect(B.rec.calls).toContain("onSaved:4");
    expect(A.counts.update).toBe(1);
    expect(B.counts.update).toBe(1);
  });

  it("a rejected save releases the row — a later save can proceed", async () => {
    // First save fails; the row must not stay locked.
    const first = makeDeps();
    const p1 = saveCompanyRow(first.deps);
    first.gate.reject(new Error("X"));
    await p1;
    expect(first.rec.calls).toContain("fail:app-1");
    expect(first.rec.calls).toContain("release:app-1");
    // A second save on the same row proceeds (a fresh claim).
    const second = makeDeps();
    const p2 = saveCompanyRow(second.deps);
    second.gate.resolve(preSaveFields());
    await p2;
    expect(second.counts.update).toBe(1);
    expect(second.rec.calls).toContain("confirm:app-1");
  });
});

/* ------------------------------------------------------------------ *
 * D. companies-step wiring (static contract)
 * ------------------------------------------------------------------ */

describe("companies-step wiring (static contract): per-row, synchronous, no refetch", () => {
  it("per-row save indicator, memoized rows, O(1) lookups, stable key", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(
      join(process.cwd(), "src/components/bewerbung-automation/companies-step.tsx"),
      "utf8",
    );
    // Synchronous per-row double-click guard.
    expect(src).toContain("inFlightSaves");
    expect(src).toMatch(/if \(inFlightSaves\.current\.has\(id\)\) return false;/);
    // The click kicks the pure orchestrator; the server action is a DEP.
    expect(src).toMatch(/void saveCompanyRow\(/);
    expect(src).toContain("setSaveState((s) => beginRowSave(s, id))");
    expect(src).toContain("setSaveState((s) => confirmRowSave(s, id))");
    expect(src).toContain("setSaveState((s) => failRowSave(s, id))");
    // The indicator is PER-ROW (other rows stay interactive).
    expect(src).toContain("saving={saveState.pending.has(app.id)}");
    expect(src).toContain("saved={saveState.saved.has(app.id)}");
    // The Save button is disabled only while ITS row saves (or the series is
    // still being created); aria-busy marks it.
    expect(src).toContain("disabled={creatingSeries || saving}");
    expect(src).toContain("aria-busy={saving || undefined}");
    // Deleting is also locked while that row is saving.
    expect(src).toContain("disabled={lockApp || creatingSeries || deletePending || saving}");
    // Memoized row component (one keystroke re-renders the row, not the list).
    expect(src).toContain("const CompanyRow = memo(function CompanyRow(");
    // O(1) lookups on the render hot path.
    expect(src).toContain("serverRecords.get(app.id)");
    expect(src).toContain("rowDirtyOf(drafts[app.id], app)");
    expect(src).toMatch(/visibleRows\.map\(\(app\)[\s\S]{0,800}?key=\{app\.id\}/);
  });

  it("the SAVE path has no step-wide busy lock and no full-view refetch", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(
      join(process.cwd(), "src/components/bewerbung-automation/companies-step.tsx"),
      "utf8",
    );
    const start = src.indexOf("const onSaveRow = useCallback(");
    const end = src.indexOf("const onDeleteRow = useCallback(");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const savePath = src.slice(start, end);
    // No step-wide lock in the save path (the busy flag is import-only).
    expect(savePath).not.toContain("setBusy(");
    // No full-view refetch after a save — only a resync for a vanished row.
    expect(savePath).not.toMatch(/await refresh\(\)/);
    expect(savePath).toContain("resync: refresh,");
    // Saves wait for the confirmed ids while a series is being created.
    expect(savePath).toContain("if (creatingRef.current) return; // placeholder ids are not real rows yet");
  });

  it("the server save returns the SAVED row (the confirmation) — no view action on the client", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(
      join(process.cwd(), "src/components/bewerbung-automation/companies-step.tsx"),
      "utf8",
    );
    const start = src.indexOf("async function updateCompanyRow(");
    const end = src.indexOf("interface Props");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const fn = src.slice(start, end);
    expect(fn).toContain("const row = await bewUpdateCompany(fd);");
    // A vanished row is reported as null (=> NOT_FOUND rollback), not a refetch.
    expect(fn).toContain("if (!row) return null;");
    expect(fn).not.toContain("refresh");
    expect(fn).not.toContain("getBewCampaignView");
  });

  it("placeholder drafts are remapped exactly once per confirmed creation (one-shot token)", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(
      join(process.cwd(), "src/components/bewerbung-automation/companies-step.tsx"),
      "utf8",
    );
    expect(src).toContain("seriesConfirmation.token === consumedTokenRef.current");
    expect(src).toContain("remapPendingDrafts(d, view.applications)");
    // The remap only fires for the CONFIRMED campaign id.
    expect(src).toContain("view.campaign.id !== seriesConfirmation.id");
  });
});
