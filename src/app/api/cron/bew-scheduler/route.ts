import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import {
  cleanupRecentlyCompletedBewLetterPdfs,
  listSendingBewCampaigns,
  processBewSendBatch,
} from "@/lib/bewerbung-engine";

/**
 * Bewerbung-Automation scheduler tick — the durable, browser-independent
 * continuation for campaigns the user has explicitly started.
 *
 * Mirrors the protected engine's cron (`.github/workflows/email-scheduler.yml`
 * / /api/cron/email-scheduler) exactly in shape and safety:
 *
 *   - Fail-closed CRON_SECRET bearer auth (timing-safe, length-independent).
 *   - Bounded work: ≤ MAX_CAMPAIGNS campaigns, ≤ BATCH_SIZE messages each,
 *     plus a wall budget — a backlog drains over multiple ticks.
 *   - Concurrency-safe: `processBewSendBatch` claims with FOR UPDATE
 *     SKIP LOCKED, so an overlapping tick (or a live browser poll) can never
 *     double-send the same application.
 *   - Safe logs: counts and ids only — never recipients or content.
 *
 * A campaign is only ever here because the user CONFIRMED a send; opening
 * the page or generating letters never enqueues anything.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// How many campaigns ONE tick may scan. Each scan is itself bounded (≤
// BATCH_SIZE messages, 5–6 s pacing each) and the tick's WALL budget
// (SOFT_BUDGET_MS) is the hard cap either way — it fits ~one batch per
// tick, so the list order IS the priority. The list is DUE-FIRST
// (listSendingBewCampaigns: scheduled batches that are NOW DUE, then
// in-flight FIFO, then timestamp-less legacy rows): a due batch carries an
// explicit send-instant promise, so in-flight backlogs can never hold the
// tick's slot against it. (Regression history: with the pending batch's
// started_at NULL and an in-flight-first merge, the tick's single batch
// went to in-flight campaigns and the due batch drained only via a live
// browser poll — "sends only when I open the website".)
const MAX_CAMPAIGNS = 10;
const BATCH_SIZE = 5;
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
  let campaigns = 0;
  let processed = 0;
  let deletedPdfs = 0;
  let stopped = "queue-empty";

  const sending = await listSendingBewCampaigns(MAX_CAMPAIGNS);
  for (const campaign of sending) {
    if (Date.now() - startedAt > SOFT_BUDGET_MS) {
      stopped = "budget";
      break;
    }
    try {
      const result = await processBewSendBatch(
        campaign.user_id,
        campaign.id,
        BATCH_SIZE,
      );
      campaigns += 1;
      processed += result.processed;
    } catch (err) {
      // Never crash the tick: the campaign stays intact and the next tick
      // (or the browser poll) continues it. Log the error kind only.
      console.warn(
        "[BEW_SCHEDULER] batch failed:",
        err instanceof Error ? err.message : "unknown error",
      );
      stopped = "batch-error";
      break;
    }
  }

  // Post-send letter-PDF cleanup retry pass (bounded, idempotent, state-safe):
  // sweeps terminal campaigns completed within the last 24 h, so a delete
  // that failed in a campaign's FINAL drain is retried on later ticks
  // instead of orphaning the file. Never sends or mutates application state.
  if (Date.now() - startedAt <= SOFT_BUDGET_MS) {
    try {
      const cleanup = await cleanupRecentlyCompletedBewLetterPdfs(10);
      deletedPdfs += cleanup.deleted;
    } catch (err) {
      console.warn(
        "[BEW_SCHEDULER] letter PDF cleanup pass failed:",
        err instanceof Error ? err.message : "unknown error",
      );
    }
  }

  console.info(
    `[BEW_SCHEDULER] tick done campaigns=${campaigns} processed=${processed} deleted_pdfs=${deletedPdfs} stop=${stopped} elapsed_ms=${
      Date.now() - startedAt
    }`,
  );
  return NextResponse.json({
    ok: true,
    campaigns,
    processed,
    deleted_pdfs: deletedPdfs,
    stop: stopped,
    elapsed_ms: Date.now() - startedAt,
  });
}
