/**
 * Bewerbung Automation — the "pending new series" view (instant UI).
 *
 * Why: "+ New series" used to wait for the server (create action, THEN a
 * separate view action — each re-authenticating) before the new series
 * interface appeared. Now the interface opens IMMEDIATELY from this locally
 * built view, which mirrors exactly what the server returns for a fresh
 * campaign (`count` empty `pending` rows, zeroed counters, no documents),
 * with PLACEHOLDER ids (`bew-pending-app-<seq>`) that are mapped to the real
 * row ids the moment the server confirms (see `remapPendingDrafts`).
 *
 * On failure the previous view is restored as-is; placeholder drafts that
 * were typed meanwhile are inert (they match no real row) and are dropped by
 * the next confirmed creation.
 *
 * Pure module: no React, no I/O — unit-testable exactly like row-state.ts.
 */
import type { BewApplicationDTO, BewViewDTO } from "./types";
import type { Drafts } from "./row-state";

export const PENDING_CAMPAIGN_ID = "bew-pending-campaign";
export const PENDING_APP_ID_PREFIX = "bew-pending-app-";

export function isPendingCampaignId(id: string): boolean {
  return id === PENDING_CAMPAIGN_ID;
}

export function isPendingAppId(id: string): boolean {
  return id.startsWith(PENDING_APP_ID_PREFIX);
}

/** The seed seq encoded in a placeholder id (null when it is not one). */
export function pendingAppSeq(id: string): number | null {
  if (!isPendingAppId(id)) return null;
  const n = Number(id.slice(PENDING_APP_ID_PREFIX.length));
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * The locally-built view for a series that is being created. The shape is
 * identical to `getBewCampaignView`'s answer for a just-created campaign:
 *
 *   - `count` empty rows, seq 1..count, status "pending" — the same rows the
 *     engine seeds (`createBewCampaignCore`), so nothing is faked;
 *   - zeroed counters (the server's counters only move on the first save —
 *     `total_count` is 0 right after creation too);
 *   - no documents (a new campaign starts with none);
 *   - the CURRENT usage snapshot (creating a campaign reserves no quota);
 *   - `senderEmail: null` (the confirmed view resolves the default sender).
 */
export function buildPendingView(
  previous: BewViewDTO | null,
  count: number,
  purpose: string,
): BewViewDTO {
  const nowIso = new Date().toISOString();
  const applications: BewApplicationDTO[] = Array.from({ length: count }, (_, i) => ({
    id: `${PENDING_APP_ID_PREFIX}${i + 1}`,
    seq: i + 1,
    company_name: "",
    contact_name: null,
    company_email: "",
    company_address: null,
    subject: "",
    body_html: "",
    body_text: "",
    status: "pending",
    error_code: null,
    error_message: null,
    attempt_count: 0,
    provider_message_id: null,
    sent_at: null,
  }));
  return {
    campaign: {
      id: PENDING_CAMPAIGN_ID,
      user_id: previous?.campaign.user_id ?? "",
      email_account_id: null,
      purpose,
      status: "draft",
      requested_count: count,
      valid_count: 0,
      total_count: 0,
      generated_count: 0,
      sent_count: 0,
      failed_count: 0,
      excluded_count: 0,
      usage_date: nowIso.slice(0, 10),
      created_at: nowIso,
      started_at: null,
      completed_at: null,
    },
    applications,
    documents: [],
    usage: previous?.usage ?? { remaining: 0, daily_limit: 0 },
    senderEmail: null,
  };
}

/**
 * Map placeholder drafts onto the CONFIRMED campaign's rows by seed seq
 * (the engine seeds seq 1..count in order and the view is seq-ordered, so
 * placeholder N ↔ application row with seq N — a 1:1 mapping).
 *
 * Only runs on a confirmed creation (the caller guarantees it): a failed
 * creation rolls back to the PREVIOUS campaign, whose seq-N row is a
 * different company and must not absorb the drafts.
 *
 * Placeholder ids with no seq match are dropped (orphaned, could never be
 * shown again); non-placeholder drafts (other campaigns) are left intact.
 * Returns the SAME reference when there was nothing to remap.
 */
export function remapPendingDrafts(
  drafts: Drafts,
  confirmedApps: Array<Pick<BewApplicationDTO, "id" | "seq">>,
): Drafts {
  const placeholderKeys = Object.keys(drafts).filter(isPendingAppId);
  if (placeholderKeys.length === 0) return drafts;
  const next: Drafts = { ...drafts };
  for (const key of placeholderKeys) {
    const seq = pendingAppSeq(key);
    const target = seq ? confirmedApps.find((a) => a.seq === seq) : undefined;
    if (target) next[target.id] = next[key];
    delete next[key];
  }
  return next;
}
