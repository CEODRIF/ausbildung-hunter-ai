/**
 * AUTO BEWERB — Step 6: ONE global email template for ALL companies.
 *
 * The per-company email body override is REMOVED: exactly one source of
 * truth (auto_bewerb_email_templates.body, one row per user) feeds every
 * preview AND every send, substituted per company via the verified tokens
 * {company} / {position} / {contactName} (missing → empty, never invented).
 * Pinned here:
 *   1. token substitution: one template rendered for 3/5/10 companies —
 *      each result carries its own company facts and none of the others',
 *      missing values stay empty, no token residue;
 *   2. source contracts: no per-company body override remains anywhere in
 *      Step 6 UI, Step 7 review, the server actions or the send engine;
 *      the engine ALWAYS resolves the shared template per company;
 *   3. the global AI-template prompt (tokens, no-invention, attachments);
 *   4. the generate-email route: global (no company input), auth /
 *      rate-limit / quota metering, honest failures.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdExtract } from "@/lib/auto-bewerb/schema";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/ai-service", () => ({ provider: vi.fn() }));
vi.mock("@/lib/billing/entitlement-service", () => ({
  reserveFeatureOp: vi.fn(),
  completeFeatureOp: vi.fn(),
  releaseFeatureOp: vi.fn(),
}));
vi.mock("@/lib/rate-limit", async () => {
  const { NextResponse } = await import("next/server");
  return {
    checkRateLimit: vi.fn(),
    rateLimitHeaders: vi.fn(() => ({})),
    tooManyRequests: vi.fn(() => NextResponse.json({ error: "RATE_LIMITED_MARKER" }, { status: 429 })),
  };
});
vi.mock("@/lib/auto-bewerb/engine", () => ({ getAutoBewerbProfile: vi.fn() }));

const { createClient } = await import("@/lib/supabase/server");
const { provider } = await import("@/lib/ai-service");
const { reserveFeatureOp, completeFeatureOp, releaseFeatureOp } = await import("@/lib/billing/entitlement-service");
const { checkRateLimit } = await import("@/lib/rate-limit");
const { getAutoBewerbProfile } = await import("@/lib/auto-bewerb/engine");
const { POST } = await import("@/app/api/auto-bewerb/generate-email/route");
const { renderAutoBewerbEmailBody } = await import("@/lib/auto-bewerb/schema");
const { buildAutoBewerbEmailTemplatePrompt } = await import("@/lib/auto-bewerb/prompts");

const read = (p: string) => readFileSync(p, "utf8");
const STEP6 = read("src/components/auto-bewerb/step6-email.tsx");
const STEP7 = read("src/components/auto-bewerb/step7-review.tsx");
const ACTIONS = read("src/app/auto-bewerb/actions.ts");
const ENGINE = read("src/lib/auto-bewerb/engine.ts");

// ---------------------------------------------------------------------------
// 1. Token substitution — one template, N companies
// ---------------------------------------------------------------------------

function extract(company: string, jobTitle: string, occupation?: string, contactPerson?: string): AdExtract {
  return {
    jobTitle,
    occupation: occupation ?? "",
    company,
    companyAddress: "",
    location: "",
    startDate: "",
    applicationDeadline: "",
    requiredQualifications: [],
    preferredQualifications: [],
    technicalSkills: [],
    softSkills: [],
    languageRequirements: [],
    educationRequirement: "",
    responsibilities: [],
    requestedDocuments: [],
    applicationMethod: "",
    contactPerson: contactPerson ?? "",
    applicationEmail: "",
    companyNotes: [],
    missingOrAmbiguous: [],
  } as AdExtract;
}

const TEMPLATE =
  "Sehr geehrte Damen und Herren,\n\nhiermit bewerbe ich mich als {position} bei {company}. " +
  "Anbei erhalten Sie meinen Lebenslauf und mein Anschreiben als PDF.\n\nMit freundlichen Grüßen\nMustapha Drif";

describe("token substitution (one global template, N companies)", () => {
  it("3 companies → 3 DISTINCT resolved bodies, no cross-contamination", () => {
    const companies = [
      extract("Kältebau Nord GmbH", "Anlagenmechaniker SHK", "Anlagenmechaniker SHK", "Frau Schneider"),
      extract("Tech Süd AG", "Fachinformatiker — Systemintegration", "Fachinformatiker", ""),
      extract("Heizungsbau Ost GmbH", "Anlagenmechaniker SHK", "", "Herr Berger"),
    ];
    const resolved = companies.map((e) => renderAutoBewerbEmailBody(TEMPLATE, e));
    expect(new Set(resolved).size).toBe(3);
    expect(resolved[0]).toContain("Kältebau Nord GmbH");
    expect(resolved[1]).toContain("Tech Süd AG");
    expect(resolved[2]).toContain("Heizungsbau Ost GmbH");
    // company A's body never contains company B's name (and vice versa):
    for (let i = 0; i < resolved.length; i++) {
      for (let j = 0; j < companies.length; j++) {
        if (i !== j) expect(resolved[i]).not.toContain(companies[j].company);
      }
    }
    // no token residue anywhere:
    for (const r of resolved) {
      expect(r).not.toContain("{company}");
      expect(r).not.toContain("{position}");
      expect(r).not.toContain("{contactName}");
    }
  });

  it("5 and 10 companies → the SAME template text, only the substitution differs", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      extract(`Firma ${i + 1} GmbH`, `Stelle ${i + 1}`, undefined, i % 2 === 0 ? `Frau K${i + 1}` : ""),
    );
    const five = many.slice(0, 5).map((e) => renderAutoBewerbEmailBody(TEMPLATE, e));
    const ten = many.map((e) => renderAutoBewerbEmailBody(TEMPLATE, e));
    // every resolved body is a substitution of the ONE template (same
    // sentence skeleton, only the token slots differ):
    for (const r of [...five, ...ten]) {
      expect(r.startsWith("Sehr geehrte Damen und Herren,")).toBe(true);
      expect(r).toContain("Anbei erhalten Sie meinen Lebenslauf und mein Anschreiben als PDF.");
    }
    expect(new Set(ten).size).toBe(10);
    expect(ten.slice(0, 5)).toEqual(five); // deterministic per company
  });

  it("missing information → the token value is EMPTY, nothing is invented", () => {
    const e = extract("NurFirma GmbH", "", "", ""); // no jobTitle, no occupation, no contact
    const resolved = renderAutoBewerbEmailBody(TEMPLATE, e);
    expect(resolved).toContain("NurFirma GmbH");
    expect(resolved).not.toContain("{position}");
    expect(resolved).not.toContain("{contactName}");
    // the empty slot collapses to the empty string — no invented
    // placeholder text, no leftover brackets:
    expect(resolved.replace(/\s+/g, " ")).toContain("hiermit bewerbe ich mich als bei NurFirma GmbH.");
  });

  it("{position} falls back to the occupation when the ad has no job title", () => {
    const resolved = renderAutoBewerbEmailBody(TEMPLATE, extract("X GmbH", "", "Elektroniker"));
    expect(resolved).toContain("als Elektroniker bei X GmbH");
  });
});

// ---------------------------------------------------------------------------
// 2. Source contracts — exactly ONE source of truth for the e-mail body
// ---------------------------------------------------------------------------

describe("single source of truth (source contracts)", () => {
  it("Step 6 UI: no per-company body override, preview = shared template per company", () => {
    expect(STEP6).not.toContain("bodyOverride");
    expect(STEP6).not.toContain("emailBody");
    expect(STEP6).not.toContain("applyDraftToCompany");
    // the preview renders the SHARED template (incl. unsaved edits) with
    // the active company's verified extraction:
    expect(STEP6).toContain("renderAutoBewerbEmailBody(template, row.ad_extracted)");
    // and the template TEXT (draft or saved) is what the editor receives:
    expect(STEP6).toContain('<CompanyEmailEditor key={`${activeId}:${active.company.updated_at}`} view={active} template={templateText} />');
  });

  it("Step 6 AI draft: global request WITHOUT any company input", () => {
    expect(STEP6).not.toContain("companyId: activeId");
    expect(STEP6).toContain('"/api/auto-bewerb/generate-email"');
    expect(STEP6).toContain("attachmentNames: sharedDocNames.slice(0, 10)");
    // the draft is applied to the global template (never to a company):
    expect(STEP6).toContain("setTemplateDraft(draftResult.body)");
  });

  it("Step 7 review: send inputs carry no body override; the confirmation modal shows the RESOLVED template body per recipient", () => {
    expect(STEP7).not.toContain("bodyOverride");
    expect(STEP7).not.toContain("email_body");
    expect(STEP7).toContain("renderAutoBewerbEmailBody(ws.emailTemplate, v.company.ad_extracted)");
  });

  it("server actions: updateCompanyAction has no emailBody; send/schedule pass no bodyOverride", () => {
    expect(ACTIONS).not.toContain("emailBody");
    expect(ACTIONS).not.toContain("bodyOverride");
  });

  it("send engine: ALWAYS resolves the shared template per company; legacy column is never read and is cleared on write", () => {
    expect(ENGINE).not.toContain("bodyOverride");
    // template is fetched per send preparation (per company) and rendered
    // from that company's stored extraction:
    expect(ENGINE).toContain("getAutoBewerbEmailTemplate(userId)");
    expect(ENGINE).toContain("renderAutoBewerbEmailBody(template, app.ad_extracted)");
    // the legacy override column is only ever written as null:
    expect(ENGINE).toContain("email_body: null,");
    expect(ENGINE).not.toContain("app.email_body");
    expect(ENGINE).not.toContain("r.email_body");
  });
});

// ---------------------------------------------------------------------------
// 3. The global template prompt
// ---------------------------------------------------------------------------

describe("buildAutoBewerbEmailTemplatePrompt", () => {
  it("requires the three tokens and a company-neutral template", () => {
    const p = buildAutoBewerbEmailTemplatePrompt({ sharedAttachmentNames: [] });
    expect(p).toContain("{company}");
    expect(p).toContain("{position}");
    expect(p).toContain("{contactName}");
    expect(p).toContain("unternehmensneutral");
    // {contactName} may never sit in the greeting (it can be empty):
    expect(p).toContain("{contactName} DARF NICHT in der Anrede stehen");
  });

  it("forbids invented qualifications and requires the JSON contract", () => {
    const p = buildAutoBewerbEmailTemplatePrompt({ sharedAttachmentNames: [] });
    expect(p).toContain("Erfinde NIEMALS");
    expect(p).toContain('{ "subject": string, "body": string }');
  });

  it("names the always-attached CV + letter PDFs and the global shared documents", () => {
    const p = buildAutoBewerbEmailTemplatePrompt({ sharedAttachmentNames: ["Abiturzeugnis.pdf"] });
    expect(p).toContain("Lebenslauf als PDF");
    expect(p).toContain("Anschreiben als PDF");
    expect(p).toContain("Abiturzeugnis.pdf");
    expect(p).not.toContain("{company} → Name des Unternehmens (wird pro Unternehmen ersetzt)\n\n");
  });
});

// ---------------------------------------------------------------------------
// 4. The generate-email route (global, metered, honest)
// ---------------------------------------------------------------------------

const USER = "22222222-2222-4222-8222-222222222222";
const BASE = "http://localhost/api/auto-bewerb/generate-email";

const PROFILE = {
  fileName: "cv.pdf",
  mimeType: "application/pdf",
  sizeBytes: 1,
  cvHash: "x",
  analyzedAt: "2026-01-01T00:00:00.000Z",
  extracted: {
    candidate: { full_name: "Mustapha Drif", location: "Hamburg" },
    experience: [{ job_title: "Praktikant Kältetechnik", company: "Kältebau Nord GmbH" }],
    skills: { technical: ["Schaltpläne lesen"] },
  },
} as never;

const DRAFT_OK = JSON.stringify({
  subject: "Bewerbung um die Ausbildungsstelle",
  body: "Sehr geehrte Damen und Herren,\n\nhiermit bewerbe ich mich als {position} bei {company}. Anbei erhalten Sie meinen Lebenslauf und mein Anschreiben als PDF.\n\nMit freundlichen Grüßen\nMustapha Drif",
});

const generateText = vi.fn(async () => DRAFT_OK);

const lastPrompt = (): string =>
  String(((generateText.mock.calls as unknown as unknown[][]).at(-1)?.[0] as Array<{ content: string }> | undefined)?.[0]
    ?.content);

beforeEach(() => {
  vi.clearAllMocks();
  generateText.mockClear();
  generateText.mockImplementation(async () => DRAFT_OK);
  (createClient as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    auth: { getUser: async () => ({ data: { user: { id: USER } } }) },
  } as never);
  (provider as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ generateText });
  (checkRateLimit as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    allowed: true,
    count: 1,
    limit: 30,
    retryAfterSeconds: 0,
  });
  (reserveFeatureOp as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ outcome: "reserved" });
  (completeFeatureOp as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ outcome: "completed" });
  (releaseFeatureOp as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ outcome: "released" });
  (getAutoBewerbProfile as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(PROFILE);
});

const post = (body: Record<string, unknown> = {}) =>
  POST(
    new Request(BASE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

describe("generate-email route", () => {
  it("unauthenticated → 401, model never called", async () => {
    (createClient as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      auth: { getUser: async () => ({ data: { user: null } }) },
    } as never);
    const res = await post();
    expect(res.status).toBe(401);
    expect(generateText).not.toHaveBeenCalled();
  });

  it("rate limited → 429, model never called", async () => {
    (checkRateLimit as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      allowed: false,
      count: 31,
      limit: 30,
      retryAfterSeconds: 30,
    });
    const res = await post();
    expect(res.status).toBe(429);
    expect(generateText).not.toHaveBeenCalled();
  });

  it("quota exhausted → 429 with code, model never called", async () => {
    (reserveFeatureOp as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ outcome: "quota_exhausted" });
    const res = await post();
    expect(res.status).toBe(429);
    expect(((await res.json()) as { code?: string }).code).toBe("quota_exhausted");
    expect(generateText).not.toHaveBeenCalled();
  });

  it("feature disabled → 403, model never called", async () => {
    (reserveFeatureOp as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ outcome: "feature_disabled" });
    const res = await post();
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code?: string }).code).toBe("feature_disabled");
    expect(generateText).not.toHaveBeenCalled();
  });

  it("success → 200 {subject, body} + the reservation is COMPLETED (quota charged)", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    const data = (await res.json()) as { subject: string; body: string };
    expect(data.subject).toBe("Bewerbung um die Ausbildungsstelle");
    expect(data.body).toContain("{company}");
    expect(completeFeatureOp).toHaveBeenCalledTimes(1);
    expect(releaseFeatureOp).not.toHaveBeenCalled();
  });

  it("invalid model output → 502 + the reservation is RELEASED", async () => {
    generateText.mockImplementation(async () => "not json at all");
    const res = await post();
    expect(res.status).toBe(502);
    expect(((await res.json()) as { code?: string }).code).toBe("invalid_ai_output");
    expect(releaseFeatureOp).toHaveBeenCalledTimes(1);
    expect(completeFeatureOp).not.toHaveBeenCalled();
  });

  it("provider failure → 400 + the reservation is RELEASED (never charged)", async () => {
    generateText.mockImplementation(async () => {
      throw new Error("provider down");
    });
    const res = await post();
    expect(res.status).toBe(400);
    expect(releaseFeatureOp).toHaveBeenCalledTimes(1);
    expect(completeFeatureOp).not.toHaveBeenCalled();
  });

  it("NO company input needed — the prompt is global: tokens + verified profile, no company facts", async () => {
    await post({ attachmentNames: ["Abiturzeugnis.pdf"] });
    const p = lastPrompt();
    expect(p).toContain("{company}");
    expect(p).toContain("{position}");
    expect(p).toContain("{contactName}");
    expect(p).toContain("Erfinde NIEMALS");
    // the verified profile grounds the motivation (real facts only):
    expect(p).toContain("Kältebau Nord GmbH");
    expect(p).toContain("Abiturzeugnis.pdf");
  });

  it("missing profile → the prompt marks it unavailable (never invents)", async () => {
    (getAutoBewerbProfile as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await post();
    expect(lastPrompt()).toContain("KANDIDATENPROFIL: nicht verfügbar");
  });
});
