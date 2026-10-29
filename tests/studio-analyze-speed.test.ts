/**
 * AI Bewerbung Studio — /api/bewerbung-studio/analyze-ad speed contract.
 *
 * Measures the FULL server-side pipeline stage by stage with a
 * latency-injected provider mock (no model calls, no paid credits) and pins
 * the anti-duplication guarantees:
 *   - one provider call per user request (single-flight for concurrent
 *     identical requests),
 *   - stored analysis reused for the same application + unchanged ad
 *     (zero provider calls, zero quota),
 *   - bounded retry on invalid model output (max 2 provider calls),
 *   - deterministic extraction (temperature 0),
 *   - prompt/output size discipline (measured, asserted to shrink).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const authState = { user: { id: "user-a" } as { id: string } | null };
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: authState.user } }) } }),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
  rateLimitHeaders: () => ({}),
  tooManyRequests: () => new Response(JSON.stringify({ error: "too many" }), { status: 429 }),
}));

const quota = { reserved: 0, completed: 0, released: 0, outcome: "reserved" as "reserved" | "quota_exhausted" | "feature_disabled" | "error" };
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

// ---------------------------------------------------------------------------
// Provider mock: latency injection + full call capture (args, timing, output)
// ---------------------------------------------------------------------------

const provider = {
  latencyMs: 0,
  calls: 0,
  /** Each captured call: user message(s) + generateText options arg. */
  invocations: [] as Array<{ messages: Array<{ role: string; content: string }>; timeoutMs?: number; options?: Record<string, unknown> }>,
  /** Queue of raw outputs; empty → DEFAULT_OUTPUT. */
  outputQueue: [] as string[],
  providerStart: 0,
  providerEnd: 0,
};
vi.mock("@/lib/ai-service", () => ({
  provider: () => ({
    generateText: async (
      messages: Array<{ role: string; content: string }>,
      timeoutMs?: number,
      options?: Record<string, unknown>,
    ) => {
      provider.calls++;
      provider.invocations.push({ messages, timeoutMs, options });
      provider.providerStart = Date.now();
      if (provider.latencyMs > 0) await new Promise((r) => setTimeout(r, provider.latencyMs));
      provider.providerEnd = Date.now();
      if (provider.outputQueue.length) return provider.outputQueue.shift() as string;
      // A compliant model honors the output discipline when the prompt
      // asks for it (the old prompt never did → undisciplined output).
      return messages.some((m) => typeof m.content === "string" && m.content.includes("KÜRZE-DISZIPLIN"))
        ? DISCIPLINED_OUTPUT
        : DEFAULT_OUTPUT;
    },
  }),
  detectFileType: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
import { createAdminClient } from "@/lib/supabase/admin";
import { createStudioDb } from "./helpers-studio";

const { POST } = await import("@/app/api/bewerbung-studio/analyze-ad/route");

// ---------------------------------------------------------------------------
// Realistic payload: a full German Ausbildung advertisement + a CV document
// ---------------------------------------------------------------------------

const AD =
  "Auszubildende/r Kaufmann/-frau für Marketingkommunikation (m/w/d)\n\n" +
  "Voyage Reiseorganisation GmbH sucht zum 01.08.2027 eine/n Auszubildende/n " +
  "Kaufmann/-frau für Marketingkommunikation für den Standort Augustdorf. " +
  "Bewerbung bis zum 30.06.2026 per E-Mail an karriere@voyage-reise.de.\n\n" +
  "Ihre Aufgaben:\n" +
  "- Unterstützung der Abteilung Marketing in der Planung und Umsetzung von Kampagnen\n" +
  "- Pflege und Betreuung der Social-Media-Kanäle (Instagram, Facebook, LinkedIn)\n" +
  "- Erstellung von Texten und Bildmaterialen für Online- und Printkanäle\n" +
  "- Mitwirkung bei der Organisation von Events und Messen\n" +
  "- Recherche und Analyse von Marketingtrends\n" +
  "- Zusammenarbeit mit externen Agenturen und Fotografen\n\n" +
  "Ihr Profil:\n" +
  "- Guter Hauptschulabschluss oder vergleichbarer Abschluss\n" +
  "- Erste Erfahrungen im Marketing, z. B. durch Praktika oder Nebenjobs\n" +
  "- Sicherer Umgang mit dem MS-Office-Paket\n" +
  "- Grundkenntnisse in Photoshop oder InDesign von Vorteil\n" +
  "- Gute Deutschkenntnisse in Wort und Schrift, Englischkenntnisse erwünscht\n" +
  "- Kreativität, Teamfähigkeit und Freude am Arbeiten im Team\n" +
  "- Eigenständige und sorgfältige Arbeitsweise\n\n" +
  "Wir bieten:\n" +
  "- Eine dreijährige duale Ausbildung mit Praxisphasen in verschiedenen Abteilungen\n" +
  "- Ein freundliches Team und flache Hierarchien\n" +
  "- Betriebliche Altersvorsorge und 30 Tage Urlaub\n" +
  "- ÜbernahmeeChance nach erfolgreicher Abschlussprüfung\n" +
  "- Fahrtkostenzuschuss und vergünstigte Kantinenessen\n\n" +
  "Interesse? Dann bewerben Sie sich bitte mit Lebenslauf und Zeugnissen über " +
  "unser Online-Portal oder per E-Mail. Ansprechpartnerin: Frau Schmidt (Marketing).";

const CV = {
  version: 1,
  templateId: "classic",
  personal: {
    fullName: "Mustafa Beispiel",
    email: "mustafa.beispiel@example.de",
    phone: "+49 170 1234567",
    location: "Hamburg",
    nationality: "Marokkanisch",
    availability: "01.08.2027",
  },
  summary: "Motivierter Azubi-Kandidat mit Erfahrung im Vertrieb.",
  education: [
    { id: "e1", degree: "Hauptschulabschluss", institution: "Stadtschule Hamburg", location: "Hamburg", start: "2018", end: "2024", description: "" },
  ],
  experience: [
    { id: "x1", jobTitle: "Praktikant Vertrieb", company: "Handel GmbH", location: "Hamburg", start: "2024", end: "2025", isCurrent: false, responsibilities: ["Kundenkommunikation", "Bewerbungsdokumente"], achievements: [] },
  ],
  skills: ["Kommunikation", "MS Office", "Teamarbeit"],
  languages: [
    { id: "l1", language: "Deutsch", level: "C1" },
    { id: "l2", language: "Arabisch", level: "Muttersprache" },
    { id: "l3", language: "Englisch", level: "B2" },
  ],
  certificates: [],
  projects: [],
  interests: ["Marketing", "Reisen"],
};

function matchItem(requirement: string, status: string, note: string) {
  return { requirement, status, note };
}

const manyItems = (n: number, prefix: string, status: string) =>
  Array.from(
    { length: n },
    (_, i) =>
      // old contract allowed 400-char notes and 50 entries → a typical
      // model response runs ~150-char grounded notes and enumerates a lot
      matchItem(
        `${prefix} ${i + 1}`,
        status,
        `Ausführliche, begründete Einschätzung zu ${prefix} ${i + 1}: Bezug zur Anzeige, zum Profil und zum Lebenslauf, inkl. Einschränkung und Quellenverweis im Anzeigentext.`,
      ),
  );

const DEFAULT_EXTRACT = {
  jobTitle: "Kaufmann/-frau für Marketingkommunikation",
  occupation: "Kaufmann/-frau für Marketingkommunikation",
  company: "Voyage Reiseorganisation GmbH",
  companyAddress: "",
  location: "Augustdorf",
  startDate: "01.08.2027",
  applicationDeadline: "30.06.2026",
  requiredQualifications: ["Guter Hauptschulabschluss oder vergleichbarer Abschluss", "Sicherer Umgang mit dem MS-Office-Paket", "Gute Deutschkenntnisse in Wort und Schrift"],
  preferredQualifications: ["Erste Erfahrungen im Marketing", "Grundkenntnisse in Photoshop oder InDesign", "Englischkenntnisse"],
  technicalSkills: ["MS Office", "Photoshop", "InDesign", "Social Media"],
  softSkills: ["Kreativität", "Teamfähigkeit", "Eigenständige Arbeitsweise", "Sorgfältige Arbeitsweise"],
  languageRequirements: ["Deutsch (sehr gute Kenntnisse)", "Englisch (erwünscht)"],
  educationRequirement: "Guter Hauptschulabschluss oder vergleichbarer Abschluss",
  responsibilities: [
    "Unterstützung der Abteilung Marketing in der Planung und Umsetzung von Kampagnen",
    "Pflege und Betreuung der Social-Media-Kanäle",
    "Erstellung von Texten und Bildmaterialien",
    "Mitwirkung bei der Organisation von Events und Messen",
    "Recherche und Analyse von Marketingtrends",
    "Zusammenarbeit mit externen Agenturen und Fotografen",
  ],
  requestedDocuments: ["Lebenslauf", "Zeugnisse"],
  applicationMethod: "Per E-Mail an karriere@voyage-reise.de oder über das Online-Portal",
  contactPerson: "Frau Schmidt (Marketing)",
  applicationEmail: "karriere@voyage-reise.de",
  companyNotes: ["30 Tage Urlaub", "Betriebliche Altersvorsorge", "Fahrtkostenzuschuss"],
  missingOrAmbiguous: [],
};

/**
 * The output a model tends to produce under the OLD prompt (no size bounds):
 * it enumerates everything the ad mentions — 20 matched / 15 missing / 10
 * transferable items with verbose (~150-char) notes, 8 advice items each.
 */
const DEFAULT_ANALYSIS = {
  matchScore: 72,
  matched: manyItems(20, "Anforderung", "matched"),
  missing: manyItems(15, "Lücke", "missing"),
  transferable: manyItems(10, "Übertragbare Qualifikation", "transferable"),
  weaknesses: Array.from({ length: 8 }, (_, i) => `Schwäche ${i + 1}: ausformulierte Begründung mit Bezug zum Profil.`),
  recommendations: Array.from({ length: 8 }, (_, i) => `Empfehlung ${i + 1}: konkreter, ausformulierter Verbesserungsvorschlag.`),
  questions: Array.from({ length: 8 }, (_, i) => `Frage ${i + 1} an die Personalabteilung zur Ausbildung.`),
};

const DEFAULT_OUTPUT = JSON.stringify({ extract: DEFAULT_EXTRACT, analysis: DEFAULT_ANALYSIS });

/** The output the OPTIMIZED prompt (≤10 list entries, ≤5 advice entries,
 *  ≤120-char notes) elicits from a compliant model. */
const capNotes = (items: Array<{ requirement: string; status: string; note: string }>) =>
  items.slice(0, 10).map((item) => ({ ...item, note: item.note.slice(0, 120) }));
const DISCIPLINED_OUTPUT = JSON.stringify({
  extract: DEFAULT_EXTRACT,
  analysis: {
    matchScore: 72,
    matched: capNotes(DEFAULT_ANALYSIS.matched),
    missing: capNotes(DEFAULT_ANALYSIS.missing),
    transferable: capNotes(DEFAULT_ANALYSIS.transferable),
    weaknesses: DEFAULT_ANALYSIS.weaknesses.slice(0, 5),
    recommendations: DEFAULT_ANALYSIS.recommendations.slice(0, 5),
    questions: DEFAULT_ANALYSIS.questions.slice(0, 5),
  },
});

// ---------------------------------------------------------------------------

let db: ReturnType<typeof createStudioDb>;

const APP_ROW: Record<string, unknown> = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  user_id: "user-a",
  ad_raw: AD,
  ad_extracted: null,
  ad_analysis: null,
  profile_snapshot: null,
  recipient_email: null,
  status: "draft" as const,
  approved: false,
  slot_no: 1,
  created_at: "2026-12-01T10:00:00.000Z",
  updated_at: "2026-12-01T10:00:00.000Z",
  ad_confirmed_at: null,
  profile_confirmed_at: null,
  cv_reviewed_at: null,
  letter_reviewed_at: null,
  checklist_ack_at: null,
};

function appWithAnalysis() {
  return {
    ...APP_ROW,
    ad_extracted: JSON.parse(DEFAULT_OUTPUT).extract,
    ad_analysis: JSON.parse(DEFAULT_OUTPUT).analysis,
    profile_snapshot: { cvHash: "stored-hash", at: "2026-12-01T10:00:00.000Z" },
  };
}

beforeEach(() => {
  authState.user = { id: "user-a" };
  quota.reserved = 0;
  quota.completed = 0;
  quota.released = 0;
  quota.outcome = "reserved";
  provider.calls = 0;
  provider.invocations.length = 0;
  provider.outputQueue.length = 0;
  provider.latencyMs = 0;
  db = createStudioDb({});
  (createAdminClient as ReturnType<typeof vi.fn>).mockReturnValue(db.admin);
});

function post(body: unknown) {
  return POST(
    new Request("http://localhost/api/bewerbung-studio/analyze-ad", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

const estTokens = (s: string) => Math.round(s.length / 4);

// ---------------------------------------------------------------------------
// Measured pipeline (stage timings + prompt/output sizes)
// ---------------------------------------------------------------------------

describe("measured pipeline (mocked provider latency)", () => {
  it("reports stage timings and prompt sizes for a realistic payload", async () => {
    provider.latencyMs = 300;
    const t0 = Date.now();
    const res = await post({ adText: AD, cv: CV });
    const tTotal = Date.now() - t0;
    const tProvider = provider.providerEnd - provider.providerStart;
    const tOverheadMs = tTotal - tProvider;
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    const inv = provider.invocations[0];
    const userPrompt = inv?.messages.map((m) => m.content).join("\n") ?? "";
    // what the (compliant) model returns for this prompt version
    const output =
      provider.outputQueue.length === 0
        ? (userPrompt.includes("KÜRZE-DISZIPLIN") ? DISCIPLINED_OUTPUT : DEFAULT_OUTPUT)
        : "";
    // The route may supply a task-specific system prompt (post-fix); before
    // the fix the provider prepends the full platform prompt (9,161 chars,
    // measured — invisible to this mock).
    const DEFAULT_SYSTEM_CHARS = 9161;
    const systemChars = typeof inv?.options?.systemPrompt === "string" ? inv.options.systemPrompt.length : DEFAULT_SYSTEM_CHARS;
    const sizes = {
      systemChars,
      systemEstTokens: Math.round(systemChars / 4),
      userPromptChars: userPrompt.length,
      userPromptEstTokens: estTokens(userPrompt),
      totalInputEstTokens: Math.round(systemChars / 4) + estTokens(userPrompt),
      outputChars: output.length,
      outputEstTokens: estTokens(output),
      providerCalls: provider.calls,
      tTotalMs: tTotal,
      tProviderMs: tProvider,
      tOverheadMs: tTotal - tProvider,
      quota: { reserved: quota.reserved, completed: quota.completed, released: quota.released },
      reused: (body.reused as boolean | undefined) ?? null,
    };
    console.log("\n[analyze-ad MEASURED]", JSON.stringify(sizes, null, 2), "\n");
    // Sanity invariants (the provider stage dominates; overhead is small)
    expect(provider.calls).toBe(1);
    expect(tProvider).toBeGreaterThanOrEqual(provider.latencyMs);
    expect(tOverheadMs).toBeLessThan(500); // validation + prompt + parse + zod
    expect(quota.reserved).toBe(1);
    expect(quota.completed).toBe(1);
  });

  it("a single user request costs exactly ONE provider call and ONE quota op", async () => {
    const res = await post({ adText: AD, cv: CV });
    expect(res.status).toBe(200);
    expect(provider.calls).toBe(1);
    expect(quota.reserved).toBe(1);
    expect(quota.completed).toBe(1);
    expect(quota.released).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Reuse: same application + unchanged ad → stored result, zero AI cost
// ---------------------------------------------------------------------------

describe("stored-analysis reuse (same application, unchanged ad)", () => {
  it("reuses the stored extract+analysis: 0 provider calls, 0 quota, reused=true", async () => {
    db.tables.studio_applications = [appWithAnalysis()];
    // The stored cvHash must match the SENT cv for reuse to apply — the test
    // app's stored hash stands in for sha256(JSON.stringify(CV)).
    const { createHash } = await import("node:crypto");
    const cvHash = createHash("sha256").update(JSON.stringify(CV)).digest("hex");
    db.tables.studio_applications[0].profile_snapshot = { cvHash, at: "2026-12-01T10:00:00.000Z" };

    const res = await post({ adText: AD, cv: CV, applicationId: APP_ROW.id });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { extract: { company: string }; analysis: { matchScore: number }; reused?: boolean };
    expect(body.extract.company).toBe("Voyage Reiseorganisation GmbH");
    expect(body.analysis.matchScore).toBe(72);
    expect(body.reused).toBe(true);
    expect(provider.calls).toBe(0);
    expect(quota.reserved).toBe(0);
  });

  it("does NOT reuse when the ad text changed", async () => {
    db.tables.studio_applications = [appWithAnalysis()];
    const { createHash } = await import("node:crypto");
    const cvHash = createHash("sha256").update(JSON.stringify(CV)).digest("hex");
    db.tables.studio_applications[0].profile_snapshot = { cvHash, at: "2026-12-01T10:00:00.000Z" };

    const res = await post({ adText: AD + " \nUpdate: neuer Standort Köln.", cv: CV, applicationId: APP_ROW.id });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reused?: boolean };
    expect(body.reused).not.toBe(true);
    expect(provider.calls).toBe(1);
    expect(quota.reserved).toBe(1);
  });

  it("does NOT reuse when the CV context changed (stored hash mismatch)", async () => {
    db.tables.studio_applications = [appWithAnalysis()]; // stored hash "stored-hash" ≠ hash(CV)
    const res = await post({ adText: AD, cv: CV, applicationId: APP_ROW.id });
    expect(res.status).toBe(200);
    expect(provider.calls).toBe(1);
  });

  it("does NOT reuse for a legacy app without a stored cvHash", async () => {
    const legacy = appWithAnalysis();
    legacy.profile_snapshot = null as never;
    db.tables.studio_applications = [legacy];
    const res = await post({ adText: AD, cv: CV, applicationId: APP_ROW.id });
    expect(res.status).toBe(200);
    expect(provider.calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Deduplication: concurrent identical requests share ONE provider call
// ---------------------------------------------------------------------------

describe("single-flight dedupe (concurrent identical requests)", () => {
  it("two concurrent identical requests → exactly ONE provider call", async () => {
    provider.latencyMs = 50;
    const [r1, r2] = await Promise.all([
      post({ adText: AD, cv: CV }),
      post({ adText: AD, cv: CV }),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(provider.calls).toBe(1);
    // Both user operations are metered (two clicks = two quota ops),
    // but the paid provider call happened once.
    expect(quota.reserved).toBe(2);
    expect(quota.completed).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Bounded retry on invalid model output
// ---------------------------------------------------------------------------

describe("bounded retry on invalid output", () => {
  it("invalid-then-valid → 200, provider called exactly twice, ONE quota op", async () => {
    provider.outputQueue = ["Das ist leider kein JSON.", DEFAULT_OUTPUT];
    const res = await post({ adText: AD, cv: CV });
    expect(res.status).toBe(200);
    expect(provider.calls).toBe(2);
    expect(quota.reserved).toBe(1);
    expect(quota.completed).toBe(1);
    expect(quota.released).toBe(0);
  });

  it("invalid-twice → 502, provider called at most twice, quota released (never 3+ calls)", async () => {
    provider.outputQueue = ["kein json", "auch kein json"];
    const res = await post({ adText: AD, cv: CV });
    expect(res.status).toBe(502);
    expect(provider.calls).toBeLessThanOrEqual(2);
    expect(quota.reserved).toBe(1);
    expect(quota.released).toBe(1);
    expect(quota.completed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Determinism + prompt discipline
// ---------------------------------------------------------------------------

describe("determinism + output discipline", () => {
  it("requests temperature 0 (deterministic extraction)", async () => {
    await post({ adText: AD, cv: CV });
    expect(provider.invocations[0]?.options?.temperature).toBe(0);
  });

  it("the prompt bounds the output size (≤10 list entries, short notes, ≤5 advice entries)", async () => {
    await post({ adText: AD, cv: CV });
    const prompt = provider.invocations[0]?.messages.map((m) => m.content).join("\n") ?? "";
    expect(prompt).toMatch(/max\.\s*10/i);
    expect(prompt).toMatch(/max\.\s*5/i);
    expect(prompt).toMatch(/120 Zeichen/i);
  });

  it("the optimized prompt + expected model output is smaller than the old contract", () => {
    // Old contract (measured BEFORE): the undisciplined default output.
    // New contract: the model is instructed to stay within ≤10/≤5/120-char
    // bounds — the disciplined output is what a compliant model returns.
    expect(estTokens(JSON.stringify(JSON.parse(DISCIPLINED_OUTPUT).analysis))).toBeLessThan(
      estTokens(JSON.stringify(JSON.parse(DEFAULT_OUTPUT).analysis)),
    );
  });
});
