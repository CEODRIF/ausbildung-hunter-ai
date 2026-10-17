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

/* ------------------------------------------------------------------ *\
 * Campaign-owned content probe (Drafts feature removal)
 * ------------------------------------------------------------------ */

let ownedContentProbe: Promise<boolean> | null = null;

/**
 * Whether `email_campaigns` already carries its OWN content columns
 * (subject, goal) and the `email_campaign_attachments` table exists —
 * i.e. migration 20261110000000_campaign_owned_content.sql has been
 * applied (MANUALLY, like every migration in this repo).
 *
 * When true, the draft-free workflow is active:
 *   - the composer never creates, saves or resumes an application_draft;
 *   - `createCampaign` receives the full payload (subject, body,
 *     recipients, attachments) and stores it on the campaign itself;
 *   - the sending worker renders from the campaign row (draft fallback
 *     only for pre-migration campaigns);
 *   - the Applications dashboard lists/count campaigns only (no Drafts
 *     card, no draft-only rows).
 *
 * When false (code deployed before the migration), EVERY legacy
 * draft-based path keeps working exactly as before — the same
 * "deploy code first, migration second" safety contract as the
 * contact_name and praktikum probes. Only a clean read of BOTH objects
 * proves support; any error resolves to `false`.
 */
export function hasCampaignOwnedContent(): Promise<boolean> {
  ownedContentProbe ??= (async () => {
    try {
      const admin = createAdminClient();
      const [{ error: columnsError }, { error: attachmentsError }] =
        await Promise.all([
          admin
            .from("email_campaigns")
            .select("id, subject, goal")
            .limit(1),
          admin.from("email_campaign_attachments").select("id").limit(1),
        ]);
      return columnsError === null && attachmentsError === null;
    } catch {
      return false;
    }
  })();
  return ownedContentProbe;
}

/** Test hook: drop the cached probe so a test can simulate a schema change. */
export function resetCampaignOwnedContentProbe(): void {
  ownedContentProbe = null;
}

/* ------------------------------------------------------------------ *
 * Profile avatar-gallery probe
 * ------------------------------------------------------------------ */

let profileAvatarProbe: Promise<boolean> | null = null;

/**
 * Whether `profiles.avatar` exists — i.e. migration
 * 20261111000000_profile_avatar_gallery.sql has been applied (MANUALLY,
 * like every migration in this repo).
 *
 * When true, the profile page renders the full identity editor
 * (display name + 10-avatar gallery) and the server action may persist
 * an avatar identifier. When false (code deployed before the migration),
 * the page falls back to display-name-only editing — the name lives in
 * the long-existing `full_name` column, so it works on ANY schema — and
 * the avatar picker is not rendered at all.
 *
 * Same contract as the other probes: cached per process, only a CLEAN
 * READ proves the column; any error resolves to `false`.
 */
export function hasProfileAvatarColumn(): Promise<boolean> {
  profileAvatarProbe ??= (async () => {
    try {
      const admin = createAdminClient();
      const { error } = await admin
        .from("profiles")
        .select("avatar")
        .limit(1);
      return error === null;
    } catch {
      return false;
    }
  })();
  return profileAvatarProbe;
}

/** Test hook: drop the cached probe so a test can simulate a schema change. */
export function resetProfileAvatarColumnProbe(): void {
  profileAvatarProbe = null;
}

let applicantProfileProbe: Promise<boolean> | null = null;

/**
 * Migration-state probe for the applicant address columns
 * (migration 20261114000000_applicant_profile_fields):
 * `street, postal_code, city, country, phone`.
 *
 * Same contract as the other probes: cached per process, only a CLEAN READ
 * proves the columns; any error resolves to `false` — the safe default.
 * Consumers:
 *   - the settings page hides the applicant form while the migration is
 *     pending (display of the existing data is unaffected);
 *   - the engine degrades the new fields to "" (so stored profiles are
 *     simply "incomplete" and new letter generation is gated with the
 *     stable PROFILE_INCOMPLETE code — never a silent name+email letter).
 */
export function hasApplicantProfileColumns(): Promise<boolean> {
  applicantProfileProbe ??= (async () => {
    try {
      const admin = createAdminClient();
      const { error } = await admin
        .from("profiles")
        .select("street, postal_code, city, country, phone")
        .limit(1);
      return error === null;
    } catch {
      return false;
    }
  })();
  return applicantProfileProbe;
}

/** Test hook: drop the cached probe so a test can simulate a schema change. */
export function resetApplicantProfileColumnsProbe(): void {
  applicantProfileProbe = null;
}
