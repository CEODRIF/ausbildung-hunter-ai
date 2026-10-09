import { NextResponse } from "next/server";

import { getCurrentUserAndProfile } from "@/lib/auth";
import { ALLOWED_DOMAINS } from "@/lib/housing/web-search/config";

export const runtime = "nodejs";

/**
 * GET /api/housing/web-search/domains — the reviewed allowlist, for the UI's
 * "targeted website" picker. Exposes domain + policy + label only; no keys,
 * no rationales containing anything sensitive.
 *
 * `fetchable` domains are the ones we may verify by fetching (robots-checked);
 * `search_only` domains are discovered via the search index and linked, never
 * fetched.
 */
export async function GET() {
  const { user } = await getCurrentUserAndProfile();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({
    domains: ALLOWED_DOMAINS.map((d) => ({
      domain: d.domain,
      label: d.label,
      fetchable: d.policy === "fetchable",
    })),
  });
}
