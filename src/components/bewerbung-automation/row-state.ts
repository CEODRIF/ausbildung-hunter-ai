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
  return rows.filter((r) => r.status !== "excluded" && r.status !== "cancelled");
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
