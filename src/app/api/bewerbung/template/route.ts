import { NextResponse } from "next/server";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { buildSampleCsvTemplate } from "@/lib/bewerbung-automation";

/**
 * Downloadable sample CSV template for the company-list import.
 *
 * Static, PERSONAL-FREE content (a fixed 3-row example) — but it lives inside
 * the authenticated feature, so it requires a logged-in, ACTIVE user. This
 * keeps the endpoint consistent with the rest of the feature surface and
 * satisfies the "every route proves its caller" security contract without
 * adding a public allowlist entry.
 */

export async function GET() {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return new NextResponse(buildSampleCsvTemplate(), {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="firmen-vorlage-bewerbung.csv"',
      "cache-control": "private, max-age=3600",
    },
  });
}
