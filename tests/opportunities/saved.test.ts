import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const detailsArbeit =
  (await import("../fixtures/ba-details-arbeit.json")) as Record<
    string,
    unknown
  >;

const { createAdminMock, candidateProfileFixture, jsonResponse } =
  await import("../helpers");

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(),
}));
const { createAdminClient } = await import("@/lib/supabase/admin");

vi.mock("@/lib/auth", () => ({
  getCurrentUserAndProfile: vi.fn(),
}));
const { getCurrentUserAndProfile } = await import("@/lib/auth");

const {
  saveOpportunityFromKey,
  removeSavedOpportunity,
  updateSavedOpportunityNotes,
} = await import("@/lib/opportunities/saved");
const { OpportunityNotFoundError, OpportunityProviderError } =
  await import("@/lib/opportunities/providers/arbeitsagentur");

const DETAILS_REF = detailsArbeit.referenznummer as string;

let adminMock: Awaited<ReturnType<typeof createAdminMock>>;

function detailsSingleRow(): Record<string, unknown> {
  return {
    id: "row-1",
    user_id: "user-1",
    opportunity_key: `arbeitsagentur:${DETAILS_REF}`,
    provider: "arbeitsagentur",
    goal: "arbeit",
    title: detailsArbeit.stellenangebotsTitel,
    company_name: detailsArbeit.firma,
    location: "Berlin",
    source_url: `https://www.arbeitsagentur.de/jobsuche/jobdetail/${DETAILS_REF}`,
    source_name: "Bundesagentur für Arbeit – Jobbörse",
    source_external_id: DETAILS_REF,
    posted_at: "2026-09-28T00:00:00.000Z",
    salary_label: "13,90 € / hour",
    training_type: null,
    education_requirement: null,
    contact_email: "wedding.service@perzukunft.de",
    notes: null,
    match_score: null,
    match_status: null,
    saved_at: "2026-09-28T12:00:00.000Z",
    updated_at: "2026-09-28T12:00:00.000Z",
  };
}

beforeEach(() => {
  adminMock = createAdminMock({
    singleData: () => detailsSingleRow(),
    maybeSingleData: (table) =>
      table === "candidate_profiles" ? { profile_json: null } : null,
  });
  vi.mocked(createAdminClient).mockReturnValue(adminMock.admin as never);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => jsonResponse(detailsArbeit)),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("saveOpportunityFromKey (server-derived data only)", () => {
  it("stores fields derived from the source, keyed by the session user", async () => {
    const row = await saveOpportunityFromKey(
      "user-1",
      `arbeitsagentur:${DETAILS_REF}`,
      "Worth applying to",
    );
    const upsert = adminMock.calls.find(
      (call) => call.table === "saved_opportunities" && call.op === "upsert",
    );
    expect(upsert).toBeDefined();
    const payload = upsert?.args[0] as Record<string, unknown>;
    expect(payload.user_id).toBe("user-1");
    expect(payload.opportunity_key).toBe(`arbeitsagentur:${DETAILS_REF}`);
    expect(payload.title).toBe(detailsArbeit.stellenangebotsTitel);
    expect(payload.company_name).toBe(detailsArbeit.firma);
    expect(payload.goal).toBe("arbeit");
    expect(payload.contact_email).toBe("wedding.service@perzukunft.de");
    expect(payload.notes).toBe("Worth applying to");
    expect(payload.source_url).toContain(DETAILS_REF);
    // Duplicate saves are prevented by the unique constraint upsert.
    expect(upsert?.args[1]).toEqual({
      onConflict: "user_id,opportunity_key",
      ignoreDuplicates: true,
    });
    // The API returns the canonical row from the database.
    expect(row.id).toBe("row-1");
  });

  it("never persists fields that are not in the server-derived payload", async () => {
    await saveOpportunityFromKey("user-1", `arbeitsagentur:${DETAILS_REF}`);
    const upsert = adminMock.calls.find(
      (call) => call.table === "saved_opportunities" && call.op === "upsert",
    );
    const payload = upsert?.args[0] as Record<string, unknown>;
    const unexpected = Object.keys(payload).filter(
      (key) =>
        ![
          "user_id",
          "opportunity_key",
          "provider",
          "goal",
          "title",
          "company_name",
          "location",
          "source_url",
          "source_name",
          "source_external_id",
          "posted_at",
          "salary_label",
          "training_type",
          "education_requirement",
          "contact_email",
          "notes",
          "match_score",
          "match_status",
        ].includes(key),
    );
    expect(unexpected).toEqual([]);
  });

  it("stores a server-computed match snapshot only when a profile exists", async () => {
    adminMock = createAdminMock({
      singleData: () => detailsSingleRow(),
      maybeSingleData: (table) =>
        table === "candidate_profiles"
          ? { profile_json: candidateProfileFixture() }
          : null,
    });
    vi.mocked(createAdminClient).mockReturnValue(adminMock.admin as never);
    await saveOpportunityFromKey("user-1", `arbeitsagentur:${DETAILS_REF}`);
    const upsert = adminMock.calls.find(
      (call) => call.table === "saved_opportunities" && call.op === "upsert",
    );
    const payload = upsert?.args[0] as Record<string, unknown>;
    // Profile exists → a complete snapshot with a real score (Servicekraft
    // job: goal + location match, role mismatch for this fixture profile).
    expect(payload.match_score).toBeTypeOf("number");
    expect((payload.match_score as number) >= 0).toBe(true);
    expect(payload.match_status).toBe("complete");
  });

  it("stores match_status=incomplete (null score) when the profile lacks essentials", async () => {
    adminMock = createAdminMock({
      singleData: () => detailsSingleRow(),
      maybeSingleData: (table) =>
        table === "candidate_profiles"
          ? {
              profile_json: {
                ...candidateProfileFixture(),
                target_roles: [],
                preferences: {
                  ...candidateProfileFixture().preferences,
                  preferred_job_titles: [],
                },
              },
            }
          : null,
    });
    vi.mocked(createAdminClient).mockReturnValue(adminMock.admin as never);
    await saveOpportunityFromKey("user-1", `arbeitsagentur:${DETAILS_REF}`);
    const upsert = adminMock.calls.find(
      (call) => call.table === "saved_opportunities" && call.op === "upsert",
    );
    const payload = upsert?.args[0] as Record<string, unknown>;
    // No documented target roles → role dimension unknown → incomplete, no score.
    expect(payload.match_score).toBeNull();
    expect(payload.match_status).toBe("incomplete");
  });

  it("rejects malformed or foreign keys before any network call", async () => {
    vi.unstubAllGlobals();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      saveOpportunityFromKey("user-1", "not-a-key"),
    ).rejects.toBeInstanceOf(OpportunityProviderError);
    await expect(
      saveOpportunityFromKey("user-1", "otherprovider:abc123-S"),
    ).rejects.toBeInstanceOf(OpportunityProviderError);
    await expect(
      saveOpportunityFromKey("user-1", "arbeitsagentur:bad ref"),
    ).rejects.toBeInstanceOf(OpportunityProviderError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("propagates not-found errors for expired source references", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              messages: [{ code: "STELLENANGEBOT_NICHT_GEFUNDEN" }],
              timestamp: "2026-09-28T00:00:00Z",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    await expect(
      saveOpportunityFromKey("user-1", `arbeitsagentur:${DETAILS_REF}`),
    ).rejects.toBeInstanceOf(OpportunityNotFoundError);
    expect(
      adminMock.calls.some(
        (call) => call.table === "saved_opportunities" && call.op === "upsert",
      ),
    ).toBe(false);
  });
});

describe("user isolation on remove/notes", () => {
  it("scopes deletes to the authenticated user", async () => {
    await removeSavedOpportunity("user-A", `arbeitsagentur:${DETAILS_REF}`);
    const deleteCall = adminMock.calls.find(
      (call) => call.table === "saved_opportunities" && call.op === "eq",
    );
    expect(deleteCall).toBeDefined();
    // The final eq chain must contain both the user scope and the key.
    const allEq = adminMock.calls.filter(
      (call) => call.table === "saved_opportunities" && call.op === "eq",
    );
    const filterValues = allEq.map((call) => call.args[0]);
    expect(filterValues).toContain("user_id");
    expect(filterValues).toContain("opportunity_key");
    const userScope = allEq.find((call) => call.args[0] === "user_id");
    expect(userScope?.args[1]).toBe("user-A");
  });

  it("scopes notes updates to the authenticated user", async () => {
    await updateSavedOpportunityNotes(
      "user-B",
      `arbeitsagentur:${DETAILS_REF}`,
      "New notes",
    );
    const updateCall = adminMock.calls.find(
      (call) => call.table === "saved_opportunities" && call.op === "update",
    );
    expect(updateCall).toBeDefined();
    expect(updateCall?.args[0]).toEqual({ notes: "New notes" });
    const userScope = adminMock.calls.find(
      (call) =>
        call.table === "saved_opportunities" &&
        call.op === "eq" &&
        call.args[0] === "user_id",
    );
    expect(userScope?.args[1]).toBe("user-B");
  });
});

describe("save route contract", () => {
  const loadRoute = () => import("@/app/api/opportunities/save/route");

  type AuthResult = Awaited<ReturnType<typeof getCurrentUserAndProfile>>;
  const authed = (userId: string): AuthResult =>
    ({ user: { id: userId }, profile: null }) as unknown as AuthResult;
  const unauthenticated = (): AuthResult =>
    ({ user: null, profile: null }) as unknown as AuthResult;

  it("requires authentication", async () => {
    vi.mocked(getCurrentUserAndProfile).mockResolvedValue(unauthenticated());
    const { POST } = await loadRoute();
    const response = await POST(
      new Request("http://localhost/api/opportunities/save", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          opportunityKey: `arbeitsagentur:${DETAILS_REF}`,
        }),
      }),
    );
    expect(response.status).toBe(401);
  });

  it("rejects bodies that inject opportunity data (strict schema)", async () => {
    vi.mocked(getCurrentUserAndProfile).mockResolvedValue(authed("user-1"));
    const { POST } = await loadRoute();
    const response = await POST(
      new Request("http://localhost/api/opportunities/save", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          opportunityKey: `arbeitsagentur:${DETAILS_REF}`,
          company_name: "FAKE COMPANY",
          title: "FAKE TITLE",
          salary: "999999 €",
          match_score: 100,
        }),
      }),
    );
    expect(response.status).toBe(400);
    expect(
      adminMock.calls.some(
        (call) => call.table === "saved_opportunities" && call.op === "upsert",
      ),
    ).toBe(false);
  });

  it("saves via the server-derived flow on a clean body", async () => {
    vi.mocked(getCurrentUserAndProfile).mockResolvedValue(authed("user-1"));
    const { POST } = await loadRoute();
    const response = await POST(
      new Request("http://localhost/api/opportunities/save", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          opportunityKey: `arbeitsagentur:${DETAILS_REF}`,
        }),
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      saved: { title: string; company_name: string };
    };
    expect(body.saved.title).toBe(detailsArbeit.stellenangebotsTitel);
    expect(body.saved.company_name).toBe(detailsArbeit.firma);
  });

  it("maps expired references to 404", async () => {
    vi.mocked(getCurrentUserAndProfile).mockResolvedValue(authed("user-1"));
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              messages: [{ code: "STELLENANGEBOT_NICHT_GEFUNDEN" }],
              timestamp: "2026-09-28T00:00:00Z",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    const { POST } = await loadRoute();
    const response = await POST(
      new Request("http://localhost/api/opportunities/save", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          opportunityKey: `arbeitsagentur:${DETAILS_REF}`,
        }),
      }),
    );
    expect(response.status).toBe(404);
  });
});
