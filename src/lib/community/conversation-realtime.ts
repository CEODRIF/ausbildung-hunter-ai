"use client";

/**
 * Community — the shared conversation realtime layer (hooks).
 *
 * ONE subscription path for every Community conversation surface. Each
 * surface supplies (a) its target (room / DM / inbox / friendships /
 * notifications) and (b) handlers that apply events to local state. This
 * module owns everything around them:
 *
 *   - the STABLE channel name (derived from the target — the same room or
 *     conversation always maps to the same Supabase channel topic);
 *   - the channel REGISTRY (one live channel per name, ref-counted — no
 *     duplicate subscriptions, no orphaned channels after unmount or
 *     room/DM switches);
 *   - the JWT handshake (the join payload must carry the token from its
 *     first byte — a token-less join streams zero RLS rows; a no-session
 *     join never happens);
 *   - the RECONNECT tracker (disconnect → resubscribe window = exactly ONE
 *     targeted missed-sync callback — never periodic polling);
 *   - teardown (removeChannel via the registry, auth-sub cleanup,
 *     onChannel(null)).
 *
 * Event deduplication by message UUID and the ≤500ms coalescing happen in
 * the surface handlers (they own the message state) using the pure
 * primitives from `realtime-core` (createEventBatcher) and
 * `mergeCommunityMessages` (id-keyed, order-preserving).
 */

import { useEffect, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  communityChannelRegistry,
  createReconnectTracker,
  type ChannelRegistry,
  type RealtimeLikeAuth,
  type RealtimeLikeChannel,
  type RealtimeLikeClient,
  type RealtimeLikeRealtime,
} from "./realtime-core";

/**
 * The full client the hook drives: the channel slice (core primitives) plus
 * the auth/realtime transport slices (the JWT handshake). The supabase
 * client satisfies this structurally.
 */
export type CommunityRealtimeClient = RealtimeLikeClient & {
  auth: RealtimeLikeAuth;
  realtime: RealtimeLikeRealtime;
};

// ---------------------------------------------------------------------------
// Targets + stable channel names
// ---------------------------------------------------------------------------

export type ConversationRealtimeTarget =
  | { kind: "room"; id: string }
  | { kind: "dm"; id: string }
  | { kind: "inbox"; userId: string }
  | { kind: "friendships"; userId: string }
  | { kind: "notifications"; userId: string };

/**
 * The ONE naming scheme — every Community channel name is derived here so
 * two surfaces can never create two channels for the same conversation.
 */
export function channelNameForTarget(target: ConversationRealtimeTarget): string {
  switch (target.kind) {
    case "room":
      return `community-room:${target.id}`;
    case "dm":
      return `community-dm:${target.id}`;
    case "inbox":
      return `community-dm-inbox-${target.userId}`;
    case "friendships":
      return `community-friendships-${target.userId}`;
    case "notifications":
      return `community-notifications-${target.userId}`;
  }
}

export function targetKey(target: ConversationRealtimeTarget): string {
  return target.kind === "room" || target.kind === "dm"
    ? `${target.kind}:${target.id}`
    : `${target.kind}:${target.userId}`;
}

// ---------------------------------------------------------------------------
// The memoized browser client (supabase-ssr memoizes createBrowserClient —
// one client, one socket, for the whole page)
// ---------------------------------------------------------------------------

let memoizedClient: CommunityRealtimeClient | null = null;
let clientResolutionFailed = false;

/** Resolve the shared realtime client (null when env is unavailable). */
export function resolveCommunityRealtimeClient(): CommunityRealtimeClient | null {
  if (memoizedClient) return memoizedClient;
  if (clientResolutionFailed) return null;
  try {
    memoizedClient = createClient() as unknown as CommunityRealtimeClient;
    return memoizedClient;
  } catch (error) {
    clientResolutionFailed = true;
    console.error("[community] realtime client unavailable:", error);
    return null;
  }
}

/** Test seam: reset the memoized client between test cases. */
export function _resetCommunityRealtimeClientForTests(): void {
  memoizedClient = null;
  clientResolutionFailed = false;
}

// ---------------------------------------------------------------------------
// Hooks (what the surfaces call)
// ---------------------------------------------------------------------------

export interface ConversationRealtimeHooks {
  /**
   * Register this surface's `postgres_changes` / `broadcast` handlers on
   * the shared channel. Called exactly once per setup, after the channel
   * exists.
   */
  registerHandlers: (channel: RealtimeLikeChannel) => void;
  /**
   * The channel is live again after a disconnect → resubscribe cycle.
   * Perform the ONE targeted synchronization here (recent-window resync /
   * summary refetch). Never poll.
   */
  onMissedSync?: () => void;
  /** Connection state flips (drives the "reconnecting" banner). */
  onConnection?: (state: "connected" | "disconnected") => void;
  /** The live channel for broadcasts (typing, message update/delete). */
  onChannel?: (channel: RealtimeLikeChannel | null) => void;
}

export interface ConversationRealtimeHandle {
  dispose(): void;
}

/**
 * Wire ONE target to the shared realtime layer (non-React core; the hook
 * below is a thin lifecycle wrapper and tests drive this directly with a
 * fake client).
 */
export function setupConversationRealtime(input: {
  client: RealtimeLikeClient;
  target: ConversationRealtimeTarget;
  hooks: ConversationRealtimeHooks;
  registry?: ChannelRegistry;
}): ConversationRealtimeHandle {
  const { client, target, hooks } = input;
  const registry = input.registry ?? communityChannelRegistry;
  const name = channelNameForTarget(target);
  const entry = registry.acquire(client, name);
  const tracker = createReconnectTracker({
    onMissedSync: hooks.onMissedSync,
    onConnection: hooks.onConnection,
  });

  try {
    hooks.registerHandlers(entry.channel);
    entry.channel.subscribe((status) => tracker.handleStatus(String(status)));
  } catch (error) {
    // A setup failure tears down the acquired channel immediately — it
    // must never reach an error boundary or leak a subscription.
    registry.release(client, name);
    tracker.reset();
    throw error;
  }

  hooks.onChannel?.(entry.channel);

  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      hooks.onChannel?.(null);
      tracker.reset();
      registry.release(client, name);
    },
  };
}

// ---------------------------------------------------------------------------
// The React hook (auth handshake + lifecycle)
// ---------------------------------------------------------------------------

/**
 * Subscribe a Community surface to its conversation target over the shared
 * realtime layer. Pass `null` (or drop the mount) to tear down.
 *
 * Lifecycle guarantees:
 *  - at most one live channel for `target` at any time (registry);
 *  - switching targets (room A → room B, DM x → DM y) disposes the old
 *    wiring and tears the old channel down when it holds no other refs;
 *  - unmount always disposes (no orphan subscriptions);
 *  - the join only happens with a JWT (auth initialized + session
 *    restored; SIGNED_OUT disposes the wiring);
 *  - after a missed window, `hooks.onMissedSync` fires exactly once.
 */
export function useConversationRealtime(
  target: ConversationRealtimeTarget | null,
  hooks: ConversationRealtimeHooks,
): void {
  // The latest hooks object, mirrored in an effect (the callbacks are
  // invoked OUTSIDE render — event-driven; the mirror runs before the
  // keyed setup effect in every commit, so setup always sees the current
  // render's callbacks).
  const hooksRef = useRef(hooks);
  useEffect(() => {
    hooksRef.current = hooks;
  });

  const key = target ? targetKey(target) : null;

  useEffect(() => {
    if (!target || !key) return;
    const client = resolveCommunityRealtimeClient();
    if (!client) return;

    let disposed = false;
    let handle: ConversationRealtimeHandle | null = null;

    const setup = () => {
      if (disposed || handle) return;
      try {
        handle = setupConversationRealtime({
          client,
          target: target as ConversationRealtimeTarget,
          hooks: hooksRef.current,
        });
      } catch (error) {
        console.error("[community] realtime setup failed:", error);
      }
    };

    void (async () => {
      try {
        await client.auth.initialize();
      } catch {
        /* session restore failure: the join stays pending (INITIAL_SESSION) */
      }
      if (disposed) return;
      const {
        data: { session },
      } = await client.auth.getSession();
      if (disposed) return;
      if (session?.access_token) {
        // Awaited on purpose: the join payload must carry the JWT from its
        // first byte — a token-less join streams zero RLS rows.
        await client.realtime.setAuth(session.access_token).catch(() => {});
        if (!disposed) setup();
      }
      // No session (yet): NEVER join without a JWT.
    })();

    const authSub = client.auth.onAuthStateChange((event, session) => {
      if (session?.access_token) {
        void client.realtime
          .setAuth(session.access_token)
          .then(() => {
            if (event === "INITIAL_SESSION" || event === "SIGNED_IN") setup();
          })
          .catch(() => {});
      } else if (event === "SIGNED_OUT" && handle) {
        handle.dispose();
        handle = null;
      }
    });

    return () => {
      disposed = true;
      authSub.data.subscription.unsubscribe();
      handle?.dispose();
      handle = null;
    };
    // The target is encoded in `key` (stable string deps — the effect must
    // NOT re-run on every render with an equal target object).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

// ---------------------------------------------------------------------------
// Convenience wrappers (the named hooks the surfaces use)
// ---------------------------------------------------------------------------

/** Subscribe to the open PUBLIC ROOM's events (one channel per room). */
export function useRoomRealtime(
  roomId: string | null,
  hooks: ConversationRealtimeHooks,
): void {
  useConversationRealtime(roomId ? { kind: "room", id: roomId } : null, hooks);
}

/** Subscribe to the open DM CONVERSATION's events (one channel per DM). */
export function useDMRealtime(
  conversationId: string | null,
  hooks: ConversationRealtimeHooks,
): void {
  useConversationRealtime(conversationId ? { kind: "dm", id: conversationId } : null, hooks);
}

/**
 * Subscribe to the CONVERSATION LIST (inbox) events — RLS delivers the
 * viewer's own conversations only; one stream per user, no per-DM
 * subscriptions.
 */
export function useConversationListRealtime(
  userId: string | null,
  hooks: ConversationRealtimeHooks,
): void {
  useConversationRealtime(userId ? { kind: "inbox", userId } : null, hooks);
}

/**
 * Subscribe to FRIENDSHIP / relationship events for the friends view
 * (requests, acceptances, removals, unblocks — the viewer's own rows).
 */
export function useFriendshipsRealtime(
  userId: string | null,
  hooks: ConversationRealtimeHooks,
): void {
  useConversationRealtime(userId ? { kind: "friendships", userId } : null, hooks);
}

/**
 * Subscribe to the viewer's NOTIFICATIONS (shell badge + toast bus) — the
 * ONE notifications channel for the whole Community.
 */
export function useNotificationsRealtime(
  userId: string | null,
  hooks: ConversationRealtimeHooks,
): void {
  useConversationRealtime(userId ? { kind: "notifications", userId } : null, hooks);
}
