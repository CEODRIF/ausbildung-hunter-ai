import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getAIContext } from "@/lib/ai-context";
import {
  prepareChat,
  provider,
  recentMessages,
  saveAssistantMessage,
} from "@/lib/ai-service";
import {
  completeFeatureOp,
  releaseFeatureOp,
  reserveFeatureOp,
} from "@/lib/billing/entitlement-service";
import {
  decideScope,
  detectUILanguage,
  isCoverLetterRequest,
  isResumeRequest,
  SCOPE_REDIRECTS,
} from "@/lib/ai-scope";
import { buildSearchContextBlock } from "@/lib/germany-knowledge";
import { researchGermany } from "@/lib/germany-research";
import {
  checkRateLimit,
  rateLimitHeaders,
  tooManyRequests,
} from "@/lib/rate-limit";

export const runtime = "nodejs";

/**
 * Live search is an EXTRA paid third-party call per question, so it has its own
 * per-user budget. When the budget cannot be confirmed (limiter error) the
 * lookup is skipped — the user still gets a complete answer from the model, so
 * this is "fail safe for cost" rather than a blocked request.
 */
async function searchBudgetAvailable(userId: string): Promise<boolean> {
  try {
    const limited = await checkRateLimit("web_search", userId);
    return limited.allowed;
  } catch {
    return false;
  }
}

/** Wrap a plain string as a small text stream (2 chunks for progressive UI). */
function textStream(text: string) {
  const encoder = new TextEncoder();
  const half = Math.ceil(text.length / 2);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text.slice(0, half)));
      controller.enqueue(encoder.encode(text.slice(half)));
      controller.close();
    },
  });
}
export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Paid AI: cap per-user bursts (session-scoped key, fail-open limiter).
  const limited = await checkRateLimit("ai_chat", user.id);
  if (!limited.allowed) return tooManyRequests(limited);
  const body = (await request.json().catch(() => ({}))) as {
    conversationId?: string;
    content?: string;
    fileIds?: string[];
  };
  if (!body.conversationId)
    return NextResponse.json(
      { error: "Conversation is required." },
      { status: 400 },
    );
  // Quota settlement state (declared before the try so the catch can
  // release a reservation when the generation fails before any chunk is
  // delivered — a failed op must not consume quota).
  let dedicatedRunId: string | null = null;
  let dedicatedFeature: "cover_letter" | "resume_ai" | null = null;
  let aiReserved = false;
  let delivered = false;
  try {
    const fileIds = Array.isArray(body.fileIds)
      ? body.fileIds.filter((id) => typeof id === "string")
      : [];
    // Server-side scope gate (BEFORE any model call): the assistant is a
    // specialist for AusbildungsWeg. Out-of-scope questions get a
    // short, language-matched redirect — streamed and persisted like any
    // assistant reply, with no model call and no fabricated off-topic answer.
    // The hardened system prompt enforces the same boundary on the model side
    // for every in-scope request.
    const history = await recentMessages(user.id, body.conversationId);
    const scope = decideScope(body.content || "", fileIds.length > 0, history);
    // Cover-letter AND resume requests are metered against their DEDICATED
    // per-feature quotas (one operation = one generated/improved/analyzed
    // document) — they must not bypass them by riding the general AI quota.
    // The reservation happens BEFORE any model call and is released when
    // nothing is delivered. Cover letters take precedence when a message
    // matches both (existing behavior).
    const content = body.content || "";
    const dedicated: "cover_letter" | "resume_ai" | null =
      isCoverLetterRequest(content)
        ? "cover_letter"
        : isResumeRequest(content)
          ? "resume_ai"
          : null;
    if (dedicated) {
      dedicatedFeature = dedicated;
      dedicatedRunId = crypto.randomUUID();
      const reserved = await reserveFeatureOp(
        user.id,
        dedicated,
        dedicatedRunId,
      );
      if (reserved.outcome === "quota_exhausted") {
        return NextResponse.json(
          {
            error:
              dedicated === "cover_letter"
                ? "Cover letter limit reached. It resets daily (UTC)."
                : "Resume limit reached for your current plan period.",
            code: "quota_exhausted",
          },
          { status: 429 },
        );
      }
      if (reserved.outcome === "feature_disabled") {
        return NextResponse.json(
          {
            error:
              dedicated === "cover_letter"
                ? "Cover letter generation is not available on your current plan."
                : "Resume AI is not available on your current plan.",
            code: "feature_disabled",
          },
          { status: 403 },
        );
      }
      if (reserved.outcome === "error") {
        return NextResponse.json(
          {
            error:
              reserved.message ?? "Quota service temporarily unavailable.",
            code: "quota_unavailable",
          },
          { status: 503 },
        );
      }
    }
    try {
      await prepareChat(
        user.id,
        body.conversationId,
        content,
        fileIds,
        { skipAiReservation: dedicated !== null },
      );
      // prepareChat succeeded: the AI reservation (regular chat) is live.
      aiReserved = dedicated === null;
    } catch (error) {
      if (dedicatedRunId && dedicatedFeature) {
        await releaseFeatureOp(user.id, dedicatedFeature, dedicatedRunId);
        dedicatedRunId = null;
        dedicatedFeature = null;
      }
      throw error;
    }
    let stream: ReadableStream<Uint8Array>;
    if (scope.inScope) {
      const context = await getAIContext(user.id, body.conversationId);
      // Germany copilot pipeline: does this question depend on information that
      // changes (fees, deadlines, thresholds, the law in force)? If so, look it
      // up — official sources ranked first — and hand the extracts to the model
      // as untrusted REFERENCE data. Any failure degrades to "no search": the
      // answer is never blocked, the model just states it cannot verify and
      // points at the competent authority.
      const research = (await searchBudgetAvailable(user.id))
        ? await researchGermany(body.content || "")
        : { searched: false, reason: "failed" as const, query: "", results: [] };
      if (research.searched) {
        console.info(
          "[ai-chat] germany research",
          JSON.stringify({
            conversationId: body.conversationId,
            results: research.results.length,
          }),
        );
      }
      stream = await provider().streamText(
        context.messages,
        research.results.length
          ? buildSearchContextBlock(body.content || "", research.results)
          : undefined,
      );
    } else {
      if (dedicatedRunId && dedicatedFeature) {
        // A scope redirect executes no generation — release the operation.
        await releaseFeatureOp(user.id, dedicatedFeature, dedicatedRunId);
        dedicatedRunId = null;
        dedicatedFeature = null;
      }
      console.info(
        "[ai-chat] out-of-scope request redirected",
        JSON.stringify({ conversationId: body.conversationId, reason: scope.reason }),
      );
      stream = textStream(SCOPE_REDIRECTS[detectUILanguage(body.content || "")]);
    }
    let complete = "";
    let persisted = false;
    const encoder = new TextEncoder();
    // Settle the dedicated-feature reservation (cover letter or resume)
    // exactly once: a document that was actually generated (any content
    // delivered) is consumed; an empty stream is released so a failed op
    // costs nothing.
    const settleDedicated = async (contentDelivered: boolean) => {
      if (!dedicatedRunId || !dedicatedFeature) return;
      const runId = dedicatedRunId;
      const feature = dedicatedFeature;
      dedicatedRunId = null;
      dedicatedFeature = null;
      if (contentDelivered) {
        await completeFeatureOp(user.id, feature, runId);
      } else {
        await releaseFeatureOp(user.id, feature, runId);
      }
    };
    // The stream ends exactly once — either cleanly (flush) or because the
    // client stopped/refreshed (cancel). Both paths persist the answer the
    // user actually saw, so assistant messages survive stop, refresh and
    // navigation. An empty answer is never persisted as a "successful"
    // message (a failed generation must not leave a fake empty reply).
    const persist = async () => {
      if (persisted || !complete.trim()) return null;
      persisted = true;
      try {
        return await saveAssistantMessage(
          user.id,
          body.conversationId!,
          complete,
        );
      } catch (error) {
        console.error("[ai-chat] failed to persist assistant message", error);
        return null;
      }
    };
    // `cancel` is a real TransformStream hook (the runtime supports it) but
    // is missing from TS's Transformer type — widen the init type locally.
    type CancelableTransformer = Transformer<Uint8Array, Uint8Array> & {
      cancel?: () => void | Promise<void>;
    };
    const transformer: CancelableTransformer = {
      transform(chunk, controller) {
        delivered = true;
        complete += new TextDecoder().decode(chunk);
        controller.enqueue(chunk);
      },
      async flush(controller) {
        const saved = await persist();
        await settleDedicated(complete.trim().length > 0);
        // Final metadata frame (NUL-delimited): the client extracts the
        // persisted message id so the committed bubble carries the real
        // database identity instead of a local placeholder.
        controller.enqueue(
          encoder.encode(
            "\u0000" +
              JSON.stringify({
                aiMeta: { messageId: saved?.id ?? null, saved: !!saved },
              }),
          ),
        );
      },
      async cancel() {
        // Client aborted mid-stream: persist the partial answer.
        await persist();
        await settleDedicated(complete.trim().length > 0);
      },
    };
    const transformed = stream.pipeThrough(new TransformStream(transformer));
    return new Response(transformed, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-cache",
        // Never buffer this stream in intermediate proxies (nginx-style
        // gateways) — the first chunk must reach the client immediately.
        "x-accel-buffering": "no",
        "x-content-type-options": "nosniff",
        ...rateLimitHeaders(limited),
      },
    });
  } catch (error) {
    // A generation that failed before ANY chunk reached the client must not
    // consume quota — release the live reservation (dedicated feature or
    // the general AI counter). Partial/complete deliveries keep it
    // (conservative: the user did receive a generated answer).
    if (!delivered) {
      if (dedicatedRunId && dedicatedFeature) {
        await releaseFeatureOp(user.id, dedicatedFeature, dedicatedRunId);
      } else if (aiReserved) {
        await releaseFeatureOp(user.id, "ai_assistant").catch(() => undefined);
      }
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "AI request failed." },
      { status: 400 },
    );
  }
}
