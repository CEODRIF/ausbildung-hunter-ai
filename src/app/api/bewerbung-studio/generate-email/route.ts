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
import { buildEmailDraftPrompt, parseJsonObject } from "@/lib/studio/prompts";
import { adExtractSchema, studioEmailDraftSchema } from "@/lib/studio/schema";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * AI Bewerbung Studio — Section H: company-specific application email.
 *
 * The company/role/contact facts come from the STORED advertisement
 * extraction of the referenced application (ownership-checked) — a
 * tampered client body cannot redirect the email to a different company in
 * the generated copy. The letter excerpt is display context only.
 * Metered on the existing `email_drafts` quota.
 */

const bodySchema = z.object({
  applicationId: z.string().uuid(),
  letterExcerpt: z.string().max(2_000).optional(),
  attachmentNames: z.array(z.string().max(255)).max(10).optional(),
});

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const limited = await checkRateLimit("studio_ai", user.id);
  if (!limited.allowed) return tooManyRequests(limited);

  const rawBody = (await request.json().catch(() => ({}))) as unknown;
  const checked = bodySchema.safeParse(rawBody);
  if (!checked.success) {
    return NextResponse.json({ error: "Ungültige Anfrage.", code: "invalid_body" }, { status: 400 });
  }

  const { data: appData } = await createAdminClient()
    .from("studio_applications")
    .select("id, ad_extracted")
    .eq("id", checked.data.applicationId)
    .eq("user_id", user.id)
    .maybeSingle();
  const extractParsed = adExtractSchema.safeParse((appData as { ad_extracted?: unknown } | null)?.ad_extracted);
  if (!appData || !extractParsed.success) {
    return NextResponse.json(
      { error: "Bewerbung oder Analyse nicht gefunden.", code: "not_found" },
      { status: 404 },
    );
  }
  const extract = extractParsed.data;

  const runId = crypto.randomUUID();
  const reserved = await reserveFeatureOp(user.id, "email_drafts", runId);
  if (reserved.outcome === "quota_exhausted") {
    return NextResponse.json(
      { error: "Ihr E-Mail-Limit ist erreicht.", code: "quota_exhausted" },
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

  // The candidate context is only used to keep the email consistent with the
  // real profile (name in the closing is conventional — the model must not
  // invent a name).
  const ctx = await buildStudioCandidateContext(user.id, null, {
    fullName: undefined,
    email: undefined,
    phone: undefined,
    location: undefined,
    linkedin: undefined,
  });

  const prompt = buildEmailDraftPrompt({
    company: extract.company,
    jobTitle: extract.jobTitle || extract.occupation,
    contactPerson: extract.contactPerson,
    applicationMethod: extract.applicationMethod,
    letterExcerpt: (checked.data.letterExcerpt ?? "").slice(0, 400),
    attachmentNames: checked.data.attachmentNames?.slice(0, 10) ?? [],
  }) + `\n\n${ctx.profileText}`;

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
