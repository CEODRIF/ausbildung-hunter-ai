import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Migration-state probes for OPTIONAL schema features. This repository
 * applies Supabase migrations MANUALLY (no CI step), so code can run
 * against a database that has not received a given migration yet. Every
 * probe is cached per process and only a CLEAN READ proves support; any
 * error means "not supported" — the safe default (feature hidden/off,
 * core sending always available).
 *
 *  - contact_name column (migration 20261108000000)
 *  - 'praktikum' enum value (migration 20261109000000)
 *
 * ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ *
 * 'praktikum' application-goal probe
 * ------------------------------------------------------------------ */

let praktikumProbe: Promise<boolean> | null = null;

/**
 * Whether the `application_goal` enum already carries 'praktikum'
 * (migration 20261109000000). Probed by a read that is only VALID if the
 * enum value exists: `goal = 'praktikum'` makes PostgREST reject the
 * query pre-migration (invalid enum input) and succeed post-migration.
 *
 * Consumers gate the Praktikum OPTION on this result, so a database
 * without the migration can never receive a goal it would reject —
 * selecting Praktikum therefore can never break draft autosave or the
 * "Send applications" button (the same failure mode as the original
 * contact_name regression).
 */
export function supportsPraktikumGoal(): Promise<boolean> {
  praktikumProbe ??= (async () => {
    try {
      const admin = createAdminClient();
      const { error } = await admin
        .from("application_drafts")
        .select("id")
        .eq("goal", "praktikum")
        .limit(1);
      return error === null;
    } catch {
      return false;
    }
  })();
  return praktikumProbe;
}

/** Test hook: drop the cached probe so a test can simulate a schema change. */
export function resetPraktikumProbe(): void {
  praktikumProbe = null;
}
