import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { checkRateLimit, tooManyRequests } from "@/lib/rate-limit";
import { importBewCompaniesFromPdf } from "@/lib/bewerbung-engine";
import { checkFeature } from "@/lib/billing/entitlement-service";

/**
 * POST /api/bew/companies-pdf — best-effort company-catalogue PDF import
 * (Bewerbung Automation, step 1). Parses the PDF into email/name candidates
 * for the preview — it stores NOTHING.
 *
 * WHY A ROUTE HANDLER (and not a server action): same 1 MB server-action
 * body limit as the document upload — a multi-page company catalogue PDF
 * would be rejected by the framework before parsing. Route handlers have no
 * such framework limit (pattern: /api/ai/files).
 *
 * Body: multipart form-data { file: File } (application/pdf)
 * Auth: session. Errors: JSON { error: <stable code> }.
 */

export const runtime = "nodejs";

const CLIENT_ERROR_CODES = new Set([
  "NO_FILE",
  "DOCUMENT_EMPTY",
  "DOCUMENT_TOO_LARGE",
  "DOCUMENT_UNSUPPORTED",
  "PDF_REQUIRED",
]);

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limited = await checkRateLimit("ai_upload", user.id);
  if (!limited.allowed) return tooManyRequests(limited);

  // Entitlement gate: this endpoint is step 1 of the Application Automation
  // workflow, which is a commercial-plan feature (0 for every
  // non-commercial state). The 10 MB document cap is already enforced
  // inside importBewCompaniesFromPdf (BEW_MAX_DOCUMENT_SIZE).
  const automation = await checkFeature(user.id, "automation");
  if (!automation.allowed) {
    const denied: Record<
      string,
      { status: number; body: Record<string, string> }
    > = {
      quota_exhausted: {
        status: 429,
        body: {
          error: "Application Automation limit reached.",
          code: "quota_exhausted",
        },
      },
      lookup_error: {
        status: 503,
        body: {
          error: "Plan state could not be verified.",
          code: "quota_unavailable",
        },
      },
      feature_disabled: {
        status: 403,
        body: {
          error:
            "Application Automation is not available on your current plan.",
          code: "feature_disabled",
        },
      },
      plan_expired: {
        status: 403,
        body: {
          error:
            "Application Automation is not available on your current plan.",
          code: "plan_expired",
        },
      },
    };
    const d = denied[automation.reason] ?? denied["feature_disabled"];
    return NextResponse.json(d.body, { status: d.status });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "INVALID_PAYLOAD" }, { status: 400 });
  }
  const file = formData.get("file");
  if (!(file instanceof File))
    return NextResponse.json({ error: "NO_FILE" }, { status: 400 });

  try {
    return NextResponse.json(await importBewCompaniesFromPdf(file));
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (CLIENT_ERROR_CODES.has(code))
      return NextResponse.json({ error: code }, { status: 400 });
    console.error("[api/bew/companies-pdf] unexpected import error", error);
    return NextResponse.json({ error: "INTERNAL" }, { status: 500 });
  }
}
