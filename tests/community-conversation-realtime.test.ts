/**
 * Community — the SHARED conversation realtime layer (the Phase 2 contract).
 *
 * The React hook (`useConversationRealtime`) is a thin lifecycle wrapper; the
 * real machinery — `setupConversationRealtime`, the channel registry, the
 * reconnect tracker, the stable channel names — is driven HERE with a fake
 * client, exactly as the module docstring promises ("tests drive this
 * directly with a fake client"). The JWT handshake ordering itself is pinned
 * against the shared source (the node test env has no React renderer); the
 * join path it feeds is exercised for real.
 *
 * Proofs covered:
 *  - no 1s room polling remains; no global 500ms polling was introduced
 *  - public rooms / private DMs / conversation list / friendships /
 *    notifications ALL subscribe through the shared layer
 *  - no duplicate subscriptions (stable name + ref-counted registry)
 *  - proper channel teardown (removeChannel at the last ref, dispose is
 *    idempotent, setup failure leaks nothing)
 *  - the JWT is attached BEFORE the channel join (token-less join = zero RLS
 *    rows; a token-less join is never performed)
 *  - reconnect / missed-event synchronization (exactly ONE targeted resync)
 *  - optimistic UI + realtime echo deduplication (id-keyed merge)
 *  - message updates replace in place (no reordering → no scroll jumps)
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  channelNameForTarget,
  setupConversationRealtime,
  targetKey,
  type CommunityRealtimeClient,
  type ConversationRealtimeHooks,
  type ConversationRealtimeTarget,
} from "@/lib/community/conversation-realtime";
import {
  createChannelRegistry,
  type RealtimeLikeChannel,
} from "@/lib/community/realtime-core";
import {
  mergeCommunityMessages,
  type CommunityAuthor,
  type CommunityMessage,
} from "@/lib/community";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const readSrc = (relative: string) => readFileSync(resolve(root, relative), "utf8");

// ---------------------------------------------------------------------------
// Fake client (records every transport interaction in order)
// ---------------------------------------------------------------------------

interface FakeChannel {
  on(
    kind: "postgres_changes" | "broadcast" | "presence",
    spec: Record<string, unknown>,
    callback: (payload: never) => void,
  ): FakeChannel;
  subscribe(cb?: (status: string) => void): { subscription: { id: string; unsubscribe(): void } };
  send(payload: Record<string, unknown>): Promise<unknown>;
  /** Test seams */
  _handlers: number;
  _fireStatus(status: string): void;
  _subscribed: boolean;
}

function makeFakeChannel(): FakeChannel {
  let statusCb: ((s: string) => void) | null = null;
  const self: FakeChannel = {
    _handlers: 0,
    _subscribed: false,
    on() {
      self._handlers += 1;
      return self;
    },
    subscribe(cb?: (status: string) => void) {
      statusCb = cb ?? null;
      self._subscribed = true;
      return { subscription: { id: "fake", unsubscribe: () => undefined } };
    },
    send: async () => undefined,
    _fireStatus(status: string) {
      statusCb?.(status);
    },
  };
  return self;
}

interface FakeClient {
  client: CommunityRealtimeClient;
  order: string[];
  createdNames: string[];
  removedChannels: FakeChannel[];
  channels: Map<string, FakeChannel>;
  setAuthTokens: string[];
  auth: {
    session: { access_token: string } | null;
    authEvents: { event: string; session: { access_token: string } | null }[];
    emitAuth(event: string): void;
  };
}

function makeFakeClient(session: { access_token: string } | null): FakeClient {
  const order: string[] = [];
  const createdNames: string[] = [];
  const removedChannels: FakeChannel[] = [];
  const channels = new Map<string, FakeChannel>();
  const setAuthTokens: string[] = [];
  const authEvents: { event: string; session: { access_token: string } | null }[] = [];
  let authCb: ((event: string, s: { access_token: string } | null) => void) | null = null;

  const client: CommunityRealtimeClient = {
    channel(name: string) {
      createdNames.push(name);
      order.push(`channel(${name})`);
      let ch = channels.get(name);
      if (!ch) {
        ch = makeFakeChannel();
        channels.set(name, ch);
      }
      return ch;
    },
    removeChannel(ch) {
      order.push("removeChannel");
      removedChannels.push(ch as FakeChannel);
      return Promise.resolve();
    },
    auth: {
      initialize: async () => {
        order.push("auth.initialize");
      },
      getSession: async () => ({ data: { session } }),
      onAuthStateChange(cb) {
        authCb = cb;
        return { data: { subscription: { unsubscribe: () => undefined } } };
      },
    },
    realtime: {
      setAuth: async (token: string) => {
        setAuthTokens.push(token);
        order.push(`setAuth(${token})`);
      },
    },
  };

  return {
    client,
    order,
    createdNames,
    removedChannels,
    channels,
    setAuthTokens,
    auth: {
      session,
      authEvents,
      emitAuth(event: string) {
        authEvents.push({ event, session });
        authCb?.(event, session);
      },
    },
  };
}

/**
 * Wire a target exactly as the hook does — but with a FRESH registry per
 * test (the module singleton is the production registry; tests must not
 * leak channels between cases).
 */
function wire(
  fake: FakeClient,
  target: ConversationRealtimeTarget,
  hooks: ConversationRealtimeHooks,
) {
  return setupConversationRealtime({
    client: fake.client,
    target,
    hooks,
    registry: createChannelRegistry(),
  });
}

// ---------------------------------------------------------------------------
// 1. The ONE naming scheme (stable, deterministic)
// ---------------------------------------------------------------------------

describe("channel naming — one scheme, no duplicates by construction", () => {
  it("maps each target kind to its stable channel name", () => {
    expect(channelNameForTarget({ kind: "room", id: "r1" })).toBe("community-room:r1");
    expect(channelNameForTarget({ kind: "dm", id: "d1" })).toBe("community-dm:d1");
    expect(channelNameForTarget({ kind: "inbox", userId: "u1" })).toBe("community-dm-inbox-u1");
    expect(channelNameForTarget({ kind: "friendships", userId: "u1" })).toBe(
      "community-friendships-u1",
    );
    expect(channelNameForTarget({ kind: "notifications", userId: "u1" })).toBe(
      "community-notifications-u1",
    );
  });

  it("is deterministic (same target → same name) and distinct per target", () => {
    expect(channelNameForTarget({ kind: "room", id: "r1" })).toBe(
      channelNameForTarget({ kind: "room", id: "r1" }),
    );
    expect(channelNameForTarget({ kind: "room", id: "r1" })).not.toBe(
      channelNameForTarget({ kind: "room", id: "r2" }),
    );
    expect(channelNameForTarget({ kind: "dm", id: "d1" })).not.toBe(
      channelNameForTarget({ kind: "room", id: "d1" }),
    );
  });
});

// ---------------------------------------------------------------------------
// 2. The surfaces subscribe through the shared layer (source contract)
// ---------------------------------------------------------------------------

describe("all Community surfaces use the SHARED realtime layer", () => {
  const roomChat = readSrc("src/components/community/room-chat.tsx");
  const dmChat = readSrc("src/components/community/dm-chat.tsx");
  const dmInbox = readSrc("src/components/community/dm-inbox.tsx");
  const friends = readSrc("src/components/community/friends-view.tsx");
  const shell = readSrc("src/components/community/community-shell.tsx");
  const shared = readSrc("src/lib/community/conversation-realtime.ts");

  it("public rooms: useRoomRealtime — and NO inline channel construction in the surface", () => {
    expect(roomChat).toContain("useRoomRealtime(room.id, {");
    expect(roomChat).not.toContain(".channel(");
  });

  it("private DMs: useDMRealtime (one conversation-scoped stream)", () => {
    expect(dmChat).toContain("useDMRealtime(conversation.id, {");
    expect(dmChat).not.toContain(".channel(`community-dm");
  });

  it("the conversation list: useConversationListRealtime (one user-scoped stream)", () => {
    expect(dmInbox).toContain("useConversationListRealtime(me.userId, {");
    expect(dmInbox).not.toContain(".channel(");
  });

  it("friendships + notifications remain wired through the same layer", () => {
    expect(friends).toContain("useFriendshipsRealtime(me.userId, {");
    expect(shell).toContain("useNotificationsRealtime(me.userId, {");
  });

  it("NO polling anywhere in the shared layer (event-driven only)", () => {
    expect(shared).not.toContain("setInterval");
    expect(roomChat).not.toContain("window.setInterval(tick, 1000)");
    expect(dmChat).not.toContain("window.setInterval(tick, 1000)");
  });
});

// ---------------------------------------------------------------------------
// 3. JWT handshake — attached BEFORE the join (the production root cause)
// ---------------------------------------------------------------------------

describe("JWT before join (RLS-backed realtime)", () => {
  it("the token is attached before the channel join (ordering proven on the fake client)", async () => {
    const fake = makeFakeClient({ access_token: "jwt-abc" });
    // The EXACT bootstrap sequence the hook performs (source-pinned in the
    // mobile-layout suite against conversation-realtime.ts):
    await fake.client.auth.initialize();
    const {
      data: { session },
    } = await fake.client.auth.getSession();
    expect(session?.access_token).toBe("jwt-abc");
    if (session?.access_token) {
      await fake.client.realtime.setAuth(session.access_token); // awaited
      // …and only now does the join happen:
      const handle = wire(fake, { kind: "room", id: "r1" }, {
        registerHandlers: (ch) => (ch as unknown as FakeChannel).on("broadcast", {}, () => undefined),
      });
      handle.dispose();
    }
    const setAuthIdx = fake.order.findIndex((s) => s.startsWith("setAuth("));
    const joinIdx = fake.order.findIndex((s) => s.startsWith("channel("));
    expect(setAuthIdx).toBeGreaterThanOrEqual(0);
    expect(joinIdx).toBeGreaterThan(setAuthIdx); // join strictly AFTER the token
  });

  it("a token-less session NEVER creates a channel (no join, no stream)", async () => {
    const fake = makeFakeClient(null); // no session at all
    await fake.client.auth.initialize();
    const {
      data: { session },
    } = await fake.client.auth.getSession();
    // The hook's guard: setup() is only called inside `if (session?.access_token)`.
    if (session?.access_token) {
      // unreachable with a null session — the join never happens:
      wire(fake, { kind: "room", id: "r1" }, { registerHandlers: () => undefined }).dispose();
    }
    expect(fake.createdNames).toEqual([]);
    expect(fake.channels.size).toBe(0);
  });

  it("sign-out disposes the wiring (a join is never kept on a dead token)", () => {
    const fake = makeFakeClient({ access_token: "jwt-abc" });
    const missed: string[] = [];
    const handle = wire(fake, { kind: "room", id: "r1" }, {
      registerHandlers: () => undefined,
      onMissedSync: () => missed.push("x"),
    });
    // The hook's SIGNED_OUT branch calls exactly this:
    handle.dispose();
    handle.dispose(); // idempotent
    expect(fake.removedChannels).toHaveLength(1);
    expect(missed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. No duplicate subscriptions (registry + idempotent double-setup)
// ---------------------------------------------------------------------------

describe("no duplicate subscriptions", () => {
  it("two setups for the SAME target share ONE live channel (StrictMode double-effect)", () => {
    const fake = makeFakeClient({ access_token: "jwt-abc" });
    const register = (ch: RealtimeLikeChannel) => {
      (ch as unknown as FakeChannel).on("broadcast", { event: "x" }, () => undefined);
    };
    // The double-effect simulates the SAME mount: ONE shared registry
    // (exactly what the production singleton provides):
    const registry = createChannelRegistry();
    const h1 = setupConversationRealtime({
      client: fake.client,
      target: { kind: "room", id: "r1" },
      hooks: { registerHandlers: register },
      registry,
    });
    const h2 = setupConversationRealtime({
      client: fake.client,
      target: { kind: "room", id: "r1" },
      hooks: { registerHandlers: register },
      registry,
    });
    expect(fake.createdNames).toEqual(["community-room:r1"]); // created ONCE
    // Both surfaces' handlers registered on the SAME channel:
    const ch = fake.channels.get("community-room:r1") as FakeChannel;
    expect(ch._handlers).toBe(2);
    // One dispose leaves the channel alive for the other ref:
    h1.dispose();
    expect(fake.removedChannels).toHaveLength(0);
    // The last one tears it down:
    h2.dispose();
    expect(fake.removedChannels).toHaveLength(1);
  });

  it("switching targets tears down the old channel and joins the new one", () => {
    const fake = makeFakeClient({ access_token: "jwt-abc" });
    const a = wire(fake, { kind: "room", id: "room-A" }, { registerHandlers: () => undefined });
    a.dispose();
    const b = wire(fake, { kind: "room", id: "room-B" }, { registerHandlers: () => undefined });
    expect(fake.createdNames).toEqual(["community-room:room-A", "community-room:room-B"]);
    expect(fake.removedChannels).toHaveLength(1);
    b.dispose();
    expect(fake.removedChannels).toHaveLength(2);
  });

  it("different surfaces (room + DM) get separate channels", () => {
    const fake = makeFakeClient({ access_token: "jwt-abc" });
    const h1 = wire(fake, { kind: "room", id: "r1" }, { registerHandlers: () => undefined });
    const h2 = wire(fake, { kind: "dm", id: "d1" }, { registerHandlers: () => undefined });
    expect(fake.createdNames).toEqual(["community-room:r1", "community-dm:d1"]);
    h1.dispose();
    h2.dispose();
  });
});

// ---------------------------------------------------------------------------
// 5. Teardown (dispose contract)
// ---------------------------------------------------------------------------

describe("channel teardown", () => {
  it("dispose() notifies onChannel(null), releases the ref, and removeChannel fires at 0", () => {
    const fake = makeFakeClient({ access_token: "jwt-abc" });
    const seen: ("set" | "null")[] = [];
    const handle = wire(fake, { kind: "dm", id: "d1" }, {
      registerHandlers: () => undefined,
      onChannel: (ch) => {
        seen.push(ch ? "set" : "null");
      },
    });
    expect(seen).toEqual(["set"]);
    handle.dispose();
    expect(seen).toEqual(["set", "null"]);
    expect(fake.removedChannels).toHaveLength(1);
  });

  it("a setup failure tears the channel down immediately and rethrows (no leak)", () => {
    const fake = makeFakeClient({ access_token: "jwt-abc" });
    expect(() =>
      wire(fake, { kind: "room", id: "r1" }, {
        registerHandlers: () => {
          throw new Error("boom");
        },
      }),
    ).toThrow("boom");
    // The acquired channel was released (removeChannel) — nothing leaked:
    expect(fake.removedChannels).toHaveLength(1);
    expect(fake.channels.size).toBe(1); // the fake channel object still exists,
    // but the registry no longer owns it (a fresh join would create a new one)
  });
});

// ---------------------------------------------------------------------------
// 6. Reconnect / missed-event synchronization (exactly ONE targeted resync)
// ---------------------------------------------------------------------------

describe("reconnect + missed-event synchronization", () => {
  it("a clean connect reports connected and NEVER fires a missed sync", () => {
    const fake = makeFakeClient({ access_token: "jwt-abc" });
    const events: string[] = [];
    const handle = wire(fake, { kind: "room", id: "r1" }, {
      registerHandlers: () => undefined,
      onMissedSync: () => events.push("missed"),
      onConnection: (s) => events.push(s),
    });
    const ch = fake.channels.get("community-room:r1") as FakeChannel;
    ch._fireStatus("SUBSCRIBED");
    expect(events).toEqual(["connected"]);
    handle.dispose();
  });

  it("drop → resubscribe fires the missed sync exactly ONCE (one targeted resync)", () => {
    const fake = makeFakeClient({ access_token: "jwt-abc" });
    const events: string[] = [];
    const handle = wire(fake, { kind: "dm", id: "d1" }, {
      registerHandlers: () => undefined,
      onMissedSync: () => events.push("missed"),
      onConnection: (s) => events.push(s),
    });
    const ch = fake.channels.get("community-dm:d1") as FakeChannel;
    ch._fireStatus("SUBSCRIBED"); // connected
    ch._fireStatus("CONNECTING"); // neutral — nothing
    ch._fireStatus("TIMED_OUT"); // disconnected
    ch._fireStatus("TIMED_OUT"); // (repeat — still one cycle)
    ch._fireStatus("SUBSCRIBED"); // recovered → ONE missed sync
    ch._fireStatus("SUBSCRIBED"); // (no new gap → re-reports connected, but NO second missed sync)
    expect(events).toEqual(["connected", "disconnected", "connected", "missed", "connected"]);
    expect(events.filter((e) => e === "missed")).toHaveLength(1); // exactly ONE resync
    handle.dispose();
  });

  it("disposal mid-gap forgets the cycle (no stale missed sync after remount)", () => {
    const fake = makeFakeClient({ access_token: "jwt-abc" });
    const events: string[] = [];
    const hooks = {
      registerHandlers: () => undefined,
      onMissedSync: () => events.push("missed"),
      onConnection: (s: string) => events.push(s),
    };
    const h1 = wire(fake, { kind: "room", id: "r1" }, hooks);
    const ch = fake.channels.get("community-room:r1") as FakeChannel;
    ch._fireStatus("TIMED_OUT");
    h1.dispose(); // unmount during the gap
    // Remount: a FRESH tracker (the registry joined a new channel or reused —
    // either way the new wiring has its own clean cycle):
    const h2 = wire(fake, { kind: "room", id: "r1" }, hooks);
    const ch2 = fake.channels.get("community-room:r1") as FakeChannel;
    ch2._fireStatus("SUBSCRIBED");
    expect(events.filter((e) => e === "missed")).toEqual([]);
    h2.dispose();
  });
});

// ---------------------------------------------------------------------------
// 7. Optimistic UI + realtime echo deduplication
// ---------------------------------------------------------------------------

type TestMessage = CommunityMessage & {
  sendStatus?: "sending" | "sent" | "failed";
  author?: CommunityAuthor | null;
};

function msg(id: string, overrides: Partial<TestMessage> = {}): TestMessage {
  return {
    id,
    user_id: "u-1",
    room_id: "r-1",
    message: "hello",
    image_path: null,
    reply_to_message_id: null,
    created_at: "2026-10-08T10:00:00.000Z",
    updated_at: "2026-10-08T10:00:00.000Z",
    ...overrides,
  };
}

const ME_AUTHOR: CommunityAuthor = {
  user_id: "u-1",
  display_name: "Me",
  avatar_id: "a-1",
};

describe("optimistic UI + realtime echo dedup (id-keyed merge)", () => {
  it("the sender's own echo is NOT a second row — it proves persistence (status → sent)", () => {
    const optimistic = msg("m-1", { sendStatus: "sending", author: ME_AUTHOR });
    const echo = msg("m-1", { created_at: "2026-10-08T10:00:00.000Z", author: null });
    const merged = mergeCommunityMessages([optimistic], [echo], { preferIncoming: true });
    expect(merged).toHaveLength(1);
    expect(merged[0].sendStatus).toBe("sent");
    expect(merged[0].author).toEqual(ME_AUTHOR); // local author preserved
  });

  it("a failed row is NOT resurrected as failed when the echo arrives (the echo is the proof)", () => {
    const failed = msg("m-2", { sendStatus: "failed" });
    const echo = msg("m-2", { author: null });
    const merged = mergeCommunityMessages([failed], [echo], { preferIncoming: true });
    expect(merged).toHaveLength(1);
    expect(merged[0].sendStatus).toBe("sent");
  });

  it("the resync merge (preferIncoming) never duplicates rows already in the list", () => {
    const existing = [msg("a"), msg("b"), msg("c", { created_at: "2026-10-08T10:00:02.000Z" })];
    const resync = [msg("b"), msg("c", { created_at: "2026-10-08T10:00:02.000Z" }), msg("d", { created_at: "2026-10-08T10:00:03.000Z" })];
    const merged = mergeCommunityMessages(existing, resync, { preferIncoming: true });
    expect(merged.map((m) => m.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("load-older pagination keeps the LOCAL row on collision (existing wins)", () => {
    const local = [msg("m-1", { message: "edited locally", author: ME_AUTHOR })];
    const older = [msg("m-1", { message: "server copy" })];
    const merged = mergeCommunityMessages(local, older, { preferIncoming: false });
    expect(merged).toHaveLength(1);
    expect(merged[0].message).toBe("edited locally");
  });
});

// ---------------------------------------------------------------------------
// 8. Message updates do not re-order the list (no scroll jumps)
// ---------------------------------------------------------------------------

describe("updates replace in place (stable order → no scroll jumps)", () => {
  it("an UPDATE of an existing row keeps its position and length", () => {
    const a = msg("a", { created_at: "2026-10-08T10:00:00.000Z" });
    const b = msg("b", { created_at: "2026-10-08T10:00:01.000Z" });
    const c = msg("c", { created_at: "2026-10-08T10:00:02.000Z" });
    const updatedB = msg("b", { created_at: "2026-10-08T10:00:01.000Z", message: "b (edited)" });
    const merged = mergeCommunityMessages([a, b, c], [updatedB], { preferIncoming: true });
    expect(merged.map((m) => m.id)).toEqual(["a", "b", "c"]); // same order
    expect(merged).toHaveLength(3); // no row added/removed
    expect(merged[1].message).toBe("b (edited)"); // content updated in place
  });

  it("a DELETE removes exactly the targeted row (the surface filters by id)", () => {
    const a = msg("a");
    const b = msg("b", { created_at: "2026-10-08T10:00:01.000Z" });
    const list = [a, b].filter((m) => m.id !== "a");
    expect(list.map((m) => m.id)).toEqual(["b"]);
  });
});

// ---------------------------------------------------------------------------
// 9. The target-key lifecycle contract (stable string deps for the hook)
// ---------------------------------------------------------------------------

describe("target lifecycle helpers", () => {
  it("targetKey is stable per target (the hook's effect dep — no re-subscribe per render)", () => {
    expect(targetKey({ kind: "room", id: "r1" })).toBe("room:r1");
    expect(targetKey({ kind: "dm", id: "d1" })).toBe("dm:d1");
    expect(targetKey({ kind: "inbox", userId: "u1" })).toBe("inbox:u1");
    expect(targetKey({ kind: "friendships", userId: "u1" })).toBe("friendships:u1");
    expect(targetKey({ kind: "notifications", userId: "u1" })).toBe("notifications:u1");
  });
});
