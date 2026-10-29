import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { claimAndDispatchDueStudioAttempts } from "@/lib/studio";

/**
 * AI Bewerbung Studio scheduler tick — durable, browser-independent
 * dispatch of SCHEDULED application sends (and retry backoff of failed
 * temporary sends).
 *
 * Same safety shape as the bew/email cron:
 *   - Fail-closed CRON_SECRET bearer auth (timing-safe, length-independent).
 *   - Bounded work: ≤ 5 attempts per tick, wall budget 45 s.
 *   - Concurrency-safe: claim_due_studio_attempts uses FOR UPDATE SKIP
 *     LOCKED and dispatchStudioAttempt re-claims atomically, so an
 *     overlapping tick can never double-send.
 *   - Every dispatched attempt was explicitly approved + confirmed by the
 *     user; nothing is enqueued by page visits or generation.
 *   - Safe logs: counts and ids only — never recipients or content.
 *
 * Wired in .github/workflows/email-scheduler.yml (same cadence as the
 * other schedulers; GitHub cron throttling is mitigated by the
 * page-load catch-up in refreshApplicationAction).
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_ATTEMPTS = 5;
const SOFT_BUDGET_MS = 45_000;

function cronAuthorized(request: Request): boolean {
  const configured = process.env.CRON_SECRET;
  if (!configured || configured.length < 16) return false; // fail closed
  const header = request.headers.get("authorization") ?? "";
  const [scheme, ...rest] = header.split(" ");
  const supplied = rest.join(" ");
  if (scheme?.toLowerCase() !== "bearer" || !supplied) return false;
  const digestConfigured = createHash("sha256").update(configured).digest();
  const digestSupplied = createHash("sha256").update(supplied).digest();
  return timingSafeEqual(digestConfigured, digestSupplied);
}

export async function GET(request: Request) {
  if (!cronAuthorized(request))
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const startedAt = Date.now();
  try {
    const { recovered, claimed, results } = await claimAndDispatchDueStudioAttempts(MAX_ATTEMPTS, SOFT_BUDGET_MS);
    const sent = results.filter((r) => r.status === "sent").length;
    const failed = results.filter((r) => r.status === "failed").length;
    const retried = results.filter((r) => r.status === "queued").length;
    console.info(
      `[STUDIO_SCHEDULER] tick done recovered=${recovered} claimed=${claimed} sent=${sent} failed=${failed} retried=${retried} elapsed_ms=${
        Date.now() - startedAt
      }`,
    );
    return NextResponse.json({
      ok: true,
      recovered,
      claimed,
      sent,
      failed,
      retried,
      elapsed_ms: Date.now() - startedAt,
    });
  } catch (err) {
    // Never crash the tick: state is durable (Postgres), the next tick
    // continues. Log the error kind only — no user data.
    console.warn(
      "[STUDIO_SCHEDULER] tick failed:",
      err instanceof Error ? err.message : "unknown error",
    );
    return NextResponse.json({ ok: false, error: "tick_failed" }, { status: 500 });
  }
}
