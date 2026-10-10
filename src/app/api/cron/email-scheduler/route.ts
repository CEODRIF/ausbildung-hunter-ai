import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { processCampaignBatch } from "@/lib/email-campaigns";

/**
 * Email scheduler tick — the durable, browser-independent sender.
 *
 * Triggered every minute by Vercel Cron (`vercel.json`); a gated GitHub
 * Actions workflow (`.github/workflows/email-scheduler.yml`) can drive the
 * same engine when Vercel crons are unavailable. This endpoint is a thin,
 * BOUNDED driver over the existing durable engine:
 *
 *   claim_next_pending_campaign (atomic, SKIP LOCKED, service-role only)
 *   → processCampaignBatch (existing claim/finalize/retry/capacity logic)
 *
 * A campaign becomes "pending" the moment every one of its messages is
 * due: immediate campaigns are due at creation, scheduled campaigns at
 * `scheduled_at` (their messages carry `next_attempt_at = scheduled_at`,
 * which is exactly what the claim predicates gate on). No other send path
 * exists, so a scheduled campaign can never be sent before its instant —
 * by the cron, by the fallback, or by a browser-triggered drain.
 *
 * Safety properties:
 *  - Bounded work per tick: ≤ MAX_ROUNDS claim+batch rounds AND a wall
 *    budget — a backlog drains over multiple minutes, not one long
 *    function (Vercel would kill it anyway).
 *  - Concurrent-invocation safe: claims are atomic per message in
 *    Postgres (FOR UPDATE SKIP LOCKED); two overlapping ticks simply
 *    spread across campaigns/messages and can never double-send.
 *  - Recovery: processCampaignBatch first runs recoverStaleCampaigns
 *    (stalled in-flight messages → failed, never silently lost), and any
 *    message that simply stayed queued is claimed on the next tick.
 *  - Fail-closed auth: missing CRON_SECRET or mismatched token → 401,
 *    no work at all. Comparison is timing-safe and length-independent.
 *  - Safe logs: only counts and ids — never recipients, content, tokens.
 */
export const dynamic = "force-dynamic";
// Hard ceiling below the platform function timeout: the loop below also
// stops itself earlier (soft budget), so the function returns normally.
export const maxDuration = 60;

const MAX_ROUNDS = 3;
const SOFT_BUDGET_MS = 45_000;
const BATCH_SIZE = 5;

function cronAuthorized(request: Request): boolean {
  const configured = process.env.CRON_SECRET;
  if (!configured || configured.length < 16) return false; // fail closed
  const header = request.headers.get("authorization") ?? "";
  const [scheme, ...rest] = header.split(" ");
  const supplied = rest.join(" ");
  if (scheme?.toLowerCase() !== "bearer" || !supplied) return false;
  // Compare digests: constant-time AND length-independent.
  const digestConfigured = createHash("sha256").update(configured).digest();
  const digestSupplied = createHash("sha256").update(supplied).digest();
  return timingSafeEqual(digestConfigured, digestSupplied);
}

export async function GET(request: Request) {
  if (!cronAuthorized(request))
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const startedAt = Date.now();
  let claimed = 0;
  let processed = 0;
  let stopped = "queue-empty";

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    if (Date.now() - startedAt > SOFT_BUDGET_MS) {
      stopped = "budget";
      break;
    }
    const admin = createAdminClient();
    const { data, error } = await admin.rpc("claim_next_pending_campaign");
    if (error) {
      console.warn("[EMAIL_SCHEDULER] claim failed:", error.message);
      stopped = "claim-error";
      break;
    }
    const campaignId = (data as { campaign_id?: string | null } | null)
      ?.campaign_id;
    const userId = (data as { user_id?: string | null } | null)?.user_id;
    if (!campaignId || !userId) {
      stopped = "queue-empty";
      break;
    }
    claimed += 1;
    try {
      // Idempotent through the message-level claims; recovers stale state
      // first; stops on the first batch that cannot progress (slot busy,
      // quota, provider down) — the rest is due on the next tick.
      const result = await processCampaignBatch(
        userId,
        campaignId,
        BATCH_SIZE,
      );
      processed += result.processed;
    } catch (err) {
      // Never crash the tick: the campaign is intact, everything it claimed
      // is finalized by the engine, and the next tick (or stale recovery)
      // continues it. Log the error kind only — never message content.
      console.warn(
        "[EMAIL_SCHEDULER] batch failed:",
        err instanceof Error ? err.message : "unknown error",
      );
      stopped = "batch-error";
      break;
    }
  }

  console.info(
    `[EMAIL_SCHEDULER] tick done claimed=${claimed} processed=${processed} stop=${stopped} elapsed_ms=${
      Date.now() - startedAt
    }`,
  );
  return NextResponse.json({
    ok: true,
    claimed,
    processed,
    stop: stopped,
    elapsed_ms: Date.now() - startedAt,
  });
}
