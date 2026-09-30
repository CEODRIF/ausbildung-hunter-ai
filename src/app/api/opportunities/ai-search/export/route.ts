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
import {
  exportableOpportunities,
  resultsWithEmailCount,
} from "@/lib/opportunities/email-export";
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

/**
 * Column order is stable and outreach-oriented: the contact data the
 * user needs to reach out (Email, Phone) sit right after the identifying
 * columns, not buried at the end of the sheet.
 */
const EXPORT_COLUMNS = [
  { header: "#", key: "index", width: 5 },
  { header: "Company", key: "company", width: 28 },
  { header: "Ausbildung Title", key: "title", width: 36 },
  { header: "Email", key: "email", width: 32 },
  { header: "Phone", key: "phone", width: 18 },
  { header: "Location", key: "location", width: 20 },
  { header: "Bundesland", key: "bundesland", width: 16 },
  { header: "Start Date", key: "start_date", width: 13 },
  { header: "Application Deadline", key: "application_deadline", width: 15 },
  { header: "Company Website", key: "company_website", width: 30 },
  { header: "Application URL", key: "application_url", width: 38 },
  { header: "Source URL", key: "source_url", width: 38 },
  { header: "Requirements", key: "requirements", width: 60 },
  { header: "Other Useful Information", key: "other", width: 52 },
  { header: "Source Type", key: "source_type", width: 18 },
  { header: "Additional Sources", key: "additional_sources", width: 55 },
] as const;

export interface EmailExportStats {
  /** All ranked results of the (re-run) search, before email filtering. */
  totalFound: number;
  /** Results that actually document a valid email (before dedupe). */
  withEmail: number;
  /** Duplicate-email rows removed by the export filter. */
  duplicatesRemoved: number;
}

async function buildWorkbook(
  results: Opportunity[],
  plan: AiSearchPlan,
  goal: "ausbildung" | "arbeit",
  targetCount: number,
  stats: EmailExportStats,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Ausbildung Hunter AI";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("Opportunities", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  sheet.columns = EXPORT_COLUMNS as unknown as Array<{
    header: string;
    key: string;
    width: number;
  }>;
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true };
  headerRow.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFE8EEF9" },
  };
  // The Email header gets an extra accent so the outreach column is
  // unmistakable in the sheet.
  const emailColumn = sheet.getColumn("email");
  emailColumn.font = { bold: true, color: { argb: "FF1D4ED8" } };
  results.forEach((opportunity, index) => {
    const row = buildExportRow(opportunity);
    const data = sheet.addRow({ index: index + 1, ...row });
    data.alignment = { wrapText: true, vertical: "top" };
    // Emphasize the email cell (the whole point of this export).
    data.getCell("email").font = { bold: true, color: { argb: "FF1D4ED8" } };
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
  addDetail("Found opportunities", String(stats.totalFound));
  addDetail(
    "With a valid contact email",
    String(stats.withEmail),
  );
  addDetail(
    "Duplicate emails removed",
    String(stats.duplicatesRemoved),
  );
  addDetail(
    "Exported opportunities (this sheet)",
    String(results.length),
  );
  addDetail(
    "Export filter",
    "Only opportunities whose source published a valid email address are included; duplicate emails are deduplicated (highest-ranked kept).",
  );
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

    // Outreach contract: the workbook contains ONLY opportunities whose
    // source actually published a valid (non-placeholder) email, with
    // duplicate emails removed (highest-ranked occurrence kept). The UI
    // disables the button at zero; this guard covers the edge where the
    // source changed between the search run and the export click.
    const exportable = exportableOpportunities(results);
    if (exportable.length === 0) {
      return NextResponse.json(
        { error: "No opportunities with an email address are available to export." },
        { status: 409 },
      );
    }
    const withEmail = resultsWithEmailCount(results);

    const bufferOut = await buildWorkbook(
      exportable,
      plan,
      goal,
      targetCount,
      {
        totalFound: results.length,
        withEmail,
        duplicatesRemoved: withEmail - exportable.length,
      },
    );
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
