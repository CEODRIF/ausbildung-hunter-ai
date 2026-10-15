import { readFileSync, readdirSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dictionaries } from "@/lib/i18n";
import {
  PROFILE_AVATAR_IDS,
  avatarAssetPath,
  isProfileAvatarId,
  resolveUserAvatar,
  validateDisplayName,
  type ResolvedUserAvatar,
} from "@/lib/profile-avatars";
import {
  hasProfileAvatarColumn,
  resetProfileAvatarColumnProbe,
} from "@/lib/contact-name-support";
import { updateProfileIdentity } from "@/app/settings/profile/actions";

/**
 * Editable user profile + 10-avatar gallery (migration 20261111000000).
 *
 * Runs the REAL server action (updateProfileIdentity) and the REAL
 * migration-state probe (hasProfileAvatarColumn) against an in-memory
 * `profiles` store. `H.migrated` simulates the code-first deploy window
 * (manual migration not yet applied → the avatar column does not exist).
 *
 * Pins:
 *   - display name: trim, 2…50 chars, client/server share one validator;
 *   - avatar: closed 10-id allowlist (URLs, filenames, case variants,
 *     injection strings are all rejected);
 *   - authorization: the acting user comes ONLY from the session; the
 *     update is constrained to .eq("id", sessionUserId) — a client-supplied
 *     user id can never redirect the write;
 *   - no side effects: email/status/limit/goal are never touched;
 *   - pre-migration fallback: avatar value is dropped, name still saves;
 *   - probe: missing column → false, clean read → true, cached, reset hook;
 *   - resolution priority asset → url → initials in ONE shared function;
 *   - i18n parity of profile.page.edit across de/en/fr/ar;
 *   - asset + wiring source contracts (10 original local SVGs, no
 *     external refs; page/menu/form use the shared pieces).
 */

type Row = Record<string, unknown>;

const USER = { id: "user-1", email: "u@example.test" };
const OTHER = { id: "user-2", email: "other@example.test" };

const seedRow = (id: string, email: string): Row => ({
  id,
  full_name: id === USER.id ? "Yassine Salmi" : "Other Person",
  email,
  account_status: "active",
  selected_goal: "ausbildung",
  daily_email_limit: 50,
  first_name: null,
  last_name: null,
  avatar_url: null,
  avatar: null,
  created_at: "2026-09-01T00:00:00.000Z",
  updated_at: "2026-09-01T00:00:00.000Z",
});

const H = vi.hoisted(() => ({
  store: {} as Record<string, Row[]>,
  /** Post-migration schema by default (the world this feature targets). */
  migrated: true,
  // Inlined (not USER — vi.hoisted runs before const initializers);
  // beforeEach re-syncs it from USER anyway.
  sessionUser: { id: "user-1", email: "u@example.test" } as unknown,
  fromCalls: [] as string[],
  updateLog: [] as Array<{
    table: string;
    patch: Record<string, unknown>;
    ids: unknown[];
  }>,
  lastEqId: null as unknown,
  dbError: null as { message: string } | null,
  selectError: null as { message: string } | null,
}));

vi.mock("@/lib/supabase/admin", () => {
  function makeChain(table: string) {
    const filters: Array<(row: Row) => boolean> = [];
    let patch: Record<string, unknown> | null = null;
    let selectColumns = "";
    const chain: Record<string | symbol, unknown> = new Proxy(
      {},
      {
        get(_t, prop) {
          if (typeof prop !== "string") return undefined;
          switch (prop) {
            case "select":
              return (cols: string) => {
                selectColumns = String(cols ?? "");
                return chain;
              };
            case "update":
              return (p: Record<string, unknown>) => {
                patch = p;
                return chain;
              };
            case "eq":
              return (col: string, val: unknown) => {
                filters.push((row) => row[col] === val);
                if (col === "id") H.lastEqId = val;
                return chain;
              };
            case "limit":
              return () => chain;
            case "then":
              return (
                resolve: (v: unknown) => void,
                reject: (e: unknown) => void,
              ) => {
                Promise.resolve().then(() => {
                  const rows = (H.store[table] ?? []).filter((row) =>
                    filters.every((f) => f(row)),
                  );
                  if (H.selectError) {
                    reject(H.selectError);
                    return;
                  }
                  if (patch) {
                    if (H.dbError) {
                      reject(H.dbError);
                      return;
                    }
                    const matched = rows.map((row) => {
                      Object.assign(row, patch);
                      return row;
                    });
                    H.updateLog.push({
                      table,
                      patch: { ...patch },
                      ids: matched.map((row) => row.id),
                    });
                    resolve({
                      data: matched.map((row) => ({ id: row.id })),
                      error: null,
                    });
                  } else if (
                    selectColumns.includes("avatar") &&
                    !H.migrated
                  ) {
                    // Pre-migration: PostgREST rejects the unknown column.
                    resolve({
                      data: null,
                      error: { message: 'column "avatar" does not exist' },
                    });
                  } else {
                    resolve({ data: rows, error: null });
                  }
                });
              };
              break;
            default:
              return undefined;
          }
        },
      },
    );
    return chain;
  }
  return {
    createAdminClient: () => ({
      from: (table: string) => {
        H.fromCalls.push(table);
        return makeChain(table);
      },
    }),
  };
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: H.sessionUser } }),
    },
  }),
}));

const form = (fields: Record<string, string>): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

beforeEach(() => {
  H.store = { profiles: [seedRow(USER.id, USER.email), seedRow(OTHER.id, OTHER.email)] };
  H.migrated = true;
  H.sessionUser = USER;
  H.fromCalls = [];
  H.updateLog = [];
  H.lastEqId = null;
  H.dbError = null;
  H.selectError = null;
  resetProfileAvatarColumnProbe();
});

const initialsOf = (r: ResolvedUserAvatar): string =>
  r.kind === "initials" ? r.initials : "";

/* ================================================================== *
 * Pure registry / validation logic (shared client + server)
 * ================================================================== */

describe("avatar registry (pure)", () => {
  it("ships exactly 10 canonical identifiers with stable asset paths", () => {
    expect(PROFILE_AVATAR_IDS).toHaveLength(10);
    PROFILE_AVATAR_IDS.forEach((id) => {
      expect(id).toMatch(/^avatar-(0[1-9]|10)$/);
      expect(avatarAssetPath(id)).toBe(`/profile-avatars/${id}.svg`);
    });
    expect(new Set(PROFILE_AVATAR_IDS).size).toBe(10);
  });

  it("allowlist accepts exactly the 10 ids and rejects everything else", () => {
    for (const id of PROFILE_AVATAR_IDS) expect(isProfileAvatarId(id)).toBe(true);
    const rejects: unknown[] = [
      "avatar-00",
      "avatar-11",
      "avatar-101",
      "avatar-01.svg",
      "Avatar-01",
      "avatar-01; drop table profiles",
      "/profile-avatars/avatar-01.svg",
      "https://evil.example/x.svg",
      "data:image/svg+xml,<svg></svg>",
      "javascript:alert(1)",
      "",
      null,
      undefined,
      42,
      ["avatar-01"],
    ];
    for (const value of rejects) expect(isProfileAvatarId(value)).toBe(false);
  });

  it("all 10 asset files exist as original 256×256 SVGs with no external refs", () => {
    const dir = readdirSync("public/profile-avatars");
    expect(dir.sort()).toEqual(
      PROFILE_AVATAR_IDS.map((id) => `${id}.svg`).sort(),
    );
    for (const id of PROFILE_AVATAR_IDS) {
      const svg = readFileSync(`public/profile-avatars/${id}.svg`, "utf8");
      expect(svg.trimStart().startsWith("<svg")).toBe(true);
      expect(svg).toMatch(/width="256"/);
      expect(svg).toMatch(/height="256"/);
      // Original, self-contained: no REMOTE resource references (the
      // required SVG namespace URI is not one), no scripts, no embedded
      // foreign objects, no raster embedding, no user data.
      expect(svg).not.toMatch(/href\s*=\s*["']/);
      expect(svg).not.toContain("xlink:href");
      expect(svg).not.toContain("<image");
      expect(svg).not.toContain("<script");
      expect(svg).not.toContain("<foreignObject");
      expect(svg).not.toContain("<metadata");
      // Lightweight (spec: 5–20 KB where practical — SVGs are ~1 KB).
      expect(svg.length).toBeGreaterThan(300);
      expect(svg.length).toBeLessThan(20_000);
    }
  });
});

describe("display-name validation (pure)", () => {
  it("trims and accepts 2…50 characters", () => {
    expect(validateDisplayName("  yassine salmi  ")).toEqual({
      ok: true,
      value: "yassine salmi",
    });
    expect(validateDisplayName("ab")).toEqual({ ok: true, value: "ab" });
    const fifty = "A".repeat(50);
    expect(validateDisplayName(fifty).ok).toBe(true);
    // Unicode names count characters, not bytes.
    const unicode = "Ähmed Ümit Özkan 🇩🇪".slice(0, 50);
    expect(validateDisplayName(unicode).ok).toBe(true);
  });

  it("rejects empty, whitespace-only and too-short names", () => {
    expect(validateDisplayName("")).toEqual({ ok: false, error: "too_short" });
    expect(validateDisplayName("    ")).toEqual({
      ok: false,
      error: "too_short",
    });
    expect(validateDisplayName("A")).toEqual({ ok: false, error: "too_short" });
    expect(validateDisplayName(undefined)).toEqual({
      ok: false,
      error: "too_short",
    });
    expect(validateDisplayName(42 as unknown as string)).toEqual({
      ok: false,
      error: "too_short",
    });
  });

  it("rejects names longer than 50 characters", () => {
    expect(validateDisplayName("A".repeat(51))).toEqual({
      ok: false,
      error: "too_long",
    });
    expect(validateDisplayName("  " + "B".repeat(52))).toEqual({
      ok: false,
      error: "too_long",
    });
  });
});

describe("avatar resolution (pure)", () => {
  it("priority: valid gallery id → uploaded url → initials", () => {
    expect(
      resolveUserAvatar({
        avatar: "avatar-05",
        avatarUrl: "https://cdn.example/a.png",
        fullName: "Yassine Salmi",
      }),
    ).toEqual({ kind: "asset", id: "avatar-05", src: "/profile-avatars/avatar-05.svg" });
    expect(
      resolveUserAvatar({
        avatarUrl: "https://cdn.example/a.png",
        fullName: "Yassine Salmi",
      }),
    ).toEqual({ kind: "url", src: "https://cdn.example/a.png" });
    expect(resolveUserAvatar({ fullName: "Yassine Salmi" })).toEqual({
      kind: "initials",
      initials: "YS",
    });
  });

  it("an invalid stored avatar value never renders — it falls through", () => {
    expect(
      resolveUserAvatar({
        avatar: "avatar-99",
        avatarUrl: "https://cdn.example/a.png",
        fullName: "A B",
      }),
    ).toEqual({ kind: "url", src: "https://cdn.example/a.png" });
    expect(
      resolveUserAvatar({ avatar: "https://evil.example/x.svg", fullName: "A B" }),
    ).toEqual({ kind: "initials", initials: "AB" });
  });

  it("graceful fallbacks: missing/blank name → '?', multi-space names collapse", () => {
    expect(initialsOf(resolveUserAvatar({}))).toBe("?");
    expect(initialsOf(resolveUserAvatar({ fullName: "   " }))).toBe("?");
    expect(initialsOf(resolveUserAvatar({ fullName: "  yassine    salmi  more  " }))).toBe(
      "YS",
    );
  });

  it("every surface resolves the SAME src for the same id (consistency)", () => {
    const srcs = Array.from(
      new Set(
        PROFILE_AVATAR_IDS.map((id) => {
          const r = resolveUserAvatar({ avatar: id });
          return r.kind === "asset" ? r.src : null;
        }).filter((s): s is string => s !== null),
      ),
    );
    expect(srcs).toHaveLength(10);
    srcs.forEach((src) => expect(src).toMatch(/^\/profile-avatars\/avatar-\d\d\.svg$/));
  });
});

/* ================================================================== *
 * hasProfileAvatarColumn probe (REAL probe, mocked database)
 * ================================================================== */

describe("hasProfileAvatarColumn probe", () => {
  it("resolves true on a clean read of the column (post-migration)", async () => {
    expect(await hasProfileAvatarColumn()).toBe(true);
  });

  it("resolves false while the column is missing (pre-migration)", async () => {
    H.migrated = false;
    expect(await hasProfileAvatarColumn()).toBe(false);
  });

  it("resolves false on an unexpected read error (safe default off, no throw)", async () => {
    H.selectError = { message: "connection reset" };
    expect(await hasProfileAvatarColumn()).toBe(false);
    // The probe never rejects — even a hard failure resolves to `false`.
    resetProfileAvatarColumnProbe();
    expect(await hasProfileAvatarColumn()).toBe(false);
  });

  it("is cached per process; the reset hook re-evaluates", async () => {
    await hasProfileAvatarColumn();
    await hasProfileAvatarColumn();
    const profileReads = H.fromCalls.filter((c) => c === "profiles").length;
    expect(profileReads).toBe(1);
    H.migrated = false;
    expect(await hasProfileAvatarColumn()).toBe(true); // still cached
    resetProfileAvatarColumnProbe();
    expect(await hasProfileAvatarColumn()).toBe(false); // re-evaluated
  });
});

/* ================================================================== *
 * updateProfileIdentity server action (REAL action, mocked database)
 * ================================================================== */

describe("updateProfileIdentity", () => {
  it("saves a trimmed display name + an allowlisted avatar (self-only row)", async () => {
    const res = await updateProfileIdentity(
      form({ fullName: "  Nadia Weber  ", avatar: "avatar-03" }),
    );
    expect(res).toEqual({ ok: true });

    const row = H.store.profiles.find((r) => r.id === USER.id)!;
    expect(row.full_name).toBe("Nadia Weber");
    expect(row.avatar).toBe("avatar-03");
    // No side effects on auth/subscription/role fields.
    expect(row.email).toBe(USER.email);
    expect(row.account_status).toBe("active");
    expect(row.daily_email_limit).toBe(50);
    expect(row.selected_goal).toBe("ausbildung");
    // Exactly one update, constrained to the SESSION user.
    expect(H.updateLog).toHaveLength(1);
    expect(H.updateLog[0].table).toBe("profiles");
    expect(H.updateLog[0].ids).toEqual([USER.id]);
    expect(H.lastEqId).toBe(USER.id);
    // The other user's row is untouched.
    const other = H.store.profiles.find((r) => r.id === OTHER.id)!;
    expect(other.full_name).toBe("Other Person");
    expect(other.avatar).toBeNull();
  });

  it("never honors a client-supplied user id — the session id wins", async () => {
    const res = await updateProfileIdentity(
      form({
        fullName: "Attacker Name",
        avatar: "avatar-01",
        userId: OTHER.id, // must be ignored entirely
      }),
    );
    expect(res).toEqual({ ok: true });
    expect(H.updateLog).toHaveLength(1);
    expect(H.updateLog[0].ids).toEqual([USER.id]);
    expect(H.lastEqId).toBe(USER.id);
    const other = H.store.profiles.find((r) => r.id === OTHER.id)!;
    expect(other.full_name).toBe("Other Person");
    expect(other.avatar).toBeNull();
  });

  it('keeps the existing avatar when the form sends "" (only name changes)', async () => {
    const row = H.store.profiles.find((r) => r.id === USER.id)!;
    row.avatar = "avatar-07";
    const res = await updateProfileIdentity(form({ fullName: "New Name", avatar: "" }));
    expect(res).toEqual({ ok: true });
    expect(row.avatar).toBe("avatar-07");
    expect(H.updateLog[0].patch).not.toHaveProperty("avatar");
    expect(row.full_name).toBe("New Name");
  });

  it("rejects empty/whitespace names WITHOUT any database write", async () => {
    expect(
      await updateProfileIdentity(form({ fullName: "   ", avatar: "" })),
    ).toEqual({ ok: false, error: "invalid_name" });
    expect(
      await updateProfileIdentity(form({ fullName: "A", avatar: "" })),
    ).toEqual({ ok: false, error: "invalid_name" });
    expect(H.updateLog).toHaveLength(0);
  });

  it("rejects names longer than 50 characters WITHOUT any database write", async () => {
    const res = await updateProfileIdentity(
      form({ fullName: "A".repeat(51), avatar: "" }),
    );
    expect(res).toEqual({ ok: false, error: "invalid_name" });
    expect(H.updateLog).toHaveLength(0);
  });

  it("rejects invalid avatar identifiers WITHOUT any database write", async () => {
    const bad = [
      "avatar-00",
      "avatar-11",
      "avatar-01.svg",
      "Avatar-01",
      "https://evil.example/x.svg",
      "data:image/svg+xml,<svg></svg>",
      "javascript:alert(1)",
      "avatar-01; drop table profiles",
    ];
    for (const avatar of bad) {
      const res = await updateProfileIdentity(
        form({ fullName: "Valid Name", avatar }),
      );
      expect(res, avatar).toEqual({ ok: false, error: "invalid_avatar" });
    }
    expect(H.updateLog).toHaveLength(0);
  });

  it("rejects unauthenticated requests without touching the database", async () => {
    H.sessionUser = null;
    const res = await updateProfileIdentity(
      form({ fullName: "Ghost Name", avatar: "avatar-01" }),
    );
    expect(res).toEqual({ ok: false, error: "unauthorized" });
    expect(H.updateLog).toHaveLength(0);
  });

  it("fails (not throws) when the profile row is missing", async () => {
    H.store.profiles = [seedRow(OTHER.id, OTHER.email)]; // user-1 absent
    const res = await updateProfileIdentity(form({ fullName: "New Name", avatar: "" }));
    expect(res).toEqual({ ok: false, error: "failed" });
  });

  it("fails (not throws) on a database error", async () => {
    H.dbError = { message: "simulated outage" };
    const res = await updateProfileIdentity(form({ fullName: "New Name", avatar: "" }));
    expect(res).toEqual({ ok: false, error: "failed" });
  });

  it("pre-migration: avatar is dropped, the display name still saves", async () => {
    H.migrated = false;
    const res = await updateProfileIdentity(
      form({ fullName: "Legacy Name", avatar: "avatar-02" }),
    );
    expect(res).toEqual({ ok: true });
    expect(H.updateLog).toHaveLength(1);
    expect(H.updateLog[0].patch).toEqual({ full_name: "Legacy Name" });
    const row = H.store.profiles.find((r) => r.id === USER.id)!;
    expect(row.avatar).toBeNull(); // never written to a missing column
  });

  it("pre-migration: a name-only update is unaffected by the missing column", async () => {
    H.migrated = false;
    const res = await updateProfileIdentity(form({ fullName: "Plain Name", avatar: "" }));
    expect(res).toEqual({ ok: true });
    expect(H.updateLog[0].patch).toEqual({ full_name: "Plain Name" });
  });
});

/* ================================================================== *
 * Source contracts: wiring, security posture, i18n parity
 * ================================================================== */

describe("source contracts", () => {
  const PAGE = readFileSync("src/app/settings/profile/page.tsx", "utf8");
  const MENU = readFileSync("src/components/profile-menu.tsx", "utf8");
  const FORM = readFileSync("src/components/profile-identity-form.tsx", "utf8");
  const ACTIONS = readFileSync("src/app/settings/profile/actions.ts", "utf8");
  const AVATAR = readFileSync("src/components/user-avatar.tsx", "utf8");

  it("the profile page gates the gallery on the probe and renders the editor", () => {
    expect(PAGE).toContain("hasProfileAvatarColumn()");
    expect(PAGE).toContain("<ProfileIdentityForm");
    expect(PAGE).toContain("<UserAvatar");
    expect(PAGE).toContain("avatarEnabled={avatarSupported}");
  });

  it("the account menu renders the shared UserAvatar (gallery-aware)", () => {
    expect(MENU).toContain("<UserAvatar");
    expect(MENU).toContain("avatar={profile.avatar}");
  });

  it("the shared avatar component resolves through the single registry", () => {
    expect(AVATAR).toContain("resolveUserAvatar");
    expect(AVATAR).toContain('width={256}');
    expect(AVATAR).toContain('height={256}');
  });

  it("the form guards against double submission and exposes accessible controls", () => {
    expect(FORM).toContain("useTransition");
    expect(FORM).toContain("inFlight.current");
    expect(FORM).toContain('aria-pressed={selected}');
    expect(FORM).toContain('role="status"');
    expect(FORM).toContain('role="alert"');
    // The form iterates the canonical registry; ALLOWLIST ENFORCEMENT lives
    // server-side (the form never re-implements validation of stored values).
    expect(FORM).toContain("PROFILE_AVATAR_IDS.map");
    expect(FORM).toContain("avatarAssetPath");
  });

  it("the action is session-scoped and allowlist-validated, never leaks errors", () => {
    expect(ACTIONS).toContain('"use server"');
    expect(ACTIONS).toContain("auth.getUser()");
    // The ONLY row filter is the SESSION user id (user.id → userId param).
    expect(ACTIONS).toContain('.eq("id", userId)');
    expect(ACTIONS).not.toContain('formData.get("userId")');
    expect(ACTIONS).toContain("isProfileAvatarId");
    expect(ACTIONS).toContain("validateDisplayName");
    expect(ACTIONS).not.toContain("formData.get('userId')");
    // Stable error codes only — no Supabase messages reach the client.
    expect(ACTIONS).not.toContain("error.message");
  });

  it("migration file is additive and enforces the same allowlist in SQL", () => {
    const sql = readFileSync(
      "supabase/migrations/20261111000000_profile_avatar_gallery.sql",
      "utf8",
    );
    expect(sql).toContain("add column if not exists avatar text");
    expect(sql).toContain("profiles_avatar_allowlist");
    PROFILE_AVATAR_IDS.forEach((id) => expect(sql).toContain(`'${id}'`));
    // Additive only: no DROP / TRUNCATE / destructive DDL.
    expect(sql).not.toMatch(/drop|truncate|alter .* drop|delete from/i);
  });

  it("profile.page.edit has full parity across de/en/fr/ar (10 avatar labels each)", () => {
    const collect = (obj: Record<string, unknown>, prefix = ""): string[] =>
      Object.entries(obj).flatMap(([k, v]) =>
        typeof v === "string"
          ? [`${prefix}${k}`]
          : collect(v as Record<string, unknown>, `${prefix}${k}.`),
      );

    const de = dictionaries.de.profile.page.edit;
    const deKeys = collect(de).sort();
    expect(deKeys).not.toHaveLength(0);
    expect(deKeys.filter((k) => k.startsWith("avatars.")).length).toBe(10);

    for (const lang of ["en", "fr", "ar"] as const) {
      const keys = collect(dictionaries[lang].profile.page.edit).sort();
      expect(keys, lang).toEqual(deKeys);
      // No empty translations.
      collect(dictionaries[lang].profile.page.edit).forEach((k) => {
        const value = k
          .split(".")
          .reduce<unknown>((acc, part) =>
            (acc as Record<string, unknown>)[part],
            dictionaries[lang].profile.page.edit,
          );
        expect(String(value).length, `${lang}.${k}`).toBeGreaterThan(0);
      });
    }

    // The 10 avatar ids map 1:1 to the registry.
    const deAvatars = de.avatars as Record<string, string>;
    for (const id of PROFILE_AVATAR_IDS) {
      expect(Object.keys(deAvatars)).toContain(id);
      expect(deAvatars[id].length).toBeGreaterThan(0);
    }
  });
});
