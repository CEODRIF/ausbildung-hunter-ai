/**
 * Bewerbung Automation — pure row-state logic for the manual company table.
 *
 * Why a separate module: the step-1 "typing in one field cleared another"
 * bug lived in the draft-merge rule, and the per-row delete/empty-state/
 * duplicate logic must be exactly the rule the tests can verify without a
 * browser. No React, no actions, no I/O — one place to reason about row
 * state, imported by `companies-step.tsx` and the regression tests.
 */
import { buildSubject, isValidEmail, type BewPurpose } from "@/lib/bewerbung-automation";
import type { CompanyRecord } from "./types";

/** A stored application row as the table sees it. */
export interface CompanyRowView {
  id: string;
  seq: number;
  companyName: string;
  companyEmail: string;
  contactName: string | null;
  companyAddress: string | null;
  positionTitle?: string | null;
  positionBrief?: string | null;
  employerFacts?: string | null;
  status: string;
  error_code: string | null;
}

/** Unsaved per-row edits, keyed by the STABLE application id. */
export type Drafts = Record<string, CompanyRecord>;

/**
 * THE BUG FIX: merge a field patch into the LATEST draft of `appId`.
 *
 * The previous implementation re-derived the base from the SERVER row on
 * every keystroke, so `type email → type name` rebuilt the row from the
 * (still-empty) server state and silently discarded the unsaved e-mail.
 * The draft the user is currently typing in is the base; the server row is
 * only the initial seed for a row that has no draft yet.
 */
export function applyDraftPatch(
  drafts: Drafts,
  appId: string,
  serverRow: CompanyRowView,
  patch: Partial<CompanyRecord>,
): Drafts {
  const base = drafts[appId] ?? {
    companyName: serverRow.companyName,
    companyEmail: serverRow.companyEmail,
    contactName: serverRow.contactName ?? "",
    companyAddress: serverRow.companyAddress ?? "",
    positionTitle: serverRow.positionTitle ?? "",
    positionBrief: serverRow.positionBrief ?? "",
    employerFacts: serverRow.employerFacts ?? "",
  };
  return {
    ...drafts,
    [appId]: { ...base, ...patch },
  };
}

/** The current (draft-aware) values of a row, or null when it no longer
 *  exists in the view (e.g. removed server-side in another tab). */
export function rowValues(
  drafts: Drafts,
  serverRows: CompanyRowView[],
  appId: string,
): CompanyRecord | null {
  const app = serverRows.find((a) => a.id === appId);
  if (!app) return null;
  return (
    drafts[appId] ?? {
      companyName: app.companyName,
      companyEmail: app.companyEmail,
      contactName: app.contactName ?? "",
      companyAddress: app.companyAddress ?? "",
      positionTitle: app.positionTitle ?? "",
      positionBrief: app.positionBrief ?? "",
      employerFacts: app.employerFacts ?? "",
    }
  );
}

/**
 * True when the row carries unsaved edits (drives the per-row Save).
 *
 * Compares ALL persisted fields — including the per-company position
 * override: the save path always sends all seven fields, so a
 * position-only edit must show a Save button too (before this fix such an
 * edit sat in the draft with no way to persist it).
 */
export function rowDirty(
  drafts: Drafts,
  serverRows: CompanyRowView[],
  appId: string,
): boolean {
  const app = serverRows.find((a) => a.id === appId);
  if (!app || !drafts[appId]) return false;
  return rowDirtyOf(drafts[appId], app);
}

/** The same rule as `rowDirty`, given both sides (no row lookup — for the
 *  render hot path). */
export function rowDirtyOf(d: CompanyRecord, app: CompanyRowView): boolean {
  return (
    d.companyName !== app.companyName ||
    d.companyEmail !== app.companyEmail ||
    (d.contactName || null) !== (app.contactName ?? null) ||
    (d.companyAddress || null) !== (app.companyAddress ?? null) ||
    (d.positionTitle || null) !== (app.positionTitle ?? null) ||
    (d.positionBrief || null) !== (app.positionBrief ?? null) ||
    (d.employerFacts || null) !== (app.employerFacts ?? null)
  );
}

/** Rows addressed by their stable id (O(1) per row instead of a per-row
 *  linear scan in the render hot path). */
export function indexRows(rows: CompanyRowView[]): Map<string, CompanyRowView> {
  const byId = new Map<string, CompanyRowView>();
  for (const r of rows) byId.set(r.id, r);
  return byId;
}

/** A stored row's values as a record (the no-draft case of `rowValues`,
 *  pre-computed once per row for the render hot path). */
export function rowToRecord(app: CompanyRowView): CompanyRecord {
  return {
    companyName: app.companyName,
    companyEmail: app.companyEmail,
    contactName: app.contactName ?? "",
    companyAddress: app.companyAddress ?? "",
    positionTitle: app.positionTitle ?? "",
    positionBrief: app.positionBrief ?? "",
    employerFacts: app.employerFacts ?? "",
  };
}

/** A row is still part of the campaign's company list. */
export function isRowActiveStatus(status: string): boolean {
  return status !== "excluded" && status !== "cancelled";
}

/**
 * Rows that are still part of the campaign's company list. Deleting a row
 * EXCLUDES it on the server (restorable, ownership-checked), so the manual
 * table — the "company data" entry surface — shows only active rows.
 *
 * IMPORTANT: a row's VALUES are never dropped here; only its membership in
 * the active list changes. Navigation away and back re-derives the same set
 * from the (unchanged) server rows, so nothing the user entered is lost.
 */
export function filterActiveRows(rows: CompanyRowView[]): CompanyRowView[] {
  return rows.filter((r) => isRowActiveStatus(r.status));
}

/**
 * E-mail addresses (lower-cased, trimmed) that appear more than once among
 * the given records — the live duplicate check for the manual table.
 * Recomputed from the CURRENT rows on every render, so it updates
 * immediately after an edit or a deletion.
 */
export function findDuplicateEmails(
  records: Array<Pick<CompanyRecord, "companyEmail">>,
): Set<string> {
  const counts = new Map<string, number>();
  for (const r of records) {
    const email = r.companyEmail.trim().toLowerCase();
    if (!email) continue;
    counts.set(email, (counts.get(email) ?? 0) + 1);
  }
  const dups = new Set<string>();
  for (const [email, n] of counts) if (n > 1) dups.add(email);
  return dups;
}

/** A row is complete (and counts for the wizard gate) with a name + a
 *  structurally valid e-mail. */
export function isRowComplete(
  record: Pick<CompanyRecord, "companyName" | "companyEmail">,
): boolean {
  return record.companyName.trim().length > 0 && isValidEmail(record.companyEmail);
}

/* ------------------------------------------------------------------ *
 * Optimistic per-row deletion (instant UI response)
 * ------------------------------------------------------------------ *
 *
 * The red X must hide the row on the FIRST click — waiting for the
 * ownership-checked server exclusion (and a view refresh) made deletion
 * feel broken. So the UI state transitions are pure here: the component
 * only wires them to its state setters and the server action. The exact
 * ordering (hide → network → confirm/restore) is what the tests verify.
 */

export interface RowDeleteState {
  /** Rows whose server exclusion is still in flight (duplicate-click guard). */
  pending: Set<string>;
  /** Rows hidden from the table — pending ∪ server-confirmed — until a
   *  fresh view reflects the exclusion (or the row is restored). */
  hidden: Set<string>;
}

export const EMPTY_ROW_DELETE_STATE: RowDeleteState = {
  pending: new Set<string>(),
  hidden: new Set<string>(),
};

/**
 * Hide the row IMMEDIATELY (no network round trip). A second begin for a
 * row that is already pending returns the SAME reference (no-op) — the
 * state-level duplicate guard on top of the component's synchronous claim.
 */
export function beginRowDelete(state: RowDeleteState, id: string): RowDeleteState {
  if (state.pending.has(id)) return state;
  return {
    pending: new Set(state.pending).add(id),
    hidden: new Set(state.hidden).add(id),
  };
}

/**
 * Server confirmed the exclusion: the row stays hidden. The entry is
 * retired only after the orchestrator's own post-confirmation view sync
 * (see `retireRowDelete`) — a stale view landing in between must never
 * un-hide the row.
 */
export function confirmRowDelete(state: RowDeleteState, id: string): RowDeleteState {
  if (!state.pending.has(id)) return state;
  const pending = new Set(state.pending);
  pending.delete(id);
  return { ...state, pending };
}

/**
 * Retire the optimistic entry for a row whose exclusion is committed AND
 * whose post-confirmation view sync has landed: from now on the VIEW owns
 * the row's visibility (excluded → hidden by the row filter; restored later
 * → active → reappears on its own). This is deliberately the ONLY path that
 * un-hides a confirmed row — a stale refresh fetched before the commit can
 * never flicker the row back.
 */
export function retireRowDelete(state: RowDeleteState, id: string): RowDeleteState {
  if (!state.hidden.has(id)) return state;
  const hidden = new Set(state.hidden);
  hidden.delete(id);
  return { ...state, hidden };
}

/**
 * Server rejected the exclusion: restore the row. Its original position
 * comes for free (list order is derived from the stable server rows), and
 * its latest field values survive because the row's draft is dropped only
 * AFTER confirmation.
 */
export function failRowDelete(state: RowDeleteState, id: string): RowDeleteState {
  if (!state.pending.has(id)) return state;
  const pending = new Set(state.pending);
  const hidden = new Set(state.hidden);
  pending.delete(id);
  hidden.delete(id);
  return { pending, hidden };
}

/**
 * Defensive reconciliation with the current view: retire hidden entries
 * whose row is gone from the view entirely (e.g. the campaign row list
 * shrank elsewhere). Entries whose row is still present are NEVER touched
 * here — un-hiding is `retireRowDelete`'s job only (see its docs). Returns
 * the SAME reference when nothing changed (no render loop).
 */
export function pruneRowDeleteState(
  state: RowDeleteState,
  view: CompanyRowView[],
): RowDeleteState {
  if (state.hidden.size === 0) return state;
  const idsInView = new Set(view.map((r) => r.id));
  const hidden = new Set([...state.hidden].filter((id) => idsInView.has(id)));
  if (hidden.size === state.hidden.size) return state;
  return { ...state, hidden };
}

export interface RowDeleteDeps {
  appId: string;
  seq: number;
  /** Synchronously claim this row for an in-flight delete; returns false
   *  when one is already running. React state updates are batched, so a
   *  ref-based claim (not a state check) is the race-free double-click
   *  guard — two rapid clicks can never start two requests. */
  claim: (id: string) => boolean;
  release: (id: string) => void;
  begin: (id: string) => void;
  confirm: (id: string) => void;
  retire: (id: string) => void;
  fail: (id: string) => void;
  /** Drop this row's unsaved draft edits — only after the server confirmed
   *  the exclusion (on failure the latest values are restored). */
  dropDraft: (id: string) => void;
  /** The ownership-checked, restorable server-side exclusion. */
  exclude: (id: string) => Promise<void>;
  /** ONE authoritative view sync AFTER confirmation — never on the
   *  click→visual path, so no artificial delay or polling. Best-effort: a
   *  failure here must not undo the committed exclusion. */
  refresh: () => Promise<void>;
  onSuccess: (seq: number) => void;
  onError: (error: unknown) => void;
}

/**
 * The optimistic delete flow (see section header for the ordering):
 *
 *   claim → begin (UI hides the row NOW) → exclude (background network)
 *     ├─ committed: confirm → dropDraft → refresh (best-effort)
 *     │             → retire (the view owns visibility now) → onSuccess
 *     └─ rejected:  fail (UI restores the row, latest values intact)
 *                   → onError
 *
 * `release` runs on every exit. No status mutation, no re-send, no other
 * row is touched.
 */
export async function deleteCompanyRow(deps: RowDeleteDeps): Promise<void> {
  if (!deps.claim(deps.appId)) return; // a delete for this row is already in flight
  deps.begin(deps.appId);
  try {
    await deps.exclude(deps.appId);
  } catch (error) {
    // The server rejected it (e.g. the row is in flight, ownership check):
    // restore the row with its latest values and surface the error.
    deps.fail(deps.appId);
    deps.onError(error);
    deps.release(deps.appId);
    return;
  }
  // The exclusion is committed — the row is gone, for real.
  deps.confirm(deps.appId);
  deps.dropDraft(deps.appId);
  try {
    await deps.refresh();
  } catch {
    // A view-sync failure must not undo the committed exclusion; the next
    // poll or navigation reconciles the view. The row stays hidden.
  }
  deps.retire(deps.appId);
  deps.onSuccess(deps.seq);
  deps.release(deps.appId);
}

/* ------------------------------------------------------------------ *\
 * Optimistic per-row SAVE (instant UI response, rollback on failure)
 * ------------------------------------------------------------------ *\
 *
 * The per-row Save must respond on the FIRST click: the row's values are
 * already what the user typed (drafts), so "saving" flips only the row's
 * indicator and — optimistically — the row's status/letter-invalidation
 * that the server will apply. The ownership-checked server action then
 * runs; its RETURNED ROW is the confirmation (no full-view refetch — that
 * was the latency: every row save re-fetched the entire campaign, and a
 * step-wide busy flag locked every other row meanwhile).
 *
 *   claim (synchronous ref guard) → begin (per-row "Saving…" indicator)
 *   → optimistic patch (the row already shows the saved values + the
 *     letter-invalidation the server applies)
 *   → update (the server action, returning the saved row)
 *     ├─ row:   confirm → apply the SERVER row (authoritative) → dropDraft
 *     │         → onSaved (transient "Saved" chip) → release
 *     │         (the row VANISHED mid-flight — another tab switched the
 *     │          campaign: one best-effort resync, never fatal)
 *     ├─ null:  the row is gone (deleted elsewhere): roll the optimistic
 *     │         patch back, keep nothing, report NOT_FOUND → release
 *     └─ error: roll the optimistic patch back, KEEP the draft (the user's
 *              edits survive), fail (indicator cleared) → onError → release
 *
 * Only THIS row is touched: the indicator, the view patch, the draft and the
 * release are all keyed by the stable id, so rows can save concurrently.
 */

export interface RowSaveState {
  /** Rows whose server save is in flight (per-row "Saving…" + lock). */
  pending: Set<string>;
  /** Rows confirmed by the server — the transient "Saved" chip. */
  saved: Set<string>;
}

export const EMPTY_ROW_SAVE_STATE: RowSaveState = {
  pending: new Set<string>(),
  saved: new Set<string>(),
};

/** Start the row's save: the indicator shows NOW. A begin for a row that is
 *  already pending returns the SAME reference (no-op) — the state-level
 *  duplicate guard on top of the component's synchronous claim. */
export function beginRowSave(state: RowSaveState, id: string): RowSaveState {
  if (state.pending.has(id)) return state;
  const saved = new Set(state.saved);
  saved.delete(id); // a re-save supersedes a previous "Saved" chip
  return { pending: new Set(state.pending).add(id), saved };
}

/** The server confirmed: "Saving…" → "Saved" (transient chip). */
export function confirmRowSave(state: RowSaveState, id: string): RowSaveState {
  if (!state.pending.has(id)) return state;
  const pending = new Set(state.pending);
  pending.delete(id);
  return { pending, saved: new Set(state.saved).add(id) };
}

/** The server rejected (or the row vanished): the indicator clears, the row
 *  is editable again with its draft intact. */
export function failRowSave(state: RowSaveState, id: string): RowSaveState {
  if (!state.pending.has(id)) return state;
  const pending = new Set(state.pending);
  pending.delete(id);
  return { ...state, pending };
}

/** Retire the transient "Saved" chip (the component schedules this). */
export function clearRowSaved(state: RowSaveState, id: string): RowSaveState {
  if (!state.saved.has(id)) return state;
  const saved = new Set(state.saved);
  saved.delete(id);
  return { ...state, saved };
}

/**
 * The view-row fields a save touches. The server resets the letter
 * (`status: "pending"`, empty body, recomputed subject) whenever a company
 * is saved — the optimistic patch applies exactly those changes, so the
 * status pill and the wizard gates react on the click, not on the answer.
 * The position override fields are carried by the CONFIRMED patch (the
 * server row) only.
 */
export type RowSaveFields = {
  company_name: string;
  company_email: string;
  contact_name: string | null;
  company_address: string | null;
  subject: string;
  status: string;
  body_html: string;
  body_text: string;
  error_code: string | null;
  error_message: string | null;
  position_title?: string | null;
  position_brief?: string | null;
  employer_facts?: string | null;
};

/** The optimistic row patch for the values about to be saved. `purpose` is
 *  the campaign's purpose (the server recomputes the subject with the same
 *  pure `buildSubject`). */
export function optimisticSaveFields(
  values: CompanyRecord,
  purpose: string,
): RowSaveFields {
  const name = (values.companyName ?? "").trim();
  return {
    company_name: values.companyName ?? "",
    company_email: values.companyEmail ?? "",
    contact_name: values.contactName || null,
    company_address: values.companyAddress || null,
    subject: name ? buildSubject(purpose as BewPurpose, name) : "",
    status: "pending",
    body_html: "",
    body_text: "",
    error_code: null,
    error_message: null,
  };
}

/** The pre-save row fields the optimistic patch must be rolled back to. */
export function snapshotSaveFields(row: RowSaveFields): RowSaveFields {
  return { ...row };
}

/** Snapshot a stored view row (any shape carrying these fields — the
 *  client DTO and the engine row both do) as the rollback target. */
export function snapshotFromRow(
  row: Pick<RowSaveFields, "company_name" | "company_email" | "contact_name" | "company_address" | "subject" | "status" | "body_html" | "body_text" | "error_code" | "error_message">,
): RowSaveFields {
  return {
    company_name: row.company_name,
    company_email: row.company_email,
    contact_name: row.contact_name,
    company_address: row.company_address,
    subject: row.subject,
    status: row.status,
    body_html: row.body_html,
    body_text: row.body_text,
    error_code: row.error_code,
    error_message: row.error_message,
  };
}

export interface RowSaveDeps {
  appId: string;
  seq: number;
  /** The row's values about to be saved (draft-aware). */
  values: CompanyRecord;
  /** The campaign purpose (subject recomputation). */
  purpose: string;
  /** The row's CURRENT (pre-save) view fields — the rollback target. */
  snapshot: RowSaveFields;
  /** Synchronously claim this row for an in-flight save; false when one is
   *  already running (two rapid clicks can never start two requests). */
  claim: (id: string) => boolean;
  release: (id: string) => void;
  begin: (id: string) => void;
  confirm: (id: string) => void;
  fail: (id: string) => void;
  /** Apply fields to the row IN THE VIEW. Returns whether the row was
   *  present (false = the view switched to another campaign mid-flight —
   *  the patch is a no-op there and the orchestrator resyncs once). */
  apply: (id: string, fields: RowSaveFields) => boolean;
  /** Drop this row's unsaved draft — only after server confirmation. */
  dropDraft: (id: string) => void;
  /** The ownership-checked server save; the returned row is the
   *  confirmation (null = the row no longer exists). */
  update: () => Promise<RowSaveFields | null>;
  /** ONE best-effort view resync when the row vanished mid-flight. */
  resync: () => Promise<void>;
  onSaved: (seq: number) => void;
  onError: (error: unknown) => void;
}

/**
 * The optimistic save flow (see the section header for the ordering).
 * The visual response (indicator + optimistic row state) is applied
 * SYNCHRONOUSLY on the call — the server round trip never gates it.
 */
export async function saveCompanyRow(deps: RowSaveDeps): Promise<void> {
  if (!deps.claim(deps.appId)) return; // this row's save is already in flight
  deps.begin(deps.appId);
  const optimisticApplied = deps.apply(deps.appId, optimisticSaveFields(deps.values, deps.purpose));
  let saved: RowSaveFields | null;
  let error: unknown = null;
  try {
    saved = await deps.update();
  } catch (e) {
    saved = null;
    error = e;
  }
  if (saved) {
    // Confirmation: the SERVER row is authoritative — apply it (it also
    // carries the position override + recomputed subject).
    const patched = deps.apply(deps.appId, saved);
    deps.confirm(deps.appId);
    deps.dropDraft(deps.appId);
    if (!patched) {
      // The view switched campaigns while this save was in flight: the
      // current view does not contain the row — resync once so whichever
      // campaign it belongs to shows the saved values.
      try {
        await deps.resync();
      } catch {
        // Best effort: the next explicit refresh reconciles.
      }
    }
    deps.onSaved(deps.seq);
    deps.release(deps.appId);
    return;
  }
  // Failure (or a vanished row): roll the optimistic patch back…
  if (optimisticApplied) deps.apply(deps.appId, snapshotSaveFields(deps.snapshot));
  deps.fail(deps.appId);
  // …the draft is KEPT (the user's edits survive) and the error is shown.
  deps.onError(error ?? new Error("NOT_FOUND"));
  deps.release(deps.appId);
}
