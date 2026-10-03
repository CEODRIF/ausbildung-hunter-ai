import "server-only";

/**
 * Deckblatt daily-quota access (2 designs per user per UTC day).
 *
 * Every call goes through the security-definer RPCs from migration
 * 20261020000000_deckblatt_usage.sql — and deliberately uses the USER
 * session client (not the service-role client): the RPCs guard with
 * `auth.uid() <> target_user_id → not_authorized`, and the tables' RLS
 * exposes only SELECT on own rows. A client-side counter can therefore
 * never bypass the quota, and no code path can charge someone else's
 * account.
 *
 * The RPCs are idempotent per run_id:
 *  - reserve  → "reserved" | "already_reserved" (retry) | "quota_exhausted"
 *  - release  → refunds exactly one FAILED reserved run ("no_op" otherwise)
 *  - complete → marks the run as succeeded (quota unchanged)
 */
import { createClient } from "@/lib/supabase/server";

export interface DeckblattUsageStatus {
  limit: number;
  used: number;
  remaining: number;
}

export type ReserveOutcome =
  | { status: "reserved"; used: number; remaining: number }
  | { status: "already_reserved"; used: number; remaining: number }
  | { status: "quota_exhausted"; used: number; remaining: number };

interface QuotaRow {
  status: string;
  used: number;
  remaining: number;
}

type RpcName =
  | "reserve_deckblatt_generation"
  | "release_deckblatt_generation"
  | "complete_deckblatt_generation";

async function callQuotaRpc(name: RpcName, args: Record<string, unknown>): Promise<QuotaRow | null> {
  try {
    const supabase = await createClient();
    const { data, error } = (await supabase.rpc(name, args)) as {
      data: unknown;
      error: { message: string } | null;
    };
    if (error) {
      // The RPC error message is logged (it is a controlled server-side
      // string, never user data), then the caller degrades gracefully.
      console.error(`[deckblatt] quota rpc ${name} failed: ${error.message}`);
      return null;
    }
    // The reserve/release RPCs return exactly one row.
    const row = Array.isArray(data) ? data[0] : data;
    if (!row || typeof row !== "object") return null;
    const record = row as Record<string, unknown>;
    if (typeof record.status !== "string") return null;
    return {
      status: record.status,
      used: Number(record.used) || 0,
      remaining: Number(record.remaining) || 0,
    };
  } catch (error) {
    console.error(
      `[deckblatt] quota rpc ${name} threw: ${error instanceof Error ? error.message : "unknown"}`,
    );
    return null;
  }
}

/**
 * Today's remaining quota, or null when the status RPC itself failed.
 * (Own parser: this RPC returns limit/used/remaining/usage_date — no
 * `status` column — so it does not go through callQuotaRpc.)
 */
export async function getDeckblattUsageStatus(): Promise<DeckblattUsageStatus | null> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return null;
    const { data, error } = (await supabase.rpc("get_deckblatt_usage_status", {
      target_user_id: user.id,
    })) as { data: unknown; error: { message: string } | null };
    if (error) {
      console.error(
        `[deckblatt] quota rpc get_deckblatt_usage_status failed: ${error.message}`,
      );
      return null;
    }
    const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
    if (!row || typeof row !== "object") return null;
    const used = Number(row.used);
    const remaining = Number(row.remaining);
    if (!Number.isInteger(used) || !Number.isInteger(remaining)) return null;
    return { limit: Number(row.limit) || used + remaining, used, remaining };
  } catch (error) {
    console.error(
      `[deckblatt] quota rpc get_deckblatt_usage_status threw: ${
        error instanceof Error ? error.message : "unknown"
      }`,
    );
    return null;
  }
}

/**
 * Atomically reserve ONE generation BEFORE the provider is called.
 * `runId` is the client's idempotency key (a UUID generated per click).
 */
export async function reserveDeckblattGeneration(runId: string): Promise<ReserveOutcome | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const row = await callQuotaRpc("reserve_deckblatt_generation", {
    target_user_id: user.id,
    p_run_id: runId,
  });
  if (!row) return null;
  if (row.status === "already_reserved") {
    return { status: "already_reserved", used: row.used, remaining: row.remaining };
  }
  if (row.status === "quota_exhausted") {
    return { status: "quota_exhausted", used: row.used, remaining: row.remaining };
  }
  if (row.status === "reserved") {
    return { status: "reserved", used: row.used, remaining: row.remaining };
  }
  // Unknown status — treat as failure (nothing was consumed visibly).
  return null;
}

/**
 * Refund a reserved generation that FAILED. Idempotent: only a run still in
 * state 'reserved' is refunded; double calls and calls for unknown/succeeded
 * runs are no-ops. Never throws.
 */
export async function releaseDeckblattGeneration(runId: string): Promise<boolean> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return false;
  const row = await callQuotaRpc("release_deckblatt_generation", {
    target_user_id: user.id,
    p_run_id: runId,
  });
  return row?.status === "released";
}

/**
 * Mark a reserved generation as SUCCEEDED. The quota was already consumed at
 * reserve time; this only keeps the audit ledger honest. Never throws —
 * the design is already generated, a ledger hiccup must not fail the user.
 */
export async function completeDeckblattGeneration(runId: string): Promise<boolean> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return false;
  const row = await callQuotaRpc("complete_deckblatt_generation", {
    target_user_id: user.id,
    p_run_id: runId,
  });
  return row !== null;
}
