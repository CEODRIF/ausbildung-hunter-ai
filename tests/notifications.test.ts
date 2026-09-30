import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Targeted notifications (Admin → Platform Updates) — spec §16.
 * 14 deterministic tests; the Supabase admin client is replaced with an
 * in-memory, stateful builder that implements the exact query semantics
 * the notification code uses (or/eq/in filters, order, limit, insert with
 * the unique send_key constraint, upsert ignore-duplicates). No live
 * Supabase, no email — pure behavior.
 */

type Row = Record<string, unknown>;

const { session, db } = vi.hoisted(() => {
  const session = {
    user: null as { id: string; email: string } | null,
  };
  const db = {
    profiles: [] as Row[],
    admins: [] as Row[],
    notifications: [] as Row[],
    notification_reads: [] as Row[],
    reset: function () {
      this.profiles = [];
      this.admins = [];
      this.notifications = [];
      this.notification_reads = [];
      this.seq = 0;
    },
    seq: 0,
  };
  return { session, db };
});

vi.mock("@/lib/auth", () => ({
  getCurrentUserAndProfile: vi.fn(async () =>
    session.user
      ? { user: session.user, profile: { id: session.user.id, email: session.user.email } }
      : { user: null, profile: null },
  ),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: session.user } }),
    },
  }),
}));

// --- in-memory supabase-style builder --------------------------------------

function query(table: string) {
  const state = {
    eq: {} as Record<string, unknown>,
    or: null as string | null,
    in: {} as Record<string, unknown[]>,
    limitN: null as number | null,
    orderCol: null as string | null,
    orderAsc: true,
    insertRow: null as Row | null,
    upsertRow: null as Row | null,
    wantSingle: false,
    wantMaybeSingle: false,
  };

  const run = async (): Promise<{ data: unknown; error: unknown }> => {
    const rows: Row[] = (db as unknown as Record<string, Row[]>)[table] ?? [];

    if (state.insertRow) {
      if (table === "notifications") {
        const key = state.insertRow.send_key;
        const duplicate =
          key != null &&
          rows.some((row) => row.send_key != null && row.send_key === key);
        if (duplicate)
          return { data: null, error: { code: "23505", message: "duplicate key" } };
        db.seq += 1;
        const row: Row = {
          // UUID-shaped id (the read endpoint validates the format).
          id: `f${String(db.seq).padStart(7, "0")}-0000-4000-8000-000000000001`,
          created_at: new Date(BASE + db.seq * 1000).toISOString(),
          ...state.insertRow,
        };
        rows.push(row);
        return { data: row, error: null };
      }
      rows.push({ ...state.insertRow });
      return { data: state.insertRow, error: null };
    }

    if (state.upsertRow) {
      if (table === "notification_reads") {
        const existing = rows.find(
          (row) =>
            row.notification_id === state.upsertRow?.notification_id &&
            row.user_id === state.upsertRow?.user_id,
        );
        // ignoreDuplicates: keep the FIRST receipt (original read_at).
        if (existing) return { data: existing, error: null };
        const row: Row = {
          read_at: new Date().toISOString(),
          ...state.upsertRow,
        };
        rows.push(row);
        return { data: row, error: null };
      }
      rows.push({ ...state.upsertRow });
      return { data: state.upsertRow, error: null };
    }

    let out = [...rows];
    for (const [col, value] of Object.entries(state.eq))
      out = out.filter((row) => row[col] === value);
    for (const [col, values] of Object.entries(state.in))
      out = out.filter((row) => values.includes(row[col]));
    if (state.or) {
      const conditions = state.or.split(",").map((c) => c.trim());
      out = out.filter((row) =>
        conditions.some((cond) => {
          const match = cond.match(/^(.*)\.(eq|ilike)\.(.*)$/);
          if (!match) return false;
          const [, col, op, raw] = match;
          if (op === "eq") return row[col] === raw;
          const pattern = String(raw).replace(/^%|%/g, "");
          return String(row[col] ?? "")
            .toLowerCase()
            .includes(pattern.toLowerCase());
        }),
      );
    }
    if (state.orderCol) {
      const col = state.orderCol;
      out.sort((a, b) => {
        const av = String(a[col]);
        const bv = String(b[col]);
        return state.orderAsc ? av.localeCompare(bv) : bv.localeCompare(av);
      });
    }
    if (state.limitN !== null) out = out.slice(0, state.limitN);
    if (state.wantSingle)
      return out.length === 1
        ? { data: out[0], error: null }
        : { data: null, error: { code: "PGRST116", message: "no rows" } };
    if (state.wantMaybeSingle) return { data: out[0] ?? null, error: null };
    return { data: out, error: null };
  };

  const api: Record<string, unknown> = {
    then: (onF?: unknown, onR?: unknown) => run().then(onF as never, onR as never),
    // Column projection is not simulated — full rows are returned.
    select: () => api,
    eq: (col: string, value: unknown) => {
      state.eq[col] = value;
      return api;
    },
    or: (cond: string) => {
      state.or = cond;
      return api;
    },
    in: (col: string, values: unknown[]) => {
      state.in[col] = values;
      return api;
    },
    order: (col: string, opts?: { ascending?: boolean }) => {
      state.orderCol = col;
      state.orderAsc = opts?.ascending ?? true;
      return api;
    },
    limit: (n: number) => {
      state.limitN = n;
      return api;
    },
    insert: (row: Row) => {
      state.insertRow = row;
      return api;
    },
    upsert: (row: Row) => {
      state.upsertRow = row;
      return api;
    },
    maybeSingle: () => {
      state.wantMaybeSingle = true;
      return run();
    },
    single: () => {
      state.wantSingle = true;
      return run();
    },
  };
  return api;
}

function makeAdminClient() {
  return {
    from: (table: string) => query(table),
    rpc: async () => ({ data: null, error: null }),
  };
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => makeAdminClient(),
}));

import { GET as listRoute } from "@/app/api/notifications/route";
import { POST as readRoute } from "@/app/api/notifications/read/route";
import { POST as searchRoute } from "@/app/api/admin/notifications/search/route";
import { POST as sendRoute } from "@/app/api/admin/notifications/send/route";
import { GET as historyRoute } from "@/app/api/admin/notifications/history/route";

const BASE = Date.UTC(2026, 8, 30, 12, 0, 0);
const OWNER_ID = "a0000000-0000-4000-8000-000000000001";
const JOHN_ID = "b0000000-0000-4000-8000-000000000002";
const JANE_ID = "c0000000-0000-4000-8000-000000000003";

function seedUsers() {
  db.profiles = [
    { id: OWNER_ID, email: "adsium.business@gmail.com", full_name: "Platform Owner" },
    { id: JOHN_ID, email: "john@example.com", full_name: "John Doe" },
    { id: JANE_ID, email: "jane@example.com", full_name: "Jane Smith" },
    ...Array.from({ length: 12 }, (_, i) => ({
      id: `d${String(i + 1).padStart(7, "0")}-0000-4000-8000-000000000000`,
      email: `user${i + 1}@example.com`,
      full_name: `User ${i + 1}`,
    })),
  ];
  db.admins = [{ user_id: OWNER_ID, created_by: null }];
}

function setSession(user: { id: string; email: string } | null) {
  session.user = user;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const key = () => {
  const first = `e${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
  const last = "1" + "0".repeat(11); // exactly 12 hex chars
  const value = `${first}-4000-8000-4000-${last}`; // 8-4-4-4-12
  if (!UUID_RE.test(value)) throw new Error("test key generator broken");
  return value;
};

beforeEach(() => {
  db.reset();
  seedUsers();
  setSession(null);
  // Guard against hand-typed UUID literals that are not canonical 8-4-4-4-12.
  for (const id of [OWNER_ID, JOHN_ID, JANE_ID]) {
    if (!UUID_RE.test(id)) throw new Error(`malformed test UUID: ${id}`);
  }
});

// ---------------------------------------------------------------------------

describe("1-2. owner can send (all users / one user)", () => {
  it("1. owner sends a global notification — row targets all users and the recipient can see it", async () => {
    setSession({ id: OWNER_ID, email: "adsium.business@gmail.com" });
    const response = await sendRoute(
      new Request("http://localhost/api/admin/notifications/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          target_type: "all",
          title: "Search update",
          content: "Opportunity search was improved.",
          type: "improvement",
          idempotency_key: key(),
        }),
      }),
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      notification: { target_type: string; target_user_id: unknown };
      duplicate: boolean;
    };
    expect(body.duplicate).toBe(false);
    expect(body.notification.target_type).toBe("all");
    expect(body.notification.target_user_id).toBeNull();
    expect(db.notifications).toHaveLength(1);
    expect(db.notifications[0].created_by).toBe(OWNER_ID);

    // A regular user sees it in their in-app list.
    setSession({ id: JOHN_ID, email: "john@example.com" });
    const list = await listRoute();
    expect(list.status).toBe(200);
    const items = ((await list.json()) as { items: Array<{ title: string }> }).items;
    expect(items.map((item) => item.title)).toContain("Search update");
  });

  it("2. owner sends a targeted notification — row carries the target user id and recipient identity", async () => {
    setSession({ id: OWNER_ID, email: "adsium.business@gmail.com" });
    const response = await sendRoute(
      new Request("http://localhost/api/admin/notifications/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          target_type: "user",
          target_user_id: JOHN_ID,
          title: "Important notice",
          content: "Please check your application status.",
          type: "important",
          idempotency_key: key(),
        }),
      }),
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      notification: { target_user_id: string; recipient: { email: string; full_name: string } };
    };
    expect(body.notification.target_user_id).toBe(JOHN_ID);
    expect(body.notification.recipient.email).toBe("john@example.com");
    expect(body.notification.recipient.full_name).toBe("John Doe");
  });
});

describe("3-4. targeting isolation", () => {
  it("3. the targeted notification reaches ONLY the selected user", async () => {
    setSession({ id: OWNER_ID, email: "adsium.business@gmail.com" });
    await sendRoute(
      new Request("http://localhost/api/admin/notifications/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          target_type: "user",
          target_user_id: JOHN_ID,
          title: "Only for John",
          content: "Personal note.",
          type: "info",
          idempotency_key: key(),
        }),
      }),
    );
    setSession({ id: JOHN_ID, email: "john@example.com" });
    const list = await listRoute();
    const items = ((await list.json()) as { items: Array<{ title: string }> }).items;
    expect(items.map((item) => item.title)).toContain("Only for John");
  });

  it("4. any other user cannot see the targeted notification", async () => {
    setSession({ id: OWNER_ID, email: "adsium.business@gmail.com" });
    await sendRoute(
      new Request("http://localhost/api/admin/notifications/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          target_type: "user",
          target_user_id: JOHN_ID,
          title: "Only for John",
          content: "Personal note.",
          type: "info",
          idempotency_key: key(),
        }),
      }),
    );
    setSession({ id: JANE_ID, email: "jane@example.com" });
    const list = await listRoute();
    const items = ((await list.json()) as { items: Array<{ title: string }> }).items;
    expect(items).toHaveLength(0); // Jane sees nothing (no globals either)
  });
});

describe("5-7. non-owner authorization", () => {
  it("5. a non-owner cannot search users through the admin API", async () => {
    setSession({ id: JOHN_ID, email: "john@example.com" });
    const response = await searchRoute(
      new Request("http://localhost/api/admin/notifications/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "jane" }),
      }),
    );
    expect(response.status).toBe(403);
  });

  it("6. a non-owner cannot send targeted notifications", async () => {
    setSession({ id: JOHN_ID, email: "john@example.com" });
    const response = await sendRoute(
      new Request("http://localhost/api/admin/notifications/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          target_type: "user",
          target_user_id: JANE_ID,
          title: "Spoofed notice",
          content: "Should never be created.",
          type: "info",
          idempotency_key: key(),
        }),
      }),
    );
    expect(response.status).toBe(403);
    expect(db.notifications).toHaveLength(0);
  });

  it("7. a non-owner cannot send global notifications", async () => {
    setSession({ id: JOHN_ID, email: "john@example.com" });
    const response = await sendRoute(
      new Request("http://localhost/api/admin/notifications/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          target_type: "all",
          title: "Spoofed global",
          content: "Should never be created.",
          type: "info",
          idempotency_key: key(),
        }),
      }),
    );
    expect(response.status).toBe(403);
    expect(db.notifications).toHaveLength(0);
  });
});

describe("8. bounded search", () => {
  it("search returns at most 10 results and matches email or name", async () => {
    setSession({ id: OWNER_ID, email: "adsium.business@gmail.com" });
    const response = await searchRoute(
      new Request("http://localhost/api/admin/notifications/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "example" }),
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      results: Array<{ id: string; email: string; full_name: string }>;
    };
    expect(body.results.length).toBeLessThanOrEqual(10);
    expect(body.results.length).toBe(10); // 15 matches exist (john, jane, user1..12)
    // Only identity fields — nothing sensitive.
    for (const row of body.results) {
      expect(Object.keys(row).sort()).toEqual(["email", "full_name", "id"]);
    }
    expect(body.results.some((row) => row.id === JOHN_ID)).toBe(true);
  });
});

describe("9. idempotency", () => {
  it("a duplicate submit (same idempotency key) returns the original — no second row", async () => {
    setSession({ id: OWNER_ID, email: "adsium.business@gmail.com" });
    const sharedKey = key();
    // One form open = one key. A double-click / network retry re-sends the
    // EXACT same payload (same key) in a fresh request.
    const makeRequest = () =>
      new Request("http://localhost/api/admin/notifications/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          target_type: "all",
          title: "Maintenance window",
          content: "Scheduled maintenance tonight.",
          type: "maintenance",
          idempotency_key: sharedKey,
        }),
      });

    const a = await sendRoute(makeRequest());
    expect(a.status).toBe(201);
    const aBody = (await a.json()) as {
      duplicate: boolean;
      notification: { id: string };
    };
    expect(aBody.duplicate).toBe(false);

    const b = await sendRoute(makeRequest());
    expect(b.status).toBe(200);
    const bBody = (await b.json()) as {
      duplicate: boolean;
      notification: { id: string };
    };
    expect(bBody.duplicate).toBe(true);
    expect(bBody.notification.id).toBe(aBody.notification.id);
    expect(db.notifications).toHaveLength(1);
  });
});

describe("10-12. read state", () => {
  async function seedTargetedForJohn() {
    setSession({ id: OWNER_ID, email: "adsium.business@gmail.com" });
    const response = await sendRoute(
      new Request("http://localhost/api/admin/notifications/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          target_type: "user",
          target_user_id: JOHN_ID,
          title: "Application status",
          content: "Your application was reviewed.",
          type: "important",
          idempotency_key: key(),
        }),
      }),
    );
    expect(response.status).toBe(201);
  }

  it("10. unread → read transition works", async () => {
    await seedTargetedForJohn();
    setSession({ id: JOHN_ID, email: "john@example.com" });

    const before = await listRoute();
    const beforeItems = ((await before.json()) as {
      items: Array<{ id: string; read: boolean }>;
    }).items;
    expect(beforeItems).toHaveLength(1);
    expect(beforeItems[0].read).toBe(false);

    const readResponse = await readRoute(
      new Request("http://localhost/api/notifications/read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ notification_id: beforeItems[0].id }),
      }),
    );
    expect(readResponse.status).toBe(200);

    const after = await listRoute();
    const afterItems = ((await after.json()) as {
      items: Array<{ read: boolean }>;
    }).items;
    expect(afterItems[0].read).toBe(true);
  });

  it("11. read_at is saved (and the FIRST read wins on re-reads)", async () => {
    await seedTargetedForJohn();
    setSession({ id: JOHN_ID, email: "john@example.com" });
    const list = await listRoute();
    const items = ((await list.json()) as {
      items: Array<{ id: string }>;
    }).items;

    const readRequest = () =>
      new Request("http://localhost/api/notifications/read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ notification_id: items[0].id }),
      });
    const first = (await (await readRoute(readRequest())).json()) as {
      read_at: string;
    };
    expect(first.read_at).toBeTruthy();

    const second = (await (await readRoute(readRequest())).json()) as {
      read_at: string;
    };

    // Idempotent: the original receipt (and its read_at) is kept.
    expect(second.read_at).toBe(first.read_at);
    expect(db.notification_reads).toHaveLength(1);
    expect(db.notification_reads[0].read_at).toBe(first.read_at);
  });

  it("12. notifications persist after logout/login (state lives in the DB only)", async () => {
    await seedTargetedForJohn();
    setSession({ id: JOHN_ID, email: "john@example.com" });
    const firstLogin = await listRoute();
    const firstItems = ((await firstLogin.json()) as { items: Array<{ title: string }> }).items;
    expect(firstItems).toHaveLength(1);

    // "Logout" then "login" as the same user: no server-side session state
    // is involved — only the (mocked) database is.
    setSession(null);
    setSession({ id: JOHN_ID, email: "john@example.com" });
    const secondLogin = await listRoute();
    const secondItems = ((await secondLogin.json()) as { items: Array<{ title: string }> }).items;
    expect(secondItems).toHaveLength(1);
    expect(secondItems[0].title).toBe(firstItems[0].title);
  });
});

describe("13-14. authorization + existing behavior", () => {
  it("13. without a session every endpoint refuses (401) — server-side, not client-side", async () => {
    setSession(null);
    expect((await listRoute()).status).toBe(401);
    expect(
      (
        await readRoute(
          new Request("http://localhost/api/notifications/read", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ notification_id: JOHN_ID }),
          }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await searchRoute(
          new Request("http://localhost/api/admin/notifications/search", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ query: "john" }),
          }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await sendRoute(
          new Request("http://localhost/api/admin/notifications/send", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              target_type: "all",
              title: "Anonymous send",
              content: "No session, no write.",
              type: "info",
              idempotency_key: key(),
            }),
          }),
        )
      ).status,
    ).toBe(401);
    expect((await historyRoute()).status).toBe(401);
    expect(db.notifications).toHaveLength(0);
  });

  it("14. the existing (empty) notification contract still works: 200 with an empty list", async () => {
    setSession({ id: JOHN_ID, email: "john@example.com" });
    const response = await listRoute();
    expect(response.status).toBe(200);
    expect(((await response.json()) as { items: unknown[] }).items).toEqual([]);
  });
});

// --- admin history (owner view) — bonus contract ---------------------------
describe("admin history", () => {
  it("the owner sees their sent notifications with recipient identity", async () => {
    setSession({ id: OWNER_ID, email: "adsium.business@gmail.com" });
    await sendRoute(
      new Request("http://localhost/api/admin/notifications/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          target_type: "user",
          target_user_id: JOHN_ID,
          title: "Application notice",
          content: "Please check your application status.",
          type: "important",
          idempotency_key: key(),
        }),
      }),
    );
    const response = await historyRoute();
    expect(response.status).toBe(200);
    const items = ((await response.json()) as {
      items: Array<{ title: string; target_type: string; recipient: { email: string } | null }>;
    }).items;
    expect(items).toHaveLength(1);
    expect(items[0].target_type).toBe("user");
    expect(items[0].recipient?.email).toBe("john@example.com");
  });
});
