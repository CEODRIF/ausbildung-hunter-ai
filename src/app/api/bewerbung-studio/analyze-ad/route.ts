import { NextResponse } from "next/server";
import { z } from "zod";
import { provider } from "@/lib/ai-service";
import {
  completeFeatureOp,
  releaseFeatureOp,
  reserveFeatureOp,
} from "@/lib/billing/entitlement-service";
import { checkRateLimit, rateLimitHeaders, tooManyRequests } from "@/lib/rate-limit";
import { buildStudioCandidateContext } from "@/lib/studio";
import {
  AD_TEXT_MAX_LENGTH,
  adAnalysisSchema,
  adExtractSchema,
  studioAdTextSchema,
} from "@/lib/studio/schema";
import { buildAdAnalysisPrompt, parseJsonObject } from "@/lib/studio/prompts";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * AI Bewerbung Studio — Section B: advertisement analysis + profile match.
 *
 * Metered on the existing `ai_assistant` daily quota (one analysis = one AI
 * request). The advertisement is untrusted input: it is fenced as data in
 * the prompt and the answer is zod-validated before it is returned or
 * persisted. A failed/invalid generation releases the reservation (failed
 * ops cost nothing).
 */

const outputSchema = z.object({
  extract: adExtractSchema,
  analysis: adAnalysisSchema,
});

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const limited = await checkRateLimit("studio_ai", user.id);
  if (!limited.allowed) return tooManyRequests(limited);

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const adText = typeof body.adText === "string" ? body.adText.slice(0, AD_TEXT_MAX_LENGTH) : "";
  const adCheck = studioAdTextSchema.safeParse(adText);
  if (!adCheck.success) {
    return NextResponse.json(
      { error: "Die Stellenanzeige ist zu kurz oder ungültig. Bitte den vollständigen Text einfügen.", code: "invalid_ad_text" },
      { status: 400 },
    );
  }
  const prefill = typeof body.prefill === "string" ? body.prefill.slice(0, 2_000) : undefined;

  const runId = crypto.randomUUID();
  const reserved = await reserveFeatureOp(user.id, "ai_assistant", runId);
  if (reserved.outcome === "quota_exhausted") {
    return NextResponse.json(
      { error: "Ihr tägliches AI-Limit ist erreicht. Es setzt sich um 00:00 UTC neu.", code: "quota_exhausted" },
      { status: 429 },
    );
  }
  if (reserved.outcome === "feature_disabled") {
    return NextResponse.json(
      { error: "AI-Analyse ist mit Ihrem aktuellen Tarif nicht verfügbar.", code: "feature_disabled" },
      { status: 403 },
    );
  }
  if (reserved.outcome === "error") {
    return NextResponse.json(
      { error: reserved.message ?? "Quota service temporarily unavailable.", code: "quota_unavailable" },
      { status: 503 },
    );
  }

  const ctx = await buildStudioCandidateContext(user.id, body.cv, null);
  const prompt = buildAdAnalysisPrompt({
    adText: adCheck.data,
    profileText: ctx.profileText,
    cvText: ctx.cvText,
    prefillText: prefill,
  });

  try {
    const raw = await provider().generateText([{ role: "user", content: prompt }], 120_000);
    const parsed = parseJsonObject(raw);
    const checked = outputSchema.safeParse(parsed);
    if (!checked.success) {
      // The model broke its output contract — refund and report a stable
      // error (never expose model internals or raw output).
      await releaseFeatureOp(user.id, "ai_assistant", runId);
      return NextResponse.json(
        { error: "Analyse konnte nicht ausgewertet werden. Bitte erneut versuchen.", code: "invalid_ai_output" },
        { status: 502 },
      );
    }
    await completeFeatureOp(user.id, "ai_assistant", runId);
    return NextResponse.json(
      { extract: checked.data.extract, analysis: checked.data.analysis },
      { headers: rateLimitHeaders(limited) },
    );
  } catch (error) {
    await releaseFeatureOp(user.id, "ai_assistant", runId);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "AI request failed." },
      { status: 400 },
    );
  }
}
