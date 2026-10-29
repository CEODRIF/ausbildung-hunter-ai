import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { provider } from "@/lib/ai-service";
import {
  completeFeatureOp,
  releaseFeatureOp,
  reserveFeatureOp,
} from "@/lib/billing/entitlement-service";
import { checkRateLimit, rateLimitHeaders, tooManyRequests } from "@/lib/rate-limit";
import { buildStudioCandidateContext, getStudioApplication } from "@/lib/studio";
import {
  AD_TEXT_MAX_LENGTH,
  adAnalysisSchema,
  adExtractSchema,
  studioAdTextSchema,
  type AdAnalysis,
  type AdExtract,
} from "@/lib/studio/schema";
import {
  AD_ANALYSIS_SYSTEM_PROMPT,
  buildAdAnalysisPrompt,
  parseJsonObject,
} from "@/lib/studio/prompts";
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
 *
 * SPEED CONTRACT (measured: the provider call dominates — everything else
 * is single-digit ms):
 *  - REUSE: for a known application, an unchanged ad + unchanged CV context
 *    (fingerprint stored at creation) returns the STORED analysis — zero
 *    provider calls, zero quota. A retried/accidental re-analysis is free.
 *  - SINGLE-FLIGHT: concurrent identical requests share ONE in-flight
 *    provider call (per process; each user operation is still metered).
 *  - BOUNDED RETRY: an invalid model answer triggers exactly ONE internal
 *    nudge retry within the same quota op (max 2 provider calls).
 *  - DETERMINISM + SIZE: temperature 0, a compact task-specific system
 *    prompt (security contract preserved), and prompt-level output bounds.
 */

const outputSchema = z.object({
  extract: adExtractSchema,
  analysis: adAnalysisSchema,
});

/** The model broke its output contract (after the bounded retry). */
class InvalidModelOutput extends Error {
  constructor() {
    super("invalid_ai_output");
    this.name = "InvalidModelOutput";
  }
}

/** In-flight single-flight table: identical concurrent requests share ONE
 *  provider call. Keyed per user (results embed user-specific CV/profile
 *  context — never share across users). */
const inFlight = new Map<string, Promise<{ extract: AdExtract; analysis: AdAnalysis }>>();

const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");

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
  const applicationId = typeof body.applicationId === "string" ? body.applicationId : null;
  // CV-context fingerprint: the CLIENT hashes exactly this (baseCv) object at
  // creation time into profile_snapshot.cvHash; a JSON round-trip preserves
  // key order, so both sides produce the same string.
  const cvHash = body.cv ? sha256Hex(JSON.stringify(body.cv)) : null;

  // REUSE — same application + unchanged ad + unchanged CV context:
  // return the stored, previously zod-validated result. No provider call,
  // no quota reservation (a free read is not a paid op).
  if (applicationId) {
    const stored = await getStudioApplication(user.id, applicationId);
    if (stored) {
      const snap = stored.app.profile_snapshot as { cvHash?: unknown } | null;
      const storedHash = typeof snap?.cvHash === "string" ? snap.cvHash : null;
      const cvContextMatches = storedHash !== null ? storedHash === cvHash : cvHash === null;
      const extractValid =
        stored.app.ad_extracted !== null &&
        stored.app.ad_extracted !== undefined &&
        adExtractSchema.safeParse(stored.app.ad_extracted).success;
      const analysisValid =
        stored.app.ad_analysis !== null &&
        stored.app.ad_analysis !== undefined &&
        adAnalysisSchema.safeParse(stored.app.ad_analysis).success;
      const adUnchanged = stored.app.ad_raw?.trim() === adCheck.data.trim();
      if (extractValid && analysisValid && cvContextMatches && adUnchanged) {
        return NextResponse.json(
          {
            extract: stored.app.ad_extracted,
            analysis: stored.app.ad_analysis,
            reused: true,
          },
          { headers: rateLimitHeaders(limited) },
        );
      }
    }
  }

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

  // SINGLE-FLIGHT: identical in-flight requests (same user, same ad, same CV
  // context, same prefill) share ONE provider call. Best effort per process
  // instance — it deduplicates, it never makes correctness depend on state.
  const sfKey = sha256Hex(`${user.id}\u0000${adCheck.data}\u0000${cvHash ?? "∅"}\u0000${prefill ?? ""}`);
  let work = inFlight.get(sfKey);
  if (!work) {
    work = (async () => {
      // BOUNDED RETRY: one nudge attempt when the model breaks its JSON
      // contract (max 2 provider calls per user operation, same quota op).
      for (let attempt = 0; ; attempt++) {
        const messages: Array<{ role: "user"; content: string }> = [
          {
            role: "user",
            content:
              attempt === 0
                ? prompt
                : `${prompt}\n\nWICHTIG: Deine vorherige Antwort war kein gültiges JSON-Objekt. Gib NUR das JSON-Objekt aus — ohne Markdown, ohne Anführungszeichen, ohne Kommentar.`,
          },
        ];
        const raw = await provider().generateText(messages, 120_000, {
          temperature: 0,
          systemPrompt: AD_ANALYSIS_SYSTEM_PROMPT,
        });
        const checked = outputSchema.safeParse(parseJsonObject(raw));
        if (checked.success) return checked.data;
        if (attempt >= 1) throw new InvalidModelOutput();
      }
    })();
    inFlight.set(sfKey, work);
  }

  try {
    const data = await work;
    await completeFeatureOp(user.id, "ai_assistant", runId);
    return NextResponse.json(
      { extract: data.extract, analysis: data.analysis, reused: false },
      { headers: rateLimitHeaders(limited) },
    );
  } catch (error) {
    await releaseFeatureOp(user.id, "ai_assistant", runId);
    if (error instanceof InvalidModelOutput) {
      // The model broke its output contract (twice) — refund and report a
      // stable error (never expose model internals or raw output).
      return NextResponse.json(
        { error: "Analyse konnte nicht ausgewertet werden. Bitte erneut versuchen.", code: "invalid_ai_output" },
        { status: 502 },
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "AI request failed." },
      { status: 400 },
    );
  } finally {
    // Drop the entry once EVERY joiner has settled (identity check: a later
    // identical request re-registered a new promise for the same key).
    if (inFlight.get(sfKey) === work) inFlight.delete(sfKey);
  }
}
