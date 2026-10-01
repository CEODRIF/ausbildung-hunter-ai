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
  const admin: { from: (table: string) => Record<string | symbol, unknown> } = {
    from: (table) => makeChain(table),
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
