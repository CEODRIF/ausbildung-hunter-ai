/**
 * Community Phase 3 — the presence model (PURE / isomorphic).
 *
 * One shared representation, used by every surface (member list, friends,
 * profile card, DM inbox, DM header, badges):
 *
 *   PRESENCE_WINDOW_MS — "fresh" heartbeat window. A user is only ever
 *     online/away/dnd while a heartbeat landed within this window; after
 *     that they are OFFLINE (server-side derivation — the client never
 *     asserts its own state).
 *   COMMUNITY_AWAY_AFTER_MS — inactivity that flips the LOCAL state from
 *     online to away. Chosen > 2x the heartbeat throttle so an active user
 *     can never flap online→away→online within one heartbeat cycle.
 *   PRESENCE_THROTTLE_MS — the heartbeat cadence (one write per 30 s while
 *     the tab is visible; rate-limited server-side to 60/min per user).
 *
 * The ONLY sanctioned periodic traffic in the community is this heartbeat
 * (presence expiry); it lives in the useCommunityPresence hook, and the
 * messenger surface components themselves stay interval-free (the
 * community-mobile-layout suite pins that).
 */

export const PRESENCE_WINDOW_MS = 2 * 60 * 1000;
export const COMMUNITY_AWAY_AFTER_MS = 3 * 60 * 1000;
export const PRESENCE_THROTTLE_MS = 30 * 1000;

/** The DECLARED mode the user's client reports (and the manual DND value). */
export type PresenceMode = "online" | "away" | "dnd";
/** The DERIVED state every surface renders. */
export type PresenceState = PresenceMode | "offline";

const PRESENCE_MODES: readonly PresenceMode[] = ["online", "away", "dnd"];

export function isPresenceMode(value: unknown): value is PresenceMode {
  return typeof value === "string" && (PRESENCE_MODES as readonly string[]).includes(value);
}

/**
 * The ONE derivation (declared mode + heartbeat freshness → state).
 * OFFLINE wins over DND: a DND user whose heartbeat went stale is offline,
 * not "do not disturb" — DND is a display preference for WHILE present.
 */
export function derivePresenceState(
  mode: PresenceMode | null | undefined,
  lastSeenAt: string | null | undefined,
  now: number = Date.now(),
): PresenceState {
  if (!lastSeenAt) return "offline";
  const ts = Date.parse(lastSeenAt);
  if (!Number.isFinite(ts) || now - ts > PRESENCE_WINDOW_MS) return "offline";
  if (mode === "dnd") return "dnd";
  if (mode === "away") return "away";
  return "online";
}

/**
 * Local inactivity → declared mode (client-side flip, NO write by itself:
 * the flip rides the next allowed heartbeat, or an immediate one when it
 * goes away → online again).
 */
export function declaredModeForActivity(
  lastActivityAt: number,
  manualMode: PresenceMode,
  now: number = Date.now(),
): PresenceMode {
  if (manualMode === "dnd") return "dnd";
  return now - lastActivityAt >= COMMUNITY_AWAY_AFTER_MS ? "away" : "online";
}

export interface PresenceProfileInput {
  last_seen_at: string | null;
  presence_mode: PresenceMode | null;
  show_presence: boolean | null;
}

/**
 * The privacy-safe view of a profile's presence for a given viewer:
 *  - the viewer always sees their OWN real state + last_seen;
 *  - a user with show_presence = false appears OFFLINE with NO last_seen
 *    (the privacy-safe state — never "last seen 4 min ago");
 *  - the mapping is applied server-side in every fetch path, so no DM /
 *    member / friends endpoint can leak the hidden presence.
 */
export function mapVisiblePresence(
  profile: PresenceProfileInput,
  isSelf: boolean,
  now: number = Date.now(),
): { state: PresenceState; lastSeenAt: string | null } {
  if (isSelf) {
    return {
      state: derivePresenceState(profile.presence_mode, profile.last_seen_at, now),
      lastSeenAt: profile.last_seen_at,
    };
  }
  if (profile.show_presence === false) return { state: "offline", lastSeenAt: null };
  return {
    state: derivePresenceState(profile.presence_mode, profile.last_seen_at, now),
    lastSeenAt: profile.last_seen_at,
  };
}

// ---------------------------------------------------------------------------
// Realtime — per-user presence broadcasts.
//
// Channel: community-presence-<userId>. Only the DM peer / profile card of
// THAT user subscribes (member-scoped, cleaned up on close) — there is no
// global presence channel. A user with show_presence = false publishes
// nothing, so the stream cannot leak hidden presence.
//
// Payloads are untrusted wire data: every field is validated, malformed
// payloads are dropped (never applied), and a stale ts (out of order) is
// ignored.
// ---------------------------------------------------------------------------

export const PRESENCE_BROADCAST_CHANNEL = (userId: string) => `community-presence-${userId}`;
export const PRESENCE_BROADCAST_EVENT = "presence_update";

export interface PresenceBroadcast {
  userId: string;
  mode: PresenceMode;
  lastSeenAt: string;
  ts: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parsePresenceBroadcast(raw: unknown): PresenceBroadcast | null {
  if (!isRecord(raw)) return null;
  const userId = typeof raw.userId === "string" ? raw.userId.trim() : "";
  const mode = raw.mode;
  const lastSeenAt = typeof raw.lastSeenAt === "string" ? raw.lastSeenAt : "";
  const ts = typeof raw.ts === "number" && Number.isFinite(raw.ts) ? raw.ts : null;
  if (!UUID.test(userId) || !isPresenceMode(mode)) return null;
  if (!lastSeenAt || !Number.isFinite(Date.parse(lastSeenAt))) return null;
  if (ts === null) return null;
  return { userId, mode, lastSeenAt, ts };
}

/** Coarse "last seen" bucketing — no minute-by-minute precision. */
export function lastSeenBucket(
  lastSeenAt: string | null,
  now: number = Date.now(),
): "recent" | "today" | "earlier" | null {
  if (!lastSeenAt) return null;
  const ts = Date.parse(lastSeenAt);
  if (!Number.isFinite(ts)) return null;
  const age = now - ts;
  if (age <= 60 * 60 * 1000) return "recent"; // within the last hour
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  if (ts >= dayStart.getTime()) return "today";
  return "earlier";
}
