import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Migration-state probe for the OPTIONAL `contact_name` column
 * (migration 20261108000000_personalization_contact_name.sql).
 *
 * This repository applies Supabase migrations MANUALLY — there is no CI
 * step — so code can legitimately run against a database that has not
 * received the migration yet. Querying the column there makes PostgREST
 * fail with PGRST204/42703, which previously broke the WHOLE send path
 * (page load lost the recipients, draft autosave threw, campaign creation
 * saw zero recipients, and the worker failed every message).
 *
 * The probe is run ONCE per process and cached. Consumers gate every
 * contact_name select/insert on its result:
 *
 *   column present  → full personalization (contact + greeting)
 *   column missing  → graceful degradation: company + generic-greeting
 *                     personalization still work (both derive from the
 *                     email address / stored columns, no contact_name
 *                     involved), and sending is never blocked by the
 *                     migration state.
 *
 * Unknown errors also resolve to `false` — the safe default is "feature
 * off, sending on". Once the migration is applied, fresh instances pick
 * the column up automatically (serverless instances turn over quickly).
 */

let probe: Promise<boolean> | null = null;

export function hasContactNameColumn(): Promise<boolean> {
  probe ??= (async () => {
    try {
      const admin = createAdminClient();
      const { error } = await admin
        .from("application_draft_recipients")
        .select("contact_name")
        .limit(1);
      // Only a clean read proves the column exists. Missing column OR any
      // other probe error → "not supported" (safe default: feature off,
      // sending on).
      return error === null;
    } catch {
      return false;
    }
  })();
  return probe;
}

/** Test hook: drop the cached probe so a test can simulate a schema change. */
export function resetContactNameProbe(): void {
  probe = null;
}
