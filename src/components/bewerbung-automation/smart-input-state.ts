/**
 * Bewerbung Automation — pure state helpers for the smart-input "Auto-
 * organize" flow. No React, no I/O: the exact rules are unit-testable
 * (like row-state.ts) and shared between the component and the tests.
 *
 * The flow this module encodes:
 *
 *   parse (shared deterministic parser, live) → precheck (client) →
 *   server action (re-parses, re-validates, appends ONE row) →
 *   success:  append the returned row to the view, THEN clear the input
 *   failure:  keep the input untouched, show the localized stable code
 *
 * The server is the source of truth: the client precheck only avoids a
 * pointless round trip (empty input, obvious duplicates, the 100-row cap).
 * Every rule is re-applied server-side by `addBewCompany`.
 */
import {
  BEW_MAX_COUNT,
  isValidEmail,
  normalizeEmail,
} from "@/lib/bewerbung-automation";
import { adAutoAddGate, parseAdvertisement, type ParsedAdvertisement } from "@/lib/bew-ad-parser";
import {
  bewErrorCode,
  isNextRedirectError,
  type BewApplicationDTO,
  type BewErrorCode,
  type BewViewDTO,
} from "./types";

/** Stable failure codes for a smart-add attempt (server + precheck). */
export type SmartAddFailCode =
  | "EMPTY_INPUT"
  | "INVALID_PAYLOAD"
  | "PARSE_NO_COMPANY"
  | "PARSE_NO_EMAIL"
  | "PARSE_INVALID_EMAIL"
  | "DUPLICATE_COMPANY"
  | "COUNT_EXCEEDED"
  | "POSITION_TOO_LONG";

export type SmartAddPrecheck =
  | { ok: true }
  | { ok: false; code: SmartAddFailCode };

/**
 * The client-side precheck (display/UX only — the server re-runs the SAME
 * rules). Runs BEFORE any request, so an empty box never costs a round trip
 * and an obvious duplicate is rejected instantly.
 */
export function precheckSmartAdd(
  parsed: ParsedAdvertisement | null,
  applications: Array<Pick<BewApplicationDTO, "status" | "company_email">>,
): SmartAddPrecheck {
  if (!parsed) return { ok: false, code: "EMPTY_INPUT" };
  if (parsed.tooLongInput) return { ok: false, code: "INVALID_PAYLOAD" };
  const gate = adAutoAddGate(parsed);
  if (!gate.ok) return { ok: false, code: gate.code };
  const active = applications.filter(
    (a) => a.status !== "excluded" && a.status !== "cancelled",
  );
  const email = normalizeEmail(parsed.companyEmail.value);
  if (active.some((a) => normalizeEmail(a.company_email ?? "") === email)) {
    return { ok: false, code: "DUPLICATE_COMPANY" };
  }
  if (active.length >= BEW_MAX_COUNT) {
    return { ok: false, code: "COUNT_EXCEEDED" };
  }
  return { ok: true };
}

/**
 * The "Check information" step — parse + validate WITHOUT any persistence.
 *
 * Unlike `precheckSmartAdd` (which stops at the FIRST blocking code), this
 * returns the FULL issue list, so the review panel can tell the user EXACTLY
 * which fields need attention (e.g. "company name missing" AND "e-mail
 * invalid" at once). The field rules mirror `adAutoAddGate` (the server's
 * gate) one-to-one; the duplicate / cap checks run only when the field rules
 * pass — the same order `precheckSmartAdd` and the server apply.
 *
 * Pure and side-effect free: it never calls the persistence layer and never
 * mutates the input. The server re-runs the identical rules when the user
 * CONFIRMS (see `runSmartAdd` / `addBewCompany`).
 */
export interface SmartCheckResult {
  /** The parse of the checked text (null for empty input) — the review panel's fields. */
  parsed: ParsedAdvertisement | null;
  /** true = every required field is present and valid (safe to confirm). */
  ok: boolean;
  /** ALL blocking problems (empty when `ok`), in stable-code form. */
  issues: SmartAddFailCode[];
}

export function checkSmartAdd(
  text: string,
  applications: Array<Pick<BewApplicationDTO, "status" | "company_email">>,
): SmartCheckResult {
  if (!text.trim()) {
    return { parsed: null, ok: false, issues: ["EMPTY_INPUT"] };
  }
  const parsed = parseAdvertisement(text);
  const issues: SmartAddFailCode[] = [];
  if (parsed.tooLongInput) issues.push("INVALID_PAYLOAD");
  // The SAME field rules the server gate applies (mirror of adAutoAddGate),
  // but ALL of them are reported — not just the first.
  if (!parsed.companyName.value.trim()) issues.push("PARSE_NO_COMPANY");
  const email = parsed.companyEmail.value.trim();
  if (!email) issues.push("PARSE_NO_EMAIL");
  else if (!isValidEmail(email)) issues.push("PARSE_INVALID_EMAIL");
  if (
    parsed.positionTitle.problem === "too_long" ||
    parsed.positionBrief.problem === "too_long"
  ) {
    issues.push("POSITION_TOO_LONG");
  }
  if (issues.length === 0) {
    const active = applications.filter(
      (a) => a.status !== "excluded" && a.status !== "cancelled",
    );
    const normalized = normalizeEmail(email);
    if (active.some((a) => normalizeEmail(a.company_email ?? "") === normalized)) {
      issues.push("DUPLICATE_COMPANY");
    } else if (active.length >= BEW_MAX_COUNT) {
      issues.push("COUNT_EXCEEDED");
    }
  }
  return { parsed, ok: issues.length === 0, issues };
}

/**
 * The row the server action returns (the persisted `bew_applications` row,
 * serialized across the RSC→client boundary). Structurally typed so the
 * client never imports the server-only engine module.
 */
export type SmartAddRow = {
  id: string;
  seq: number;
  company_name: string;
  contact_name: string | null;
  company_email: string;
  company_address: string | null;
  subject: string;
  body_html: string;
  body_text: string;
  status: string;
  error_code: string | null;
  error_message: string | null;
  attempt_count: number;
  provider_message_id: string | null;
  sent_at: string | null;
  position_title?: string | null;
  position_brief?: string | null;
  employer_facts?: string | null;
};

/** Map the persisted row onto the view's DTO (extra server fields dropped). */
export function toApplicationDTO(row: SmartAddRow): BewApplicationDTO {
  return {
    id: row.id,
    seq: row.seq,
    company_name: row.company_name,
    contact_name: row.contact_name,
    company_email: row.company_email,
    company_address: row.company_address,
    subject: row.subject,
    body_html: row.body_html,
    body_text: row.body_text,
    status: row.status,
    error_code: row.error_code,
    error_message: row.error_message,
    attempt_count: row.attempt_count,
    provider_message_id: row.provider_message_id,
    sent_at: row.sent_at,
    ...(row.position_title !== undefined
      ? { position_title: row.position_title }
      : {}),
    ...(row.position_brief !== undefined ? { position_brief: row.position_brief } : {}),
    ...(row.employer_facts !== undefined ? { employer_facts: row.employer_facts } : {}),
  };
}

/**
 * Append (or refresh, if the id already exists) ONE application row in the
 * view and keep the campaign counters consistent with the rows — the same
 * row-derived rule the engine's counters use (`total_count` = all rows,
 * `valid_count` = name + valid e-mail, excluding excluded/cancelled).
 *
 * Pure: returns a NEW view; the previous view is never mutated. All other
 * rows keep their exact references (memoized rows stay memoized).
 */
export function appendRowToView(
  view: BewViewDTO,
  dto: BewApplicationDTO,
): BewViewDTO {
  const exists = view.applications.some((a) => a.id === dto.id);
  const applications = exists
    ? view.applications.map((a) => (a.id === dto.id ? { ...a, ...dto } : a))
    : [...view.applications, dto];
  const total = applications.length;
  // The same row-derived rule the engine's counters use (name + valid e-mail,
  // excluding excluded/cancelled) — so the header counters and the step-1→2
  // gate (which counts the rows directly) agree instantly.
  const valid = applications.filter(
    (a) =>
      a.status !== "excluded" &&
      a.status !== "cancelled" &&
      (a.company_name ?? "").trim().length > 0 &&
      isValidEmail(a.company_email ?? ""),
  ).length;
  return {
    ...view,
    applications,
    campaign: { ...view.campaign, total_count: total, valid_count: valid },
  };
}

/* ------------------------------------------------------------------ *
 * The Auto-organize orchestration (pure — unit-tested without a DOM)
 * ------------------------------------------------------------------ */

/**
 * A smart-add failure carries a STABLE bewauto error code (the precheck
 * codes plus the server codes, all already members of the shared
 * `BewErrorCode` union) — the caller maps it 1:1 through the existing
 * `bewauto.err.{code}` i18n lookup; only a truly unknown error ends up as
 * "UNKNOWN" (the single existing fallback).
 */
export type SmartAddOutcome =
  | { ok: true; row: SmartAddRow }
  | { ok: false; code: BewErrorCode; /** true = a second click while one op was in flight (silent no-op). */ busy: boolean };

export interface SmartAddDeps {
  /**
   * Synchronous, race-free claim of the in-flight slot (a ref inside the
   * component). Returns false when an operation is already running.
   */
  claim: () => boolean;
  release: () => void;
  /** The persistence call (the server action) with the RAW pasted text. */
  add: (rawText: string) => Promise<SmartAddRow>;
  /** Called ONLY after `add` resolved (the input-clear hook lives here). */
  onRowAdded: (row: BewApplicationDTO) => void;
}

/**
 * parse (exact text) → precheck → server add → onRowAdded.
 *
 * The ordering IS the safety contract:
 *   - a failed precheck returns BEFORE `add` is ever called (no request,
 *     no write, input untouched);
 *   - `onRowAdded` (which clears the input) runs only AFTER the server
 *     confirmed the insert — a failed persist never clears anything;
 *   - the claim guard makes rapid repeated clicks no-ops (busy: true)
 *     instead of double inserts; the server's DUPLICATE_COMPANY check is
 *     the final backstop for races between separate requests.
 *
 * RE-THROWS ONE exception: the NEXT_REDIRECT error the action rejects with
 * when the session expired mid-flow (the server's `requireUser` bounced the
 * call to /login). That is re-authentication, not a smart-add failure —
 * swallowing it here as "UNKNOWN" was the reported generic-error bug. The
 * caller (the component) catches it and navigates.
 */
export async function runSmartAdd(
  text: string,
  applications: Array<Pick<BewApplicationDTO, "status" | "company_email">>,
  deps: SmartAddDeps,
): Promise<SmartAddOutcome> {
  if (!deps.claim()) return { ok: false, code: "UNKNOWN", busy: true };
  try {
    const parsed = text.trim() ? parseAdvertisement(text) : null;
    const check = precheckSmartAdd(parsed, applications);
    if (!check.ok) return { ok: false, code: check.code, busy: false };
    const row = await deps.add(text);
    deps.onRowAdded(toApplicationDTO(row));
    return { ok: true, row };
  } catch (e) {
    // Session expired mid-flow → the action asked for re-authentication.
    // Re-throw so the component can navigate (never an error message here).
    if (isNextRedirectError(e)) throw e;
    // Stable server codes pass through untouched; anything else is the
    // single existing fallback (err.UNKNOWN) — no NEW generic path.
    return { ok: false, code: bewErrorCode(e), busy: false };
  } finally {
    deps.release();
  }
}
