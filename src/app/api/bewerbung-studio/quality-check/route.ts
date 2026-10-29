import { NextResponse } from "next/server";
import { z } from "zod";
import { provider } from "@/lib/ai-service";
import {
  completeFeatureOp,
  releaseFeatureOp,
  reserveFeatureOp,
} from "@/lib/billing/entitlement-service";
import { checkRateLimit, rateLimitHeaders, tooManyRequests } from "@/lib/rate-limit";
import { runDeterministicQuality } from "@/lib/studio/quality";
import { buildGrammarCheckPrompt, parseJsonObject } from "@/lib/studio/prompts";
import {
  adAnalysisSchema,
  adExtractSchema,
  qualityIssueSchema,
  type QualityIssue,
  type StudioAttachmentRow,
} from "@/lib/studio/schema";
import { createClient } from "@/lib/supabase/server";
import { cvHasContent, sanitizeCvDocument } from "@/lib/templates/cv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * AI Bewerbung Studio — Section G: application quality review.
 *
 * Two layers:
 *  1. DETERMINISTIC checks (free, always run): company/role presence,
 *     missing documents, recipient validity, deadline-vs-schedule, PII sweep.
 *  2. Optional AI grammar/consistency pass (`withAi: true`), metered on
 *     `ai_assistant`. Its issues are always `optional` severity — the
 *     blocking/optional split stays a deterministic, user-explained matter.
 */

const attachmentRowSchema = z.object({
  id: z.string().uuid(),
  application_id: z.string().uuid(),
  user_id: z.string().uuid(),
  display_name: z.string().max(255),
  doc_category: z.string().max(80),
  mime_type: z.string().max(120),
  size_bytes: z.number().int().nonnegative(),
  storage_path: z.string().max(500),
  required: z.boolean(),
  created_at: z.string(),
});

const bodySchema = z.object({
  extract: adExtractSchema.nullable().optional(),
  analysis: adAnalysisSchema.nullable().optional(),
  cv: z.unknown().optional(),
  letter: z
    .object({ text: z.string().max(16_000), tone: z.string().max(40).optional() })
    .nullable()
    .optional(),
  email: z
    .object({
      subject: z.string().max(200),
      body: z.string().max(6_000),
      attachmentIds: z.array(z.string().uuid()).max(10).optional(),
    })
    .nullable()
    .optional(),
  recipientEmail: z.string().max(320).nullable().optional(),
  attachments: z.array(attachmentRowSchema).max(20).optional(),
  scheduledAtMs: z.number().int().positive().nullable().optional(),
  withAi: z.boolean().optional(),
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
    return NextResponse.json({ error: "Ungültige Prüfungsanfrage.", code: "invalid_body" }, { status: 400 });
  }
  const b = checked.data;

  const cv = sanitizeCvDocument(b.cv);
  const issues: QualityIssue[] = runDeterministicQuality({
    extract: b.extract ?? null,
    analysis: b.analysis ?? null,
    cv: cv && cvHasContent(cv) ? cv : null,
    letter:
      b.letter && b.letter.text.trim()
        ? {
            text: b.letter.text,
            tone: b.letter.tone === "formal" || b.letter.tone === "engaged" ? b.letter.tone : "professional",
          }
        : null,
    email:
      b.email && b.email.subject.trim() && b.email.body.trim()
        ? { ...b.email, attachmentIds: b.email.attachmentIds ?? [] }
        : null,
    recipientEmail: b.recipientEmail ?? null,
    attachments: (b.attachments ?? []) as unknown as StudioAttachmentRow[],
    scheduledAtMs: b.scheduledAtMs ?? null,
    nowMs: Date.now(),
  });

  if (b.withAi !== true) {
    return NextResponse.json({ issues, aiChecked: false }, { headers: rateLimitHeaders(limited) });
  }

  // AI grammar/consistency pass — metered like any other assistant op.
  const runId = crypto.randomUUID();
  const reserved = await reserveFeatureOp(user.id, "ai_assistant", runId);
  if (reserved.outcome === "quota_exhausted") {
    return NextResponse.json({ issues, aiChecked: false, aiCode: "quota_exhausted" }, { status: 200 });
  }
  if (reserved.outcome === "feature_disabled" || reserved.outcome === "error") {
    return NextResponse.json({ issues, aiChecked: false, aiCode: "unavailable" }, { status: 200 });
  }

  const cvText = cv
    ? [cv.summary, ...cv.education.map((e) => `${e.degree} ${e.institution}`), ...cv.experience.map((x) => `${x.jobTitle} ${x.company}`), cv.skills.join(", ")].join(" | ").slice(0, 8_000)
    : "(nicht vorhanden)";
  const prompt = buildGrammarCheckPrompt({
    cvText,
    letterText: b.letter?.text ?? "(nicht vorhanden)",
    emailText: b.email ? `${b.email.subject}\n\n${b.email.body}` : "(nicht vorhanden)",
  });
  try {
    const raw = await provider().generateText([{ role: "user", content: prompt }], 90_000);
    const parsed = z.object({ issues: z.array(qualityIssueSchema).max(10) }).safeParse(parseJsonObject(raw));
    if (parsed.success) {
      for (const issue of parsed.data.issues) issues.push({ ...issue, severity: "optional" });
    }
    await completeFeatureOp(user.id, "ai_assistant", runId);
    return NextResponse.json({ issues, aiChecked: true }, { headers: rateLimitHeaders(limited) });
  } catch {
    await releaseFeatureOp(user.id, "ai_assistant", runId);
    // The deterministic result is still useful — return it, AI part skipped.
    return NextResponse.json({ issues, aiChecked: false, aiCode: "ai_failed" }, { headers: rateLimitHeaders(limited) });
  }
}
