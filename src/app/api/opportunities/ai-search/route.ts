import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { reserveAIUsage } from "@/lib/ai-service";
import {
  aiSearchCountSchema,
  aiSearchGoalSchema,
  runAISearch,
  type AiSearchProgress,
} from "@/lib/opportunities/ai-search";
import {
  chargeSearchCredits,
  InvalidSearchCountError,
  setSearchStatus,
} from "@/lib/search-credits";
import {
  checkRateLimit,
  rateLimitHeaders,
  tooManyRequests,
} from "@/lib/rate-limit";

export const runtime = "nodejs";

/**
 * AI Ausbildung Search — streaming pipeline endpoint.
 *
 * Response is a newline-delimited JSON event stream (same plain-text
 * streaming pattern as /api/ai/chat; CSP-safe, no inline scripts):
 *   {"type":"profile",...}   → candidate profile summary
 *   {"type":"plan",...}      → AI-generated, Zod-validated search plan
 *   {"type":"search",...}    → per-query collection progress
 *   {"type":"enrich",...}    → detail-enrichment progress
 *   {"type":"complete",...}  → final ranked results (real source data)
 *   {"type":"error","message":...}
 *
 * Exactly one AI quota request is reserved (the planning call). All
 * opportunity data comes from the public Bundesagentur für Arbeit Jobsuche
 * via the shared provider + cache — the AI never contributes content.
 */

type AiSearchEvent =
  | AiSearchProgress
  | { type: "credits"; creditsRemaining: number; creditLimit: number }
  | { type: "error"; message: string };

const bodySchema = z
  .object({
    goal: aiSearchGoalSchema,
    targetCount: aiSearchCountSchema,
    /** Client-generated idempotency key: a replayed request (double click,
     *  retry, refresh) with the same id is never charged twice. */
    requestId: z.string().uuid().optional(),
  })
  .strict();

function encodeEvent(event: AiSearchEvent): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(event)}\n`);
}

export async function POST(request: Request) {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limited = await checkRateLimit("ai_search", user.id);
  if (!limited.allowed) return tooManyRequests(limited);

  const raw = await request.json().catch(() => null);
  const parsed = raw !== null ? bodySchema.safeParse(raw) : null;
  if (!parsed?.success)
    return NextResponse.json(
      { error: "Invalid AI search request." },
      { status: 400 },
    );
  const { goal, targetCount } = parsed.data;
  const searchId = parsed.data.requestId ?? crypto.randomUUID();

  // ---------------------------------------------------------------------
  // Credits are charged BEFORE the search starts (atomic, idempotent by
  // searchId) and are NEVER refunded afterwards — not on client disconnect,
  // not on timeout, not on a pipeline failure.
  // ---------------------------------------------------------------------
  let charge;
  try {
    charge = await chargeSearchCredits({
      userId: user.id,
      searchId,
      selectedCount: targetCount,
    });
  } catch (error) {
    if (error instanceof InvalidSearchCountError)
      return NextResponse.json(
        { error: "Invalid search count." },
        { status: 400 },
      );
    return NextResponse.json(
      { error: "Search credits are unavailable." },
      { status: 503 },
    );
  }

  if (charge.status === "insufficient_credits")
    return NextResponse.json(
      {
        error: "insufficient_credits",
        creditsRemaining: charge.creditsRemaining,
        required: charge.required,
      },
      // No search starts and nothing is charged.
      { status: 402 },
    );

  try {
    await reserveAIUsage(user.id);
  } catch (error) {
    // The run cannot start — the search is recorded as failed. The charged
    // credits stay spent (the search was confirmed, per policy).
    await setSearchStatus({ userId: user.id, searchId, status: "failed" });
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "AI usage is unavailable.",
      },
      { status: 429 },
    );
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: AiSearchEvent) => {
        try {
          controller.enqueue(encodeEvent(event));
        } catch {
          // The client closed the stream (cancellation) — stop emitting.
        }
      };
      // The post-charge balance travels to the UI with the run.
      emit({
        type: "credits",
        creditsRemaining: charge.creditsRemaining,
        creditLimit: charge.creditLimit,
      });
      try {
        await runAISearch({
          userId: user.id,
          goal,
          targetCount,
          onProgress: emit,
        });
        await setSearchStatus({ userId: user.id, searchId, status: "completed" });
      } catch (error) {
        await setSearchStatus({ userId: user.id, searchId, status: "failed" });
        const message =
          error instanceof Error && error.message.length
            ? error.message
            : "The AI search could not be completed.";
        emit({ type: "error", message });
      } finally {
        controller.close();
      }
    },
    async cancel() {
      // The client navigated away / aborted: the run is recorded honestly as
      // interrupted. No refund.
      await setSearchStatus({
        userId: user.id,
        searchId,
        status: "interrupted",
      });
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
      "x-search-id": searchId,
      ...rateLimitHeaders(limited),
    },
  });
}
