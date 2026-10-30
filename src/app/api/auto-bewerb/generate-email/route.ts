import { NextResponse } from "next/server";
import { z } from "zod";
import { provider } from "@/lib/ai-service";
import {
  completeFeatureOp,
  releaseFeatureOp,
  reserveFeatureOp,
} from "@/lib/billing/entitlement-service";
import { checkRateLimit, rateLimitHeaders, tooManyRequests } from "@/lib/rate-limit";
import { parseJsonObject } from "@/lib/studio/prompts";
import { studioEmailDraftSchema } from "@/lib/studio/schema";
import { formatProfileForPrompt } from "@/lib/templates/cover-letter";
import { buildAutoBewerbEmailTemplatePrompt } from "@/lib/auto-bewerb/prompts";
import { createClient } from "@/lib/supabase/server";
import { getAutoBewerbProfile } from "@/lib/auto-bewerb/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * AUTO BEWERB — Step 6: AI draft for the SHARED application e-mail template.
 *
 * ONE reusable, tokenized ({company} / {position} / {contactName}) German
 * e-mail template per user — the result is a SUGGESTION for the global
 * template, applied to EVERY company (incl. newly added ones). This route
 * therefore takes NO company input: the template must stay company-neutral,
 * and the per-company facts are substituted by the send engine at send time
 * (missing values stay empty — nothing is invented).
 *
 * The server never persists — the UI puts the draft into the template
 * editor and the user saves it explicitly. Metered on the existing
 * `email_drafts` quota.
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
  // One parse, fallback [] — a missing/invalid field is simply "no shared
  // documents", never a crash (the template prompt degrades gracefully).
  const parsedNames = attachmentNamesSchema.safeParse(body.attachmentNames ?? []);
  const sharedAttachmentNames = parsedNames.success ? parsedNames.data : [];

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

  // The verified candidate profile grounds the motivation — never invented
  // facts (a missing profile yields an explicit "no data" marker).
  const profile = await getAutoBewerbProfile(user.id);

  const prompt =
    buildAutoBewerbEmailTemplatePrompt({ sharedAttachmentNames }) +
    `\n\n${formatProfileForPrompt(profile?.extracted ?? null)}`;

  try {
    const raw = await provider().generateText([{ role: "user", content: prompt }], 90_000);
    const parsed = studioEmailDraftSchema.safeParse(parseJsonObject(raw));
    if (!parsed.success) {
      await releaseFeatureOp(user.id, "email_drafts", runId);
      return NextResponse.json(
        { error: "E-Mail-Vorlage konnte nicht ausgewertet werden. Bitte erneut versuchen.", code: "invalid_ai_output" },
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
