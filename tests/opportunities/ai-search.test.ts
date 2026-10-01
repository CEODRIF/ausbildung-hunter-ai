import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  aiSearchPlanSchema,
  buildExportRow,
  collectOpportunities,
  enrichOpportunities,
  planAISearch,
  rankOpportunities,
  runAISearch,
  summarizeProfile,
  type AiSearchPlan,
} from "@/lib/opportunities/ai-search";
import { candidateProfileSchema } from "@/lib/bewerbung-schema";
import type { Opportunity } from "@/lib/opportunities/types";
import {
  extractApplicationDeadline,
  getArbeitsagenturDetails,
  OpportunityNotFoundError,
} from "@/lib/opportunities/providers/arbeitsagentur";
import {
  candidateProfileFixture,
  createAdminMock,
  jsonResponse,
  mkSearchItem,
} from "../helpers";

const { createAdminClient } = await import("@/lib/supabase/admin");
const { createAIProvider } = await import("@/lib/ai-provider");
const { resolveOpportunity } =
  await import("@/lib/opportunities/providers/arbeitsagentur");

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(),
}));
vi.mock("@/lib/ai-provider", () => ({
  createAIProvider: vi.fn(),
}));
vi.mock("@/lib/opportunities/providers/arbeitsagentur", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/lib/opportunities/providers/arbeitsagentur")
  >();
  return {
    ...actual,
    resolveOpportunity: vi.fn(),
  };
});

const detailsAusbildung = (await import(
  "../fixtures/ba-details-ausbildung.json"
)) as Record<string, unknown>;

let adminMock: Awaited<ReturnType<typeof createAdminMock>>;

function setAdminMock(
  options: Parameters<typeof createAdminMock>[0] = {},
) {
  adminMock = createAdminMock(options);
  vi.mocked(createAdminClient).mockReturnValue(adminMock.admin as never);
}

/** Full, schema-valid Opportunity literal (test factory). */
function mkOpp(overrides: Partial<Opportunity> = {}): Opportunity {
  const base: Opportunity = {
    id: "arbeitsagentur:TEST-1",
    provider: "arbeitsagentur",
    external_id: "TEST-1",
    source_name: "S",
    source_url: "https://example.test/1",
    source_type: "official_source",
    additional_sources: [],
    source_ids: [],
    enrichment: null,
    application_url: null,
    title: "Ausbildung Mechatroniker/in",
    goal: "ausbildung",
    stellenangebotsart: "AUSBILDUNG",
    company_name: null,
    company_url: null,
    location: "10115 Berlin",
    location_detail: {
      city: "Berlin",
      region: "Berlin",
      country: "Deutschland",
      postal_code: "10115",
    },
    distance_km: null,
    latitude: null,
    longitude: null,
    profession: "Mechatroniker/in",
    alternative_professions: [],
    description: null,
    tasks: [],
    requirements: [],
    employment_type: null,
    home_office: null,
    career_change_friendly: null,
    salary: null,
    training_type: "AUSBILDUNG",
    education_requirement: null,
    valid_from: null,
    application_deadline: null,
    posted_at: null,
    updated_at: null,
    retrieved_at: "2026-09-30T12:00:00.000Z",
    contact: null,
    required_skills: [],
    preferred_skills: [],
    required_languages: [],
    extracted_keywords: [],
    match: null,
    ...overrides,
  };
  return base;
}

function mockAIPlan(payload: string | unknown) {
  vi.mocked(createAIProvider).mockReturnValue({
    generateText: vi.fn(async () =>
      typeof payload === "string" ? payload : JSON.stringify(payload),
    ),
    streamText: vi.fn(),
    analyzeFile: vi.fn(),
    analyzeImage: vi.fn(),
    generateFile: vi.fn(),
  } as never);
}

beforeEach(() => {
  setAdminMock();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Deadline extraction (strict, source-faithful)
// ---------------------------------------------------------------------------
describe("extractApplicationDeadline", () => {
  it("parses a documented 'Bewerbungsfrist: DD.MM.YYYY'", () => {
    expect(
      extractApplicationDeadline("Wir freuen uns auf dich.\nBewerbungsfrist: 03.01.2027"),
    ).toBe("2027-01-03");
  });

  it("parses 'Bewerbung bis DD.MM.YYYY' with spacing variants", () => {
    expect(
      extractApplicationDeadline("Bitte senden Sie Ihre Bewerbung bis 31.12.2026"),
    ).toBe("2026-12-31");
    expect(
      extractApplicationDeadline("Bewerbungsfrist 30. 06. 2026"),
    ).toBe("2026-06-30");
    expect(
      extractApplicationDeadline("Bewerbung bis zum 15.03.2027 möglich"),
    ).toBe("2027-03-15");
  });

  it("rejects dates without an application context (no false positives)", () => {
    expect(extractApplicationDeadline("Gültig bis 31.12.2026")).toBeNull();
    expect(extractApplicationDeadline("Bis 31.12.2026 offen")).toBeNull();
    expect(
      extractApplicationDeadline("Ausbildung startet am 01.08.2027"),
    ).toBeNull();
  });

  it("rejects impossible calendar dates and malformed numbers", () => {
    expect(extractApplicationDeadline("Bewerbung bis 31.02.2026")).toBeNull();
    expect(extractApplicationDeadline("Bewerbung bis 31.12.202")).toBeNull();
    expect(extractApplicationDeadline("Bewerbung bis 99.99.2026")).toBeNull();
  });

  it("is end-to-end populated by the details normalizer (live fixture)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(detailsAusbildung)));
    const details = await getArbeitsagenturDetails(
      (detailsAusbildung.referenznummer as string) ?? "14795-70300_123764-S",
    );
    // The fixture's published text documents "Bewerbungsfrist: 03.01.2027".
    expect(details.application_deadline).toBe("2027-01-03");
  });
});

// ---------------------------------------------------------------------------
// Plan schema + AI planning
// ---------------------------------------------------------------------------
describe("aiSearchPlanSchema", () => {
  it("accepts a minimal valid plan", () => {
    const parsed = aiSearchPlanSchema.parse({
      rationale: "Profile documents one target role.",
      queries: [{ keyword: "", role: "Mechatroniker/in", location: "" }],
    });
    expect(parsed.queries).toHaveLength(1);
  });

  it("rejects empty or oversized query lists", () => {
    expect(
      aiSearchPlanSchema.safeParse({ queries: [] }).success,
    ).toBe(false);
    const six = Array.from({ length: 6 }, () => ({
      keyword: "",
      role: "x",
      location: "",
    }));
    expect(aiSearchPlanSchema.safeParse({ queries: six }).success).toBe(false);
  });

  it("rejects unknown fields (strict) and oversized strings", () => {
    expect(
      aiSearchPlanSchema.safeParse({
        queries: [{ keyword: "", role: "x", location: "", surprise: 1 }],
      }).success,
    ).toBe(false);
    expect(
      aiSearchPlanSchema.safeParse({
        queries: [{ keyword: "k".repeat(121), role: "", location: "" }],
      }).success,
    ).toBe(false);
  });
});

describe("planAISearch", () => {
  const profile = candidateProfileSchema.parse(candidateProfileFixture());

  it("parses a raw JSON plan from the AI", async () => {
    mockAIPlan({
      rationale: "Role from profile.",
      queries: [{ keyword: "", role: "Mechatroniker/in", location: "Berlin" }],
    });
    const plan = await planAISearch({
      profile,
      goal: "ausbildung",
      targetCount: 25,
    });
    expect(plan.queries[0].role).toBe("Mechatroniker/in");
  });

  it("strips markdown fences and leading prose", async () => {
    mockAIPlan(
      'Sure! Here is the plan:\n```json\n{"rationale":"r","queries":[{"keyword":"","role":"Kaufmann","location":""}]}\n```',
    );
    const plan = await planAISearch({
      profile,
      goal: "arbeit",
      targetCount: 10,
    });
    expect(plan.queries[0].role).toBe("Kaufmann");
  });

  it("throws a controlled message on garbage or invalid plans", async () => {
    mockAIPlan("I cannot help with that.");
    await expect(
      planAISearch({ profile, goal: "ausbildung", targetCount: 10 }),
    ).rejects.toThrow(/AI search plan/i);

    mockAIPlan({
      rationale: "too many",
      queries: Array.from({ length: 6 }, () => ({
        keyword: "",
        role: "x",
        location: "",
      })),
    });
    await expect(
      planAISearch({ profile, goal: "ausbildung", targetCount: 10 }),
    ).rejects.toThrow(/invalid/i);
  });
});

// ---------------------------------------------------------------------------
// Profile summary
// ---------------------------------------------------------------------------
describe("summarizeProfile", () => {
  it("projects only documented facts, deduped and capped", () => {
    const profile = candidateProfileSchema.parse(
      candidateProfileFixture(),
    );
    const summary = summarizeProfile(profile);
    expect(summary.goal).toBe("arbeit");
    expect(summary.target_roles).toEqual(["Mechatroniker"]);
    expect(summary.locations).toContain("Berlin");
    expect(summary.skills).toContain("Wartung");
    expect(summary.keywords).toEqual([]);
    // No contact details leak into the summary shape.
    expect(JSON.stringify(summary)).not.toContain("email");
  });
});

// ---------------------------------------------------------------------------
// Collection (dedupe + progress)
// ---------------------------------------------------------------------------
describe("collectOpportunities", () => {
  it("merges queries and dedupes by stable id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          ergebnisliste: [
            mkSearchItem("REF-A", "2026-09-28", { hauptberuf: "Mechatroniker/in" }),
          ],
          maxErgebnisse: 1,
        }),
      ),
    );
    const plan: AiSearchPlan = {
      rationale: "two phrasings",
      queries: [
        { keyword: "", role: "Mechatroniker", location: "" },
        { keyword: "", role: "Mechatronik", location: "" },
      ],
      web_queries: [],
    };
    const progress: number[] = [];
    const collected = await collectOpportunities({
      plan,
      goal: "ausbildung",
      targetCount: 10,
      onProgress: (event) => progress.push(event.collected),
    });
    // Same single upstream item for both queries → exactly one unique row.
    expect(collected.opportunities).toHaveLength(1);
    expect(collected.opportunities[0].id).toBe("arbeitsagentur:REF-A");
    expect(collected.ba).toBe("ok");
    expect(collected.baRetryable).toBe(false);
    expect(progress).toEqual([1, 1]);
  });

  it("keeps distinct items across queries", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        const item = (ref: string, posted: string) =>
          mkSearchItem(ref, posted, { hauptberuf: "Mechatroniker/in" });
        const list =
          calls === 1 ? [item("REF-A", "2026-09-28")] : [
            item("REF-A", "2026-09-28"),
            item("REF-B", "2026-09-27"),
          ];
        return jsonResponse({ ergebnisliste: list, maxErgebnisse: list.length });
      }),
    );
    const plan: AiSearchPlan = {
      rationale: "complementary",
      queries: [
        { keyword: "", role: "Mechatroniker", location: "" },
        { keyword: "Wartung", role: "Mechatroniker", location: "" },
      ],
      web_queries: [],
    };
    const collected = await collectOpportunities({
      plan,
      goal: "ausbildung",
      targetCount: 10,
    });
    expect(collected.opportunities.map((item) => item.id)).toEqual([
      "arbeitsagentur:REF-A",
      "arbeitsagentur:REF-B",
    ]);
    expect(collected.ba).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// Enrichment (details; failures skipped, never substituted)
// ---------------------------------------------------------------------------
describe("enrichOpportunities", () => {
  it("keeps successful details and skips dead postings", async () => {
    vi.mocked(resolveOpportunity)
      .mockResolvedValueOnce(
        mkOpp({
          id: "arbeitsagentur:REF-A",
          external_id: "REF-A",
          description: "Text mit **Bewerbungsfrist: 03.01.2027**",
          requirements: ["Mittlere Reife"],
          contact: { email: "a@company.de", phone: "030 123456", person: "Herr Maier" },
          application_deadline: "2027-01-03",
        }),
      )
      .mockRejectedValueOnce(
        new OpportunityNotFoundError("This vacancy is no longer available at the source."),
      );
    const progress: Array<[number, number]> = [];
    const enriched = await enrichOpportunities(
      [
        mkOpp({ id: "arbeitsagentur:REF-A" }),
        mkOpp({ id: "arbeitsagentur:REF-B" }),
      ],
      (done, total) => progress.push([done, total]),
    );
    expect(enriched).toHaveLength(1);
    expect(enriched[0].id).toBe("arbeitsagentur:REF-A");
    expect(enriched[0].contact?.email).toBe("a@company.de");
    expect(progress.at(-1)).toEqual([2, 2]);
  });
});

// ---------------------------------------------------------------------------
// Ranking (documented match order, capped)
// ---------------------------------------------------------------------------
describe("rankOpportunities", () => {
  const ids = ["zeta", "alpha", "mike"].map((suffix) =>
    mkOpp({ id: `arbeitsagentur:${suffix}`, external_id: suffix }),
  );

  it("without a profile: stable id order, capped by limit", () => {
    const ranked = rankOpportunities(ids, null, 2);
    expect(ranked.map((item) => item.id)).toEqual([
      "arbeitsagentur:alpha",
      "arbeitsagentur:mike",
    ]);
    expect(ranked[0].match).toBeNull();
  });

  it("with a profile: every row carries a computed match, limit respected", () => {
    const profile = candidateProfileSchema.parse(candidateProfileFixture());
    const ranked = rankOpportunities(ids, profile, 3);
    expect(ranked).toHaveLength(3);
    for (const item of ranked) expect(item.match).not.toBeNull();
    // Complete matches always precede incomplete ones.
    const status = ranked.map((item) => item.match?.status);
    const firstIncomplete = status.indexOf("incomplete");
    if (firstIncomplete !== -1) {
      expect(status.slice(0, firstIncomplete)).not.toContain("incomplete");
    }
  });
});

// ---------------------------------------------------------------------------
// Excel export row mapping
// ---------------------------------------------------------------------------
describe("buildExportRow", () => {
  it("maps every documented source field (nothing invented)", () => {
    const row = buildExportRow(
      mkOpp({
        company_name: "Berliner Feuerwehr",
        title: "Ausbildung Notfallsanitäter",
        location: "10115 Berlin",
        location_detail: {
          city: "Berlin",
          region: "Berlin",
          country: "Deutschland",
          postal_code: "10115",
        },
        valid_from: "2027-01-01T00:00:00.000Z",
        application_deadline: "2027-01-03",
        salary: { amount: 1440.7, unit: "monthly", label: "1.440,70 € / month" },
        contact: { email: "bewerbung@ff.de", phone: "030 123456", person: "Herr Maier" },
        application_url: "https://apply.example.test/form",
        company_url: "https://example.test",
        requirements: ["Mittlere Reife", "Sportprüfung"],
        profession: "Notfallsanitäter",
        training_type: "AUSBILDUNG",
        education_requirement: { raw: "MITTLERE_REIFE", level: "intermediate" },
        posted_at: "2026-09-20T08:00:00.000Z",
      }),
    );
    expect(row).toEqual({
      company: "Berliner Feuerwehr",
      title: "Ausbildung Notfallsanitäter",
      location: "10115 Berlin",
      bundesland: "Berlin",
      start_date: "2027-01-01",
      application_deadline: "2027-01-03",
      email: "bewerbung@ff.de",
      phone: "030 123456",
      company_website: "https://example.test",
      application_url: "https://apply.example.test/form",
      source_url: "https://example.test/1",
      source_type: "official_source",
      additional_sources: "",
      sources: "",
      requirements: "Mittlere Reife\nSportprüfung",
      other: expect.stringContaining("Salary: 1.440,70 € / month"),
    });
    expect(row.other).toContain("Contact person: Herr Maier");
    expect(row.other).toContain("Training type: AUSBILDUNG");
    expect(row.other).toContain("Posted: 2026-09-20");
  });

  it("leaves missing values empty (never placeholders)", () => {
    const row = buildExportRow(
      mkOpp({
        contact: null,
        company_name: null,
        location: null,
        location_detail: null,
      }),
    );
    expect(row.company).toBe("");
    expect(row.email).toBe("");
    expect(row.phone).toBe("");
    expect(row.company_website).toBe("");
    expect(row.application_url).toBe("");
    expect(row.application_deadline).toBe("");
    expect(row.requirements).toBe("");
    expect(row.bundesland).toBe("");
    // Identity fields are always present from the source.
    expect(row.title).toBe("Ausbildung Mechatroniker/in");
    expect(row.source_url).toBe("https://example.test/1");
  });
});

// ---------------------------------------------------------------------------
// End-to-end pipeline (mocked upstream, real matching + dedupe + ranking)
// ---------------------------------------------------------------------------
describe("runAISearch", () => {
  it("streams profile → plan → search → enrich → complete with real rows", async () => {
    setAdminMock({
      maybeSingleData: (table) =>
        table === "candidate_profiles"
          ? { profile_json: candidateProfileFixture() }
          : null,
    });
    mockAIPlan({
      rationale: "Profile documents Mechatroniker in Berlin.",
      queries: [{ keyword: "", role: "Mechatroniker", location: "Berlin" }],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          ergebnisliste: [
            mkSearchItem("REF-A", "2026-09-28", { hauptberuf: "Mechatroniker/in" }),
          ],
          maxErgebnisse: 1,
        }),
      ),
    );
    vi.mocked(resolveOpportunity).mockResolvedValue(
      mkOpp({
        id: "arbeitsagentur:REF-A",
        external_id: "REF-A",
        description: "Ausbildungstext",
        requirements: ["Mittlere Reife"],
        contact: { email: "azubi@company.de", phone: null, person: null },
      }),
    );

    const events: string[] = [];
    const result = await runAISearch({
      userId: "user-1",
      goal: "ausbildung",
      targetCount: 10,
      onProgress: (event) => events.push(event.type),
    });

    expect(events).toEqual([
      "profile",
      "plan",
      "search",
      "enrich",
      "dedupe",
      "complete",
    ]);
    expect(result.found).toBe(1);
    expect(result.searched).toBe(1);
    expect(result.enriched).toBe(1);
    expect(result.discovery.configured).toBe(false);
    const row = result.results[0];
    // Enriched from the details endpoint, matched against the profile.
    expect(row.description).toBe("Ausbildungstext");
    expect(row.contact?.email).toBe("azubi@company.de");
    expect(row.match).not.toBeNull();
  });

  it("rejects with a controlled message when no candidate profile exists", async () => {
    setAdminMock(); // candidate_profiles → null
    mockAIPlan({
      rationale: "r",
      queries: [{ keyword: "", role: "x", location: "" }],
    });
    await expect(
      runAISearch({ userId: "user-1", goal: "ausbildung", targetCount: 10 }),
    ).rejects.toThrow(/No candidate profile/i);
  });
});
