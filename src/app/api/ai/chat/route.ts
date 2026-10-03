import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  getAIContext,
  prepareChat,
  provider,
  recentMessages,
  saveAssistantMessage,
} from "@/lib/ai-service";
import {
  decideScope,
  detectUILanguage,
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
  try {
    const fileIds = Array.isArray(body.fileIds)
      ? body.fileIds.filter((id) => typeof id === "string")
      : [];
    // Server-side scope gate (BEFORE any model call): the assistant is a
    // specialist for Ausbildung Hunter AI. Out-of-scope questions get a
    // short, language-matched redirect — streamed and persisted like any
    // assistant reply, with no model call and no fabricated off-topic answer.
    // The hardened system prompt enforces the same boundary on the model side
    // for every in-scope request.
    const history = await recentMessages(user.id, body.conversationId);
    const scope = decideScope(body.content || "", fileIds.length > 0, history);
    await prepareChat(user.id, body.conversationId, body.content || "", fileIds);
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
      console.info(
        "[ai-chat] out-of-scope request redirected",
        JSON.stringify({ conversationId: body.conversationId, reason: scope.reason }),
      );
      stream = textStream(SCOPE_REDIRECTS[detectUILanguage(body.content || "")]);
    }
    let complete = "";
    let persisted = false;
    const encoder = new TextEncoder();
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
        complete += new TextDecoder().decode(chunk);
        controller.enqueue(chunk);
      },
      async flush(controller) {
        const saved = await persist();
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
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "AI request failed." },
      { status: 400 },
    );
  }
}
