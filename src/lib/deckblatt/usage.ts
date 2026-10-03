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

/** PostgREST error fields that are safe to log: a controlled message and a
 *  code. Codes that identify the production failure directly:
 *   - PGRST205  → function not found in the schema cache (migration not
 *                 applied to the database)
 *   - 42501     → permission denied for function (grants wrong)
 *   - 42883     → argument name/type mismatch
 *   - "transport" → the call never reached PostgREST (network/client) */
interface PostgrestErrorLike {
  message: string;
  code?: string;
}

/**
 * Diagnostics for quota RPC failures. PII discipline: the line contains ONLY
 * the kind of failure, the route, the RPC name, the authenticated state, the
 * PostgREST error code and the controlled error message — never a user id,
 * run id, RPC argument or field value. The underlying Supabase error is
 * preserved (code + message), not replaced by a generic string.
 */
function logQuotaRpcFailure(
  kind: "rpc" | "threw" | "unauthenticated",
  route: string,
  rpcName: string,
  authenticated: boolean,
  error: PostgrestErrorLike | null,
): void {
  console.error(
    `[deckblatt] quota ${kind} route=${route} rpc=${rpcName} auth=${authenticated ? "authenticated" : "unauthenticated"} postgrest_code=${error?.code ?? "n/a"} message=${error?.message ?? "unknown"}`,
  );
}

async function callQuotaRpc(
  name: RpcName,
  args: Record<string, unknown>,
  route: string,
  authenticated: boolean,
): Promise<QuotaRow | null> {
  try {
    const supabase = await createClient();
    const { data, error } = (await supabase.rpc(name, args)) as {
      data: unknown;
      error: PostgrestErrorLike | null;
    };
    if (error) {
      logQuotaRpcFailure("rpc", route, name, authenticated, error);
      return null;
    }
    // The reserve/release RPCs return exactly one row.
    const row = Array.isArray(data) ? data[0] : data;
    if (!row || typeof row !== "object") {
      logQuotaRpcFailure("rpc", route, name, authenticated, {
        message: "malformed_rpc_row",
        code: "shape",
      });
      return null;
    }
    const record = row as Record<string, unknown>;
    if (typeof record.status !== "string") {
      logQuotaRpcFailure("rpc", route, name, authenticated, {
        message: "malformed_rpc_row",
        code: "shape",
      });
      return null;
    }
    return {
      status: record.status,
      used: Number(record.used) || 0,
      remaining: Number(record.remaining) || 0,
    };
  } catch (error) {
    logQuotaRpcFailure("threw", route, name, authenticated, {
      message: error instanceof Error ? error.message : "unknown",
      code: "transport",
    });
    return null;
  }
}

/**
 * Today's remaining quota, or null when the status RPC itself failed.
 * (Own parser: this RPC returns limit/used/remaining/usage_date — no
 * `status` column — so it does not go through callQuotaRpc.)
 */
export async function getDeckblattUsageStatus(): Promise<DeckblattUsageStatus | null> {
  const ROUTE = "/api/deckblatt/status";
  const RPC = "get_deckblatt_usage_status";
  const malformed = { message: "malformed_rpc_row", code: "shape" } as const;
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      logQuotaRpcFailure("unauthenticated", ROUTE, RPC, false, null);
      return null;
    }
    const { data, error } = (await supabase.rpc(RPC, {
      target_user_id: user.id,
    })) as { data: unknown; error: PostgrestErrorLike | null };
    if (error) {
      logQuotaRpcFailure("rpc", ROUTE, RPC, true, error);
      return null;
    }
    const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
    if (!row || typeof row !== "object") {
      logQuotaRpcFailure("rpc", ROUTE, RPC, true, malformed);
      return null;
    }
    const used = Number(row.used);
    const remaining = Number(row.remaining);
    if (!Number.isInteger(used) || !Number.isInteger(remaining)) {
      logQuotaRpcFailure("rpc", ROUTE, RPC, true, malformed);
      return null;
    }
    // The SQL return field is "daily_limit" (bare "limit" is a fully
    // reserved PostgreSQL word and cannot be a RETURNS TABLE field name).
    return { limit: Number(row.daily_limit) || used + remaining, used, remaining };
  } catch (error) {
    logQuotaRpcFailure("threw", ROUTE, RPC, true, {
      message: error instanceof Error ? error.message : "unknown",
      code: "transport",
    });
    return null;
  }
}

/**
 * Atomically reserve ONE generation BEFORE the provider is called.
 * `runId` is the client's idempotency key (a UUID generated per click).
 */
export async function reserveDeckblattGeneration(runId: string): Promise<ReserveOutcome | null> {
  const ROUTE = "/api/deckblatt/generate";
  const RPC = "reserve_deckblatt_generation";
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    logQuotaRpcFailure("unauthenticated", ROUTE, RPC, false, null);
    return null;
  }
  const row = await callQuotaRpc(
    "reserve_deckblatt_generation",
    { target_user_id: user.id, p_run_id: runId },
    ROUTE,
    true,
  );
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
  const ROUTE = "/api/deckblatt/generate";
  const RPC = "release_deckblatt_generation";
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    logQuotaRpcFailure("unauthenticated", ROUTE, RPC, false, null);
    return false;
  }
  const row = await callQuotaRpc(
    "release_deckblatt_generation",
    { target_user_id: user.id, p_run_id: runId },
    ROUTE,
    true,
  );
  return row?.status === "released";
}

/**
 * Mark a reserved generation as SUCCEEDED. The quota was already consumed at
 * reserve time; this only keeps the audit ledger honest. Never throws —
 * the design is already generated, a ledger hiccup must not fail the user.
 */
export async function completeDeckblattGeneration(runId: string): Promise<boolean> {
  const ROUTE = "/api/deckblatt/generate";
  const RPC = "complete_deckblatt_generation";
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      logQuotaRpcFailure("unauthenticated", ROUTE, RPC, false, null);
      return false;
    }
    // The SQL function returns VOID: PostgREST answers { data: null,
    // error: null } on success — so "no error" IS success. Parsing it as a
    // row (callQuotaRpc) would report every completion as a failure.
    const { error } = (await supabase.rpc(RPC, {
      target_user_id: user.id,
      p_run_id: runId,
    })) as { error: PostgrestErrorLike | null };
    if (error) {
      logQuotaRpcFailure("rpc", ROUTE, RPC, true, error);
      return false;
    }
    return true;
  } catch (error) {
    logQuotaRpcFailure("threw", ROUTE, RPC, true, {
      message: error instanceof Error ? error.message : "unknown",
      code: "transport",
    });
    return false;
  }
}
