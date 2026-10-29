/**
 * AI Bewerbung Studio — /api/bewerbung-studio/generate-cv route contract.
 *
 * Reproduces the production incident: `Generate CV` failed with
 * "Angaben, die sich nicht aus Ihren Daten ableiten lassen" naming the
 * candidate's OWN verified identity (personal.fullName / personal.email /
 * personal.phone). The model faithfully echoes the scanner profile — the
 * only identity the prompt shows (formatCvForPrompt omits the CV's contacts)
 * — while the fact guard compared against the browser-CV-priority value.
 *
 * The AI provider is mocked — no model calls, no paid credits.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const authState = { user: { id: "user-a" } as { id: string } | null };
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: authState.user } }) } }),
}));

const rateLimitState = { allowed: true };
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: rateLimitState.allowed })),
  rateLimitHeaders: () => ({}),
  tooManyRequests: () => new Response(JSON.stringify({ error: "too many" }), { status: 429 }),
}));

const quota: { reserved: number; completed: number; released: number; outcome: "reserved" | "quota_exhausted" | "feature_disabled" | "error" } = {
  reserved: 0,
  completed: 0,
  released: 0,
  outcome: "reserved",
};
vi.mock("@/lib/billing/entitlement-service", () => ({
  reserveFeatureOp: vi.fn(async () => {
    quota.reserved++;
    return { outcome: quota.outcome };
  }),
  completeFeatureOp: vi.fn(async () => {
    quota.completed++;
    return { outcome: "completed" };
  }),
  releaseFeatureOp: vi.fn(async () => {
    quota.released++;
    return { outcome: "released" };
  }),
}));

let modelOutput: string;
const prompts: string[] = [];
vi.mock("@/lib/ai-service", () => ({
  provider: () => ({
    generateText: async (msgs: Array<{ role: string; content: string }>) => {
      prompts.push(msgs[0]?.content ?? "");
      return modelOutput;
    },
  }),
  detectFileType: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
import { createAdminClient } from "@/lib/supabase/admin";
import { createStudioDb } from "./helpers-studio";

const { POST } = await import("@/app/api/bewerbung-studio/generate-cv/route");

// ---------------------------------------------------------------------------
// The candidate's two verified sources — they DISAGREE on identity (the
// browser CV's personal section is stale). Both are the user's own data.
// ---------------------------------------------------------------------------

const PROFILE_JSON = {
  goal: "ausbildung",
  candidate: {
    full_name: "Mustapha Drif",
    location: "Berlin",
    country: "Deutschland",
    contact: { email: "mustapha.drif@example.de", phone: "+49 151 2345678" },
  },
  education: [
    { school: "Gymnasium Berlin-Mitte", degree: "Abitur", graduation_year: 2024, education_level: "Abitur", source: "user_provided" },
  ],
  // year-only dates (the common German CV style) — keeps the test focused on
  // identity; the date-precision tolerance is pinned separately (d64bdf5)
  experience: [
    { job_title: "Auszubildender Fachinformatiker", company: "Muster AG", responsibilities: ["Pflege von Webanwendungen"], start_date: "2024", end_date: null, type: "employment", source: "user_provided" },
  ],
  skills: { technical: ["JavaScript", "SQL"], soft: ["Teamwork"] },
  languages: [
    { language: "Deutsch", level: "Muttersprache" },
    { language: "Englisch", level: "C1" },
  ],
};

const CLIENT_CV = {
  version: 1,
  templateId: "classic",
  personal: {
    fullName: "M. Drif",
    professionalTitle: "",
    email: "old.person@example.de",
    phone: "+49 170 1234567",
    location: "Berlin",
    linkedin: "",
    website: "",
    nationality: "",
    dateOfBirth: "",
    availability: "",
    photo: null,
  },
  summary: "Motivierter Ausbildungskandidat mit Erfahrung im IT-Bereich.",
  education: [
    { id: "e1", degree: "Abitur", institution: "Gymnasium Berlin-Mitte", location: "Berlin", start: "2019", end: "2024", description: "" },
  ],
  experience: [
    { id: "x1", jobTitle: "Auszubildender Fachinformatiker", company: "Muster AG", location: "Berlin", start: "2024", end: "", isCurrent: true, responsibilities: ["Pflege von Webanwendungen"], achievements: [] },
  ],
  skills: ["JavaScript", "SQL", "Teamwork"],
  languages: [
    { id: "l1", language: "Deutsch", level: "Muttersprache" },
    { id: "l2", language: "Englisch", level: "C1" },
  ],
  certificates: [],
  projects: [],
  interests: [],
};

const EXTRACT = {
  jobTitle: "Fachinformatiker",
  occupation: "Fachinformatiker",
  company: "Muster AG",
  companyAddress: "Musterstraße 1",
  location: "Berlin",
  startDate: "01.08.2027",
  applicationDeadline: "30.06.2026",
  requiredQualifications: ["Guter Schulabschluss"],
  preferredQualifications: [],
  technicalSkills: ["JavaScript"],
  softSkills: [],
  languageRequirements: [],
  educationRequirement: "",
  responsibilities: [],
  requestedDocuments: ["Lebenslauf"],
  applicationMethod: "Per E-Mail",
  contactPerson: "",
  applicationEmail: "jobs@muster-ag.de",
  companyNotes: [],
  missingOrAmbiguous: [],
};

/** What a faithful model returns: the PROFILE identity (its only visible
 *  source), the CV's grounded facts, standard German date/phone formatting. */
const FAITHFUL_OUTPUT = {
  version: 1,
  templateId: "classic",
  personal: {
    fullName: "Mustapha Drif",
    professionalTitle: "Fachinformatiker",
    email: "mustapha.drif@example.de",
    phone: "0151 2345678",
    location: "Berlin",
    linkedin: "",
    website: "",
    nationality: "",
    dateOfBirth: "",
    availability: "",
    photo: null,
  },
  summary: "Motivierter Ausbildungskandidat mit Erfahrung im IT-Bereich.",
  education: [
    { id: "e1", degree: "Abitur", institution: "Gymnasium Berlin-Mitte", location: "Berlin", start: "09/2019", end: "07/2024", description: "" },
  ],
  experience: [
    { id: "x1", jobTitle: "Auszubildender Fachinformatiker", company: "Muster AG", location: "Berlin", start: "08/2024", end: "", isCurrent: true, responsibilities: ["Pflege von Webanwendungen"], achievements: [] },
  ],
  skills: ["JavaScript", "SQL", "Teamwork"],
  languages: [
    { id: "l1", language: "Deutsch", level: "Muttersprache" },
    { id: "l2", language: "Englisch", level: "C1" },
  ],
  certificates: [],
  projects: [],
  interests: [],
};

beforeEach(() => {
  authState.user = { id: "user-a" };
  rateLimitState.allowed = true;
  quota.reserved = 0;
  quota.completed = 0;
  quota.released = 0;
  quota.outcome = "reserved";
  modelOutput = JSON.stringify(FAITHFUL_OUTPUT);
  prompts.length = 0;
  const db = createStudioDb({
    candidate_profiles: [
      { id: "p1", user_id: "user-a", profile_json: PROFILE_JSON, updated_at: "2026-10-29T00:00:00.000Z" },
    ],
  });
  (createAdminClient as ReturnType<typeof vi.fn>).mockReturnValue(db.admin);
});

function post(body: unknown) {
  return POST(new Request("http://localhost/api/bewerbung-studio/generate-cv", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

describe("the candidate's own verified identity is accepted (incident repro)", () => {
  it("Generate CV succeeds when the model faithfully echoes the PROFILE identity while the client CV disagrees", async () => {
    const res = await post({ cv: CLIENT_CV, extract: EXTRACT, templateId: "classic" });
    expect(res.status, JSON.stringify(await res.clone().json().catch(() => null))).toBe(200);
    const body = await res.json();
    // the saved CV carries the candidate's verified identity, not the stale one
    expect(body.cv.personal.fullName).toBe("Mustapha Drif");
    expect(body.cv.personal.email).toBe("mustapha.drif@example.de");
    expect(body.cv.personal.phone).toBe("0151 2345678");
    expect(quota.completed).toBe(1);
    expect(quota.released).toBe(0);
    // sanity: the model saw the profile identity — and NOT the stale CV one
    expect(prompts[0]).toContain("mustapha.drif@example.de");
    expect(prompts[0]).not.toContain("old.person@example.de");
  });

  it("still returns 422 fact_violations (quota released) when the model invents identity", async () => {
    const bad = JSON.parse(JSON.stringify(FAITHFUL_OUTPUT));
    bad.personal.email = "nobody@unknown.de";
    bad.personal.fullName = "Ergänzt Person";
    modelOutput = JSON.stringify(bad);
    const res = await post({ cv: CLIENT_CV, extract: EXTRACT, templateId: "classic" });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe("fact_violations");
    expect(body.violations.map((v: { field: string }) => v.field).sort()).toEqual(["personal.email", "personal.fullName"]);
    expect(quota.released).toBe(1);
    expect(quota.completed).toBe(0);
  });
});

describe("gates", () => {
  it("401 when unauthenticated (no AI call, no quota)", async () => {
    authState.user = null;
    const res = await post({ cv: CLIENT_CV, extract: EXTRACT });
    expect(res.status).toBe(401);
    expect(prompts.length).toBe(0);
    expect(quota.reserved).toBe(0);
  });

  it("400 cv_empty when the client CV has no content", async () => {
    const emptyCv = {
      ...CLIENT_CV,
      personal: { fullName: "", professionalTitle: "", email: "", phone: "", location: "", linkedin: "", website: "", nationality: "", dateOfBirth: "", availability: "", photo: null },
      summary: "",
      education: [],
      experience: [],
      skills: [],
      languages: [],
    };
    const res = await post({ cv: emptyCv, extract: EXTRACT });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("cv_empty");
    expect(prompts.length).toBe(0);
    expect(quota.released).toBe(1);
  });
});
