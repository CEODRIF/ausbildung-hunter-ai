/**
 * Chat route resume metering (P0 quota audit 2026-10-25, R2): the ONLY
 * resume-generation entry point is the AI chat, and resume requests must be
 * metered against the dedicated `resume_ai` quota — reserve BEFORE any model
 * call, complete only on delivered content, release on every failure path,
 * and never ride the general AI quota. Same architecture as the existing
 * cover-letter suite.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));
vi.mock("@/lib/billing/entitlement-service", () => ({
  reserveFeatureOp: vi.fn(),
  completeFeatureOp: vi.fn(),
  releaseFeatureOp: vi.fn(),
}));
vi.mock("@/lib/ai-service", () => ({
  prepareChat: vi.fn(),
  provider: vi.fn(),
  recentMessages: vi.fn(async () => []),
  saveAssistantMessage: vi.fn(async () => ({ id: "msg-1" })),
}));
vi.mock("@/lib/ai-context", () => ({
  getAIContext: vi.fn(async () => ({ messages: [] })),
}));
vi.mock("@/lib/germany-research", () => ({
  researchGermany: vi.fn(async () => ({
    searched: false,
    reason: "failed",
    query: "",
    results: [],
  })),
}));
// The REAL ai-scope (the detector under test) also imports
// hasGermanySignal from this module — keep every other original export.
vi.mock("@/lib/germany-knowledge", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/germany-knowledge")>();
  return { ...orig, buildSearchContextBlock: vi.fn(() => "") };
});
vi.mock("@/lib/rate-limit", async () => {
  const { NextResponse } = await import("next/server");
  return {
    checkRateLimit: vi.fn(),
    rateLimitHeaders: vi.fn(() => ({ "x-ratelimit-remaining": "8" })),
    tooManyRequests: vi.fn(() =>
      NextResponse.json({ error: "RATE_LIMITED_MARKER" }, { status: 429 }),
    ),
  };
});

const { createClient } = await import("@/lib/supabase/server");
const { prepareChat, provider } = await import("@/lib/ai-service");
const { reserveFeatureOp, completeFeatureOp, releaseFeatureOp } =
  await import("@/lib/billing/entitlement-service");
const { checkRateLimit } = await import("@/lib/rate-limit");

const authClient = createClient as unknown as ReturnType<typeof vi.fn>;
const reserve = reserveFeatureOp as unknown as ReturnType<typeof vi.fn>;
const complete = completeFeatureOp as unknown as ReturnType<typeof vi.fn>;
const release = releaseFeatureOp as unknown as ReturnType<typeof vi.fn>;
const prepare = prepareChat as unknown as ReturnType<typeof vi.fn>;
const streamText = vi.fn();

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function authed(userId: string) {
  authClient.mockResolvedValue({
    auth: { getUser: async () => ({ data: { user: { id: userId } } }) },
  } as never);
}

async function postChat(body: Record<string, unknown>) {
  const { POST } = await import("@/app/api/ai/chat/route");
  return POST(
    new Request("http://localhost/api/ai/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

/** Consume the streamed response so the transformer's flush runs (persist +
 *  quota settlement happen there). */
async function consume(res: Response) {
  await res.text();
}

const RESUME_MSG =
  "Schreib mir einen Lebenslauf für meine Bewerbung als Fachinformatiker";

beforeEach(() => {
  vi.clearAllMocks();
  authed("u1");
  (checkRateLimit as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    allowed: true,
    limit: 20,
    remaining: 9,
    retryAfterMs: 0,
  });
  (provider as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    streamText,
  });
  reserve.mockResolvedValue({ outcome: "reserved" });
  complete.mockResolvedValue({ outcome: "completed" });
  release.mockResolvedValue({ outcome: "released" });
  prepare.mockResolvedValue(undefined);
  streamText.mockReturnValue(streamOf(["LEBENSLAUF_TEIL_1 ", "TEIL_2"]));
});

describe("POST /api/ai/chat — resume_ai quota cycle (R2)", () => {
  it("resume request → reserves resume_ai (NOT ai_assistant), completes only after delivery", async () => {
    const res = await postChat({ conversationId: "c1", content: RESUME_MSG });
    expect(res.status).toBe(200);
    await consume(res);

    expect(reserve).toHaveBeenCalledTimes(1);
    expect(reserve.mock.calls[0][0]).toBe("u1");
    expect(reserve.mock.calls[0][1]).toBe("resume_ai");
    expect(reserve.mock.calls[0][2]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    // The general AI reservation is skipped for dedicated features.
    expect(prepare).toHaveBeenCalledWith("u1", "c1", RESUME_MSG, [], {
      skipAiReservation: true,
    });
    // Content was delivered → the operation is FINAL (consumed).
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0][1]).toBe("resume_ai");
    expect(release).not.toHaveBeenCalled();
  });

  it("quota_exhausted → exact 429 resume body; model and prepareChat NEVER run", async () => {
    reserve.mockResolvedValue({ outcome: "quota_exhausted" });
    const res = await postChat({
      conversationId: "c1",
      content: "Write a resume for me",
    });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      error: "Resume limit reached for your current plan period.",
      code: "quota_exhausted",
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(streamText).not.toHaveBeenCalled();
  });

  it("feature_disabled (no plan capacity) → 403 resume body, model never called", async () => {
    reserve.mockResolvedValue({ outcome: "feature_disabled" });
    const res = await postChat({
      conversationId: "c1",
      content: "Improve my CV",
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "Resume AI is not available on your current plan.",
      code: "feature_disabled",
    });
    expect(streamText).not.toHaveBeenCalled();
  });

  it("quota service failure → 503 fail-closed, model never called", async () => {
    reserve.mockResolvedValue({
      outcome: "error",
      message: "Feature quota is unavailable.",
    });
    const res = await postChat({
      conversationId: "c1",
      content: "Analysiere meinen Lebenslauf",
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("quota_unavailable");
    expect(streamText).not.toHaveBeenCalled();
  });

  it("model failure BEFORE any delivery → the resume reservation is RELEASED (no charge)", async () => {
    streamText.mockRejectedValue(new Error("model down"));
    const res = await postChat({
      conversationId: "c1",
      content: "Generate a resume",
    });
    expect(res.status).toBe(400);
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(release.mock.calls[0][1]).toBe("resume_ai");
    expect(complete).not.toHaveBeenCalled();
  });

  it("EMPTY stream (nothing delivered) → released, not completed", async () => {
    streamText.mockReturnValue(streamOf([]));
    const res = await postChat({
      conversationId: "c1",
      content: "Draft my resume please",
    });
    expect(res.status).toBe(200);
    await consume(res);
    expect(complete).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    expect(release.mock.calls[0][1]).toBe("resume_ai");
  });

  it("regular chat is NOT metered on resume_ai (general AI path untouched)", async () => {
    const res = await postChat({
      conversationId: "c1",
      content: "Was kostet eine Ausbildung in Deutschland?",
    });
    expect(res.status).toBe(200);
    await consume(res);
    expect(reserve).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(prepare).toHaveBeenCalledWith(
      "u1",
      "c1",
      "Was kostet eine Ausbildung in Deutschland?",
      [],
      { skipAiReservation: false },
    );
  });

  it("a message matching BOTH patterns → cover_letter precedence (existing behavior kept)", async () => {
    const res = await postChat({
      conversationId: "c1",
      content:
        "Schreib mir ein Anschreiben und einen Lebenslauf für meine Bewerbung",
    });
    expect(res.status).toBe(200);
    await consume(res);
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(reserve.mock.calls[0][1]).toBe("cover_letter");
  });
});
