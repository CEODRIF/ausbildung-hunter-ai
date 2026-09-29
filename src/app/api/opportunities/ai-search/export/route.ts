import { NextResponse } from "next/server";
import { z } from "zod";
import ExcelJS from "exceljs";
import { getCurrentUserAndProfile } from "@/lib/auth";
import {
  aiSearchCountSchema,
  aiSearchGoalSchema,
  aiSearchPlanSchema,
  buildExportRow,
  collectOpportunities,
  enrichOpportunities,
  rankOpportunities,
  type AiSearchPlan,
} from "@/lib/opportunities/ai-search";
import {
  getCandidateProfile,
  OpportunityProviderError,
} from "@/lib/opportunities/search";
import { checkRateLimit, tooManyRequests } from "@/lib/rate-limit";
import type { Opportunity } from "@/lib/opportunities/types";

export const runtime = "nodejs";

/**
 * AI Ausbildung Search — Excel export.
 *
 * The client echoes back the AI plan (Zod-validated, short strings only).
 * The server RE-RUNS the deterministic collection + detail enrichment
 * against the public source (search windows are cache-warm from the run)
 * and ranks with the user's current profile — the exported workbook is
 * always derived server-side from real, currently published postings.
 * No client-supplied opportunity data is ever trusted (same contract as
 * /api/opportunities/save). No AI call happens here (no quota).
 */

const bodySchema = z
  .object({
    goal: aiSearchGoalSchema,
    targetCount: aiSearchCountSchema,
    plan: aiSearchPlanSchema,
  })
  .strict();

const EXPORT_HEADERS = [
  "#",
  "Company",
  "Ausbildung Title",
  "Location",
  "Bundesland",
  "Start Date",
  "Application Deadline",
  "Email",
  "Phone",
  "Company Website",
  "Application URL",
  "Source URL",
  "Requirements",
  "Other Useful Information",
  "Source Type",
  "Additional Sources",
] as const;

async function buildWorkbook(
  results: Opportunity[],
  plan: AiSearchPlan,
  goal: "ausbildung" | "arbeit",
  targetCount: number,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Ausbildung Hunter AI";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("Opportunities", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  sheet.columns = [
    { header: EXPORT_HEADERS[0], key: "index", width: 5 },
    { header: EXPORT_HEADERS[1], key: "company", width: 28 },
    { header: EXPORT_HEADERS[2], key: "title", width: 36 },
    { header: EXPORT_HEADERS[3], key: "location", width: 20 },
    { header: EXPORT_HEADERS[4], key: "bundesland", width: 16 },
    { header: EXPORT_HEADERS[5], key: "start_date", width: 13 },
    { header: EXPORT_HEADERS[6], key: "application_deadline", width: 14 },
    { header: EXPORT_HEADERS[7], key: "email", width: 30 },
    { header: EXPORT_HEADERS[8], key: "phone", width: 16 },
    { header: EXPORT_HEADERS[9], key: "company_website", width: 30 },
    { header: EXPORT_HEADERS[10], key: "application_url", width: 38 },
    { header: EXPORT_HEADERS[11], key: "source_url", width: 38 },
    { header: EXPORT_HEADERS[12], key: "requirements", width: 60 },
    { header: EXPORT_HEADERS[13], key: "other", width: 52 },
    { header: EXPORT_HEADERS[14], key: "source_type", width: 18 },
    { header: EXPORT_HEADERS[15], key: "additional_sources", width: 55 },
  ];
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true };
  headerRow.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFE8EEF9" },
  };
  results.forEach((opportunity, index) => {
    const row = buildExportRow(opportunity);
    const data = sheet.addRow({ index: index + 1, ...row });
    data.alignment = { wrapText: true, vertical: "top" };
  });

  const details = workbook.addWorksheet("Search details");
  details.columns = [
    { header: "Item", key: "item", width: 24 },
    { header: "Value", key: "value", width: 100 },
  ];
  details.getRow(1).font = { bold: true };
  const addDetail = (item: string, value: string) => {
    const row = details.addRow({ item, value });
    row.alignment = { wrapText: true, vertical: "top" };
  };
  addDetail("Generated", new Date().toISOString());
  addDetail("Goal", goal);
  addDetail("Requested opportunities", String(targetCount));
  addDetail("Found opportunities", String(results.length));
  addDetail(
    "Source",
    "Bundesagentur für Arbeit — Jobsuche (public API, live postings)",
  );
  addDetail("AI rationale", plan.rationale || "(none)");
  plan.queries.forEach((query, index) => {
    const description =
      [query.role, query.keyword, query.location]
        .filter(Boolean)
        .join(" · ") || "(no constraints — goal-wide search)";
    addDetail(`Query ${index + 1}`, description);
  });

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export async function POST(request: Request) {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limited = await checkRateLimit("ai_search", user.id);
  if (!limited.allowed) return tooManyRequests(limited);

  const raw = await request.json().catch(() => null);
  const parsed = raw !== null ? bodySchema.safeParse(raw) : null;
  if (!parsed?.success)
    return NextResponse.json(
      { error: "Invalid export request." },
      { status: 400 },
    );
  const { goal, targetCount, plan } = parsed.data;

  try {
    // Deterministic re-run (cache-warm search windows), server-derived.
    const collected = await collectOpportunities({
      plan,
      goal,
      targetCount,
    });
    const buffer = Math.min(collected.length, targetCount + 10);
    const enriched = await enrichOpportunities(collected.slice(0, buffer));
    const currentProfile = await getCandidateProfile(user.id);
    const results = rankOpportunities(enriched, currentProfile, targetCount);

    const bufferOut = await buildWorkbook(results, plan, goal, targetCount);
    // Copy into a plain Uint8Array: Response's BodyInit rejects TS's
    // generic Buffer<ArrayBufferLike> in this toolchain.
    const body = new Uint8Array(bufferOut.byteLength);
    body.set(bufferOut);
    const stamp = new Date()
      .toISOString()
      .slice(0, 16)
      .replace("T", "-")
      .replace(":", "-");
    const filename = `ausbildung-search-${stamp}.xlsx`;
    return new Response(body, {
      headers: {
        "content-type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "no-store",
        "x-ratelimit-limit": String(limited.limit),
        "x-ratelimit-remaining": String(
          Math.max(0, limited.limit - limited.count),
        ),
      },
    });
  } catch (error) {
    if (error instanceof OpportunityProviderError)
      return NextResponse.json({ error: error.message }, { status: 502 });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Export failed." },
      { status: 500 },
    );
  }
}
