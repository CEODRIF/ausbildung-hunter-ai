import type { OpportunitySearchParams } from "@/lib/opportunities/types";

export interface RecordedCall {
  table: string;
  op: string;
  args: unknown[];
  filters: Record<string, unknown>;
}

interface AdminMockOptions {
  maybeSingleData?: (table: string) => Record<string, unknown> | null;
  singleData?: (table: string) => Record<string, unknown> | null;
  singleError?: (table: string) => { message: string } | null;
  /** RPC override. Default answers the entitlement-service RPCs with
   *  "fresh meter / reserved / ok" so suites that seed a commercial
   *  subscription can run the REAL service end-to-end (see
   *  commercialMaybeSingleData). */
  rpc?: (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: unknown }>;
}

/**
 * Records a chainable Supabase-style builder per table so tests can assert
 * exactly which tables/operations/filters the code under test used.
 */
export function createAdminMock(options: AdminMockOptions = {}) {
  const calls: RecordedCall[] = [];
  function makeChain(table: string) {
    const filters: Record<string, unknown> = {};
    const make: Record<string | symbol, unknown> = new Proxy(
      {},
      {
        get(_target, prop) {
          if (typeof prop !== "string") return undefined;
          if (prop === "maybeSingle")
            return async () => ({
              data: options.maybeSingleData?.(table) ?? null,
              error: null,
            });
          if (prop === "single")
            return async () => ({
              data: options.singleData?.(table) ?? null,
              error: options.singleError?.(table) ?? null,
            });
          // Non-terminal chains are thenable (supabase builders are awaitable):
          // resolve to an empty result instead of recording a "then" op.
          if (prop === "then")
            return (
              onFulfilled?: unknown,
              onRejected?: unknown,
            ): Promise<unknown> =>
              Promise.resolve({ data: null, error: null }).then(
                onFulfilled as never,
                onRejected as never,
              );
          return (...args: unknown[]) => {
            if (prop === "eq") filters[`eq:${String(args[0])}`] = args[1];
            if (prop === "gte") filters[`gte:${String(args[0])}`] = args[1];
            if (prop === "or") filters["or"] = args[0];
            calls.push({ table, op: prop, args, filters: { ...filters } });
            return make;
          };
        },
      },
    );
    return make;
  }
  const defaultRpc = async (
    fn: string,
  ): Promise<{ data: unknown; error: unknown }> => {
    if (fn === "feature_quota_status" || fn === "feature_capacity_status")
      return { data: { used: 0, resets_at: null }, error: null };
    if (fn === "reserve_feature_op")
      return {
        data: [{ status: "reserved", used: 1, remaining: 99 }],
        error: null,
      };
    if (fn === "complete_feature_op")
      return { data: [{ status: "no_op" }], error: null };
    if (fn === "release_feature_op")
      return { data: [{ status: "released" }], error: null };
    if (fn === "reserve_ai_request" || fn === "release_ai_request")
      return { data: null, error: null };
    if (fn === "check_saved_application_capacity")
      return {
        data: [{ status: "ok", plan_limit: 500, used: 0, remaining: 500 }],
        error: null,
      };
    return { data: null, error: null };
  };
  const admin: {
    from: (table: string) => Record<string | symbol, unknown>;
    rpc: (
      fn: string,
      args?: Record<string, unknown>,
    ) => Promise<{ data: unknown; error: unknown }>;
  } = {
    from: (table) => makeChain(table),
    rpc: (fn, args = {}) => {
      calls.push({ table: fn, op: "rpc", args: [args], filters: {} });
      return (options.rpc ?? defaultRpc)(fn, args);
    },
  };
  return { admin, calls };
}

export function jsonResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

export function httpError(
  status: number,
  body: unknown = { message: "error" },
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function baseParams(
  overrides: Partial<OpportunitySearchParams> = {},
): OpportunitySearchParams {
  return {
    goal: "arbeit",
    keyword: "",
    role: "",
    company: "",
    location: "",
    cities: [],
    beginn: "any",
    freshness: "any",
    sort: "relevance",
    employment: "any",
    training_type: "any",
    home_office: "any",
    salary: "any",
    contact_email: "any",
    page: 1,
    pageSize: 20,
    match: false,
    ...overrides,
  };
}

export function mkSearchItem(
  ref: string,
  posted: string,
  extra: Record<string, unknown> = {},
) {
  return {
    referenznummer: ref,
    stellenangebotsTitel: `Stelle ${ref}`,
    stellenangebotsart: "ARBEIT",
    datumErsteVeroeffentlichung: posted,
    ...extra,
  };
}

/** Minimal valid candidate profile for the shared scanner schema. */
export function candidateProfileFixture() {
  return {
    goal: "arbeit",
    education: [
      {
        school: null,
        university: null,
        degree: null,
        field_of_study: null,
        graduation_year: null,
        education_level: "Mittlerer Schulabschluss",
        source: "ai_extracted",
      },
    ],
    training: [
      {
        name: "Mechatroniker",
        provider: null,
        year: null,
        source: "ai_extracted",
      },
    ],
    experience: [
      {
        job_title: "Mechatroniker",
        company: null,
        responsibilities: ["Wartung von Anlagen"],
        start_date: null,
        end_date: null,
        type: "employment",
        source: "ai_extracted",
      },
    ],
    skills: {
      technical: ["Wartung"],
      software_tools: [],
      marketing: [],
      it: [],
      soft: ["Zuverlässigkeit"],
    },
    languages: [
      {
        language: "German",
        level: "C1",
        level_is_inferred: false,
        source: "ai_extracted",
      },
    ],
    preferences: {
      target: "arbeit",
      preferred_job_titles: ["Mechatroniker"],
      preferred_industries: [],
      preferred_locations: ["Berlin"],
      willing_to_relocate: false,
      remote_hybrid_preference: null,
    },
    target_roles: [
      {
        role: "Mechatroniker",
        reason: "Ausbildung abgeschlossen",
        source: "ai_extracted",
      },
    ],
    strengths: [],
    missing_information: [],
    potential_concerns: [],
    keywords: [],
  };
}

/**
 * Shared fixtures for tests that run the REAL entitlement service
 * (unmocked) against an in-memory Supabase boundary.
 *
 * 2026-10-24 entitlement fix: non-commercial states are FAIL CLOSED (0)
 * for the restricted features, so a test whose subject is NOT plan gating
 * must seed a verified active commercial subscription — otherwise the
 * write is (correctly) denied before it reaches the code under test.
 * Entitlement denial itself is pinned in
 * tests/subscription-entitlement-boundary.test.ts.
 */
export const COMMERCIAL_SUB_ROW: Record<string, unknown> = {
  plan: "premium_monthly",
  status: "active",
  provider: "mock",
  current_period_start: "2026-10-01T00:00:00.000Z",
  current_period_end: "2027-01-01T00:00:00.000Z",
  canceled_at: null,
  trial_activated_at: null,
};

export const COMMERCIAL_PLAN_ROW: Record<string, unknown> = {
  plan_id: "premium_monthly",
  emails_per_day: 250,
  ai_requests_per_day: 200,
  price_cents: 2000,
  duration_kind: "calendar_month",
  duration_value: 1,
  is_commercial: true,
  // Mirrors COMMERCIAL_PLANS.premium_monthly.featureLimits
  // (src/lib/billing/commercial-plans.ts) — the values these suites rely
  // on are large enough that the quota meters under test never bind.
  feature_limits: {
    ai_assistant: 200,
    cover_letter: 50,
    resume_ai: 60,
    scanner: 60,
    deckblatt: 30,
    email_drafts: 120,
    opportunity_search: 300,
    saved_opportunities: 500,
    saved_applications: 500,
    salary_calculator: null,
    automation: 250,
  },
};

/**
 * maybeSingle rows for the entitlement service's subscription lookups
 * (the service filters by user_id / plan_id server-side; single-user
 * suites can serve the row unconditionally).
 */
export function commercialMaybeSingleData(
  table: string,
): Record<string, unknown> | null {
  if (table === "subscriptions") return { ...COMMERCIAL_SUB_ROW };
  if (table === "billing_plans") return { ...COMMERCIAL_PLAN_ROW };
  return null;
}
