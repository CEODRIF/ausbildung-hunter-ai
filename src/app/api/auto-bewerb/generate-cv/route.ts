import { NextResponse } from "next/server";
import { provider } from "@/lib/ai-service";
import {
  completeFeatureOp,
  releaseFeatureOp,
  reserveFeatureOp,
} from "@/lib/billing/entitlement-service";
import { checkRateLimit, rateLimitHeaders, tooManyRequests } from "@/lib/rate-limit";
import {
  collectVerifiedFacts,
  validateGeneratedCv,
} from "@/lib/studio/facts";
import {
  buildCvGenerationPrompt,
  extractSummaryText,
  parseJsonObject,
} from "@/lib/studio/prompts";
import { formatCvForPrompt, formatProfileForPrompt } from "@/lib/templates/cover-letter";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveCvTemplateId, sanitizeCvDocument } from "@/lib/templates/cv";
import { getAutoBewerbCompany, getAutoBewerbProfile } from "@/lib/auto-bewerb/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * AUTO BEWERB — Step 4: the tailored German CV (Lebenslauf) for ONE company.
 *
 * Inputs: the analyzed CV profile (Step 1, user-corrected), the company's
 * stored ad extraction (Step 2), and the account facts (letterhead). Triple
 * defense against fabrication (identical to the Studio):
 *  1. prompt contract (only verified facts, empty when unknown);
 *  2. `sanitizeCvDocument` — the output must parse into a valid CvDocument;
 *  3. `validateGeneratedCv` fact guard — every structured value must be
 *     grounded in the verified input; violations → 422 + quota released.
 *
 * Metered on the existing `resume_ai` quota (per cycle). The route only
 * RETURNS the document — persistence (per-company versioned row) happens in
 * the saveDocument server action, so regenerating company A never touches
 * company B.
 */

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const limited = await checkRateLimit("auto_bewerb_ai", user.id);
  if (!limited.allowed) return tooManyRequests(limited);

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const templateId = resolveCvTemplateId(body.templateId);
  const companyId = typeof body.companyId === "string" ? body.companyId : "";

  const bundle = companyId ? await getAutoBewerbCompany(user.id, companyId) : null;
  if (!bundle) {
    return NextResponse.json(
      { error: "Bitte zuerst ein Unternehmen mit analysierter Anzeige hinzufügen.", code: "no_company" },
      { status: 400 },
    );
  }
  const extract = bundle.company.ad_extracted;
  if (!extract) {
    return NextResponse.json(
      { error: "Keine Analyse der Anzeige vorhanden — erst die Anzeige analysieren.", code: "no_extract" },
      { status: 400 },
    );
  }

  // The analyzed CV profile is the workflow's single candidate source.
  const profile = await getAutoBewerbProfile(user.id);
  if (!profile?.extracted) {
    return NextResponse.json(
      { error: "Bitte zuerst Ihren Lebenslauf hochladen und prüfen (Schritt 1).", code: "profile_required" },
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

  // Verified facts: the corrected profile + the account's letterhead data.
  const { data: prof } = await createAdminClient()
    .from("profiles")
    .select("full_name, email, phone, city, country")
    .eq("id", user.id)
    .maybeSingle();
  const pr = (prof ?? {}) as Record<string, string | null | undefined>;
  const userFacts = {
    fullName: pr.full_name ?? null,
    email: pr.email ?? null,
    phone: pr.phone ?? null,
    location: pr.city ?? null,
    linkedin: null, // no linkedin column on profiles — the profile (Step 1) is the source
  };
  const facts = collectVerifiedFacts(null, profile.extracted, userFacts);
  const prompt = buildCvGenerationPrompt({
    extractText: extractSummaryText(extract),
    profileText: formatProfileForPrompt(profile.extracted),
    cvText: formatCvForPrompt(null),
    templateId,
  });

  try {
    const raw = await provider().generateText([{ role: "user", content: prompt }], 120_000, {
      temperature: 0,
    });
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
