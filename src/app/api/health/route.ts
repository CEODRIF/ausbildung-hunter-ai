import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { probeTzdb } from "@/lib/schedule-time";

export const dynamic = "force-dynamic";

/**
 * Phase 14 — operational health/readiness probe for uptime monitors
 * and deployment checkers.
 *
 * Public by design (no auth) — it exposes booleans and the runtime's
 * tzdata probe labels (a fact about the IANA database bundled in this
 * Node build), never env var values, error details, or user data.
 *
 * `checks.tzdbCurrent` detects STALE tzdata in the server runtime: if
 * Morocco's 2026 rule change is missing (casablanca probe ≠ +00:00),
 * timezone conversions — scheduled sends included — use the OLD
 * offsets. See src/lib/schedule-time.ts (TZDB_PROBES). 200 when the
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

  const tzdbProbe = probeTzdb();
  const body = {
    status: database ? ("ok" as const) : ("degraded" as const),
    checks: {
      database,
      workerSecretConfigured: Boolean(process.env.EMAIL_WORKER_SECRET),
      // True iff the runtime's bundled IANA tzdata is current (every
      // probe label matches its current-tzdb expectation). A `false`
      // here means scheduled-send timezone conversions may use stale
      // offsets (Morocco's rule changed during 2026) — upgrade the
      // Node runtime before relying on scheduling for such zones.
      tzdbCurrent: tzdbProbe.every((probe) => probe.current),
    },
    tzdbProbe,
  };
  return NextResponse.json(body, {
    status: database ? 200 : 503,
    headers: { "cache-control": "no-store" },
  });
}
