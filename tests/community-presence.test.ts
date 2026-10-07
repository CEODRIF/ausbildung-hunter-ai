/**
 * Community Phase 3 — the presence model (PURE logic, deterministic).
 *
 * Every assertion uses FIXED timestamps (no wall clock, no timers, no
 * real-time waiting) so the suite is fully deterministic:
 *
 *   NOW        = 2026-10-07T12:00:00.000Z (the reference instant)
 *   iso(t)     = NOW - t (milliseconds before the reference)
 *
 * Coverage:
 *   - state derivation (fresh / boundary / stale / malformed heartbeat)
 *   - ONLINE → AWAY / AWAY → ONLINE / ONLINE → DND / DND → ONLINE /
 *     ONLINE → OFFLINE transitions (declared mode × heartbeat freshness)
 *   - inactivity threshold (away flip, boundary-inclusive)
 *   - manual DND override (activity cannot flip out of DND)
 *   - privacy (show_presence = false → offline + NO last-seen leak;
 *     the viewer always sees their OWN real state)
 *   - last-seen bucketing (recent / today / earlier, boundaries)
 *   - broadcast payload validation (untrusted wire data — malformed
 *     payloads are dropped, never applied)
 *   - the anti-flap invariants between the heartbeat throttle, the
 *     freshness window and the away threshold (throttling is expressed
 *     through these pure constants — the hook itself is not a test seam)
 */
import { describe, expect, it } from "vitest";
import {
  COMMUNITY_AWAY_AFTER_MS,
  derivePresenceState,
  declaredModeForActivity,
  isPresenceMode,
  lastSeenBucket,
  mapVisiblePresence,
  parsePresenceBroadcast,
  type PresenceProfileInput,
  PRESENCE_THROTTLE_MS,
  PRESENCE_WINDOW_MS,
} from "@/lib/community/presence";

const NOW = Date.parse("2026-10-07T12:00:00.000Z");
/** The ISO timestamp of (NOW - msBefore). */
const iso = (msBefore: number): string => new Date(NOW - msBefore).toISOString();

const VALID_UUID = "3f2b7c1a-9d4e-4f6b-8a1c-2e5d7f9b3c4a";

describe("isPresenceMode", () => {
  it("accepts exactly the three declared modes", () => {
    expect(isPresenceMode("online")).toBe(true);
    expect(isPresenceMode("away")).toBe(true);
    expect(isPresenceMode("dnd")).toBe(true);
  });

  it("rejects everything else (offline is DERIVED, never declared)", () => {
    expect(isPresenceMode("offline")).toBe(false);
    expect(isPresenceMode("ONLINE")).toBe(false);
    expect(isPresenceMode("brb")).toBe(false);
    expect(isPresenceMode("")).toBe(false);
    expect(isPresenceMode(null)).toBe(false);
    expect(isPresenceMode(42)).toBe(false);
    expect(isPresenceMode(undefined)).toBe(false);
  });
});

describe("derivePresenceState — heartbeat freshness", () => {
  it("missing / malformed heartbeat → offline for every mode", () => {
    for (const mode of ["online", "away", "dnd"] as const) {
      expect(derivePresenceState(mode, null, NOW)).toBe("offline");
      expect(derivePresenceState(mode, undefined, NOW)).toBe("offline");
      expect(derivePresenceState(mode, "", NOW)).toBe("offline");
      expect(derivePresenceState(mode, "not-a-date", NOW)).toBe("offline");
    }
  });

  it("a fresh heartbeat (10 s old) yields the declared mode", () => {
    expect(derivePresenceState("online", iso(10_000), NOW)).toBe("online");
    expect(derivePresenceState("away", iso(10_000), NOW)).toBe("away");
    expect(derivePresenceState("dnd", iso(10_000), NOW)).toBe("dnd");
    // A missing declared mode defaults to online (the client always sends one,
    // but a legacy row must not render as offline while its heartbeat is fresh).
    expect(derivePresenceState(null, iso(10_000), NOW)).toBe("online");
  });

  it("the freshness boundary is inclusive (exactly WINDOW old = still fresh)", () => {
    expect(derivePresenceState("online", iso(PRESENCE_WINDOW_MS), NOW)).toBe("online");
  });

  it("one millisecond past the window → offline", () => {
    expect(derivePresenceState("online", iso(PRESENCE_WINDOW_MS + 1), NOW)).toBe("offline");
  });

  it("OFFLINE wins over DND: a stale DND user is offline, not DND", () => {
    expect(derivePresenceState("dnd", iso(PRESENCE_WINDOW_MS + 60_000), NOW)).toBe("offline");
    expect(derivePresenceState("away", iso(PRESENCE_WINDOW_MS + 60_000), NOW)).toBe("offline");
  });

  it("clock skew (a future heartbeat) never errors — it reads as fresh", () => {
    expect(derivePresenceState("online", new Date(NOW + 5_000).toISOString(), NOW)).toBe("online");
  });
});

describe("presence transitions (declared mode × heartbeat freshness)", () => {
  const fresh = (mode: "online" | "away" | "dnd") =>
    derivePresenceState(mode, iso(5_000), NOW);

  it("ONLINE → AWAY: inactivity crosses the threshold, the next heartbeat carries away", () => {
    const t0 = NOW; // last activity
    expect(declaredModeForActivity(t0, "online", t0 + COMMUNITY_AWAY_AFTER_MS - 1)).toBe("online");
    expect(declaredModeForActivity(t0, "online", t0 + COMMUNITY_AWAY_AFTER_MS)).toBe("away");
    // The away heartbeat landed 5 s ago → the derived state is away.
    expect(fresh("away")).toBe("away");
  });

  it("AWAY → ONLINE: new activity flips back, the immediate flush reports online", () => {
    const t0 = NOW - 10 * 60_000; // was idle for 10 min
    expect(declaredModeForActivity(t0, "online", NOW)).toBe("away");
    expect(declaredModeForActivity(NOW, "online", NOW)).toBe("online");
    expect(fresh("online")).toBe("online");
  });

  it("ONLINE → DND: a manual DND write while present", () => {
    expect(declaredModeForActivity(NOW, "dnd", NOW)).toBe("dnd");
    expect(fresh("dnd")).toBe("dnd");
  });

  it("DND → ONLINE: leaving manual DND restores activity-driven online", () => {
    expect(declaredModeForActivity(NOW, "online", NOW)).toBe("online");
    expect(fresh("online")).toBe("online");
  });

  it("ONLINE → OFFLINE: heartbeats stop (hidden tab / sleep) and the window expires", () => {
    // 1 min after the last activity the user still reads as online:
    expect(derivePresenceState("online", iso(60_000), NOW)).toBe("online");
    // 3 min after the last activity the heartbeat is stale → offline:
    expect(derivePresenceState("online", iso(3 * 60_000), NOW)).toBe("offline");
  });

  it("manual DND is sticky: inactivity alone can never flip DND to away", () => {
    const t0 = NOW - 30 * 60_000; // 30 min idle
    expect(declaredModeForActivity(t0, "dnd", NOW)).toBe("dnd");
  });
});

describe("declaredModeForActivity — the inactivity threshold", () => {
  it("is boundary-inclusive at exactly AWAY_AFTER (>=)", () => {
    expect(declaredModeForActivity(NOW - (COMMUNITY_AWAY_AFTER_MS - 1), "online", NOW)).toBe("online");
    expect(declaredModeForActivity(NOW - COMMUNITY_AWAY_AFTER_MS, "online", NOW)).toBe("away");
  });

  it("a manual away is STICKY — activity (and the heartbeat) never clears it", () => {
    const t0 = NOW - 10 * 60_000;
    expect(declaredModeForActivity(t0, "away", NOW)).toBe("away");
    // (incident fix: an explicit Away is only changed by an explicit user
    // action — fresh activity must not flip it back to online)
    expect(declaredModeForActivity(NOW, "away", NOW)).toBe("away");
  });
});

describe("mapVisiblePresence — privacy", () => {
  const prof = (
    mode: "online" | "away" | "dnd",
    show: boolean | null,
    msBefore: number,
  ): PresenceProfileInput => ({
    last_seen_at: iso(msBefore),
    presence_mode: mode,
    show_presence: show,
  });

  it("the viewer ALWAYS sees their own real state + last-seen", () => {
    // Hidden from others, but self never sees the privacy mapping:
    const staleHidden = prof("dnd", false, PRESENCE_WINDOW_MS + 60_000);
    expect(mapVisiblePresence(staleHidden, true, NOW)).toEqual({
      state: "offline", // stale → offline (honest self-view)
      lastSeenAt: staleHidden.last_seen_at, // the real last-seen stays visible to self
    });
    expect(mapVisiblePresence(prof("online", false, 5_000), true, NOW)).toEqual({
      state: "online",
      lastSeenAt: iso(5_000),
    });
  });

  it("show_presence = false → OFFLINE with NO last-seen (even while genuinely online)", () => {
    expect(mapVisiblePresence(prof("online", false, 5_000), false, NOW)).toEqual({
      state: "offline",
      lastSeenAt: null,
    });
  });

  it("show_presence = false hides a FRESH DND too — no 'do not disturb' leak", () => {
    expect(mapVisiblePresence(prof("dnd", false, 5_000), false, NOW)).toEqual({
      state: "offline",
      lastSeenAt: null,
    });
  });

  it("show_presence = true renders the derived state + the real last-seen", () => {
    expect(mapVisiblePresence(prof("dnd", true, 5_000), false, NOW)).toEqual({
      state: "dnd",
      lastSeenAt: iso(5_000),
    });
  });

  it("a missing toggle (null) is treated as visible — the safe default direction is explicit", () => {
    expect(mapVisiblePresence(prof("away", null, 5_000), false, NOW)).toEqual({
      state: "away",
      lastSeenAt: iso(5_000),
    });
  });

  it("a stale heartbeat of a visible user is offline but the last-seen is still shown", () => {
    expect(mapVisiblePresence(prof("online", true, 3 * 60_000), false, NOW)).toEqual({
      state: "offline",
      lastSeenAt: iso(3 * 60_000),
    });
  });
});

describe("lastSeenBucket — coarse last-seen display", () => {
  // The bucket is relative to the VIEWER'S LOCAL day, so anchor the test
  // clock at LOCAL noon: the day boundary is then well-defined and the
  // assertions hold deterministically in any runner timezone.
  const ANCHOR = (() => {
    const d = new Date("2026-10-07T12:00:00.000Z");
    d.setHours(12, 0, 0, 0);
    return d.getTime();
  })();
  const DAY_START = (() => {
    const d = new Date(ANCHOR);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  })();
  const isoA = (msBefore: number): string => new Date(ANCHOR - msBefore).toISOString();

  it("null / malformed → null (nothing to display)", () => {
    expect(lastSeenBucket(null, ANCHOR)).toBeNull();
    expect(lastSeenBucket("", ANCHOR)).toBeNull();
    expect(lastSeenBucket("garbage", ANCHOR)).toBeNull();
  });

  it("within the last hour → 'recent' (boundary inclusive at 60 min)", () => {
    expect(lastSeenBucket(isoA(0), ANCHOR)).toBe("recent");
    expect(lastSeenBucket(isoA(59 * 60_000), ANCHOR)).toBe("recent");
    expect(lastSeenBucket(isoA(60 * 60_000), ANCHOR)).toBe("recent");
  });

  it("older, but on the current local day → 'today'", () => {
    expect(lastSeenBucket(isoA(2 * 60 * 60_000), ANCHOR)).toBe("today"); // local 10:00
    expect(lastSeenBucket(new Date(DAY_START + 2 * 60 * 60_000).toISOString(), ANCHOR)).toBe(
      "today",
    ); // local 02:00
  });

  it("local midnight is the day boundary (inclusive 'today', 1 ms before = 'earlier')", () => {
    expect(lastSeenBucket(new Date(DAY_START).toISOString(), ANCHOR)).toBe("today");
    expect(lastSeenBucket(new Date(DAY_START - 1).toISOString(), ANCHOR)).toBe("earlier");
  });
});

describe("parsePresenceBroadcast — untrusted wire data", () => {
  it("accepts a well-formed payload", () => {
    const raw = {
      userId: VALID_UUID,
      mode: "dnd",
      lastSeenAt: iso(5_000),
      ts: NOW - 5_000,
    };
    expect(parsePresenceBroadcast(raw)).toEqual(raw);
  });

  it("accepts an uppercase UUID (wire data casing is not significant)", () => {
    const raw = {
      userId: VALID_UUID.toUpperCase(),
      mode: "online",
      lastSeenAt: iso(1_000),
      ts: NOW - 1_000,
    };
    expect(parsePresenceBroadcast(raw)?.mode).toBe("online");
  });

  it("drops non-object payloads", () => {
    expect(parsePresenceBroadcast(null)).toBeNull();
    expect(parsePresenceBroadcast(undefined)).toBeNull();
    expect(parsePresenceBroadcast("online")).toBeNull();
    expect(parsePresenceBroadcast(42)).toBeNull();
    expect(parsePresenceBroadcast(["online"])).toBeNull();
  });

  it("drops an invalid or missing user id", () => {
    const base = { mode: "online", lastSeenAt: iso(1_000), ts: NOW - 1_000 };
    expect(parsePresenceBroadcast({ ...base, userId: "not-a-uuid" })).toBeNull();
    expect(parsePresenceBroadcast({ ...base, userId: "" })).toBeNull();
    expect(parsePresenceBroadcast({ ...base, userId: 123 })).toBeNull();
    expect(parsePresenceBroadcast(base)).toBeNull();
  });

  it("drops an invalid or missing mode (offline is never broadcast)", () => {
    const base = { userId: VALID_UUID, lastSeenAt: iso(1_000), ts: NOW - 1_000 };
    expect(parsePresenceBroadcast({ ...base, mode: "offline" })).toBeNull();
    expect(parsePresenceBroadcast({ ...base, mode: "ONLINE" })).toBeNull();
    expect(parsePresenceBroadcast({ ...base, mode: 1 })).toBeNull();
    expect(parsePresenceBroadcast(base)).toBeNull();
  });

  it("drops an invalid or missing lastSeenAt", () => {
    const base = { userId: VALID_UUID, mode: "online", ts: NOW - 1_000 };
    expect(parsePresenceBroadcast({ ...base, lastSeenAt: "garbage" })).toBeNull();
    expect(parsePresenceBroadcast({ ...base, lastSeenAt: 123 })).toBeNull();
    expect(parsePresenceBroadcast(base)).toBeNull();
  });

  it("drops a missing / non-finite ts (stale-out-of-order protection)", () => {
    const base = { userId: VALID_UUID, mode: "online", lastSeenAt: iso(1_000) };
    expect(parsePresenceBroadcast(base)).toBeNull();
    expect(parsePresenceBroadcast({ ...base, ts: Number.NaN })).toBeNull();
    expect(parsePresenceBroadcast({ ...base, ts: Number.POSITIVE_INFINITY })).toBeNull();
    expect(parsePresenceBroadcast({ ...base, ts: "now" })).toBeNull();
  });
});

describe("throttling invariants (pure constants)", () => {
  it("the away threshold is > 2× the heartbeat throttle — an active user never flaps", () => {
    expect(COMMUNITY_AWAY_AFTER_MS).toBeGreaterThan(2 * PRESENCE_THROTTLE_MS);
  });

  it("the freshness window is > 2× the heartbeat throttle — one missed beat never offlines", () => {
    expect(PRESENCE_WINDOW_MS).toBeGreaterThan(2 * PRESENCE_THROTTLE_MS);
  });

  it("all cadence constants are finite positive values", () => {
    for (const ms of [PRESENCE_WINDOW_MS, COMMUNITY_AWAY_AFTER_MS, PRESENCE_THROTTLE_MS]) {
      expect(Number.isFinite(ms)).toBe(true);
      expect(ms).toBeGreaterThan(0);
    }
  });
});
