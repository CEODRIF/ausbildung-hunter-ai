/**
 * Community Phase 6C — structured logging for critical community/voice
 * reliability & security events.
 *
 * A deliberately tiny convention (no framework, no new dependency):
 *   * stable dot-namespaced event names (community.voice.*)
 *   * one single line per event, machine-parseable `key=value` fields
 *   * level discipline: info = normal operation, warn = denied/degraded,
 *     error = hard failure
 *
 * NEVER logged through this helper: passwords, OAuth secrets, LiveKit API
 * secrets, access tokens, refresh tokens, signed URLs, private message
 * contents, image contents, or more personal data than the event needs
 * (userId / roomId are the standard fields). Defense in depth: fields are
 * scalar-only by type, and any string longer than
 * COMMUNITY_LOG_MAX_FIELD_LENGTH is truncated — so even a mistaken
 * `token=<jwt>` / `url=<signed-url>` field cannot leak a full credential.
 * Newlines are flattened (log-injection safe: one event = one line).
 *
 * Wired hot paths (Phase 6C): voice token route (join / token_issued /
 * join_denied), voice count sync (leave_sync), stale-session sweep
 * (cleanup / unavailable). The Phase 6B eviction lines in moderation.ts
 * keep their established `[community]` format (their exact strings are
 * part of the 6B test contract).
 */
import "server-only";

export const COMMUNITY_VOICE_EVENTS = [
  "community.voice.join",
  "community.voice.token_issued",
  "community.voice.join_denied",
  "community.voice.leave_sync",
  "community.voice.cleanup",
  "community.voice.eviction",
  "community.voice.unavailable",
  // Production diagnostics (voice incident): server-side SFU reachability
  // probe + the CLIENT-side connect-failure report. Both carry only safe
  // metadata (url scheme/host, key LENGTH, grant booleans, error name/code +
  // redacted message) — never tokens, API keys, or secrets.
  "community.voice.sfu_probe",
  "community.voice.client_error",
] as const;

export type CommunityVoiceEvent = (typeof COMMUNITY_VOICE_EVENTS)[number];

/** Scalar-only fields — objects/functions cannot be smuggled into a log. */
export type CommunityLogFields = Record<string, string | number | boolean>;

/** No field value may exceed this length; longer values are truncated. */
export const COMMUNITY_LOG_MAX_FIELD_LENGTH = 120;

function formatValue(value: string | number | boolean): string {
  if (typeof value !== "string") return String(value);
  const flat = value.replace(/[\r\n\t]+/g, " ");
  if (flat.length <= COMMUNITY_LOG_MAX_FIELD_LENGTH) return flat;
  return `${flat.slice(0, 12)}…(len=${flat.length})`;
}

/**
 * Emit one stable, single-line, machine-parseable community event.
 *
 *   communityLog("community.voice.token_issued", { userId, roomId, room, ttlSeconds });
 *   → `[community] community.voice.token_issued userId=… roomId=… room=… ttlSeconds=600`
 */
export function communityLog(
  event: CommunityVoiceEvent,
  fields: CommunityLogFields = {},
  level: "info" | "warn" | "error" = "info",
): void {
  const parts = Object.entries(fields)
    .map(([key, value]) => `${key}=${formatValue(value)}`)
    .join(" ");
  const line = `[community] ${event}${parts ? ` ${parts}` : ""}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}
