import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AIProviderError } from "@/lib/ai-provider";
import { provider } from "@/lib/ai-service";
import {
  completeFeatureOp,
  releaseFeatureOp,
  reserveFeatureOp,
} from "@/lib/billing/entitlement-service";
import { checkRateLimit, rateLimitHeaders, tooManyRequests } from "@/lib/rate-limit";
import { formatCvForPrompt, formatProfileForPrompt } from "@/lib/templates/cover-letter";
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
import { getAutoBewerbCompany, getAutoBewerbProfile } from "@/lib/auto-bewerb/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * AUTO BEWERB — Step 2: job-advertisement analysis + profile match.
 *
 * Mirrors the Studio's analyze-ad pipeline (fenced untrusted input, zod
 * validation, single-flight, bounded retry, temperature 0), metered on the
 * existing `ai_assistant` daily quota. The candidate context comes from the
 * AUTO BEWERB analyzed CV profile (Step 1) — the workflow's single source
 * of truth; there is no client-supplied CV JSON here.
 *
 * REUSE: when re-analyzing a KNOWN company (companyId), an unchanged ad +
 * unchanged profile fingerprint returns the stored analysis — zero provider
 * calls, zero quota (accidental re-analysis is free).
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

/**
 * Map a caught analysis failure to the browser response:
 *  - an HTTP status with correct semantics (5xx provider faults are server
 *    errors, NOT 400 client errors — the old flat-400 made every provider
 *    outage look like a broken request),
 *  - a stable machine `code` the frontend maps to a LOCALIZED, actionable
 *    message (the raw provider wording never reaches the browser),
 *  - `retryable` so the UI can afford the user an immediate retry for
 *    transient conditions (outage / timeout / rate limit).
 * The detailed cause (status, provider code, sanitized body) was already
 * logged server-side where the failure happened — nothing sensitive is
 * duplicated here.
 */
export function analyzeAdFailureResponse(error: unknown): NextResponse {
  if (error instanceof InvalidModelOutput) {
    return NextResponse.json(
      {
        error: "Analyse konnte nicht ausgewertet werden. Bitte erneut versuchen.",
        code: "invalid_ai_output",
        retryable: true,
      },
      { status: 502 },
    );
  }
  if (error instanceof AIProviderError) {
    const status =
      error.code === "provider_rate_limited"
        ? 429
        : error.code === "provider_timeout"
          ? 504
          : error.code === "provider_unavailable" ||
              error.code === "provider_network" ||
              error.code === "provider_not_configured"
            ? 503
            : 502;
    return NextResponse.json(
      { error: error.message, code: error.code, retryable: error.retryable },
      { status },
    );
  }
  return NextResponse.json(
    {
      error: error instanceof Error ? error.message : "AI request failed.",
      code: "unknown_error",
      retryable: false,
    },
    { status: 400 },
  );
}

/** In-flight single-flight table: identical concurrent requests share ONE
 *  provider call. Keyed per user (results embed user-specific profile
 *  context — never shared across users). */
const inFlight = new Map<string, Promise<{ extract: AdExtract; analysis: AdAnalysis }>>();

const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const limited = await checkRateLimit("auto_bewerb_ai", user.id);
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
  const companyId = typeof body.companyId === "string" ? body.companyId : null;

  // The candidate context (the analyzed + corrected profile from Step 1).
  const profile = await getAutoBewerbProfile(user.id);
  const profileText = formatProfileForPrompt(profile?.extracted ?? null);
  const cvText = formatCvForPrompt(null);
  // Fingerprint: the profile's CV hash (the analyzed file, not the analysis
  // run) — a new CV re-runs the profile match, an unchanged one may reuse.
  const profileHash = profile?.cv_hash ?? null;

  // REUSE — same company + unchanged ad + unchanged profile context.
  if (companyId) {
    const stored = await getAutoBewerbCompany(user.id, companyId);
    if (stored) {
      const snap = stored.company.profile_snapshot as { cvHash?: unknown } | null;
      const storedHash = typeof snap?.cvHash === "string" ? snap.cvHash : null;
      const profileContextMatches = storedHash !== null ? storedHash === profileHash : profileHash === null;
      const extractValid = stored.company.ad_extracted !== null && adExtractSchema.safeParse(stored.company.ad_extracted).success;
      const analysisValid = stored.company.ad_analysis !== null && adAnalysisSchema.safeParse(stored.company.ad_analysis).success;
      const adUnchanged = stored.company.ad_raw?.trim() === adCheck.data.trim();
      if (extractValid && analysisValid && profileContextMatches && adUnchanged) {
        return NextResponse.json(
          {
            extract: stored.company.ad_extracted,
            analysis: stored.company.ad_analysis,
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

  const prompt = buildAdAnalysisPrompt({
    adText: adCheck.data,
    profileText,
    cvText,
  });

  // SINGLE-FLIGHT: identical in-flight requests (same user, same ad, same
  // profile context) share ONE provider call. Best effort per process
  // instance — it deduplicates, it never makes correctness depend on state.
  const sfKey = sha256Hex(`${user.id}\u0000${adCheck.data}\u0000${profileHash ?? "∅"}`);
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

  const analysisStarted = Date.now();
  try {
    const data = await work;
    await completeFeatureOp(user.id, "ai_assistant", runId);
    console.info(
      `[auto-bewerb][analyze-ad] analysis ok: runId=${runId} userId=${user.id} adChars=${adCheck.data.length} durationMs=${Date.now() - analysisStarted}`,
    );
    return NextResponse.json(
      { extract: data.extract, analysis: data.analysis, reused: false, profileHash },
      { headers: rateLimitHeaders(limited) },
    );
  } catch (error) {
    await releaseFeatureOp(user.id, "ai_assistant", runId);
    // One greppable server line per failure (code + status + duration only —
    // never the ad text, the profile, or any credential). The detailed
    // provider cause (HTTP status, provider error code/body, redacted) is
    // logged by the provider layer itself at the point of failure.
    const code =
      error instanceof InvalidModelOutput
        ? "invalid_ai_output"
        : error instanceof AIProviderError
          ? error.code
          : "unknown_error";
    console.error(
      `[auto-bewerb][analyze-ad] analysis failed: code=${code} providerStatus=${error instanceof AIProviderError ? error.status ?? "n/a" : "n/a"} runId=${runId} userId=${user.id} adChars=${adCheck.data.length} durationMs=${Date.now() - analysisStarted}`,
    );
    return analyzeAdFailureResponse(error);
  } finally {
    // Drop the entry once EVERY joiner has settled (identity check: a later
    // identical request re-registered a new promise for the same key).
    if (inFlight.get(sfKey) === work) inFlight.delete(sfKey);
  }
}
