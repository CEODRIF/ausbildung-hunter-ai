/**
 * Trial activation — server-only facade over the `activate_trial` RPC.
 *
 * The one-trial rule is enforced in Postgres (FOR UPDATE on the
 * subscriptions row + on-conflict on `trial_activated_at`), so client state,
 * localStorage, or a page refresh can never restart a consumed trial: every
 * activation goes through this single server path and the stored timestamps
 * are the only source of truth.
 *
 * This facade never throws. Every outcome is a discriminated union so the
 * calling server action can map it to a UI state without interpreting
 * database errors.
 */
import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Shape-only UUID check (input validation, not identity). */
export function isUuidShape(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** Parse an ISO-8601 UTC string into epoch ms; anything else is null. */
export function parseIsoUtcMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export type ActivateTrialOutcome =
  | {
      ok: true;
      status: "activated";
      periodStartMs: number;
      periodEndMs: number;
      trialActivatedAtMs: number | null;
    }
  | {
      ok: true;
      status: "trial_already_used";
      trialActivatedAtMs: number | null;
    }
  | {
      ok: true;
      status: "paid_active";
      planId: string;
      periodEndMs: number | null;
    }
  | { ok: false; error: "invalid_input" | "failed" };

/**
 * Activate the 72-hour trial for `userId` (server-resolved identity).
 *
 * `userId` must come from the server session — never from form data.
 */
export async function activateTrial(
  userId: string,
): Promise<ActivateTrialOutcome> {
  if (!isUuidShape(userId)) return { ok: false, error: "invalid_input" };

  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch {
    // Missing service-role env (or misconfiguration): fail closed.
    return { ok: false, error: "failed" };
  }

  let data: unknown;
  try {
    const res = await admin.rpc("activate_trial", { p_user_id: userId });
    if (res.error) return { ok: false, error: "failed" };
    data = res.data;
  } catch {
    return { ok: false, error: "failed" };
  }

  // House unwrap idiom: scalar jsonb may arrive as an object or 1-row array.
  const obj = (Array.isArray(data) ? data[0] : data) as
    | Record<string, unknown>
    | null;
  if (!obj || typeof obj !== "object") return { ok: false, error: "failed" };

  const status = obj.status;
  if (status === "activated") {
    const startMs = parseIsoUtcMs(obj.current_period_start);
    const endMs = parseIsoUtcMs(obj.current_period_end);
    if (startMs === null || endMs === null || endMs <= startMs) {
      // Malformed oracle output: do NOT surface as a successful activation.
      return { ok: false, error: "failed" };
    }
    return {
      ok: true,
      status: "activated",
      periodStartMs: startMs,
      periodEndMs: endMs,
      trialActivatedAtMs: parseIsoUtcMs(obj.trial_activated_at),
    };
  }

  if (status === "trial_already_used") {
    return {
      ok: true,
      status: "trial_already_used",
      trialActivatedAtMs: parseIsoUtcMs(obj.trial_activated_at),
    };
  }

  if (status === "paid_active") {
    const planId =
      typeof obj.plan_id === "string" && obj.plan_id.length > 0
        ? obj.plan_id
        : null;
    if (planId === null) return { ok: false, error: "failed" };
    return {
      ok: true,
      status: "paid_active",
      planId,
      periodEndMs: parseIsoUtcMs(obj.current_period_end),
    };
  }

  return { ok: false, error: "failed" };
}
