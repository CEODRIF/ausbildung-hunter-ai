/**
 * Community — availability switch (production state: LIVE).
 *
 * The Community v2 feature (Discord-like rooms) is live. The whole feature
 * stays behind ONE boolean so it can be pulled again without a deploy-config
 * change:
 *
 *   true  → /community renders the "Coming Soon" state (no data access at
 *           all — not even the auth check), and the shell/nav hide the
 *           Community entry + unread badge.
 *   false → the feature is live (identity onboarding → room home →
 *           per-room chat with replies, reactions, mentions, edit/delete),
 *           with no other code change required.
 *
 * Flipping this constant back to `true` is the entire "park the feature" —
 * no migration, no feature-flag service, no deploy config.
 *
 * Keep this the ONLY gate: the route, the metadata, the nav and the badge
 * all read it, so one change switches the whole feature consistently.
 */
export const COMMUNITY_COMING_SOON = false;
