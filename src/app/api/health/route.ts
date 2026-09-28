import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/**
 * Phase 14 — operational health/readiness probe for uptime monitors
 * and deployment checkers.
 *
 * Public by design (no auth) — it exposes **booleans only**, never
 * env var values, error details, or any user data. 200 when the
 * database is reachable, 503 otherwise (a DB-down app cannot serve
 * its core surfaces).
 */
export async function GET() {
  let database = false;
  try {
    const admin = createAdminClient();
    // HEAD-style probe: counts only, transfers no rows.
    const { error } = await admin
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .limit(1);
    database = !error;
  } catch {
    database = false;
  }

  const body = {
    status: database ? ("ok" as const) : ("degraded" as const),
    checks: {
      database,
      workerSecretConfigured: Boolean(process.env.EMAIL_WORKER_SECRET),
    },
  };
  return NextResponse.json(body, {
    status: database ? 200 : 503,
    headers: { "cache-control": "no-store" },
  });
}
