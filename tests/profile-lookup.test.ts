import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Profile lookup contract (production incident: confirmed + active users
 * bounced to /verify because the RLS-gated profiles SELECT saw no row):
 *  - a visible profile is returned as-is (no service-role call on the happy
 *    path);
 *  - when the RLS-gated query finds no row, the SAME row is re-checked with
 *    the service role (strictly the session user's own id) so a confirmed
 *    user is never locked out while the database access contract is
 *    repaired;
 *  - using the fallback is a production defect signal and must be logged.
 */
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

const { getCurrentUserAndProfile } = await import("@/lib/auth");
const { createClient } = await import("@/lib/supabase/server");
const { createAdminClient } = await import("@/lib/supabase/admin");

const USER = {
  id: "u1",
  email: "jane@example.com",
  email_confirmed_at: "2026-01-01T00:00:00Z",
} as never;

const PROFILE = {
  id: "u1",
  full_name: "Jane Doe",
  email: "jane@example.com",
  account_status: "active" as const,
  selected_goal: null,
  daily_email_limit: 50,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

type Query = {
  select: () => Query;
  eq: (col: string, val: string) => Query;
  maybeSingle: () => Promise<{
    data: unknown;
    error: { message: string } | null;
  }>;
};

function makeClient(
  result: () => Promise<{ data: unknown; error: { message: string } | null }>,
) {
  const query: Query = {
    select: () => query,
    eq: () => query,
    maybeSingle: result,
  };
  return {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: USER } }) },
    from: vi.fn(() => query),
  };
}

afterEach(() => {
  vi.clearAllMocks();
  (console.error as unknown as { mockRestore?: () => void }).mockRestore?.();
});

describe("getCurrentUserAndProfile", () => {
  it("returns the RLS-visible profile without any service-role call", async () => {
    const serverClient = makeClient(async () => ({
      data: PROFILE,
      error: null,
    }));
    const adminClient = makeClient(async () => ({
      data: PROFILE,
      error: null,
    }));
    vi.mocked(createClient).mockResolvedValue(serverClient as never);
    vi.mocked(createAdminClient).mockReturnValue(adminClient as never);

    const { user, profile } = await getCurrentUserAndProfile();

    expect(user).toBe(USER);
    // Phase 10: the profile is enriched with the server-computed
    // platform-admin flag — false for every non-admin id, at zero
    // service-role cost (the membership is only queried when the stable
    // admin id matches, which "u1" never does).
    expect(profile).toEqual({ ...PROFILE, isPlatformAdmin: false });
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("the designated admin id pays exactly one service-role PK read (flag true)", async () => {
    const ADMIN_ID = "6fa45036-1b86-427a-a7d0-54a3a3904767";
    const adminUser = {
      id: ADMIN_ID,
      email: "jane@example.com",
      email_confirmed_at: "2026-01-01T00:00:00Z",
    } as never;
    const serverClient = {
      ...makeClient(async () => ({ data: { ...PROFILE, id: ADMIN_ID }, error: null })),
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: adminUser } }) },
    };
    const adminClient = makeClient(async () => ({ data: { user_id: ADMIN_ID }, error: null }));
    vi.mocked(createClient).mockResolvedValue(serverClient as never);
    vi.mocked(createAdminClient).mockReturnValue(adminClient as never);

    const { profile } = await getCurrentUserAndProfile();
    expect(profile).toMatchObject({ id: ADMIN_ID, isPlatformAdmin: true });
    expect(createAdminClient).toHaveBeenCalledTimes(1);
  });

  it("an admins read error fails the flag closed (false, no throw)", async () => {
    const ADMIN_ID = "6fa45036-1b86-427a-a7d0-54a3a3904767";
    const adminUser = {
      id: ADMIN_ID,
      email: "jane@example.com",
      email_confirmed_at: "2026-01-01T00:00:00Z",
    } as never;
    const serverClient = {
      ...makeClient(async () => ({ data: { ...PROFILE, id: ADMIN_ID }, error: null })),
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: adminUser } }) },
    };
    const adminClient = makeClient(async () => ({ data: null, error: { message: "boom" } }));
    vi.mocked(createClient).mockResolvedValue(serverClient as never);
    vi.mocked(createAdminClient).mockReturnValue(adminClient as never);

    const { profile } = await getCurrentUserAndProfile();
    expect(profile).toMatchObject({ id: ADMIN_ID, isPlatformAdmin: false });
  });

  it("falls back to the service role (same id) when RLS hides the row, and logs it", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const serverClient = makeClient(async () => ({ data: null, error: null }));
    const adminClient = makeClient(async () => ({
      data: PROFILE,
      error: null,
    }));
    vi.mocked(createClient).mockResolvedValue(serverClient as never);
    vi.mocked(createAdminClient).mockReturnValue(adminClient as never);

    const { profile } = await getCurrentUserAndProfile();

    // Phase 10: the fallback path carries the same (false for "u1") flag.
    expect(profile).toEqual({ ...PROFILE, isPlatformAdmin: false });
    expect(createAdminClient).toHaveBeenCalled();
    const logged = spy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain("service_role");
    expect(logged).toContain("20261008000000");
  });

  it("still returns null when the row truly does not exist anywhere", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const serverClient = makeClient(async () => ({ data: null, error: null }));
    const adminClient = makeClient(async () => ({ data: null, error: null }));
    vi.mocked(createClient).mockResolvedValue(serverClient as never);
    vi.mocked(createAdminClient).mockReturnValue(adminClient as never);

    const { profile } = await getCurrentUserAndProfile();

    expect(profile).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("logs the swallowed RLS error and still falls back", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const serverClient = makeClient(async () => ({
      data: null,
      error: { message: "permission denied for table profiles" },
    }));
    const adminClient = makeClient(async () => ({
      data: PROFILE,
      error: null,
    }));
    vi.mocked(createClient).mockResolvedValue(serverClient as never);
    vi.mocked(createAdminClient).mockReturnValue(adminClient as never);

    const { profile } = await getCurrentUserAndProfile();

    // Phase 10: the fallback path carries the same (false for "u1") flag.
    expect(profile).toEqual({ ...PROFILE, isPlatformAdmin: false });
    const logged = spy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain("permission denied for table profiles");
    expect(logged).toContain("service_role");
  });

  it("returns user null without touching profiles when there is no session", async () => {
    const serverClient = {
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: null } }),
      },
      from: vi.fn(),
    };
    vi.mocked(createClient).mockResolvedValue(serverClient as never);

    const result = await getCurrentUserAndProfile();

    expect(result).toEqual({ user: null, profile: null });
    expect(serverClient.from).not.toHaveBeenCalled();
    expect(createAdminClient).not.toHaveBeenCalled();
  });
});
