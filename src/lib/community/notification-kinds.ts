/**
 * Community Phase 3 — social notification kinds (isomorphic).
 *
 * Social notification rows store the machine KIND MARKER in BOTH the enum
 * `type` column (the v4 CHECK constraint validates the per-kind reference
 * shape) and the `title` column (the client render signal); legacy/platform
 * rows carry the kind in `type` only, or neither. Client components (shell
 * toasts, the notification center) classify rows with socialKindOf() and
 * render the viewer-language text from the marker + structured fields.
 *
 * This module is PURE (no server imports): safe on the client and in
 * social.ts. Do NOT import `@/lib/community/social` from client components.
 */

/** The machine kind markers stored in `notifications.title`. */
export const SOCIAL_KIND_MARKERS = [
  "friend_request",
  "friend_accepted",
  "mention",
  "reply",
  "reaction",
  "direct_message",
  // Phase 5: Q&A notifications (reference question_id + answer_id).
  "answer",
  "answer_accepted",
] as const;
export type SocialKindMarker = (typeof SOCIAL_KIND_MARKERS)[number];

function isMarker(value: string): value is SocialKindMarker {
  return (SOCIAL_KIND_MARKERS as readonly string[]).includes(value);
}

/**
 * Classify a stored notification row by kind: the marker in `title` (current
 * contract) wins, then the kind in `type` (legacy rows), else null (the row
 * is a platform/legacy row rendered from its stored text).
 */
export function socialKindOf(row: {
  type: string;
  title: string;
}): SocialKindMarker | null {
  if (isMarker(row.title)) return row.title;
  if (isMarker(row.type)) return row.type;
  return null;
}
