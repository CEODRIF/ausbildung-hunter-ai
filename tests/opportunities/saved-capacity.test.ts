import { beforeEach, describe, expect, it, vi } from "vitest";

// saved_opportunities plan-item capacity (one item = one NEW saved row),
// enforced SERVER-SIDE in saveOpportunityFromKey:
//   allowed        → normal upsert
//   quota_exhausted + no existing row → capacity error, ZERO writes
//   quota_exhausted + existing row    → re-save allowed (idempotent upsert,
//                                       never counted as a new item)
//   lookup_error   → fail CLOSED with a retryable error (never grants a slot)
//   other denials  → "not available on your plan"
// The API route maps the capacity error to 403 { code: "capacity_reached" }
// and the lookup failure to 502 (retryable upstream-style error).
//
// `@/lib/opportunities/search` (resolveOpportunityCached) is faked — the BA
// network is never touched. Key validation uses the REAL
// `parseOpportunityKey` contract.

vi.mock("@/lib/auth", () => ({
  getCurrentUserAndProfile: vi.fn(),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
  rateLimitHeaders: vi.fn(() => ({})),
  tooManyRequests: vi.fn(() => ({ status: 429 })),
}));
vi.mock("@/lib/billing/entitlement-service", () => ({
  checkFeature: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(),
}));
vi.mock("@/lib/opportunities/search", () => ({
  resolveOpportunityCached: vi.fn(),
}));

const { getCurrentUserAndProfile } = await import("@/lib/auth");
const { checkRateLimit } = await import("@/lib/rate-limit");
const { checkFeature } = await import("@/lib/billing/entitlement-service");
const { createAdminClient } = await import("@/lib/supabase/admin");
const { resolveOpportunityCached } = await import("@/lib/opportunities/search");
const { createAdminMock } = await import("../helpers");
const {
  OpportunityCapacityError,
  OpportunityProviderError,
  saveOpportunityFromKey,
} = await import("@/lib/opportunities/saved");
const { POST } = await import("@/app/api/opportunities/save/route");

const check = checkFeature as unknown as ReturnType<typeof vi.fn>;
const resolve = resolveOpportunityCached as unknown as ReturnType<typeof vi.fn>;

const USER = "u1";
// Valid key per the real contract: provider "arbeitsagentur" + ref matching
// /^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/
const KEY = "arbeitsagentur:2026_123456";

const opportunity = {
  id: KEY, // the saved row's opportunity_key IS the resolved id
  provider: "arbeitsagentur",
  goal: "arbeit",
  title: "Mechatroniker (m/w/d)",
  company_name: "ACME GmbH",
  location: "Berlin",
  source_url: "https://www.arbeitsagentur.de/stellenangebote",
  source_name: "Bundesagentur für Arbeit",
  posted_at: "2026-10-01",
  salary: { label: "2000 EUR", min: 2000, max: null, currency: "EUR" },
  training_type: null,
  education_requirement: null,
  contact: { email: "hr@acme.de", phone: null },
};

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "row-1",
    user_id: USER,
    opportunity_key: KEY,
    provider: "arbeitsagentur",
    goal: "arbeit",
    title: opportunity.title,
    company_name: "ACME GmbH",
    location: "Berlin",
    source_url: opportunity.source_url,
    source_name: opportunity.source_name,
    posted_at: "2026-10-01",
    salary_label: "2000 EUR",
    training_type: null,
    education_requirement: null,
    contact_email: "hr@acme.de",
    notes: null,
    match_score: null,
    match_status: null,
    matcher_version: null,
    match_profile_updated_at: null,
    saved_at: "2026-10-24T00:00:00.000Z",
    ...overrides,
  };
}

function mockAdmin(options: Parameters<typeof createAdminMock>[0] = {}) {
  const { admin, calls } = createAdminMock({
    // No candidate profile → match snapshot stays null (best-effort path).
    maybeSingleData: (table: string) => {
      if (table === "saved_opportunities")
        return options.maybeSingleData?.(table) ?? null;
      return null;
    },
    singleData: () => row(),
    ...options,
  });
  vi.mocked(createAdminClient).mockReturnValue(admin as never);
  return calls;
}

function allowedPlan(overrides: Record<string, unknown> = {}) {
  check.mockResolvedValue({ allowed: true, reason: "ok", ...overrides } as never);
}

function deniedPlan(reason: string) {
  check.mockResolvedValue({ allowed: false, reason } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCurrentUserAndProfile).mockResolvedValue({
    user: { id: USER },
    profile: { account_status: "active" },
  } as never);
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
  allowedPlan();
  resolve.mockResolvedValue(opportunity as never);
  mockAdmin();
});

describe("saveOpportunityFromKey — capacity gate (function level)", () => {
  it("saves when capacity is available: upsert with conflict key + activity log", async () => {
    const calls = mockAdmin();
    const saved = await saveOpportunityFromKey(USER, KEY, "note");

    expect(check).toHaveBeenCalledWith(USER, "saved_opportunities");
    // The function returns the DB row (the mock's single() payload).
    expect(saved).toEqual(row());
    const upsert = calls.find(
      (call) => call.table === "saved_opportunities" && call.op === "upsert",
    );
    expect(upsert).toBeDefined();
    const [payload, opts] = upsert!.args as [Record<string, unknown>, Record<string, unknown>];
    // Server-derived fields: the key is the RESOLVED id, notes trimmed.
    expect(payload).toMatchObject({
      user_id: USER,
      opportunity_key: KEY,
      title: "Mechatroniker (m/w/d)",
      salary_label: "2000 EUR",
      notes: "note",
    });
    expect(opts).toEqual({
      onConflict: "user_id,opportunity_key",
      ignoreDuplicates: true,
    });
    expect(
      calls.some(
        (call) => call.table === "activity_logs" && call.op === "insert",
      ),
    ).toBe(true);
  });

  it.each([
    ["feature_disabled", "Saved opportunities are not available on your current plan."],
    ["plan_expired", "Saved opportunities are not available on your current plan."],
  ] as const)(
    "plan denial %s → capacity error, ZERO database writes",
    async (reason, message) => {
      const calls = mockAdmin();
      deniedPlan(reason);

      await expect(saveOpportunityFromKey(USER, KEY)).rejects.toThrow(
        new RegExp(`^${message}$`),
      );
      expect(check).toHaveBeenCalledTimes(1);
      expect(resolve).not.toHaveBeenCalled(); // rejected before the resolver
      expect(calls).toEqual([]); // no read, no upsert, no activity log
    },
  );

  it("quota_exhausted + NO existing row → capacity_reached error, zero writes", async () => {
    const calls = mockAdmin();
    deniedPlan("quota_exhausted");

    const promise = saveOpportunityFromKey(USER, KEY);
    await expect(promise).rejects.toBeInstanceOf(OpportunityCapacityError);
    await expect(promise).rejects.toThrow(
      "Saved opportunity limit reached for your current plan.",
    );
    // The re-save probe is a READ only — the write path never runs.
    expect(calls.map((call) => call.table)).toEqual([
      "saved_opportunities",
      "saved_opportunities",
      "saved_opportunities",
    ]);
    expect(calls.map((call) => call.op)).toEqual(["select", "eq", "eq"]);
    expect(calls[2].filters).toEqual({
      "eq:user_id": USER,
      "eq:opportunity_key": KEY,
    });
    expect(calls.some((call) => call.op === "upsert")).toBe(false);
    expect(calls.some((call) => call.table === "activity_logs")).toBe(false);
  });

  it("quota_exhausted + EXISTING row → re-save succeeds (not counted again)", async () => {
    const calls = mockAdmin({
      maybeSingleData: (table: string) =>
        table === "saved_opportunities" ? row({ id: "row-existing" }) : null,
    });
    deniedPlan("quota_exhausted");

    const saved = await saveOpportunityFromKey(USER, KEY);

    expect(saved).toEqual(row());
    // The upsert is the same idempotent statement — at the database level the
    // unique(user_id, opportunity_key) conflict makes it a no-op, so a
    // re-save never creates a second item.
    expect(
      calls.filter(
        (call) => call.table === "saved_opportunities" && call.op === "upsert",
      ),
    ).toHaveLength(1);
  });

  it("lookup_error → fail CLOSED: retryable provider error, zero admin calls", async () => {
    const calls = mockAdmin();
    deniedPlan("lookup_error");

    await expect(saveOpportunityFromKey(USER, KEY)).rejects.toBeInstanceOf(
      OpportunityProviderError,
    );
    await expect(saveOpportunityFromKey(USER, KEY)).rejects.toThrow(
      "Unable to verify your plan right now. Please try again.",
    );
    expect(resolve).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("invalid key (not arbeitsagentur:<ref>) → rejected before resolver or DB", async () => {
    const calls = mockAdmin();

    await expect(saveOpportunityFromKey(USER, "not-a-key")).rejects.toBeInstanceOf(
      OpportunityProviderError,
    );
    await expect(saveOpportunityFromKey(USER, "other:1234")).rejects.toBeInstanceOf(
      OpportunityProviderError,
    );
    expect(check).not.toHaveBeenCalled(); // key contract checked first
    expect(resolve).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });
});

describe("POST /api/opportunities/save — HTTP contract", () => {
  async function post(body: unknown) {
    return POST(
      new Request("http://localhost/api/opportunities/save", {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      }),
    );
  }

  it("200 + saved row when capacity is available", async () => {
    const response = await post({ opportunityKey: KEY, notes: null });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { saved: Record<string, unknown> };
    expect(body.saved).toEqual(row());
  });

  it("403 { code: capacity_reached } when the limit is reached (no existing row)", async () => {
    mockAdmin();
    deniedPlan("quota_exhausted");

    const response = await post({ opportunityKey: KEY, notes: null });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: string; code: string };
    expect(body).toEqual({
      error: "Saved opportunity limit reached for your current plan.",
      code: "capacity_reached",
    });
  });

  it("502 (retryable) when the plan cannot be verified — fail closed", async () => {
    mockAdmin();
    deniedPlan("lookup_error");

    const response = await post({ opportunityKey: KEY, notes: null });
    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe(
      "Unable to verify your plan right now. Please try again.",
    );
  });

  it("401 without an authenticated user", async () => {
    vi.mocked(getCurrentUserAndProfile).mockResolvedValue({
      user: null,
      profile: null,
    } as never);
    const response = await post({ opportunityKey: KEY });
    expect(response.status).toBe(401);
  });

  it("400 for an unknown extra field (strict schema strips/ rejects client data)", async () => {
    const response = await post({
      opportunityKey: KEY,
      notes: null,
      title: "injected",
    });
    expect(response.status).toBe(400);
  });
});

describe("concurrency — capacity cannot be exceeded by racing re-saves", () => {
  it("two simultaneous saves of the SAME key at the limit → exactly one row (unique conflict + ignoreDuplicates)", async () => {
    // Shared table state: the user is AT the limit and already owns this key.
    const rows: Record<string, unknown>[] = [row({ id: "row-existing" })];
    const upserts: { row: Record<string, unknown>; opts: unknown }[] = [];

    const statefulAdmin = {
      from() {
        const filters: Record<string, unknown> = {};
        let upsertPayload: Record<string, unknown> | null = null;
        let upsertOpts: unknown = null;
        const make: Record<string | symbol, unknown> = new Proxy({}, {
          get(_t, prop) {
            if (typeof prop !== "string") return undefined;
            if (prop === "eq")
              return (col: string, val: unknown) => {
                filters[col] = val;
                return make;
              };
            if (prop === "upsert")
              return (r: Record<string, unknown>, opts: unknown) => {
                upsertPayload = r;
                upsertOpts = opts;
                return make;
              };
            if (prop === "maybeSingle")
              return async () => ({
                data:
                  rows.find((r) =>
                    Object.entries(filters).every(
                      ([k, v]) => r[k] === v,
                    ),
                  ) ?? null,
                error: null,
              });
            if (prop === "single")
              return async () => {
                if (!upsertPayload) return { data: null, error: null };
                upserts.push({ row: { ...upsertPayload }, opts: upsertOpts });
                // Model the DB's unique(user_id, opportunity_key) +
                // ignoreDuplicates: a racing insert of the same key is a
                // no-op, never a second row.
                const existing = rows.find(
                  (r) =>
                    r.user_id === upsertPayload!.user_id &&
                    r.opportunity_key === upsertPayload!.opportunity_key,
                );
                if (existing) return { data: existing, error: null };
                const created = { ...upsertPayload, id: `row-${rows.length + 1}` };
                rows.push(created);
                return { data: created, error: null };
              };
            if (prop === "then")
              return (onF?: unknown, onR?: unknown) =>
                Promise.resolve({ data: null, error: null }).then(
                  onF as never,
                  onR as never,
                );
            return () => make;
          },
        });
        return make;
      },
    };
    vi.mocked(createAdminClient).mockReturnValue(statefulAdmin as never);
    deniedPlan("quota_exhausted");
    resolve.mockResolvedValue(opportunity as never);

    const [a, b] = await Promise.all([
      saveOpportunityFromKey(USER, KEY),
      saveOpportunityFromKey(USER, KEY),
    ]);

    // Both callers succeed (each saw the existing row), both issued the
    // idempotent upsert — but the table gained NO new item.
    expect(a.opportunity_key).toBe(KEY);
    expect(b.opportunity_key).toBe(KEY);
    expect(upserts).toHaveLength(2);
    for (const { opts } of upserts) {
      expect(opts).toEqual({
        onConflict: "user_id,opportunity_key",
        ignoreDuplicates: true,
      });
    }
    expect(rows.filter((r) => r.opportunity_key === KEY)).toHaveLength(1);
  });
});
