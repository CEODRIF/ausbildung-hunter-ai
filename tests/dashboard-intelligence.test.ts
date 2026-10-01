import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks (data assembly tests)
// ---------------------------------------------------------------------------

interface Filters {
  [key: string]: unknown;
}

interface MockHandlers {
  list?: (
    table: string,
    filters: Filters,
  ) => Array<Record<string, unknown>> | null;
  single?: (table: string, filters: Filters) => Record<string, unknown> | null;
  count?: (table: string, filters: Filters) => number;
  rpc?: (name: string) => Record<string, unknown> | null;
  /** PostgREST error simulation: returns the error message for a
   *  (target, op) pair, or null for a successful call. */
  error?: (target: string, op: "list" | "single" | "rpc") => string | null;
}

/** Chainable supabase-builder mock supporting select/eq/in/not/order/limit
 *  and the terminals single/maybeSingle/await, recording calls. */
function makeClientMock(handlers: MockHandlers) {
  const calls: Array<{ table: string; op: string; filters: Filters }> = [];
  function chain(table: string) {
    const filters: Filters = {};
    const make: Record<string | symbol, unknown> = new Proxy(
      {},
      {
        get(_target, prop) {
          if (typeof prop !== "string") return undefined;
          if (prop === "then") {
            const listError = handlers.error?.(table, "list") ?? null;
            return (onFulfilled?: unknown, onRejected?: unknown) =>
              Promise.resolve({
                data: listError
                  ? null
                  : (handlers.list?.(table, filters) ?? null),
                count: filters["selectCount"]
                  ? listError
                    ? null
                    : (handlers.count?.(table, filters) ?? 0)
                  : null,
                error: listError ? { message: listError } : null,
              }).then(onFulfilled as never, onRejected as never);
          }
          if (prop === "maybeSingle" || prop === "single") {
            const singleError = handlers.error?.(table, "single") ?? null;
            return async () => ({
              data: singleError
                ? null
                : (handlers.single?.(table, filters) ?? null),
              error: singleError ? { message: singleError } : null,
            });
          }
          if (prop === "select")
            return (...args: unknown[]) => {
              filters["select"] = args[0];
              if (typeof args[1] === "object" && args[1] !== null) {
                filters["selectCount"] = (args[1] as { count?: string }).count;
              }
              return make;
            };
          if (prop === "eq")
            return (field: string, value: unknown) => {
              filters[field] = value;
              return make;
            };
          if (prop === "in")
            return (field: string, values: unknown[]) => {
              filters[`in:${field}`] = values;
              return make;
            };
          if (prop === "not")
            return (field: string, op: string, value: unknown) => {
              filters[`not:${field}:${op}`] = value;
              return make;
            };
          // Non-terminal chaining ops resolve to themselves.
          return () => {
            calls.push({ table, op: prop, filters: { ...filters } });
            return make;
          };
        },
      },
    );
    return make;
  }
  return {
    client: {
      from: (table: string) => chain(table),
      rpc: (name: string) => ({
        single: async () => {
          const rpcError = handlers.error?.(name, "rpc") ?? null;
          return {
            data: rpcError ? null : (handlers.rpc?.(name) ?? null),
            error: rpcError ? { message: rpcError } : null,
          };
        },
      }),
    },
    calls,
  };
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(),
}));
vi.mock("@/lib/email-campaigns", () => ({
  getUsageSnapshot: vi.fn(),
}));
vi.mock("@/lib/opportunities/search", () => ({
  searchOpportunities: vi.fn(),
}));
vi.mock("@/lib/opportunities/saved", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/opportunities/saved")
  >("@/lib/opportunities/saved");
  return { ...actual, listSavedOpportunities: vi.fn() };
});

const { createClient } = await import("@/lib/supabase/server");
const { createAdminClient } = await import("@/lib/supabase/admin");
const { getUsageSnapshot } = await import("@/lib/email-campaigns");
const { searchOpportunities } = await import("@/lib/opportunities/search");
const { listSavedOpportunities } = await import("@/lib/opportunities/saved");
const { getDashboardData } = await import("@/lib/dashboard");
const {
  evaluateProfileCompleteness,
  resolveNextAction,
  buildRecommendationQuery,
} = await import("@/lib/dashboard-intelligence");
const { candidateProfileFixture } = await import("./helpers");
import type { Opportunity } from "@/lib/opportunities/types";

/** Normalized opportunity builder (same shape as the engine fixtures). */
function mkOpp(
  ref: string,
  posted: string,
  extra: Record<string, unknown> = {},
): Opportunity {
  return {
    id: `arbeitsagentur:${ref}`,
    provider: "arbeitsagentur",
    external_id: ref,
    source_name: "S",
    source_url: "https://example.test/1",
    source_type: "official_source",
    additional_sources: [],
    source_ids: [],
    enrichment: null,
    application_url: null,
    title: `Stelle ${ref}`,
    goal: "arbeit",
    stellenangebotsart: "ARBEIT",
    company_name: null,
    company_url: null,
    location: null,
    location_detail: null,
    distance_km: null,
    latitude: null,
    longitude: null,
    profession: null,
    alternative_professions: [],
    description: null,
    tasks: [],
    requirements: [],
    employment_type: null,
    home_office: null,
    career_change_friendly: null,
    salary: null,
    training_type: null,
    education_requirement: null,
    valid_from: null,
    application_deadline: null,
    posted_at: posted,
    updated_at: null,
    retrieved_at: "2026-09-28T12:00:00.000Z",
    contact: null,
    required_skills: [],
    preferred_skills: [],
    required_languages: [],
    extracted_keywords: [],
    match: null,
    ...extra,
  } as Opportunity;
}

const USER_ID = "user-dash-1";

function fullProfile() {
  const base = candidateProfileFixture() as Record<string, unknown>;
  return {
    ...base,
    candidate: {
      full_name: "Alex Beispiel",
      location: "Berlin",
      country: "DE",
      current_location: null,
      target_location: [],
      contact: { email: null, phone: null, linkedin: null },
    },
    languages: [
      {
        language: "German",
        level: "C1",
        level_is_inferred: false,
        source: "ai_extracted",
      },
      {
        language: "English",
        level: "B1",
        level_is_inferred: false,
        source: "ai_extracted",
      },
    ],
    target_roles: [
      { role: "Mechatroniker", reason: "Zielberuf", source: "ai_extracted" },
    ],
  };
}

function minimalProfile() {
  return {
    candidate: {
      full_name: null,
      location: null,
      country: null,
      current_location: null,
      target_location: [],
      contact: { email: null, phone: null, linkedin: null },
    },
    goal: "arbeit" as const,
    education: [],
    training: [],
    experience: [],
    skills: {
      technical: [],
      software_tools: [],
      marketing: [],
      it: [],
      soft: [],
    },
    languages: [],
    preferences: {
      target: null,
      preferred_job_titles: [],
      preferred_industries: [],
      preferred_locations: [],
      willing_to_relocate: null,
      remote_hybrid_preference: null,
    },
    target_roles: [],
    strengths: [],
    missing_information: [],
    potential_concerns: [],
    keywords: [],
  };
}

// ---------------------------------------------------------------------------
// 1. Profile completeness (deterministic, no AI)
// ---------------------------------------------------------------------------

describe("profile completeness", () => {
  it("a fully documented profile is 100% with no missing sections", () => {
    const result = evaluateProfileCompleteness(fullProfile() as never);
    expect(result.percentage).toBe(100);
    expect(result.missing).toEqual([]);
    expect(result.completed.length).toBe(12);
  });

  it("a minimal profile only completes the mandatory goal section", () => {
    const result = evaluateProfileCompleteness(minimalProfile() as never);
    expect(result.completed).toEqual(["Goal"]);
    expect(result.missing.length).toBe(11);
    expect(result.percentage).toBe(8); // round(100/12)
  });

  it("German without a documented level does NOT count as completed", () => {
    const profile = {
      ...minimalProfile(),
      languages: [
        {
          language: "German",
          level: null,
          level_is_inferred: false,
          source: "ai_extracted",
        },
      ],
    } as never;
    const result = evaluateProfileCompleteness(profile);
    expect(result.missing).toContain("German language level");
  });

  it("German with a level + one other language complete both sections", () => {
    const profile = {
      ...minimalProfile(),
      languages: [
        {
          language: "Deutsch",
          level: "C1",
          level_is_inferred: false,
          source: "user_provided",
        },
        {
          language: "English",
          level: "B1",
          level_is_inferred: false,
          source: "user_provided",
        },
      ],
    } as never;
    const result = evaluateProfileCompleteness(profile);
    expect(result.completed).toContain("German language level");
    expect(result.completed).toContain("Other languages");
  });

  it("null/empty values are never counted as completed", () => {
    const result = evaluateProfileCompleteness(minimalProfile() as never);
    for (const section of [
      "Name",
      "Location",
      "Education",
      "Skills",
      "Experience",
      "Certifications",
      "Target roles",
      "Location preferences",
      "Relocation preference",
    ]) {
      expect(result.missing).toContain(section);
    }
  });

  it("is deterministic (same input → same output)", () => {
    const a = evaluateProfileCompleteness(fullProfile() as never);
    const b = evaluateProfileCompleteness(fullProfile() as never);
    expect(a).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// 2. Next action (deterministic rule chain)
// ---------------------------------------------------------------------------

describe("next action", () => {
  const complete = evaluateProfileCompleteness(fullProfile() as never);

  it("no profile → scan the Bewerbung", () => {
    const action = resolveNextAction({
      hasProfile: false,
      completeness: null,
      savedTotal: 0,
      completeMatchCount: 0,
      hasApplicationDraft: false,
      hasEmailAccount: false,
      campaign: null,
    });
    expect(action.id).toBe("scan_profile");
    expect(action.href).toBe("/bewerbung-scanner");
  });

  it("profile missing important sections → complete the profile", () => {
    const sparse = evaluateProfileCompleteness(minimalProfile() as never);
    const action = resolveNextAction({
      hasProfile: true,
      completeness: sparse,
      savedTotal: 0,
      completeMatchCount: 0,
      hasApplicationDraft: false,
      hasEmailAccount: false,
      campaign: null,
    });
    expect(action.id).toBe("complete_profile");
    expect(action.reason).toContain("Target roles");
  });

  it("complete profile, nothing saved → find opportunities", () => {
    const action = resolveNextAction({
      hasProfile: true,
      completeness: complete,
      savedTotal: 0,
      completeMatchCount: 0,
      hasApplicationDraft: false,
      hasEmailAccount: true,
      campaign: null,
    });
    expect(action.id).toBe("find_opportunities");
    expect(action.href).toBe("/opportunities");
  });

  it("saved but no complete matches, no draft → review matches", () => {
    const action = resolveNextAction({
      hasProfile: true,
      completeness: complete,
      savedTotal: 2,
      completeMatchCount: 0,
      hasApplicationDraft: false,
      hasEmailAccount: true,
      campaign: null,
    });
    expect(action.id).toBe("review_matches");
  });

  it("complete matches saved, no draft → prepare an application", () => {
    const action = resolveNextAction({
      hasProfile: true,
      completeness: complete,
      savedTotal: 2,
      completeMatchCount: 1,
      hasApplicationDraft: false,
      hasEmailAccount: true,
      campaign: null,
    });
    expect(action.id).toBe("prepare_application");
    expect(action.href).toBe("/applications/new");
  });

  it("draft exists, no email → connect email", () => {
    const action = resolveNextAction({
      hasProfile: true,
      completeness: complete,
      savedTotal: 2,
      completeMatchCount: 1,
      hasApplicationDraft: true,
      hasEmailAccount: false,
      campaign: null,
    });
    expect(action.id).toBe("connect_email");
    expect(action.href).toBe("/settings/email");
  });

  it.each([
    ["draft", "review_send"],
    ["queued", "track_sending"],
    ["sending", "track_sending"],
    ["completed", "track_sent"],
    ["partially_failed", "track_sent"],
    ["failed", "explore"],
    ["cancelled", "explore"],
  ])("campaign %s → %s", (status, expected) => {
    const action = resolveNextAction({
      hasProfile: true,
      completeness: complete,
      savedTotal: 2,
      completeMatchCount: 1,
      hasApplicationDraft: true,
      hasEmailAccount: true,
      campaign: { id: "campaign-1", status },
    });
    expect(action.id).toBe(expected);
    if (expected.startsWith("track") || expected === "review_send") {
      expect(action.href).toBe("/applications/campaign/campaign-1");
    }
  });

  it("is deterministic", () => {
    const input = {
      hasProfile: true,
      completeness: complete,
      savedTotal: 3,
      completeMatchCount: 2,
      hasApplicationDraft: true,
      hasEmailAccount: true,
      campaign: { id: "c1", status: "completed" } as const,
    };
    expect(resolveNextAction(input)).toEqual(resolveNextAction(input));
  });
});

// ---------------------------------------------------------------------------
// 3. Recommendation query (pure, server-side inputs only)
// ---------------------------------------------------------------------------

describe("recommendation query", () => {
  it("returns null when the profile documents no usable keyword", () => {
    expect(buildRecommendationQuery(minimalProfile() as never)).toBeNull();
  });

  it("uses documented preferred titles, goal and location; matcher v2 ranking", () => {
    const query = buildRecommendationQuery(fullProfile() as never);
    expect(query).not.toBeNull();
    expect(query?.goal).toBe("arbeit");
    expect(query?.keyword).toBe("Mechatroniker");
    expect(query?.location).toBe("Berlin");
    expect(query?.sort).toBe("match");
    expect(query?.match).toBe(true);
    expect(query?.page).toBe(1);
    expect(query?.pageSize).toBe(6);
  });

  it("falls back to target_roles when no preferred titles exist", () => {
    const full = fullProfile();
    const profile = {
      ...full,
      preferences: {
        target: "arbeit",
        preferred_job_titles: [],
        preferred_industries: [],
        preferred_locations: ["Berlin"],
        willing_to_relocate: false,
        remote_hybrid_preference: null,
      },
    } as never;
    const query = buildRecommendationQuery(profile);
    expect(query?.keyword).toBe("Mechatroniker");
  });

  it("never accepts browser-provided input (profile only)", () => {
    // The function signature takes only the validated profile — there is
    // no parameter for scores, keys, or snapshots to inject.
    const query = buildRecommendationQuery(fullProfile() as never);
    expect(query).not.toHaveProperty("user_id");
  });
});

// ---------------------------------------------------------------------------
// 4. Dashboard data assembly (server-side only, no fabricated data)
// ---------------------------------------------------------------------------

describe("getDashboardData", () => {
  let sessionMock: ReturnType<typeof makeClientMock>;
  let adminMock: ReturnType<typeof makeClientMock>;

  const baseProfileRow = {
    id: "profile-row",
    full_name: "Alex Beispiel",
    email: "alex@example.com",
    selected_goal: "arbeit",
    account_status: "active",
    daily_email_limit: 20,
  };

  const baseSessionHandlers: MockHandlers = {
    single: (table) =>
      table === "profiles"
        ? (baseProfileRow as Record<string, unknown>)
        : table === "email_accounts"
          ? {
              id: "mail-1",
              provider: "gmail",
              email: "alex@gmail.com",
              is_active: true,
              created_at: "2026-09-01T00:00:00.000Z",
              updated_at: "2026-09-01T00:00:00.000Z",
              last_used_at: null,
            }
          : null,
    list: (table, filters) => {
      if (table === "activity_logs" && filters["user_id"] === USER_ID) {
        return [
          {
            id: "act-1",
            activity_type: "opportunity_saved",
            title: "Opportunity saved: Testjob",
            description: "Test AG",
            metadata: {},
            created_at: "2026-09-28T10:00:00.000Z",
          },
        ];
      }
      return null;
    },
    count: (table) =>
      table === "bewerbung_scans" ? 1 : table === "application_drafts" ? 0 : 0,
    rpc: (name) =>
      name === "get_or_create_daily_usage"
        ? { emails_sent: 2, ai_requests: 3, date: "2026-09-28" }
        : null,
  };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    sessionMock = makeClientMock(baseSessionHandlers);
    adminMock = makeClientMock({
      single: () => null,
      list: (table, filters) => {
        if (table === "application_drafts" && filters["user_id"] === USER_ID) {
          return [
            {
              id: "draft-1",
              goal: "arbeit",
              subject: "Bewerbung als Mechatroniker",
              body_text: "Sehr geehrte Damen und Herren",
              created_at: "2026-09-20T09:00:00.000Z",
              updated_at: "2026-09-25T09:00:00.000Z",
              opportunity_key: "arbeitsagentur:TEST-1",
              opportunity_title: "Mechatroniker (m/w/d)",
              opportunity_company: "Test AG",
            },
          ];
        }
        if (table === "application_draft_recipients") {
          return [
            {
              draft_id: "draft-1",
              email: "jobs@test-ag.de",
              company_name: "Test AG",
            },
          ];
        }
        if (table === "email_campaigns") {
          return [
            {
              id: "camp-1",
              draft_id: "draft-1",
              status: "completed",
              created_at: "2026-09-25T10:00:00.000Z",
              updated_at: "2026-09-25T11:00:00.000Z",
            },
          ];
        }
        if (table === "email_messages") {
          return [
            { campaign_id: "camp-1", sent_at: "2026-09-25T11:05:00.000Z" },
          ];
        }
        return null;
      },
    });
    vi.mocked(createClient).mockResolvedValue(sessionMock.client as never);
    vi.mocked(createAdminClient).mockReturnValue(adminMock.client as never);
    vi.mocked(getUsageSnapshot).mockResolvedValue({
      date: "2026-09-28",
      emails_sent: 2,
      emails_reserved: 0,
      daily_limit: 20,
      remaining: 18,
    });
    vi.mocked(listSavedOpportunities).mockResolvedValue([]);
    vi.mocked(searchOpportunities).mockResolvedValue({
      results: [],
      total: 0,
      scan_truncated: false,
      mode: "upstream",
      match_available: true,
    });
  });

  it("no candidate profile → scan action, no recommendations, empty states", async () => {
    const data = await getDashboardData(USER_ID);
    expect(data.candidateProfile).toBeNull();
    expect(data.completeness).toBeNull();
    expect(data.nextAction.id).toBe("scan_profile");
    expect(data.recommendations.available).toBe(false);
    expect(data.recommendations.blockedReason).toBe("no_profile");
    expect(data.recommendations.items).toEqual([]);
    expect(data.savedPreview).toEqual([]);
  });

  it("profile without keywords → recommendations blocked, never invented", async () => {
    const candidateRow = {
      profile_json: minimalProfile(),
      updated_at: "2026-09-20T09:00:00.000Z",
    };
    // point the session candidate_profiles read at the minimal profile
    const originalList = sessionMock.client.from;
    vi.mocked(createClient).mockResolvedValue({
      ...sessionMock.client,
      from: (table: string) =>
        table === "candidate_profiles"
          ? {
              select: () => ({
                eq: () => ({
                  order: () => ({
                    limit: () => ({
                      maybeSingle: async () => ({
                        data: candidateRow,
                        error: null,
                      }),
                    }),
                  }),
                }),
              }),
            }
          : originalList(table),
    } as never);
    const data = await getDashboardData(USER_ID);
    expect(data.candidateProfile).not.toBeNull();
    expect(data.nextAction.id).toBe("complete_profile");
    expect(data.recommendations.available).toBe(false);
    expect(data.recommendations.blockedReason).toBe("no_keyword");
    expect(data.recommendations.items).toEqual([]);
  });

  it("search failure → explicit empty state, no fabricated items", async () => {
    const candidateRow = {
      profile_json: fullProfile(),
      updated_at: "2026-09-20T09:00:00.000Z",
    };
    const originalFrom = sessionMock.client.from;
    vi.mocked(createClient).mockResolvedValue({
      ...sessionMock.client,
      from: (table: string) =>
        table === "candidate_profiles"
          ? {
              select: () => ({
                eq: () => ({
                  order: () => ({
                    limit: () => ({
                      maybeSingle: async () => ({
                        data: candidateRow,
                        error: null,
                      }),
                    }),
                  }),
                }),
              }),
            }
          : originalFrom(table),
    } as never);
    vi.mocked(searchOpportunities).mockRejectedValue(
      new Error("provider unavailable"),
    );
    const data = await getDashboardData(USER_ID);
    expect(data.recommendations.available).toBe(false);
    expect(data.recommendations.blockedReason).toBe("search_failed");
    expect(data.recommendations.items).toEqual([]);
  });

  it("search success → real items with match state, saved flags, no re-ranking", async () => {
    const candidateRow = {
      profile_json: fullProfile(),
      updated_at: "2026-09-20T09:00:00.000Z",
    };
    const originalFrom = sessionMock.client.from;
    vi.mocked(createClient).mockResolvedValue({
      ...sessionMock.client,
      from: (table: string) =>
        table === "candidate_profiles"
          ? {
              select: () => ({
                eq: () => ({
                  order: () => ({
                    limit: () => ({
                      maybeSingle: async () => ({
                        data: candidateRow,
                        error: null,
                      }),
                    }),
                  }),
                }),
              }),
            }
          : originalFrom(table),
    } as never);
    const complete = mkOpp("TEST-A", "2026-09-20", {
      title: "Mechatroniker (m/w/d)",
    });
    complete.match = {
      status: "complete",
      score: 82,
      version: 2,
      dimensions: [],
      reasons: ["Zielberuf passt"],
      missing_information: [],
      cap: null,
    };
    const incomplete = mkOpp("TEST-B", "2026-09-21");
    incomplete.match = {
      status: "incomplete",
      score: null,
      version: 2,
      dimensions: [],
      reasons: [],
      missing_information: ["Kein Schulabschluss im Profil dokumentiert."],
      cap: null,
    };
    vi.mocked(searchOpportunities).mockResolvedValue({
      results: [complete, incomplete],
      total: 2,
      scan_truncated: false,
      mode: "upstream",
      match_available: true,
    });
    vi.mocked(listSavedOpportunities).mockResolvedValue([
      {
        id: "saved-1",
        user_id: USER_ID,
        opportunity_key: "arbeitsagentur:TEST-A",
        provider: "arbeitsagentur",
        goal: "arbeit",
        title: "Mechatroniker (m/w/d)",
        company_name: "Test AG",
        location: "Berlin",
        source_url: null,
        source_name: null,
        posted_at: "2026-09-20T00:00:00.000Z",
        salary_label: null,
        training_type: null,
        education_requirement: null,
        contact_email: null,
        notes: null,
        match_score: 82,
        match_status: "complete",
        matcher_version: 2,
        match_profile_updated_at: "2026-09-20T09:00:00.000Z",
        saved_at: "2026-09-22T09:00:00.000Z",
      },
    ]);

    const data = await getDashboardData(USER_ID);

    // Recommendations carry the server-returned items untouched.
    expect(data.recommendations.available).toBe(true);
    expect(
      data.recommendations.items.map((item) => item.opportunity.id),
    ).toEqual(["arbeitsagentur:TEST-A", "arbeitsagentur:TEST-B"]);
    expect(data.recommendations.items[0].saved).toBe(true);
    expect(data.recommendations.items[1].saved).toBe(false);
    expect(data.recommendations.items[0].match?.score).toBe(82);
    expect(data.recommendations.items[1].match?.status).toBe("incomplete");

    // Saved preview with fresh snapshot metadata.
    expect(data.savedPreview).toHaveLength(1);
    expect(data.savedPreview[0].match_score).toBe(82);
    expect(data.savedPreview[0].stale).toBe(false);

    // Recent applications joined with persisted campaign state.
    expect(data.recentApplications).toHaveLength(1);
    expect(data.recentApplications[0]).toMatchObject({
      id: "draft-1",
      company: "Test AG",
      has_content: true,
      campaign_id: "camp-1",
      campaign_status: "completed",
      sent_at: "2026-09-25T11:05:00.000Z",
    });

    // Next action reflects the persisted campaign, not an assumption.
    expect(data.nextAction.id).toBe("track_sent");
    expect(data.nextAction.href).toBe("/applications/campaign/camp-1");

    // Usage comes from the server-side quota function, not the browser.
    expect(data.usageSnapshot.remaining).toBe(18);
    expect(data.aiLimit).toBe(100);
    expect(data.activities).toHaveLength(1);
  });

  it("profile changed after the snapshot → saved preview flagged stale", async () => {
    const candidateRow = {
      profile_json: fullProfile(),
      updated_at: "2026-10-01T09:00:00.000Z", // newer than the snapshot
    };
    const originalFrom = sessionMock.client.from;
    vi.mocked(createClient).mockResolvedValue({
      ...sessionMock.client,
      from: (table: string) =>
        table === "candidate_profiles"
          ? {
              select: () => ({
                eq: () => ({
                  order: () => ({
                    limit: () => ({
                      maybeSingle: async () => ({
                        data: candidateRow,
                        error: null,
                      }),
                    }),
                  }),
                }),
              }),
            }
          : originalFrom(table),
    } as never);
    vi.mocked(listSavedOpportunities).mockResolvedValue([
      {
        id: "saved-1",
        user_id: USER_ID,
        opportunity_key: "arbeitsagentur:TEST-A",
        provider: "arbeitsagentur",
        goal: "arbeit",
        title: "Mechatroniker (m/w/d)",
        company_name: "Test AG",
        location: "Berlin",
        source_url: null,
        source_name: null,
        posted_at: "2026-09-20T00:00:00.000Z",
        salary_label: null,
        training_type: null,
        education_requirement: null,
        contact_email: null,
        notes: null,
        match_score: 82,
        match_status: "complete",
        matcher_version: 2,
        match_profile_updated_at: "2026-09-20T09:00:00.000Z",
        saved_at: "2026-09-22T09:00:00.000Z",
      },
    ]);
    const data = await getDashboardData(USER_ID);
    expect(data.savedPreview[0].stale).toBe(true);
    expect(data.savedPreview[0].staleReasons.join(" ")).toContain("Profil");
  });

  // Production incident: the dashboard error boundary showed a generic
  // message while the exact PostgREST failure (missing RLS policy/grant or
  // missing RPC) was swallowed. Each strict query must now log its exact
  // target + error while keeping the user-facing message safe.
  const strictErrorCases: Array<{
    target: string;
    op: "list" | "single" | "rpc";
    message: string;
  }> = [
    {
      target: "profiles",
      op: "single",
      message: "Unable to load your profile.",
    },
    {
      target: "get_or_create_daily_usage",
      op: "rpc",
      message: "Unable to load daily usage.",
    },
    {
      target: "application_drafts",
      op: "list",
      message: "Unable to load applications.",
    },
    {
      target: "activity_logs",
      op: "list",
      message: "Unable to load recent activity.",
    },
    {
      target: "email_accounts",
      op: "single",
      message: "Unable to load email account status.",
    },
    {
      target: "bewerbung_scans",
      op: "list",
      message: "Unable to load scan status.",
    },
    {
      target: "candidate_profiles",
      op: "single",
      message: "Unable to load candidate profile status.",
    },
  ];

  for (const testCase of strictErrorCases) {
    it(`logs the exact PostgREST failure for ${testCase.target} and throws the safe message`, async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const failingMock = makeClientMock({
        ...baseSessionHandlers,
        error: (target, op) =>
          target === testCase.target && op === testCase.op
            ? `permission denied for table ${testCase.target}`
            : null,
      });
      vi.mocked(createClient).mockResolvedValue(failingMock.client as never);

      await expect(getDashboardData(USER_ID)).rejects.toThrow(testCase.message);

      const logged = spy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).toContain(
        `[dashboard] query failed target="${testCase.target}"`,
      );
      expect(logged).toContain(
        `permission denied for table ${testCase.target}`,
      );
      spy.mockRestore();
    });
  }
});
