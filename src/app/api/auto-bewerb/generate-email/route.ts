import { NextResponse } from "next/server";
import { z } from "zod";
import { provider } from "@/lib/ai-service";
import {
  completeFeatureOp,
  releaseFeatureOp,
  reserveFeatureOp,
} from "@/lib/billing/entitlement-service";
import { checkRateLimit, rateLimitHeaders, tooManyRequests } from "@/lib/rate-limit";
import { buildEmailDraftPrompt, parseJsonObject } from "@/lib/studio/prompts";
import { studioEmailDraftSchema } from "@/lib/studio/schema";
import { formatProfileForPrompt } from "@/lib/templates/cover-letter";
import { createClient } from "@/lib/supabase/server";
import { getAutoBewerbCompany, getLatestAutoBewerbDocument, getAutoBewerbProfile } from "@/lib/auto-bewerb/engine";
import { autoBewerbLetterSchema } from "@/lib/auto-bewerb/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * AUTO BEWERB — Step 6: AI draft for the application email (subject + body).
 *
 * The draft is a SUGGESTION for one of two places, chosen by the user in the
 * UI:
 *  - the SHARED email-body template (one row per user, tokenized), or
 *  - the per-company subject + body override.
 * This route never persists — the server actions do — so "keep the shared
 * body consistent unless deliberately changed" holds by construction.
 *
 * Metered on the existing `email_drafts` quota.
 */

const attachmentNamesSchema = z.array(z.string().trim().max(255)).max(10);

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const limited = await checkRateLimit("auto_bewerb_ai", user.id);
  if (!limited.allowed) return tooManyRequests(limited);

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const companyId = typeof body.companyId === "string" ? body.companyId : "";
  const attachmentNames = attachmentNamesSchema.safeParse(body.attachmentNames ?? []).success
    ? (attachmentNamesSchema.parse(body.attachmentNames) as string[])
    : [];

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

  // Motivation excerpt from the REVIEWED letter (when present) — the email
  // must not copy the letter, only reflect its motivation.
  let letterExcerpt = "";
  const letterDoc = await getLatestAutoBewerbDocument(user.id, bundle.company.id, "cover_letter");
  const letter = letterDoc ? autoBewerbLetterSchema.safeParse(letterDoc.content) : null;
  if (letter?.success) letterExcerpt = letter.data.text.slice(0, 400);

  const runId = crypto.randomUUID();
  const reserved = await reserveFeatureOp(user.id, "email_drafts", runId);
  if (reserved.outcome === "quota_exhausted") {
    return NextResponse.json(
      { error: "Ihr E-Mail-AI-Limit ist erreicht.", code: "quota_exhausted" },
      { status: 429 },
    );
  }
  if (reserved.outcome === "feature_disabled") {
    return NextResponse.json(
      { error: "E-Mail-Entwürfe sind mit Ihrem aktuellen Tarif nicht verfügbar.", code: "feature_disabled" },
      { status: 403 },
    );
  }
  if (reserved.outcome === "error") {
    return NextResponse.json(
      { error: reserved.message ?? "Quota service temporarily unavailable.", code: "quota_unavailable" },
      { status: 503 },
    );
  }

  // The candidate context keeps the email consistent with the real profile
  // (the closing name is conventional — the model must not invent a name).
  const profile = await getAutoBewerbProfile(user.id);

  const prompt = buildEmailDraftPrompt({
    company: extract.company,
    jobTitle: extract.jobTitle || extract.occupation,
    contactPerson: extract.contactPerson,
    applicationMethod: extract.applicationMethod,
    letterExcerpt,
    attachmentNames,
  }) + `\n\n${formatProfileForPrompt(profile?.extracted ?? null)}`;

  try {
    const raw = await provider().generateText([{ role: "user", content: prompt }], 90_000);
    const parsed = studioEmailDraftSchema.safeParse(parseJsonObject(raw));
    if (!parsed.success) {
      await releaseFeatureOp(user.id, "email_drafts", runId);
      return NextResponse.json(
        { error: "E-Mail-Entwurf konnte nicht ausgewertet werden. Bitte erneut versuchen.", code: "invalid_ai_output" },
        { status: 502 },
      );
    }
    await completeFeatureOp(user.id, "email_drafts", runId);
    return NextResponse.json(parsed.data, { headers: rateLimitHeaders(limited) });
  } catch (error) {
    await releaseFeatureOp(user.id, "email_drafts", runId);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "AI request failed." },
      { status: 400 },
    );
  }
}
