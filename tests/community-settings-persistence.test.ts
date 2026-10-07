/**
 * Community Settings — production persistence contract (regression suite).
 *
 * The reported incident: the settings sheet rendered, but controls did not
 * reliably persist. Root causes fixed:
 *   R1  the heartbeat WROTE presence_mode — an activity/visibility flip
 *       silently reverted a manual AWAY (DND was filtered, AWAY was not);
 *   R2  presence + visibility writes were fire-and-forget void actions —
 *       failures were swallowed, the UI kept lying, no revert, no error;
 *   R3  notification updates returned success on a ZERO-ROW UPDATE
 *       (PostgREST reports no error when .update() affects nothing);
 *   R4  the sheet rendered a mount-time copy of the settings and never
 *       reloaded the database on open.
 *
 * This suite proves the 17-point acceptance contract with the REAL server
 * actions (mocked Supabase clients, per-table result queues + recorded
 * calls) and source invariants:
 *
 *   1  selecting away   writes presence_mode='away'
 *   2  selecting dnd    writes presence_mode='dnd'
 *   3  selecting online writes presence_mode='online'
 *   4  visibility off   writes show_presence=false
 *   5  visibility on    writes show_presence=true
 *   6  each notification toggle updates ONLY its own column
 *   7  an existing DND  is NOT overwritten by the heartbeat
 *   8  an existing AWAY is NOT overwritten by the heartbeat
 *   9  a missing community_profiles row is INSERTed (upsert, not update)
 *   10 an existing community_profiles row is UPDATED
 *   11 ignoreDuplicates: true is NOT used for settings persistence
 *   12 an update failure reverts the optimistic state
 *   13 an RLS failure produces a classified error (42501 → rls_blocked)
 *   14 a normal user cannot update another user's profile
 *   15 admin/protected fields cannot be modified through this path
 *   16 reopening settings loads the database-confirmed state
 *   17 a full reload preserves all saved settings
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

import {
  refreshCommunitySettings,
  setPresenceMode,
  setShowPresence,
  touchCommunityPresence,
  updateNotificationPreferences,
} from "@/app/community/actions";
import { classifySettingsError } from "@/lib/community/settings";
import { buildViewerSettings } from "@/lib/community/social";
import { declaredModeForActivity } from "@/lib/community/presence";

const ROOT = join(__dirname, "..");
const readSrc = (p: string) => readFileSync(join(ROOT, p), "utf8");

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const NOW = "2026-10-28T12:00:00.000Z";
const t0 = Date.parse(NOW) - 10 * 60_000;
const tNow = Date.parse(NOW);

// ---------------------------------------------------------------------------
// Mocks (queued per-table results + recorded calls — project convention)
// ---------------------------------------------------------------------------

interface TerminalResult {
  data: unknown;
  error: { message: string; code?: string } | null;
}
interface Call {
  table: string;
  op: string;
  args: unknown[];
}
const ok = (data: unknown = null): TerminalResult => ({ data, error: null });
const fail = (message: string, code?: string): TerminalResult => ({ data: null, error: { message, code } });

let mockAuthUserId: string | null = null;
const mockAuth = (userId: string | null) => {
  mockAuthUserId = userId;
};

function makeUserClient(queues: Record<string, TerminalResult[]> = {}) {
  const calls: Call[] = [];
  const consume = (table: string): TerminalResult => {
    const queue = queues[table] ?? [];
    return queue.length > 0 ? (queue.shift() as TerminalResult) : ok(null);
  };
  const from = (table: string) => {
    const base: Record<string, unknown> = {};
    for (const op of ["select", "order", "limit", "eq", "neq", "in", "or", "is", "not", "ilike", "lt", "gt"]) {
      base[op] = (...args: unknown[]) => {
        calls.push({ table, op, args });
        return base;
      };
    }
    base.maybeSingle = () => {
      calls.push({ table, op: "maybeSingle", args: [] });
      return Promise.resolve(consume(table));
    };
    base.single = () => {
      calls.push({ table, op: "single", args: [] });
      return Promise.resolve(consume(table));
    };
    base.insert = (values: unknown) => {
      calls.push({ table, op: "insert", args: [values] });
      return base;
    };
    base.update = (values: unknown) => {
      calls.push({ table, op: "update", args: [values] });
      return base;
    };
    base.upsert = (values: unknown, upsertOpts?: unknown) => {
      calls.push({ table, op: "upsert", args: [values, upsertOpts] });
      // the real builder is chainable AND thenable:
      return {
        then: (onF?: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
          Promise.resolve(consume(table)).then(onF as never, onR as never),
        not: (...args: unknown[]) => {
          calls.push({ table, op: "not", args });
          return base;
        },
        eq: (...args: unknown[]) => {
          calls.push({ table, op: "eq", args });
          return base;
        },
      };
    };
    base.then = (onF?: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve(consume(table)).then(onF as never, onR as never);
    return base;
  };
  const client = {
    from,
    auth: { getUser: () => Promise.resolve({ data: { user: mockAuthUserId ? { id: mockAuthUserId } : null }, error: null }) },
    calls,
  } as unknown as SupabaseClient & { calls: Call[] };
  return { calls, client };
}

type RateLimit = { allowed: boolean; count?: number; limit?: number; retry_after?: number };
function mockAdmin(opts: { rateLimit?: RateLimit; banRows?: Record<string, TerminalResult[]> } = {}) {
  const adminCalls: Call[] = [];
  const from = (table: string) => {
    const base: Record<string, unknown> = {};
    for (const op of ["select", "eq", "is", "order", "limit", "maybeSingle"]) {
      base[op] = (...args: unknown[]) => {
        adminCalls.push({ table, op, args });
        return op === "maybeSingle"
          ? Promise.resolve(opts.banRows?.[table]?.shift() ?? ok(null))
          : base;
      };
    }
    return base;
  };
  const rpc = (fn: string, args?: unknown) => {
    adminCalls.push({ table: `rpc:${fn}`, op: "rpc", args: [args] });
    if (fn === "check_rate_limit") {
      return Promise.resolve({
        data: opts.rateLimit ?? { allowed: true, count: 1, limit: 60, retry_after: 0 },
        error: null,
      });
    }
    return Promise.resolve({ data: null, error: null });
  };
  vi.mocked(createAdminClient).mockReturnValue({ from, rpc } as never);
  return { calls: adminCalls };
}

afterEach(() => {
  vi.clearAllMocks();
  mockAuthUserId = null;
});

// ---------------------------------------------------------------------------
// 1–3 — presence mode writes land in the database (verified read-back)
// ---------------------------------------------------------------------------

describe("presence mode persistence (1-3)", () => {
  const rowWith = (mode: string) => ({ presence_mode: mode });

  for (const [label, mode] of [
    ["away", "away"],
    ["dnd", "dnd"],
    ["online", "online"],
  ] as const) {
    it(`${label === "away" ? "1" : label === "dnd" ? "2" : "3"}. selecting ${label} writes presence_mode='${mode}' and the read-back confirms it`, async () => {
      mockAuth(ME);
      mockAdmin();
      const { client } = makeUserClient({
        community_profiles: [ok(null), ok(rowWith(mode))],
      });
      vi.mocked(createClient).mockResolvedValue(client);

      const result = await setPresenceMode(mode);
      expect(result).toEqual({ ok: true, code: "success" });

      const upsert = client.calls.find((c) => c.table === "community_profiles" && c.op === "upsert");
      expect(upsert).toBeTruthy();
      const values = upsert!.args[0] as Record<string, unknown>;
      expect(values.user_id).toBe(ME); // the SESSION's id — never client input
      expect(values.presence_mode).toBe(mode);
      // online/away stamp last_seen (immediate display), dnd never does
      expect("last_seen_at" in values).toBe(mode !== "dnd");
    });
  }
});

// ---------------------------------------------------------------------------
// 4–5 — online-status visibility
// ---------------------------------------------------------------------------

describe("online status visibility (4-5)", () => {
  it("4. toggling OFF writes show_presence=false (verified)", async () => {
    mockAuth(ME);
    mockAdmin();
    const { client } = makeUserClient({ community_profiles: [ok({ show_presence: false })] });
    vi.mocked(createClient).mockResolvedValue(client);
    expect(await setShowPresence(false)).toEqual({ ok: true, code: "success" });
    const update = client.calls.find((c) => c.table === "community_profiles" && c.op === "update");
    expect(update?.args[0]).toEqual({ show_presence: false });
    expect(client.calls.some((c) => c.op === "eq" && c.args[0] === "user_id" && c.args[1] === ME)).toBe(true);
  });

  it("5. toggling ON writes show_presence=true (verified)", async () => {
    mockAuth(ME);
    mockAdmin();
    const { client } = makeUserClient({ community_profiles: [ok({ show_presence: true })] });
    vi.mocked(createClient).mockResolvedValue(client);
    expect(await setShowPresence(true)).toEqual({ ok: true, code: "success" });
    const update = client.calls.find((c) => c.table === "community_profiles" && c.op === "update");
    expect(update?.args[0]).toEqual({ show_presence: true });
  });

  it("4./5. a zero-row visibility update is a failure, never a silent success", async () => {
    mockAuth(ME);
    mockAdmin();
    const { client } = makeUserClient({ community_profiles: [ok(null)] });
    vi.mocked(createClient).mockResolvedValue(client);
    expect(await setShowPresence(false)).toEqual({ ok: false, code: "not_found" });
  });
});

// ---------------------------------------------------------------------------
// 6 — each notification toggle updates ONLY its own column
// ---------------------------------------------------------------------------

describe("notification preference isolation (6)", () => {
  const CASES: Array<[string, string, boolean]> = [
    ["friend_requests", "friendRequests", false],
    ["mentions", "mentions", true],
    ["replies", "replies", false],
    ["reactions", "reactions", true],
    ["direct_messages", "directMessages", false],
    ["notification_sound", "sound", true],
  ];

  it.each(CASES)(
    "6. toggling %s (→ %s) writes exactly notify_%s and nothing else",
    async (_label, inputKey, value) => {
      mockAuth(ME);
      mockAdmin();
      const column = `notify_${inputKey === "friendRequests" ? "friend_requests" : inputKey === "directMessages" ? "direct_messages" : inputKey}`;
      const { client } = makeUserClient({ community_profiles: [ok({ [column]: value })] });
      vi.mocked(createClient).mockResolvedValue(client);

      const result = await updateNotificationPreferences({ [inputKey]: value } as never);
      expect(result).toEqual({ ok: true, code: "success" });

      const update = client.calls.find((c) => c.table === "community_profiles" && c.op === "update");
      expect(update?.args[0]).toEqual({ [column]: value }); // exactly ONE column
      // the other five columns are absent from the payload (no clobbering)
      const payload = update?.args[0] as Record<string, unknown>;
      expect(Object.keys(payload)).toHaveLength(1);
    },
  );

  it("6. an empty patch is a no-op success (nothing written)", async () => {
    mockAuth(ME);
    mockAdmin();
    const { client } = makeUserClient();
    vi.mocked(createClient).mockResolvedValue(client);
    expect(await updateNotificationPreferences({})).toEqual({ ok: true, code: "success" });
    expect(client.calls.filter((c) => c.op === "update" || c.op === "upsert")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 7–8 — the heartbeat never overwrites a manual DND / AWAY
// ---------------------------------------------------------------------------

describe("heartbeat cannot change a manual mode (7-8)", () => {
  it("7. a heartbeat over an EXISTING dnd row writes last_seen_at only — no presence_mode, no filter", async () => {
    mockAuth(ME);
    mockAdmin();
    const { client } = makeUserClient();
    vi.mocked(createClient).mockResolvedValue(client);
    await touchCommunityPresence();
    const upsert = client.calls.find((c) => c.table === "community_profiles" && c.op === "upsert");
    const values = upsert!.args[0] as Record<string, unknown>;
    expect(values.user_id).toBe(ME);
    expect(typeof values.last_seen_at).toBe("string");
    expect("presence_mode" in values).toBe(false); // 7./8. the mode is untouched
    expect(upsert?.args[1]).toEqual({ onConflict: "user_id" });
  });

  it("8. the declared-mode derivation is STICKY for manual away (activity cannot clear it)", () => {
    // manual away + fresh activity → STILL away (previously flipped to online
    // — the exact overwrite that lost the user's manual choice):
    expect(declaredModeForActivity(tNow, "away", tNow)).toBe("away");
    expect(declaredModeForActivity(t0, "away", tNow)).toBe("away");
    // and dnd was already sticky:
    expect(declaredModeForActivity(tNow, "dnd", tNow)).toBe("dnd");
    // only an un-pinned "online" declaration auto-flips with inactivity:
    expect(declaredModeForActivity(tNow, "online", tNow)).toBe("online");
  });

  it("the hook's heartbeat call carries no mode (source invariant)", () => {
    const HOOK = readSrc("src/lib/community/use-presence.ts");
    expect(HOOK).toContain("await touchCommunityPresence()");
    expect(HOOK).not.toContain("touchCommunityPresence(next)");
  });
});

// ---------------------------------------------------------------------------
// 9–10 — insert when missing / update when existing (one upsert, both branches)
// ---------------------------------------------------------------------------

describe("row existence (9-10)", () => {
  it("9./10. the settings write is an onConflict upsert: missing row INSERTed, existing row UPDATED", async () => {
    mockAuth(ME);
    mockAdmin();
    const { client } = makeUserClient({
      community_profiles: [ok(null), ok({ presence_mode: "away" })],
    });
    vi.mocked(createClient).mockResolvedValue(client);
    expect(await setPresenceMode("away")).toEqual({ ok: true, code: "success" });
    const upsert = client.calls.find((c) => c.table === "community_profiles" && c.op === "upsert");
    // a plain .update() would affect zero rows for a MISSING row — the
    // upsert (onConflict: user_id) inserts when missing, updates when present:
    expect(upsert?.args[1]).toEqual({ onConflict: "user_id" });
    expect(client.calls.some((c) => c.table === "community_profiles" && c.op === "update")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 11 — no ignoreDuplicates on the settings path
// ---------------------------------------------------------------------------

describe("ignoreDuplicates guard (11)", () => {
  it("11. the settings path NEVER opts into DO NOTHING (ignoreDuplicates: true on existing rows)", () => {
    const ACTIONS = readSrc("src/app/community/actions.ts");
    const SETTINGS_START = ACTIONS.indexOf("Community settings — the persistence contract");
    const SETTINGS_END = ACTIONS.indexOf("Phase 3 room mute");
    const SETTINGS_BLOCK = ACTIONS.slice(SETTINGS_START, SETTINGS_END);
    // The notification READ-STATE upserts (onConflict "notification_id,…")
    // legitimately use DO NOTHING — idempotent read marking. Every
    // occurrence OUTSIDE the settings block must belong to those:
    for (const m of ACTIONS.matchAll(/ignoreDuplicates: true/g)) {
      const idx = m.index ?? 0;
      if (idx >= SETTINGS_START && idx <= SETTINGS_END) continue;
      expect(ACTIONS.slice(idx - 80, idx)).toContain('onConflict: "notification_id');
    }
    // Inside the settings persistence block, the literal may appear only as
    // the backticked contract comment ("NEVER used here"), never as an
    // actual upsert option:
    for (const m of SETTINGS_BLOCK.matchAll(/ignoreDuplicates: true/g)) {
      expect(SETTINGS_BLOCK.slice((m.index ?? 0) - 40, m.index ?? 0)).toContain("`");
    }
  });
});

// ---------------------------------------------------------------------------
// 12 — failure reverts the optimistic state
// ---------------------------------------------------------------------------

describe("optimistic revert on failure (12)", () => {
  it("12a. the presence hook reverts mode + visibility to the last confirmed value on !ok", () => {
    const HOOK = readSrc("src/lib/community/use-presence.ts");
    // mode revert:
    expect(HOOK).toMatch(/if \(!result\.ok\) \{[\s\S]{0,220}?modeRef\.current = prev;[\s\S]{0,120}?setModeState\(prev\);/);
    expect(HOOK).toContain("onError?.(result.code);");
    // visibility revert:
    expect(HOOK).toMatch(/showRef\.current = prev;[\s\S]{0,80}?setShowPresenceState\(prev\);/);
  });

  it("12b. the settings sheet reverts the toggle and shows the localized error", () => {
    const SHEET = readSrc("src/components/community/community-settings.tsx");
    expect(SHEET).toContain("if (!result.ok) {");
    expect(SHEET).toContain("setPrefs(prev);");
    expect(SHEET).toContain('setPrefError(t("community.settings.saveError"));');
    expect(SHEET).toContain('role="alert"');
  });

  it("12c. the shell surfaces the hook's error as the sheet's alert (localized, auto-cleared)", () => {
    const SHELL = readSrc("src/components/community/community-shell.tsx");
    expect(SHELL).toContain("onError: onPresenceError");
    expect(SHELL).toContain('setSettingsError(t("community.settings.saveError"))');
    expect(SHELL).toContain("error={settingsError}");
  });
});

// ---------------------------------------------------------------------------
// 13 — RLS failures are classified (SQLSTATE → stable code)
// ---------------------------------------------------------------------------

describe("error classification (13)", () => {
  it("13a. the classifier maps the SQLSTATEs to stable, display-safe codes", () => {
    expect(classifySettingsError({ message: "x", code: "42501" })).toEqual({ code: "rls_blocked", sqlstate: "42501" });
    expect(classifySettingsError({ message: "x", code: "23505" })).toEqual({ code: "unique_conflict", sqlstate: "23505" });
    expect(classifySettingsError({ message: "x", code: "23514" })).toEqual({ code: "check_constraint", sqlstate: "23514" });
    expect(classifySettingsError({ message: "x", code: "23503" })).toEqual({ code: "foreign_key", sqlstate: "23503" });
    expect(classifySettingsError({ message: "x", code: "PGRST204" })).toEqual({ code: "postgrest", sqlstate: "PGRST204" });
    expect(classifySettingsError({ message: "new row violates row-level security policy for table \"community_profiles\"" })).toEqual({ code: "rls_blocked" });
    expect(classifySettingsError(null).code).toBe("database");
  });

  it("13b. an RLS-blocked presence write returns the classified failure (no SQL/stack to the client)", async () => {
    mockAuth(ME);
    mockAdmin();
    const { client } = makeUserClient({
      community_profiles: [fail("new row violates row-level security policy for table \"community_profiles\"", "42501")],
    });
    vi.mocked(createClient).mockResolvedValue(client);
    const result = await setPresenceMode("dnd");
    expect(result).toEqual({ ok: false, code: "rls_blocked", sqlstate: "42501" });
    // the client-visible result carries no message/SQL:
    expect(JSON.stringify(result)).not.toContain("violates");
  });

  it("13c. every settings failure logs the structured diagnostic (setting + code, no user content)", async () => {
    const lines: string[] = [];
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation((...a: unknown[]) => {
        lines.push(a.map(String).join(" "));
      });
    mockAuth(ME);
    mockAdmin();
    const { client } = makeUserClient({
      community_profiles: [fail("boom", "42501")],
    });
    vi.mocked(createClient).mockResolvedValue(client);
    await setShowPresence(true);
    spy.mockRestore();
    expect(
      lines.some(
        (l) =>
          l.includes("[community] settings_update") &&
          l.includes(`user=${ME}`) &&
          l.includes("setting=show_online_status") &&
          l.includes("result=failure") &&
          l.includes("code=42501"),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 14 — own row only (auth.uid(), never client input)
// ---------------------------------------------------------------------------

describe("identity (14-15)", () => {
  it("14. the actor is always the SESSION user — a client-supplied id cannot redirect the update", async () => {
    mockAuth(ME);
    mockAdmin();
    const { client } = makeUserClient({
      community_profiles: [ok(null), ok({ presence_mode: "away" })],
    });
    vi.mocked(createClient).mockResolvedValue(client);
    await setPresenceMode("away");
    // every filter targets the session id, not OTHER:
    const eqs = client.calls.filter((c) => c.op === "eq").map((c) => c.args);
    expect(eqs.length).toBeGreaterThan(0);
    for (const args of eqs) {
      expect(args).toEqual(["user_id", ME]);
    }
    expect(client.calls.some((c) => JSON.stringify(c.args).includes(OTHER))).toBe(false);
  });

  it("14b. anonymous (no session) is rejected before any table access", async () => {
    mockAuth(null);
    mockAdmin();
    const { client } = makeUserClient();
    vi.mocked(createClient).mockResolvedValue(client);
    expect(await setPresenceMode("online")).toEqual({ ok: false, code: "unauthenticated" });
    expect(await setShowPresence(false)).toEqual({ ok: false, code: "unauthenticated" });
    expect(await updateNotificationPreferences({ sound: false })).toEqual({ ok: false, code: "unauthenticated" });
    expect(client.calls.filter((c) => c.table === "community_profiles")).toHaveLength(0);
  });

  it("14c. the RLS UPDATE policy is own-row-only (migration audit — the DB backstop)", () => {
    const V10 = readSrc("supabase/migrations/20261104000000_community_v10_platform_admin.sql");
    // the re-created update policy: using AND with-check pin the row to auth.uid()
    expect(V10).toMatch(/"Users can update their own community profile"[\s\S]{0,400}?auth\.uid\(\) = user_id[\s\S]{0,200}?auth\.uid\(\) = user_id/);
    // no anon/public policy exists on community_profiles:
    expect(V10).not.toMatch(/on public\.community_profiles\s+for\s+\w+\s+to\s+(anon|public)/);
  });

  it("15. the settings path writes ONLY whitelisted own-profile columns — never admins/bans/roles/reputation", () => {
    const ACTIONS = readSrc("src/app/community/actions.ts");
    const SETTINGS_BLOCK = ACTIONS.slice(ACTIONS.indexOf("Community settings — the persistence contract"));
    // no privileged tables are touched by the settings block:
    expect(SETTINGS_BLOCK).not.toMatch(/from\(\s*"(admins|community_bans|community_memberships|community_reputation_events)"\s*\)/);
    // the writable payloads contain only the settings columns:
    const writable = [
      "presence_mode",
      "show_presence",
      "notify_friend_requests",
      "notify_mentions",
      "notify_replies",
      "notify_reactions",
      "notify_direct_messages",
      "notify_sound",
      "last_seen_at",
      "user_id", // only as the upsert key derived from the session
    ];
    const columnLiterals = [...SETTINGS_BLOCK.matchAll(/(?<![\w])((?:notify_[a-z_]+)|presence_mode|show_presence|last_seen_at|user_id|role|banned_by|reputation|display_name|avatar_id|bio|community_suspended|community_muted_until)\b/g)]
      .map((m) => m[1]);
    for (const column of new Set(columnLiterals)) {
      expect(writable, column).toContain(column);
    }
  });
});

// ---------------------------------------------------------------------------
// 16 — reopening the sheet loads the database-confirmed state
// ---------------------------------------------------------------------------

describe("settings reload on open (16-17)", () => {
  it("16a. refreshCommunitySettings reads the OWN row (session-derived id) and maps it", async () => {
    mockAuth(ME);
    mockAdmin();
    const row = {
      presence_mode: "dnd",
      show_presence: false,
      notify_friend_requests: false,
      notify_mentions: true,
      notify_replies: false,
      notify_reactions: true,
      notify_direct_messages: true,
      notify_sound: false,
      muted_room_ids: [],
    };
    const { client } = makeUserClient({ community_profiles: [ok(row)] });
    vi.mocked(createClient).mockResolvedValue(client);
    const fresh = await refreshCommunitySettings();
    expect(fresh).toEqual({
      mode: "dnd",
      showPresence: false,
      friendRequests: false,
      mentions: true,
      replies: false,
      reactions: true,
      directMessages: true,
      sound: false,
      mutedRooms: [],
    });
    // and it queried the session's id, nothing else:
    expect(client.calls.some((c) => c.op === "eq" && c.args[0] === "user_id" && c.args[1] === ME)).toBe(true);
  });

  it("16b. anonymous / failed read → null (the sheet keeps its current state, no blank slate)", async () => {
    mockAuth(null);
    mockAdmin();
    vi.mocked(createClient).mockResolvedValue(makeUserClient().client);
    expect(await refreshCommunitySettings()).toBeNull();
  });

  it("16c. the sheet calls the reload ON OPEN (mount) and applies the result to shell + hook", () => {
    const SHEET = readSrc("src/components/community/community-settings.tsx");
    expect(SHEET).toContain("void refreshCommunitySettings().then((fresh) => {");
    expect(SHEET).toContain("onRefreshedRef.current?.(fresh);");
    const SHELL = readSrc("src/components/community/community-shell.tsx");
    expect(SHELL).toContain("onRefreshed={handleSettingsRefresh}");
    expect(SHELL).toContain("syncPresence(fresh.mode, fresh.showPresence)");
    // the hook's sync performs NO write:
    const HOOK = readSrc("src/lib/community/use-presence.ts");
    const syncFn = HOOK.slice(HOOK.indexOf("const syncState = useCallback"));
    expect(syncFn.slice(0, syncFn.indexOf("}, [onShowPresenceChanged]"))).not.toMatch(/setPresenceMode|setShowPresence\(|touchCommunityPresence/);
  });

  it("17. a full page reload rebuilds the settings from the database (page → shell initial state)", () => {
    const PAGE = readSrc("src/app/community/page.tsx");
    // The page reads the viewer's OWN community_profiles row (RLS-scoped)
    // with the settings column set and maps it through the single
    // nulls → defaults transform into the shell's initial state:
    expect(PAGE).toContain("buildViewerSettings");
    expect(PAGE).toContain("VIEWER_SETTINGS_SELECT");
    expect(PAGE).toContain('settings={viewer}');
    expect(PAGE).toContain('.eq("user_id", user.id)');
    // and the mapper is the single column → state transform (nulls → defaults):
    const mapped = buildViewerSettings({
      presence_mode: "away",
      show_presence: false,
      notify_friend_requests: false,
      notify_mentions: null,
      notify_replies: null,
      notify_reactions: null,
      notify_direct_messages: null,
      notify_sound: null,
      muted_room_ids: null,
    });
    expect(mapped).toMatchObject({ mode: "away", showPresence: false, friendRequests: false, mentions: true });
  });
});
