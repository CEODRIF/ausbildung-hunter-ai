import { NextResponse } from "next/server";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  checkRateLimit,
  rateLimitHeaders,
  tooManyRequests,
} from "@/lib/rate-limit";
import { fetchCommunityWriteGate } from "@/lib/community/roles";
import {
  createReport,
  fetchMyReports,
} from "@/lib/community/reports";

/**
 * /api/community/reports — user reports (Phase 5).
 *
 * POST — file a report. The reporter is ALWAYS the session user (RLS:
 *        insert own-only). The target is validated server-side: it must
 *        exist and match its type (arbitrary UUIDs are rejected), and the
 *        reporter can never report their own content. DMs are not a
 *        reportable target. Anti-duplicate: one pending report per
 *        (reporter, target) — the partial unique index turns a re-file
 *        into a 409.
 * GET  — the reporter's OWN reports (status visibility). RLS own-only:
 *        no user can ever read another reporter's row.
 *
 * Rate limits: community_report (5/min) for POST, community_profile for
 * GET (same class as other member reads). Suspended users cannot file
 * reports (moderation is not self-service); timed-out users can.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  const { user } = await getCurrentUserAndProfile();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const limited = await checkRateLimit("community_report", user.id);
  if (!limited.allowed) return tooManyRequests(limited);

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const gate = await fetchCommunityWriteGate(user.id);
  if (!gate.writable && gate.code === "suspended") {
    return NextResponse.json({ error: "suspended" }, { status: 403 });
  }

  const targetType = typeof body.target_type === "string" ? body.target_type : "";
  const targetId = typeof body.target_id === "string" ? body.target_id : "";
  const reason = typeof body.reason === "string" ? body.reason : "";
  const details = typeof body.details === "string" ? body.details : "";
  if (!targetType || !targetId || !reason || !UUID.test(targetId)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const supabase = await createClient();
  const result = await createReport(supabase, user.id, {
    targetType,
    targetId,
    reason,
    details,
  });
  if (!result.ok) {
    switch (result.error) {
      case "invalid":
        return NextResponse.json({ error: "Invalid request." }, { status: 400 });
      case "target_not_found":
        return NextResponse.json({ error: "target_not_found" }, { status: 404 });
      case "self_report":
        return NextResponse.json({ error: "self_report" }, { status: 403 });
      case "duplicate":
        return NextResponse.json({ error: "already_reported" }, { status: 409 });
      default:
        return NextResponse.json({ error: "report_failed" }, { status: 500 });
    }
  }
  return NextResponse.json(
    { report: result.report },
    { status: 201, headers: rateLimitHeaders(limited) },
  );
}

export async function GET() {
  const { user } = await getCurrentUserAndProfile();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const limited = await checkRateLimit("community_profile", user.id);
  if (!limited.allowed) return tooManyRequests(limited);

  const supabase = await createClient();
  const items = await fetchMyReports(supabase, user.id, 20);
  return NextResponse.json(
    { items },
    { headers: rateLimitHeaders(limited) },
  );
}
