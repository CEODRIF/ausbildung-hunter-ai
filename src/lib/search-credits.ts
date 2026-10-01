import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Search credits for AI Ausbildung Search (Phase 16).
 *
 * The balance lives in Postgres and is only ever changed by the security
 * definer RPCs in migration 20261016000000_search_credits.sql — the browser
 * can read its own row and nothing else, so DevTools cannot grant credits.
 *
 * Policy:
 *   free user      : 150 credits, reset every 5 days (no accumulation)
 *   code-activated : 500 credits, reset every 24 h (invitation_codes row of
 *                    type `quota_upgrade` linked through user_quota_upgrades)
 *
 * Charging:
 *   credits_to_charge = selected_count  (10 | 25 | 50 | 100 — nothing else)
 *   the charge is atomic and happens BEFORE the search starts; a failed,
 *   interrupted or shorter-than-requested run is NEVER refunded.
 */

/** The only accepted opportunity counts (= credits charged per search). */
export const SEARCH_COUNT_OPTIONS = [10, 25, 50, 100] as const;
export type SearchCount = (typeof SEARCH_COUNT_OPTIONS)[number];

/** Free-tier policy, mirrored from the SQL function (single source: SQL). */
export const FREE_CREDIT_LIMIT = 150;
export const FREE_RESET_HOURS = 120;

export type SearchCreditStatus = {
  creditLimit: number;
  creditsRemaining: number;
  resetHours: number;
  /** When the current cycle ends (ISO string). */
  resetsAt: string | null;
  /** True when a quota-upgrade code is active (premium policy). */
  premium: boolean;
};

export type ChargeOutcome =
  | {
      status: "charged" | "already_charged";
      creditLimit: number;
      creditsRemaining: number;
      balanceBefore: number;
      balanceAfter: number;
      resetsAt: string | null;
    }
  | {
      status: "insufficient_credits";
      creditLimit: number;
      creditsRemaining: number;
      balanceBefore: number;
      balanceAfter: number;
      resetsAt: string | null;
      /** Credits the attempted search required. */
      required: number;
    };

/** Server-side allow-list check (never trust the client value). */
export function isAllowedSearchCount(value: unknown): value is SearchCount {
  return (
    typeof value === "number" &&
    (SEARCH_COUNT_OPTIONS as readonly number[]).includes(value)
  );
}

/** Pure helper for the UI/route: what the balance becomes after a charge. */
export function remainingAfter(
  creditsRemaining: number,
  selectedCount: number,
): number {
  return Math.max(0, creditsRemaining - selectedCount);
}

/** Thrown when the selected count is not one of the offered options. */
export class InvalidSearchCountError extends Error {
  constructor() {
    super("Invalid search count.");
    this.name = "InvalidSearchCountError";
  }
}

type StatusRow = {
  credit_limit?: unknown;
  credits_remaining?: unknown;
  reset_hours?: unknown;
  resets_at?: unknown;
  premium?: unknown;
};

function numberOf(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readStatusRow(row: StatusRow | undefined): SearchCreditStatus {
  return {
    creditLimit: numberOf(row?.credit_limit, FREE_CREDIT_LIMIT),
    creditsRemaining: numberOf(row?.credits_remaining, 0),
    resetHours: numberOf(row?.reset_hours, FREE_RESET_HOURS),
    resetsAt: typeof row?.resets_at === "string" ? row.resets_at : null,
    premium: row?.premium === true,
  };
}

/**
 * Current balance for the signed-in user. The RPC applies the lazy reset, so
 * reading the status after a cycle expired already returns the renewed
 * balance (no cron required).
 */
export async function getSearchCreditStatus(
  userId: string,
): Promise<SearchCreditStatus> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("get_search_credit_status", {
    target_user_id: userId,
  });
  if (error) throw new Error("Unable to read the search credit balance.");
  const row = (Array.isArray(data) ? data[0] : data) as StatusRow | undefined;
  return readStatusRow(row);
}

/**
 * Atomically charge the selected count BEFORE the search runs.
 *
 * Idempotent by `searchId`: a replay (double click, retry, duplicate
 * request, refreshed browser) returns `already_charged` without a second
 * charge. Returns `insufficient_credits` (and charges nothing) when the
 * balance is too low — the caller must then NOT start the search.
 */
export async function chargeSearchCredits(input: {
  userId: string;
  searchId: string;
  selectedCount: number;
}): Promise<ChargeOutcome> {
  if (!isAllowedSearchCount(input.selectedCount))
    throw new InvalidSearchCountError();

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("charge_search_credits", {
    target_user_id: input.userId,
    p_search_id: input.searchId,
    p_count: input.selectedCount,
  });
  if (error) throw new Error("Unable to charge search credits.");

  const row = (Array.isArray(data) ? data[0] : data) as
    | (StatusRow & {
        status?: unknown;
        balance_before?: unknown;
        balance_after?: unknown;
      })
    | undefined;

  const status =
    row?.status === "charged" ||
    row?.status === "already_charged" ||
    row?.status === "insufficient_credits"
      ? row.status
      : "insufficient_credits";

  const base = {
    creditLimit: numberOf(row?.credit_limit, FREE_CREDIT_LIMIT),
    creditsRemaining: numberOf(row?.credits_remaining, 0),
    balanceBefore: numberOf(row?.balance_before, 0),
    balanceAfter: numberOf(row?.balance_after, 0),
    resetsAt: typeof row?.resets_at === "string" ? row.resets_at : null,
  };

  if (status === "insufficient_credits")
    return { status, ...base, required: input.selectedCount };

  return { status, ...base };
}

/**
 * Record the run's outcome. There is deliberately no refund path: a run that
 * fails, is interrupted by the client or finds fewer opportunities than
 * requested leaves the balance untouched.
 */
export async function setSearchStatus(input: {
  userId: string;
  searchId: string;
  status:
    | "pending"
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    | "interrupted";
}): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.rpc("set_search_status", {
    target_user_id: input.userId,
    p_search_id: input.searchId,
    p_status: input.status,
  });
  if (error) {
    // Status recording is observability, never a reason to fail the request
    // (and never a reason to refund).
    console.warn("[SEARCH_CREDITS] unable to record the search status");
  }
}
