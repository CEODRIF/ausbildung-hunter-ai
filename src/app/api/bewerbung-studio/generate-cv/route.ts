import { NextResponse } from "next/server";
import { provider } from "@/lib/ai-service";
import {
  completeFeatureOp,
  releaseFeatureOp,
  reserveFeatureOp,
} from "@/lib/billing/entitlement-service";
import { checkRateLimit, rateLimitHeaders, tooManyRequests } from "@/lib/rate-limit";
import { buildStudioCandidateContext } from "@/lib/studio";
import {
  collectVerifiedFacts,
  validateGeneratedCv,
} from "@/lib/studio/facts";
import {
  buildCvGenerationPrompt,
  extractSummaryText,
  parseJsonObject,
} from "@/lib/studio/prompts";
import { adExtractSchema } from "@/lib/studio/schema";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { resolveCvTemplateId, sanitizeCvDocument } from "@/lib/templates/cv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * AI Bewerbung Studio — Section D: job-tailored German CV (Lebenslauf).
 *
 * Triple defense against fabrication:
 *  1. prompt contract (only verified facts, empty when unknown);
 *  2. `sanitizeCvDocument` — the output must parse into a valid CvDocument;
 *  3. `validateGeneratedCv` fact guard — every structured value (contacts,
 *     education, jobs, skills, languages, dates) must be grounded in the
 *     verified input; violations → 422 + the reservation is released.
 *
 * Metered on the existing `resume_ai` quota (per cycle).
 */

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const limited = await checkRateLimit("studio_ai", user.id);
  if (!limited.allowed) return tooManyRequests(limited);

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const templateId = resolveCvTemplateId(body.templateId);

  // Advertisement context: prefer the STORED extraction of the referenced
  // application (ownership-checked) over client-supplied JSON.
  let extract = null;
  if (typeof body.applicationId === "string" && body.applicationId) {
    const { data } = await createAdminClient()
      .from("studio_applications")
      .select("ad_extracted")
      .eq("id", body.applicationId)
      .eq("user_id", user.id)
      .maybeSingle();
    const parsed = adExtractSchema.safeParse((data as { ad_extracted?: unknown } | null)?.ad_extracted);
    if (parsed.success) extract = parsed.data;
  }
  if (!extract) {
    const parsed = adExtractSchema.safeParse(body.extract ?? null);
    if (parsed.success) extract = parsed.data;
  }
  if (!extract) {
    return NextResponse.json(
      { error: "Keine Analyse der Anzeige vorhanden — erst die Anzeige analysieren.", code: "no_extract" },
      { status: 400 },
    );
  }

  const runId = crypto.randomUUID();
  const reserved = await reserveFeatureOp(user.id, "resume_ai", runId);
  if (reserved.outcome === "quota_exhausted") {
    return NextResponse.json(
      { error: "Ihr Lebenslauf-AI-Limit ist erreicht.", code: "quota_exhausted" },
      { status: 429 },
    );
  }
  if (reserved.outcome === "feature_disabled") {
    return NextResponse.json(
      { error: "Lebenslauf-Generierung ist mit Ihrem aktuellen Tarif nicht verfügbar.", code: "feature_disabled" },
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
  if (!ctx.cv || !ctx.hasCvContent) {
    await releaseFeatureOp(user.id, "resume_ai", runId);
    return NextResponse.json(
      {
        error: "Ihr Lebenslauf ist leer. Bitte füllen Sie zuerst Ihre Lebenslauf-Daten aus (Vorlage → Lebenslauf).",
        code: "cv_empty",
      },
      { status: 400 },
    );
  }

  const facts = collectVerifiedFacts(ctx.cv, ctx.profile, null);
  const prompt = buildCvGenerationPrompt({
    extractText: extractSummaryText(extract),
    profileText: ctx.profileText,
    cvText: ctx.cvText,
    templateId,
  });

  try {
    const raw = await provider().generateText([{ role: "user", content: prompt }], 120_000);
    const doc = sanitizeCvDocument(parseJsonObject(raw));
    if (!doc) {
      await releaseFeatureOp(user.id, "resume_ai", runId);
      return NextResponse.json(
        { error: "Lebenslauf konnte nicht ausgewertet werden. Bitte erneut versuchen.", code: "invalid_ai_output" },
        { status: 502 },
      );
    }
    // Keep the user's chosen template; the model may not re-style it.
    doc.templateId = templateId;
    const violations = validateGeneratedCv(facts, doc);
    if (violations.length > 0) {
      await releaseFeatureOp(user.id, "resume_ai", runId);
      return NextResponse.json(
        {
          error: "Die generierte Version enthält Angaben, die sich nicht aus Ihren Daten ableiten lassen. Bitte erneut versuchen — andernfalls Ihre Daten prüfen.",
          code: "fact_violations",
          violations: violations.slice(0, 10),
        },
        { status: 422 },
      );
    }
    await completeFeatureOp(user.id, "resume_ai", runId);
    return NextResponse.json({ cv: doc }, { headers: rateLimitHeaders(limited) });
  } catch (error) {
    await releaseFeatureOp(user.id, "resume_ai", runId);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "AI request failed." },
      { status: 400 },
    );
  }
}
