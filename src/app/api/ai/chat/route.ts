import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  getAIContext,
  prepareChat,
  provider,
  saveAssistantMessage,
} from "@/lib/ai-service";
import {
  checkRateLimit,
  rateLimitHeaders,
  tooManyRequests,
} from "@/lib/rate-limit";

export const runtime = "nodejs";
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
    await prepareChat(
      user.id,
      body.conversationId,
      body.content || "",
      Array.isArray(body.fileIds)
        ? body.fileIds.filter((id) => typeof id === "string")
        : [],
    );
    const context = await getAIContext(user.id, body.conversationId);
    const stream = await provider().streamText(context.messages);
    let complete = "";
    const transformed = stream.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          complete += new TextDecoder().decode(chunk);
          controller.enqueue(chunk);
        },
        async flush() {
          try {
            await saveAssistantMessage(user.id, body.conversationId!, complete);
          } catch {
            /* response already streamed; monitor can retry persistence */
          }
        },
      }),
    );
    return new Response(transformed, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-cache",
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
