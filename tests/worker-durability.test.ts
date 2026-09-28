import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

const { createAdminClient } = await import("@/lib/supabase/admin");

const SECRET = "test-worker-secret-9f8e7d6c";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("EMAIL_WORKER_SECRET", SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function mockClaimRpc(result: {
  data?: Record<string, unknown> | null;
  error?: { message: string } | null;
}) {
  vi.mocked(createAdminClient).mockReturnValue({
    rpc: vi.fn().mockResolvedValue(result),
  } as never);
}

function claimRequest(body?: unknown, secret?: string | null) {
  return new Request("http://localhost/api/internal/email-worker/claim", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(secret === null ? {} : { "x-email-worker-secret": secret ?? SECRET }),
    },
    body: body === undefined ? "{}" : JSON.stringify(body),
  });
}

describe("migration guards (claim_next_pending_campaign)", () => {
  const sql = readFileSync(
    fileURLToPath(
      new URL(
        "../supabase/migrations/20261003000000_durable_worker.sql",
        import.meta.url,
      ),
    ),
    "utf8",
  );

  it("claims atomically with skip-locked (concurrent pollers never double-claim a campaign)", () => {
    expect(sql).toMatch(/for update of c skip locked/i);
    expect(sql).toMatch(/limit 1/i);
  });

  it("is security definer; execute revoked from public/anon/authenticated, granted to service_role", () => {
    expect(sql).toMatch(/security definer/i);
    expect(sql).toMatch(
      /revoke execute on function public\.claim_next_pending_campaign\(\)\s*from public, anon, authenticated/i,
    );
    expect(sql).toMatch(
      /grant execute on function public\.claim_next_pending_campaign\(\)\s*to service_role/i,
    );
  });

  it("only discovers non-terminal campaigns with a due queued message (FIFO)", () => {
    expect(sql).toMatch(/c\.status in \('queued', 'sending'\)/i);
    expect(sql).toMatch(/m\.status = 'queued'/i);
    expect(sql).toMatch(
      /m\.next_attempt_at is null\s+or\s+m\.next_attempt_at <= timezone\('utc', now\(\)\)/i,
    );
    expect(sql).toMatch(/order by c\.created_at asc/i);
  });

  it("returns an explicit null campaign instead of failing when the queue is empty", () => {
    expect(sql).toMatch(/'campaign_id', null/i);
  });
});

describe("POST /api/internal/email-worker/claim", () => {
  it("401 without the worker secret header", async () => {
    const { POST } =
      await import("@/app/api/internal/email-worker/claim/route");
    mockClaimRpc({ data: { user_id: "u", campaign_id: "c" } });
    const res = await POST(claimRequest(undefined, null));
    expect(res.status).toBe(401);
  });

  it("401 with a wrong secret", async () => {
    const { POST } =
      await import("@/app/api/internal/email-worker/claim/route");
    mockClaimRpc({ data: { user_id: "u", campaign_id: "c" } });
    const res = await POST(claimRequest(undefined, "wrong"));
    expect(res.status).toBe(401);
  });

  it("401 even with a header when the secret is not configured", async () => {
    vi.stubEnv("EMAIL_WORKER_SECRET", "");
    const { POST } =
      await import("@/app/api/internal/email-worker/claim/route");
    mockClaimRpc({ data: { user_id: "u", campaign_id: "c" } });
    const res = await POST(claimRequest());
    expect(res.status).toBe(401);
  });

  it("400 on invalid JSON", async () => {
    const { POST } =
      await import("@/app/api/internal/email-worker/claim/route");
    mockClaimRpc({ data: null });
    const res = await POST(
      new Request("http://localhost/api/internal/email-worker/claim", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-email-worker-secret": SECRET,
        },
        body: "{nope",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("400 on any extra field (worker supplies nothing it controls)", async () => {
    const { POST } =
      await import("@/app/api/internal/email-worker/claim/route");
    mockClaimRpc({ data: null });
    const res = await POST(claimRequest({ userId: "evil", campaignId: "x" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Claim request must be empty" });
  });

  it("200 campaign:null when the queue is empty (both RPC shapes)", async () => {
    const { POST } =
      await import("@/app/api/internal/email-worker/claim/route");
    mockClaimRpc({ data: { user_id: null, campaign_id: null } });
    expect((await (await POST(claimRequest())).json()) as unknown).toEqual({
      campaign: null,
    });
    mockClaimRpc({ data: null });
    expect((await (await POST(claimRequest())).json()) as unknown).toEqual({
      campaign: null,
    });
  });

  it("200 maps the claimed pair (server-derived, no client input)", async () => {
    const { POST } =
      await import("@/app/api/internal/email-worker/claim/route");
    mockClaimRpc({
      data: {
        user_id: "11111111-1111-4111-8111-111111111111",
        campaign_id: "22222222-2222-4222-8222-222222222222",
      },
    });
    const res = await POST(claimRequest());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      campaign: {
        userId: "11111111-1111-4111-8111-111111111111",
        campaignId: "22222222-2222-4222-8222-222222222222",
      },
    });
  });

  it("500 when the RPC errors (worker retries next tick, no corruption)", async () => {
    const { POST } =
      await import("@/app/api/internal/email-worker/claim/route");
    mockClaimRpc({ error: { message: "db down" } });
    const res = await POST(claimRequest());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Claim failed" });
  });
});

describe("GET /api/health", () => {
  function mockHealthAdmin(ok: boolean) {
    vi.mocked(createAdminClient).mockReturnValue({
      from: () => ({
        select: () => ({
          limit: async () => ({
            data: null,
            error: ok ? null : { message: "db down" },
          }),
        }),
      }),
    } as never);
  }

  it("200 ok with boolean checks only when the database responds", async () => {
    const { GET } = await import("@/app/api/health/route");
    mockHealthAdmin(true);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      status: "ok",
      checks: { database: true, workerSecretConfigured: true },
    });
  });

  it("503 degraded when the database probe fails", async () => {
    const { GET } = await import("@/app/api/health/route");
    mockHealthAdmin(false);
    const res = await GET();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      status: "degraded",
      checks: { database: false, workerSecretConfigured: true },
    });
  });

  it("503 when the admin client throws entirely (no unhandled rejection)", async () => {
    const { GET } = await import("@/app/api/health/route");
    vi.mocked(createAdminClient).mockImplementation(() => {
      throw new Error("no env");
    });
    const res = await GET();
    expect(res.status).toBe(503);
  });

  it("reports workerSecretConfigured=false when the env var is absent", async () => {
    vi.stubEnv("EMAIL_WORKER_SECRET", "");
    const { GET } = await import("@/app/api/health/route");
    mockHealthAdmin(true);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "ok",
      checks: { database: true, workerSecretConfigured: false },
    });
  });

  it("never leaks env var values or error details (public endpoint)", async () => {
    const { GET } = await import("@/app/api/health/route");
    mockHealthAdmin(false);
    const raw = await (await GET()).text();
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain("db down");
    const body = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["checks", "status"]);
    const checks = body["checks"] as Record<string, unknown>;
    expect(Object.keys(checks).sort()).toEqual([
      "database",
      "workerSecretConfigured",
    ]);
    expect(typeof checks["database"]).toBe("boolean");
    expect(typeof checks["workerSecretConfigured"]).toBe("boolean");
  });
});
