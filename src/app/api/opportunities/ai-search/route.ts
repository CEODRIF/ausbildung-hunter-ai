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

type AiSearchEvent = AiSearchProgress | { type: "error"; message: string };

const bodySchema = z
  .object({
    goal: aiSearchGoalSchema,
    targetCount: aiSearchCountSchema,
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

  try {
    await reserveAIUsage(user.id);
  } catch (error) {
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
      try {
        await runAISearch({
          userId: user.id,
          goal,
          targetCount,
          onProgress: emit,
        });
      } catch (error) {
        const message =
          error instanceof Error && error.message.length
            ? error.message
            : "The AI search could not be completed.";
        emit({ type: "error", message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
      ...rateLimitHeaders(limited),
    },
  });
}
