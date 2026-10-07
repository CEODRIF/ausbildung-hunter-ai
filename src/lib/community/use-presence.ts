"use client";

/**
 * Community Phase 3 — the presence heartbeat hook (ONE instance per shell).
 *
 * The only periodic traffic in the community is this heartbeat, and it
 * follows the sanctioned model:
 *   - activity (pointer / keyboard / scroll / touch / navigation) updates a
 *     LOCAL timestamp — it never triggers a per-event network request;
 *   - one throttled write per PRESENCE_THROTTLE_MS (30 s) while the tab is
 *     VISIBLE (server rate-limited to 60/min per user on top);
 *   - hidden tabs do NOT heartbeat aggressively (the visibility flip and
 *     the next visible tick re-evaluate immediately);
 *   - an away → online activity flip flushes one immediate write (bounded:
 *     at most one per throttle window);
 *   - network return (window "online") flushes one immediate write;
 *   - manual DND / Away / Online (setMode) is an explicit write.
 *
 * After each successful write the hook publishes on the PER-USER channel
 * community-presence-<myId> (only that user's DM peer / profile card
 * subscribe) — there is no global presence channel. Users with
 * show_presence = false publish nothing, so the stream cannot leak hidden
 * presence.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  setPresenceMode,
  setShowPresence,
  touchCommunityPresence,
} from "@/app/community/actions";
import {
  declaredModeForActivity,
  isPresenceMode,
  PRESENCE_BROADCAST_CHANNEL,
  PRESENCE_BROADCAST_EVENT,
  PRESENCE_THROTTLE_MS,
  type PresenceMode,
} from "@/lib/community/presence";

export interface UseCommunityPresenceArgs {
  myId: string;
  /** The stored declared mode (the page server reads the own profile row). */
  initialMode: PresenceMode;
  /** The "show my online status" privacy toggle. */
  showPresence: boolean;
  /** Flips showPresence in the parent (after a successful server write). */
  onShowPresenceChanged?: (show: boolean) => void;
}

export interface UseCommunityPresence {
  /** The local declared mode (what the shell's controls + UI render). */
  mode: PresenceMode;
  showPresence: boolean;
  /** Manual presence control (DND / Away / Online) — an explicit write. */
  setMode: (mode: PresenceMode) => void;
  toggleShowPresence: () => void;
}

type PresenceChannel = {
  send: (opts: { type: string; event: string; payload: unknown }) => { error?: unknown };
  unsubscribe: () => void;
};

export function useCommunityPresence({
  myId,
  initialMode,
  showPresence: initialShow,
  onShowPresenceChanged,
}: UseCommunityPresenceArgs): UseCommunityPresence {
  const [mode, setModeState] = useState<PresenceMode>(initialMode);
  const [showPresence, setShowPresenceState] = useState<boolean>(initialShow);

  // Seeded in the mount effect (a render-phase Date.now() is impure): 0 =
  // "not started yet", which can never reach the activity math — the first
  // heartbeat and every listener are wired inside that same effect.
  const lastActivityRef = useRef<number>(0);
  const lastSentRef = useRef<number>(0);
  const sentModeRef = useRef<PresenceMode>(initialMode);
  const modeRef = useRef<PresenceMode>(initialMode);
  const showRef = useRef<boolean>(initialShow);
  const channelRef = useRef<PresenceChannel | null>(null);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);
  useEffect(() => {
    showRef.current = showPresence;
  }, [showPresence]);

  const publish = useCallback(
    (sentMode: PresenceMode) => {
      if (!showRef.current) return; // hidden presence publishes nothing
      const channel = channelRef.current;
      if (!channel) return;
      try {
        channel.send({
          type: "broadcast",
          event: PRESENCE_BROADCAST_EVENT,
          payload: {
            userId: myId,
            mode: sentMode,
            lastSeenAt: new Date().toISOString(),
            ts: Date.now(),
          },
        });
      } catch (error) {
        console.error("[community] presence broadcast failed:", error);
      }
    },
    [myId],
  );

  const send = useCallback(
    async (immediate: boolean) => {
      const now = Date.now();
      if (document.visibilityState !== "visible") return;
      if (!immediate && now - lastSentRef.current < PRESENCE_THROTTLE_MS) return;
      const next = declaredModeForActivity(lastActivityRef.current, modeRef.current, now);
      if (!immediate && next === sentModeRef.current) return; // nothing changed
      lastSentRef.current = now;
      sentModeRef.current = next;
      if (next !== modeRef.current) {
        modeRef.current = next;
        setModeState(next);
      }
      // Server-stamped + rate-limited; never throws (presence is chrome).
      await touchCommunityPresence(next);
      publish(next);
    },
    [publish],
  );

  // Activity: LOCAL timestamp only. A flip away → online flushes the new
  // mode immediately (bounded by the throttle: one extra write max).
  const onActivity = useCallback(() => {
    const now = Date.now();
    const wasSentAway = sentModeRef.current === "away";
    lastActivityRef.current = now;
    if (
      wasSentAway &&
      document.visibilityState === "visible" &&
      now - lastSentRef.current >= PRESENCE_THROTTLE_MS
    ) {
      void send(true);
    }
  }, [send]);

  const setMode = useCallback(
    (next: PresenceMode) => {
      if (!isPresenceMode(next)) return;
      modeRef.current = next;
      sentModeRef.current = next;
      setModeState(next);
      lastActivityRef.current = Date.now();
      lastSentRef.current = Date.now(); // explicit write just happened
      void (async () => {
        await setPresenceMode(next);
        publish(next);
      })();
    },
    [publish],
  );

  const toggleShowPresence = useCallback(() => {
    const next = !showRef.current;
    showRef.current = next;
    setShowPresenceState(next);
    onShowPresenceChanged?.(next);
    void setShowPresence(next);
    if (next) void send(true); // re-appear: report immediately
    // Hiding: simply stop publishing — stale broadcasts age out through
    // the 2-minute freshness window (no farewell event, no extra write).
  }, [onShowPresenceChanged, send]);

  // The heartbeat + activity listeners (the single sanctioned timer of
  // the hook — the messenger components themselves stay interval-free).
  useEffect(() => {
    let disposed = false;
    lastActivityRef.current = Date.now(); // start the activity clock on mount
    const tick = () => {
      if (!disposed) void send(false);
    };
    void send(true); // opening community: report immediately
    const interval = window.setInterval(tick, PRESENCE_THROTTLE_MS);
    const onVisibility = () => {
      if (document.visibilityState === "visible") void send(true);
    };
    const onOnline = () => {
      // Network returned (sleep/wake/airplane): resync presence state.
      void send(true);
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", onOnline);
    window.addEventListener("pointerdown", onActivity, { passive: true });
    window.addEventListener("keydown", onActivity, { passive: true });
    window.addEventListener("scroll", onActivity, { passive: true });
    window.addEventListener("touchstart", onActivity, { passive: true });
    return () => {
      disposed = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("pointerdown", onActivity);
      window.removeEventListener("keydown", onActivity);
      window.removeEventListener("scroll", onActivity);
      window.removeEventListener("touchstart", onActivity);
    };
  }, [onActivity, send]);

  // The per-user broadcast channel (PUBLISH only — peer presence is
  // consumed by the DM chat / profile card on their own subscriptions).
  useEffect(() => {
    let disposed = false;
    let client: ReturnType<typeof createClient>;
    try {
      client = createClient();
    } catch (error) {
      console.error("[community] realtime client unavailable:", error);
      return;
    }
    void (async () => {
      try {
        await client.auth.initialize();
      } catch {
        /* session restore failure: publishing stays off */
      }
      if (disposed) return;
      const {
        data: { session },
      } = await client.auth.getSession();
      if (disposed || !session?.access_token) return;
      try {
        channelRef.current = client
          .channel(PRESENCE_BROADCAST_CHANNEL(myId))
          .subscribe() as unknown as PresenceChannel;
      } catch (error) {
        console.error("[community] presence channel failed:", error);
      }
    })();
    return () => {
      disposed = true;
      if (channelRef.current) {
        try {
          channelRef.current.unsubscribe();
        } catch {
          /* already gone */
        }
        channelRef.current = null;
      }
    };
  }, [myId]);

  return { mode, showPresence, setMode, toggleShowPresence };
}
