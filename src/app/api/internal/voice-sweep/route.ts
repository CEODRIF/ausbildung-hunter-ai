import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { communityLog } from "@/lib/community/log";

/**
 * Community Phase 6C (C-2) — stale voice-conversation TTL sweep.
 *
 * Same trust boundary as /api/internal/storage-reconcile and
 * /api/internal/email-worker: the `x-email-worker-secret` header
 * (worker == service-level trust; no browser path exists to this route).
 * Phase 6D attaches the durable poller once real LiveKit infrastructure
 * is provisioned — this endpoint is the narrow seam, nothing schedules it
 * in-repo and nothing client-side can call it.
 *
 * Convergence semantics (see v9 migration `community_voice_sweep_stale`):
 * an `active` row whose `updated_at` is older than the threshold is marked
 * `ended`. The sweep NEVER touches LiveKit, never deletes rows, never
 * changes participant_count / room references, and the response therefore
 * reports ONLY how many DB records converged — it makes no claim about
 * actual SFU participant state.
 */
export const VOICE_SWEEP_DEFAULT_STALE_MINUTES = 15;
export const VOICE_SWEEP_MIN_STALE_MINUTES = 1;
export const VOICE_SWEEP_MAX_STALE_MINUTES = 1440;
export const VOICE_SWEEP_DEFAULT_MAX = 25;
export const VOICE_SWEEP_MAX_CAP = 100;

const clamp = (n: number, min: number, max: number): number =>
  Math.min(Math.max(n, min), max);

/** Strict body — unknown keys (e.g. an "execute" flag) are rejected: there
 *  is nothing to "execute more" of, the threshold IS the safety boundary. */
const sweepBody = z
  .object({
    /** Minutes of silence before an active conversation record is stale. */
    staleMinutes: z
      .number()
      .int()
      .min(VOICE_SWEEP_MIN_STALE_MINUTES)
      .max(VOICE_SWEEP_MAX_STALE_MINUTES)
      .optional(),
    /** Per-tick convergence budget (server-clamped to 1..100 in SQL). */
    maxSwept: z.number().int().min(1).max(VOICE_SWEEP_MAX_CAP).optional(),
  })
  .strict();

export async function POST(request: Request) {
  const configuredSecret = process.env.EMAIL_WORKER_SECRET;
  const suppliedSecret = request.headers.get("x-email-worker-secret");
  if (!configuredSecret || suppliedSecret !== configuredSecret)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = sweepBody.safeParse(body ?? {});
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid sweep request" }, { status: 400 });
  }

  const staleMinutes = clamp(
    parsed.data.staleMinutes ?? VOICE_SWEEP_DEFAULT_STALE_MINUTES,
    VOICE_SWEEP_MIN_STALE_MINUTES,
    VOICE_SWEEP_MAX_STALE_MINUTES,
  );
  const maxSwept = clamp(
    parsed.data.maxSwept ?? VOICE_SWEEP_DEFAULT_MAX,
    1,
    VOICE_SWEEP_MAX_CAP,
  );

  try {
    const admin = createAdminClient();
    const { data, error } = await admin.rpc("community_voice_sweep_stale", {
      p_stale_minutes: staleMinutes,
      p_max: maxSwept,
    });
    if (error) {
      communityLog(
        "community.voice.unavailable",
        { context: "stale_sweep", detail: error.message },
        "error",
      );
      return NextResponse.json({ error: "Voice sweep failed" }, { status: 500 });
    }
    // DB returns the swept count (integer → number); anything else is
    // treated as 0 — an unknown shape is NEVER reported as a sweep.
    const swept = typeof data === "number" && Number.isFinite(data) ? data : 0;
    communityLog("community.voice.cleanup", {
      swept,
      staleMinutes,
      maxSwept,
    });
    return NextResponse.json({ swept, staleMinutes, maxSwept });
  } catch {
    communityLog(
      "community.voice.unavailable",
      { context: "stale_sweep", detail: "rpc_exception" },
      "error",
    );
    return NextResponse.json({ error: "Voice sweep failed" }, { status: 500 });
  }
}
