import { NextResponse } from "next/server";
import { provider } from "@/lib/ai-service";
import {
  completeFeatureOp,
  releaseFeatureOp,
  reserveFeatureOp,
} from "@/lib/billing/entitlement-service";
import { checkRateLimit, rateLimitHeaders, tooManyRequests } from "@/lib/rate-limit";
import { parseJsonObject } from "@/lib/studio/prompts";
import { formatProfileForPrompt } from "@/lib/templates/cover-letter";
import { createClient } from "@/lib/supabase/server";
import { importCandidateProfileToCv, resolveCvTemplateId } from "@/lib/templates/cv";
import { collectAddableSkillTerms, verifyCvAgainstAd } from "@/lib/auto-bewerb/cv-verification";
import { mergeTailoredCvDocument } from "@/lib/auto-bewerb/tailored-cv";
import {
  AUTO_BEWERB_CV_SYSTEM_PROMPT,
  buildAutoBewerbCvPrompt,
} from "@/lib/auto-bewerb/prompts";
import {
  getAutoBewerbCompany,
  getAutoBewerbProfile,
  getAutoBewerbProfilePhotoRef,
} from "@/lib/auto-bewerb/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * AUTO BEWERB — Step 4: the tailored German CV (Lebenslauf) for ONE company.
 *
 * Company-specific generation (the quality fix): the prompt is built from
 * the company's STORED, zod-validated ad context — full extraction +
 * profile match analysis + the complete (fenced) advertisement text — so
 * every employer gets a distinct, genuinely tailored document grounded in
 * the verified candidate profile (never a generic CV with the name swapped).
 *
 * Defense in depth:
 *  1. prompt contract (only verified facts; dates verbatim; photo always
 *     null — the PLATFORM freezes the uploaded profile-photo reference
 *     into the document after generation, the model never sees an image);
 *  2. `mergeTailoredCvDocument` — the CONTROLLED TRANSFORMATION: the
 *     candidate's original CV (deterministic import of the parsed upload)
 *     is the base, and ONLY the four tailored sections (PROFIL → summary,
 *     KENNTNISSE + EDV-KENNTNISSE → skills, HOBBYS → interests) are taken
 *     from the model output — grounded to the candidate's own facts,
 *     de-duplicated, complete. Every other field is copied 1:1 from the
 *     original, so the non-tailored sections are protected in CODE, not
 *     only by the prompt (see tailored-cv.ts).
 * Provider/quota/network failures still surface their real error.
 *
 * SINGLE-FLIGHT per (user, company): identical concurrent requests
 * (double click, two tabs) share ONE paid provider call (same pattern as
 * analyze-ad) — duplicate concurrent generation is prevented.
 *
 * Metered on the existing `resume_ai` quota (per cycle). The route only
 * RETURNS the document — persistence (per-company versioned row) happens in
 * the saveDocument server action, so regenerating company A never touches
 * company B.
 */

// In-flight single-flight table: one provider call per (user, company).
// Keyed per user+company — results embed user-specific profile context and
// company-specific ad context (never shared across either axis).
const inFlight = new Map<string, Promise<string>>();

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

  // The uploaded profile photo (frozen into the document BELOW, never seen
  // by the model). Missing/unsupported → null: generation always works.
  const photoRef = await getAutoBewerbProfilePhotoRef(user.id);

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

  // The verified candidate facts, formatted exactly as the model sees
  // them — also the ONLY allowed source the platform accepts for new
  // skills/hobbies in the controlled transformation below.
  const profileText = formatProfileForPrompt(profile.extracted);
  const prompt = buildAutoBewerbCvPrompt({
    extract,
    analysis: bundle.company.ad_analysis,
    adRaw: bundle.company.ad_raw,
    profileText,
    templateId,
  });

  const sfKey = `${user.id}\u0000${companyId}`;
  let work = inFlight.get(sfKey);
  if (!work) {
    work = (async () => {
      try {
        return await provider().generateText([{ role: "user", content: prompt }], 120_000, {
          temperature: 0,
          systemPrompt: AUTO_BEWERB_CV_SYSTEM_PROMPT,
        });
      } finally {
        // Drop the entry once the work has settled (identity check: a later
        // identical request may have registered a NEW promise).
        if (inFlight.get(sfKey) === work) inFlight.delete(sfKey);
      }
    })();
    inFlight.set(sfKey, work);
  }

  try {
    const raw = await work;
    // CONTROLLED TRANSFORMATION (defense in depth — the prompt alone never
    // protected the non-tailored fields): the candidate's ORIGINAL CV
    // (deterministic import of the parsed upload) is the base; the
    // platform copies ONLY the four tailored sections (PROFIL / KENNTNISSE
    // / EDV-KENNTNISSE / HOBBYS) from the model output — grounded to the
    // candidate's own facts, de-duplicated, complete — and keeps every
    // other field 1:1 (see tailored-cv.ts).
    const original = importCandidateProfileToCv(profile.extracted);
    // AD-SIDE TAILORING INPUT (all values from the stored, zod-validated
    // extraction of THIS company's ad — never from the model):
    //  - skillTerms: the skill-like requirements (technical + soft +
    //    skill-like qualifications; education/experience/language claims
    //    filtered out) — every one missing from the CV is auto-added and
    //    flagged in `cv.tailoring.addedFromAd`,
    //  - summaryContext: the position identity (job title, occupation,
    //    company, location, start) — the only ad content the PROFIL may
    //    name (grounded by the ad, not by the candidate profile).
    const doc = mergeTailoredCvDocument({
      original,
      generated: parseJsonObject(raw),
      profileText,
      ad: {
        skillTerms: collectAddableSkillTerms(extract),
        summaryContext: {
          jobTitle: extract.jobTitle,
          occupation: extract.occupation,
          company: extract.company,
          location: extract.location,
          startDate: extract.startDate,
        },
      },
    });
    if (!doc) {
      await releaseFeatureOp(user.id, "resume_ai", runId);
      return NextResponse.json(
        { error: "Lebenslauf konnte nicht ausgewertet werden. Bitte erneut versuchen.", code: "invalid_ai_output" },
        { status: 502 },
      );
    }
    // Keep the user's chosen template; the model may not re-style it.
    doc.templateId = templateId;
    // The uploaded profile photo is frozen into the document by the
    // PLATFORM (server-owned reference, ownership-resolved at render time) —
    // the model's answer for personal.photo is never trusted.
    doc.personal.photo = photoRef;
    // FINAL VERIFICATION (deterministic, no LLM): the per-requirement
    // coverage report of THIS final document — the Step-4 preview shows it
    // before any export (the export path renders the same stored document).
    const verification = verifyCvAgainstAd({ cv: doc, extract });
    await completeFeatureOp(user.id, "resume_ai", runId);
    return NextResponse.json(
      { cv: doc, photo: photoRef, verification },
      { headers: rateLimitHeaders(limited) },
    );
  } catch (error) {
    await releaseFeatureOp(user.id, "resume_ai", runId);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "AI request failed." },
      { status: 400 },
    );
  }
}
