/**
 * Bewerbung Automation — pure row-state logic for the manual company table.
 *
 * Why a separate module: the step-1 "typing in one field cleared another"
 * bug lived in the draft-merge rule, and the per-row delete/empty-state/
 * duplicate logic must be exactly the rule the tests can verify without a
 * browser. No React, no actions, no I/O — one place to reason about row
 * state, imported by `companies-step.tsx` and the regression tests.
 */
import { isValidEmail } from "@/lib/bewerbung-automation";
import type { CompanyRecord } from "./types";

/** A stored application row as the table sees it. */
export interface CompanyRowView {
  id: string;
  seq: number;
  companyName: string;
  companyEmail: string;
  contactName: string | null;
  companyAddress: string | null;
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
    }
  );
}

/** True when the row carries unsaved edits (drives the per-row Save). */
export function rowDirty(
  drafts: Drafts,
  serverRows: CompanyRowView[],
  appId: string,
): boolean {
  const app = serverRows.find((a) => a.id === appId);
  if (!app || !drafts[appId]) return false;
  const d = drafts[appId];
  return (
    d.companyName !== app.companyName ||
    d.companyEmail !== app.companyEmail ||
    (d.contactName || null) !== (app.contactName ?? null) ||
    (d.companyAddress || null) !== (app.companyAddress ?? null)
  );
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
