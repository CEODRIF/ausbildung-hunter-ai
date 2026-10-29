import { NextResponse } from "next/server";
import { z } from "zod";
import { provider } from "@/lib/ai-service";
import {
  completeFeatureOp,
  releaseFeatureOp,
  reserveFeatureOp,
} from "@/lib/billing/entitlement-service";
import { checkRateLimit, rateLimitHeaders, tooManyRequests } from "@/lib/rate-limit";
import { formatProfileForPrompt } from "@/lib/templates/cover-letter";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  buildAutoBewerbLetterPrompt,
  fenceAdText,
  AUTO_BEWERB_LETTER_SYSTEM_PROMPT,
} from "@/lib/auto-bewerb/prompts";
import { autoBewerbLetterSchema } from "@/lib/auto-bewerb/schema";
import { getAutoBewerbCompany, getAutoBewerbProfile } from "@/lib/auto-bewerb/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * AUTO BEWERB — Step 5: the individualized Anschreiben for ONE company.
 *
 * Inputs: the analyzed + corrected profile (Step 1), the company's stored
 * ad extraction + the RAW ad text (Step 2, fenced as untrusted data), and
 * the contact person's name when the ad reliably names one. The model may
 * only use provided facts — unknown details are omitted or flagged with
 * [bitte ergänzen: …], never invented (prompt contract + zod validation).
 *
 * The output is the COMPLETE German letter (greeting … body … closing …
 * signature line) — the shape the deterministic PDF folio renderer and the
 * DIN-5008 preview both expect.
 *
 * Metered on the existing `cover_letter` quota. The route only RETURNS the
 * letter — persistence (per-company versioned row) happens in the
 * saveDocument server action, so regenerating one company never overwrites
 * another company's letter.
 */

/** Plain-text letter output → normalized text (strip fences/quotes the
 *  model sometimes wraps its answer in). */
function normalizeLetterText(raw: string): string {
  let text = raw.trim();
  const fenced = text.match(/^```(?:[a-z]+)?\s*([\s\S]*?)```$/i);
  if (fenced) text = fenced[1].trim();
  if (
    (text.startsWith('"') && text.endsWith('"') && text.length > 2) ||
    (text.startsWith("„") && text.endsWith("“"))
  ) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

const currentTextSchema = z.string().trim().max(16_000);

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
  const currentText = currentTextSchema.safeParse(typeof body.currentText === "string" ? body.currentText : "");
  const current = currentText.success && currentText.data ? currentText.data : undefined;

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

  const profile = await getAutoBewerbProfile(user.id);
  if (!profile?.extracted) {
    return NextResponse.json(
      { error: "Bitte zuerst Ihren Lebenslauf hochladen und prüfen (Schritt 1).", code: "profile_required" },
      { status: 400 },
    );
  }

  const runId = crypto.randomUUID();
  const reserved = await reserveFeatureOp(user.id, "cover_letter", runId);
  if (reserved.outcome === "quota_exhausted") {
    return NextResponse.json(
      { error: "Ihr Anschreiben-AI-Limit ist erreicht.", code: "quota_exhausted" },
      { status: 429 },
    );
  }
  if (reserved.outcome === "feature_disabled") {
    return NextResponse.json(
      { error: "Anschreiben-Generierung ist mit Ihrem aktuellen Tarif nicht verfügbar.", code: "feature_disabled" },
      { status: 403 },
    );
  }
  if (reserved.outcome === "error") {
    return NextResponse.json(
      { error: reserved.message ?? "Quota service temporarily unavailable.", code: "quota_unavailable" },
      { status: 503 },
    );
  }

  // Signature line: the corrected profile's name, falling back to the
  // account's verified name — never invented.
  const profileName = profile.extracted.candidate?.full_name?.trim() ?? "";
  let accountName = "";
  const { data: prof } = await createAdminClient()
    .from("profiles")
    .select("full_name")
    .eq("id", user.id)
    .maybeSingle();
  accountName = String((prof as { full_name?: string } | null)?.full_name ?? "").trim();
  const candidateName = profileName || accountName;

  const prompt = buildAutoBewerbLetterPrompt({
    profileText: formatProfileForPrompt(profile.extracted),
    adFenced: fenceAdText(bundle.company.ad_raw),
    extract,
    candidateName,
    currentText: current,
  });

  try {
    const raw = await provider().generateText(
      [{ role: "user", content: prompt }],
      120_000,
      { temperature: 0.3, systemPrompt: AUTO_BEWERB_LETTER_SYSTEM_PROMPT },
    );
    const text = normalizeLetterText(raw);
    const checked = autoBewerbLetterSchema.safeParse({ text, tone: "professional" });
    if (!checked.success) {
      await releaseFeatureOp(user.id, "cover_letter", runId);
      return NextResponse.json(
        { error: "Das Anschreiben konnte nicht ausgewertet werden. Bitte erneut versuchen.", code: "invalid_ai_output" },
        { status: 502 },
      );
    }
    await completeFeatureOp(user.id, "cover_letter", runId);
    return NextResponse.json({ letter: checked.data }, { headers: rateLimitHeaders(limited) });
  } catch (error) {
    await releaseFeatureOp(user.id, "cover_letter", runId);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "AI request failed." },
      { status: 400 },
    );
  }
}
