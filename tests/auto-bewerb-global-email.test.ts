/**
 * AUTO BEWERB — Step 6: ONE global e-mail configuration for the whole batch.
 *
 * Every company receives the SAME shared template (subject + body), sending
 * account and attachment flags. The template is personalized PER RECIPIENT
 * at send time from verified data only ({{candidate_name}}, {{contact_person}},
 * {{company_name}}, {{greeting}}, {{position}} — missing values render EMPTY:
 * never a leftover placeholder, never invented). The only per-company value
 * for delivery is the destination: the verified application email of each
 * company's ad (legacy manual value preserved). The body is sanitized HTML
 * (single allowlist in @/lib/email-sanitize — sanitized on save AND on send).
 *
 * Pinned here (real engine, in-memory DB, sends SCHEDULED — no dispatch,
 * no real email):
 *   1. one template applied to 3 companies → identical subject/body/
 *      account/attachments, per-company verified recipients;
 *   2. legacy per-company values (incl. the old email_body override) can
 *      NEVER override the global configuration;
 *   3. a newly added company uses the global configuration automatically;
 *   4. an explicit global recipient is used for ALL companies;
 *   5. scheduled sends carry the same global configuration;
 *   6. per-recipient personalization (tokens from verified data only;
 *      missing → empty; no placeholder survives);
 *   7. HTML sanitization on save (actions) and on send (engine);
 *   8. per-company CV/letter isolation + blocking; no duplicate attachments;
 *   9. source contracts: no per-company override path anywhere (Step 6
 *      UI, Step 7 review, actions, engine);
 *   10. the AI prompt generates a shared, company-neutral template that
 *      may only use the supported tokens;
 *   11. the generate-email route stays global + metered.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StudioDb } from "./helpers-studio";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
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
vi.mock("@/lib/email-providers", () => ({ createEmailProvider: vi.fn() }));
// PARTIAL engine mock: the REAL send engine is under test (fake DB); only the
// profile getter is faked (it serves the route's prompt context).
vi.mock("@/lib/auto-bewerb/engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auto-bewerb/engine")>();
  return { ...actual, getAutoBewerbProfile: vi.fn() };
});

const { createAdminClient } = await import("@/lib/supabase/admin");
const { createClient } = await import("@/lib/supabase/server");
const { provider } = await import("@/lib/ai-service");
const { reserveFeatureOp, completeFeatureOp, releaseFeatureOp } = await import("@/lib/billing/entitlement-service");
const { checkRateLimit } = await import("@/lib/rate-limit");
const { getAutoBewerbProfile, prepareAutoBewerbSend } = await import("@/lib/auto-bewerb/engine");
const { POST } = await import("@/app/api/auto-bewerb/generate-email/route");
const { createStudioDb } = await import("./helpers-studio");
const { buildAutoBewerbEmailTemplatePrompt } = await import("@/lib/auto-bewerb/prompts");
const { resolveAutoBewerbRecipient } = await import("@/lib/auto-bewerb/schema");
const { cvEmpty } = await import("@/lib/templates/cv");
const { saveEmailTemplateAction, saveEmailSettingsAction } = await import("@/app/auto-bewerb/actions");
const { sanitizeEmailHtml, htmlToText } = await import("@/lib/email-sanitize");

const read = (p: string) => readFileSync(p, "utf8");
const STEP6 = read("src/components/auto-bewerb/step6-email.tsx");
const STEP7 = read("src/components/auto-bewerb/step7-review.tsx");
const ACTIONS = read("src/app/auto-bewerb/actions.ts");
const ENGINE = read("src/lib/auto-bewerb/engine.ts");
const SCHEMA = read("src/lib/auto-bewerb/schema.ts");
const DICT = read("src/lib/i18n/dictionaries.ts");

// ---------------------------------------------------------------------------
// Fake-DB functional tests (global mode — settings columns present)
// ---------------------------------------------------------------------------

const USER = "11111111-1111-4111-8111-111111111111";
const ACCT_ID = "33333333-3333-4333-8333-333333333333";
const CO1 = "44444444-4444-4444-8444-444444444444";
const CO2 = "55555555-5555-4555-8555-555555555555";
const CO3 = "66666666-6666-4666-8666-666666666666";
const CO_NEW = "99990000-1111-2222-3333-444455556666";
const D1 = "77777777-7777-4777-8777-777777777777";

const GLOBAL_BODY =
  "Sehr geehrte Damen und Herren,\n\nhiermit bewerbe ich mich um eine Ausbildungsstelle. Anbei erhalten Sie meinen Lebenslauf und mein Anschreiben als PDF.\n\nMit freundlichen Grüßen\nMustapha Drif";
const GLOBAL_SUBJECT = "Bewerbung um eine Ausbildungsstelle";

/** Far-future schedule → durable attempt, never dispatched (no real email). */
const FUTURE = { timeZone: "Europe/Berlin", year: 2030, month: 6, day: 10, hour: 9, minute: 0 };

function extractFor(company: string, applicationEmail: string, jobTitle: string) {
  return {
    jobTitle,
    occupation: jobTitle,
    company,
    companyAddress: "",
    location: "",
    startDate: "",
    // NOTE: adExtractSchema types this as a STRING (default "") — null would
    // fail re-validation on read and silently null out the whole extract.
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
    contactPerson: "",
    applicationEmail,
    companyNotes: [],
    missingOrAmbiguous: [],
  };
}

function companyRow(id: string, company: string, email: string, job: string, over: Record<string, unknown> = {}) {
  return {
    id,
    user_id: USER,
    company,
    company_key: company.toLowerCase().replace(/[^a-z0-9]+/g, " "),
    slot_no: 1,
    ad_raw: "x".repeat(40),
    ad_extracted: extractFor(company, email, job),
    ad_analysis: null,
    profile_snapshot: null,
    status: "ready" as const,
    // LEGACY per-company values — deliberately different from the global
    // configuration: none of them may win over the global settings.
    recipient_email: "legacy-" + email,
    email_subject: "Legacy-Betreff",
    email_body: "LEGACY OVERRIDETEXT — must never be sent",
    email_attach_cv: true,
    email_attach_letter: true,
    email_account_id: "00000000-0000-4000-8000-000000000000",
    idempotency_key: null,
    approved: true,
    approved_at: "2026-12-01T10:00:00.000Z",
    scheduled_at: null,
    schedule_timezone: null,
    sent_at: null,
    provider_message_id: null,
    last_failure_code: null,
    ad_confirmed_at: "2026-12-01T10:00:00.000Z",
    cv_reviewed_at: null,
    letter_reviewed_at: null,
    created_at: "2026-12-01T00:00:00.000Z",
    updated_at: "2026-12-01T00:00:00.000Z",
    ...over,
  };
}

let db: StudioDb;

function seed(template: Record<string, unknown>) {
  db = createStudioDb({
    auto_bewerb_profiles: [],
    auto_bewerb_companies: [
      companyRow(CO1, "Kältebau Nord GmbH", "jobs@kaltbau-nord.de", "Anlagenmechaniker SHK"),
      companyRow(CO2, "Tech Süd AG", "bewerbung@tech-sued.de", "Fachinformatiker"),
      companyRow(CO3, "Heizungsbau Ost GmbH", "hr@heizung-ost.de", "Anlagenmechaniker SHK"),
    ],
    auto_bewerb_documents: [],
    auto_bewerb_attachments: [
      {
        id: D1,
        user_id: USER,
        display_name: "Abiturzeugnis.pdf",
        doc_category: "school_certificate",
        mime_type: "application/pdf",
        size_bytes: 1024,
        storage_path: `${USER}/auto-bewerb/docs/${D1}.pdf`,
        file_hash: "h1",
        created_at: "2026-12-01T00:00:00.000Z",
        updated_at: "2026-12-01T00:00:00.000Z",
      },
    ],
    auto_bewerb_company_attachments: [],
    auto_bewerb_email_templates: [{ user_id: USER, ...template }],
    auto_bewerb_send_attempts: [],
    email_accounts: [{ id: ACCT_ID, user_id: USER, provider: "gmail", email: "mail@example.de", is_active: true, requires_reconnect: false }],
    activity_logs: [],
    profiles: [],
  });
  (createAdminClient as ReturnType<typeof vi.fn>).mockReturnValue(db.admin);
}

function globalTemplate(over: Record<string, unknown> = {}) {
  return {
    body: GLOBAL_BODY,
    recipient: "",
    subject: GLOBAL_SUBJECT,
    account_id: ACCT_ID,
    attach_cv: false,
    attach_letter: false,
    ...over,
  };
}

function attempt(companyId: string) {
  const a = db.tables.auto_bewerb_send_attempts.find((r) => r.company_id === companyId) as
    | { payload: { text: string; html: string; attachments: Array<{ filename: string }> }; recipient_email: string; subject: string; scheduled_at: string | null }
    | undefined;
  expect(a, `attempt for ${companyId}`).toBeTruthy();
  return a!;
}

describe("one global configuration — functional (engine, fake DB, scheduled)", () => {
  it("3 companies (no manual recipient) → IDENTICAL subject/body/account; each keeps its VERIFIED ad address", async () => {
    seed(globalTemplate());
    // No manually stored recipient → the destination falls back to each
    // company's verified application email from its own ad:
    for (const r of db.tables.auto_bewerb_companies) r.recipient_email = null;
    for (const id of [CO1, CO2, CO3]) {
      const res = await prepareAutoBewerbSend(USER, { companyId: id, schedule: FUTURE });
      expect(res.ok, JSON.stringify(res)).toBe(true);
    }
    const a1 = attempt(CO1);
    const a2 = attempt(CO2);
    const a3 = attempt(CO3);
    // Identical shared content for everyone:
    expect(a1.payload.html).toBe(GLOBAL_BODY);
    expect(a2.payload.html).toBe(GLOBAL_BODY);
    expect(a3.payload.html).toBe(GLOBAL_BODY);
    expect(a1.subject).toBe(GLOBAL_SUBJECT);
    expect(a2.subject).toBe(GLOBAL_SUBJECT);
    expect(a3.subject).toBe(GLOBAL_SUBJECT);
    // The VERIFIED per-company delivery destination (from each ad) — each
    // company receives its application at ITS OWN address:
    expect(a1.recipient_email).toBe("jobs@kaltbau-nord.de");
    expect(a2.recipient_email).toBe("bewerbung@tech-sued.de");
    expect(a3.recipient_email).toBe("hr@heizung-ost.de");
    // NEVER to one company's address — all three pairwise distinct:
    expect(a2.recipient_email).not.toBe(a1.recipient_email);
    expect(a3.recipient_email).not.toBe(a1.recipient_email);
    expect(a3.recipient_email).not.toBe(a2.recipient_email);
    expect(new Set([a1, a2, a3].map((a) => a.recipient_email)).size).toBe(3);
    // Shared attachment settings (global flags off → only the library doc):
    for (const a of [a1, a2, a3]) {
      expect(a.payload.attachments.map((x) => x.filename)).toEqual(["Abiturzeugnis.pdf"]);
    }
  });

  it("legacy per-company CONFIG values (subject/account/override) NEVER win over the global config", async () => {
    seed(globalTemplate());
    // The row carries legacy values (incl. a stored body override):
    expect(db.tables.auto_bewerb_companies[0].email_body).toBe("LEGACY OVERRIDETEXT — must never be sent");
    const res = await prepareAutoBewerbSend(USER, { companyId: CO1, schedule: FUTURE });
    expect(res.ok).toBe(true);
    const a = attempt(CO1);
    // Global content wins over every legacy config value:
    expect(a.subject).toBe(GLOBAL_SUBJECT);
    expect(a.subject).not.toBe("Legacy-Betreff");
    expect(a.payload.html).toBe(GLOBAL_BODY);
    expect(a.payload.text).not.toContain("LEGACY OVERRIDETEXT");
    // But the legacy recipient is a preserved per-company DELIVERY
    // destination (user-entered earlier) — it is honored, never overwritten:
    expect(a.recipient_email).toBe("legacy-jobs@kaltbau-nord.de");
    // The legacy override column is cleared on send preparation:
    const row = db.tables.auto_bewerb_companies.find((r) => r.id === CO1);
    expect(row?.email_body).toBeNull();
  });

  it("an EXPLICIT global recipient is delivered to ALL companies", async () => {
    seed(globalTemplate({ recipient: " Zentral@Postbox.de " }));
    for (const id of [CO1, CO2, CO3]) {
      const res = await prepareAutoBewerbSend(USER, { companyId: id, schedule: FUTURE });
      expect(res.ok).toBe(true);
    }
    for (const id of [CO1, CO2, CO3]) {
      expect(attempt(id).recipient_email).toBe("zentral@postbox.de");
    }
  });

  it("a NEWLY ADDED company uses the global configuration automatically", async () => {
    seed(globalTemplate());
    // The company joins AFTER the configuration was saved (no manual
    // recipient → its verified ad address is the destination):
    db.tables.auto_bewerb_companies.push(
      companyRow(CO_NEW, "Neu GmbH", "neu@neu-gmbh.de", "Elektroniker", { recipient_email: null }),
    );
    const res = await prepareAutoBewerbSend(USER, { companyId: CO_NEW, schedule: FUTURE });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const a = attempt(CO_NEW);
    expect(a.payload.html).toBe(GLOBAL_BODY);
    expect(a.subject).toBe(GLOBAL_SUBJECT);
    expect(a.recipient_email).toBe("neu@neu-gmbh.de");
  });

  it("a company WITHOUT any verifiable address is refused (nothing invented)", async () => {
    seed(globalTemplate());
    db.tables.auto_bewerb_companies.push(companyRow(CO_NEW, "OhneMail GmbH", "", "Elektroniker", { recipient_email: null }));
    const res = await prepareAutoBewerbSend(USER, { companyId: CO_NEW, schedule: FUTURE });
    expect(res.ok).toBe(false);
    expect((res as { code?: string }).code).toBe("invalid_recipient");
  });

  it("SCHEDULED sends carry the same global configuration (no separate path)", async () => {
    seed(globalTemplate());
    const res = await prepareAutoBewerbSend(USER, { companyId: CO2, schedule: FUTURE });
    expect(res.ok).toBe(true);
    const a = attempt(CO2);
    expect(a.scheduled_at).toBeTruthy();
    expect(a.payload.html).toBe(GLOBAL_BODY);
    expect(a.subject).toBe(GLOBAL_SUBJECT);
  });
});

// ---------------------------------------------------------------------------
// Per-company CV + cover-letter attachments (global FLAGS, OWN documents)
//
// The global attach_cv / attach_letter flags decide WHETHER those document
// categories are attached, but the actual files are always resolved from the
// company's OWN stored documents + a company-scoped storage path. A company
// without the document is BLOCKED (never silently sent without it, never fed
// another company's document).
// ---------------------------------------------------------------------------

const CV_FULL_NAME = "Mustapha Drif";
const CV_PDF_NAME = "Lebenslauf_Mustapha_Drif.pdf";
const BUCKET = "application-attachments";

/** A valid, company-tailored CV document (renders deterministically). */
function cvDocFor(company: string, marker: string) {
  const cv = cvEmpty();
  cv.personal = {
    ...cv.personal,
    fullName: CV_FULL_NAME,
    professionalTitle: `Auszubildende:r — ${company}`,
    email: "mustapha.drif@example.de",
    phone: "+49 151 23456789",
    location: "Hamburg, Deutschland",
  };
  cv.summary = `Maßgeschneiderte Zusammenfassung für ${company} (${marker}).`;
  cv.skills = ["Schaltpläne lesen", "Montage", marker];
  cv.languages = [{ id: "l1", language: "Deutsch", level: "C1" }];
  return cv;
}

/** A valid, company-tailored cover letter (autoBewerbLetterSchema-compliant). */
function letterDocFor(company: string, marker: string) {
  return {
    text:
      `Sehr geehrte Damen und Herren, hiermit bewerbe ich mich bei ${company} (${marker}). ` +
      "Ich freue mich auf Ihre Rückmeldung und stehe einem persönlichen Gespräch jederzeit gerne zur Verfügung. Mit freundlichen Grüßen Mustapha Drif",
    tone: "professional" as const,
  };
}

/** Seed one CV + one cover-letter document for a company (version 1). */
function seedCompanyDocs(companyId: string, company: string, marker: string) {
  const ts = "2026-12-01T00:00:00.000Z";
  db.tables.auto_bewerb_documents.push(
    { id: `cv-${companyId}`, user_id: USER, company_id: companyId, doc_type: "cv", version: 1, content: cvDocFor(company, marker), created_at: ts, updated_at: ts },
    { id: `letter-${companyId}`, user_id: USER, company_id: companyId, doc_type: "cover_letter", version: 1, content: letterDocFor(company, marker), created_at: ts, updated_at: ts },
  );
}

const ATTACH_ON = globalTemplate({ attach_cv: true, attach_letter: true });

function fullAttempt(companyId: string) {
  const a = db.tables.auto_bewerb_send_attempts.find((r) => r.company_id === companyId) as
    | { payload: { text: string; html: string; attachments: Array<{ filename: string; mimeType: string; storagePath: string }> }; recipient_email: string; subject: string; scheduled_at: string | null }
    | undefined;
  expect(a, `attempt for ${companyId}`).toBeTruthy();
  return a!;
}

async function storageBytes(path: string): Promise<Uint8Array> {
  const { data } = (await db.admin.storage.from(BUCKET).download(path)) as { data: Blob | null };
  expect(data, `stored object at ${path}`).toBeTruthy();
  return new Uint8Array(await (data as Blob).arrayBuffer());
}
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

describe("per-company CV + cover-letter attachments (global flags, own documents)", () => {
  it("3 companies → 3 OWN CVs + 3 OWN letters; identical subject/body; shared doc in all; no cross-company leakage", async () => {
    seed(ATTACH_ON);
    seedCompanyDocs(CO1, "Kältebau Nord GmbH", "kaltbau");
    seedCompanyDocs(CO2, "Tech Süd AG", "techsued");
    seedCompanyDocs(CO3, "Heizungsbau Ost GmbH", "heizung");
    for (const r of db.tables.auto_bewerb_companies) r.recipient_email = null; // verified ad address
    for (const id of [CO1, CO2, CO3]) {
      const res = await prepareAutoBewerbSend(USER, { companyId: id, schedule: FUTURE });
      expect(res.ok, JSON.stringify(res)).toBe(true);
    }
    const a1 = fullAttempt(CO1);
    const a2 = fullAttempt(CO2);
    const a3 = fullAttempt(CO3);

    // (3) Identical shared content for everyone:
    for (const a of [a1, a2, a3]) {
      expect(a.payload.html).toBe(GLOBAL_BODY);
      expect(a.subject).toBe(GLOBAL_SUBJECT);
    }

    const cvOf = (a: typeof a1) => a.payload.attachments.find((x) => x.filename === CV_PDF_NAME);
    const letterOf = (a: typeof a1) => a.payload.attachments.find((x) => x.filename.startsWith("Anschreiben_"));

    // (1) Each company's OWN CV at its OWN company-scoped path:
    expect(cvOf(a1)!.storagePath).toBe(`auto-bewerb/cv/${USER}/${CO1}.pdf`);
    expect(cvOf(a2)!.storagePath).toBe(`auto-bewerb/cv/${USER}/${CO2}.pdf`);
    expect(cvOf(a3)!.storagePath).toBe(`auto-bewerb/cv/${USER}/${CO3}.pdf`);

    // (2) Each company's OWN letter at its OWN company-scoped path, all distinct:
    expect(letterOf(a1)!.storagePath).toBe(`auto-bewerb/letter/${USER}/${CO1}.pdf`);
    expect(letterOf(a2)!.storagePath).toBe(`auto-bewerb/letter/${USER}/${CO2}.pdf`);
    expect(letterOf(a3)!.storagePath).toBe(`auto-bewerb/letter/${USER}/${CO3}.pdf`);
    expect(new Set([letterOf(a1)!.filename, letterOf(a2)!.filename, letterOf(a3)!.filename]).size).toBe(3);

    // (1b) The three tailored CVs are genuinely DIFFERENT files (distinct bytes):
    const b1 = b64(await storageBytes(`auto-bewerb/cv/${USER}/${CO1}.pdf`));
    const b2 = b64(await storageBytes(`auto-bewerb/cv/${USER}/${CO2}.pdf`));
    const b3 = b64(await storageBytes(`auto-bewerb/cv/${USER}/${CO3}.pdf`));
    expect(new Set([b1, b2, b3]).size).toBe(3);

    // (4) The shared supporting document is attached to EVERY attempt:
    for (const a of [a1, a2, a3]) {
      expect(a.payload.attachments.map((x) => x.filename)).toContain("Abiturzeugnis.pdf");
    }

    // (5) NO cross-company leakage: every company-specific attachment references
    //     ONLY its own company id in the storage path.
    for (const [a, id] of [
      [a1, CO1],
      [a2, CO2],
      [a3, CO3],
    ] as const) {
      for (const att of a.payload.attachments) {
        if (att.storagePath.startsWith("auto-bewerb/cv/") || att.storagePath.startsWith("auto-bewerb/letter/")) {
          expect(att.storagePath.endsWith(`/${id}.pdf`)).toBe(true);
        }
      }
    }
  });

  it("missing CV blocks ONLY that company (missing_cv); the others still attach their own CV", async () => {
    seed(ATTACH_ON);
    seedCompanyDocs(CO1, "Kältebau Nord GmbH", "kaltbau");
    seedCompanyDocs(CO2, "Tech Süd AG", "techsued");
    const ts = "2026-12-01T00:00:00.000Z";
    // CO3 has a cover letter but NO CV:
    db.tables.auto_bewerb_documents.push({
      id: `letter-${CO3}`, user_id: USER, company_id: CO3, doc_type: "cover_letter", version: 1,
      content: letterDocFor("Heizungsbau Ost GmbH", "heizung"), created_at: ts, updated_at: ts,
    });
    for (const r of db.tables.auto_bewerb_companies) r.recipient_email = null;
    const res3 = await prepareAutoBewerbSend(USER, { companyId: CO3, schedule: FUTURE });
    expect(res3.ok).toBe(false);
    expect((res3 as { code?: string }).code).toBe("missing_cv");
    // No attempt was created for the blocked company:
    expect(db.tables.auto_bewerb_send_attempts.find((r) => r.company_id === CO3)).toBeUndefined();
    // The other two are unaffected and attach their own CVs:
    expect((await prepareAutoBewerbSend(USER, { companyId: CO1, schedule: FUTURE })).ok).toBe(true);
    expect((await prepareAutoBewerbSend(USER, { companyId: CO2, schedule: FUTURE })).ok).toBe(true);
    expect(fullAttempt(CO1).payload.attachments.map((x) => x.filename)).toContain(CV_PDF_NAME);
    expect(fullAttempt(CO2).payload.attachments.map((x) => x.filename)).toContain(CV_PDF_NAME);
  });

  it("missing cover letter blocks ONLY that company (missing_letter)", async () => {
    seed(ATTACH_ON);
    seedCompanyDocs(CO1, "Kältebau Nord GmbH", "kaltbau");
    const ts = "2026-12-01T00:00:00.000Z";
    // CO2 has a CV but NO cover letter:
    db.tables.auto_bewerb_documents.push({
      id: `cv-${CO2}`, user_id: USER, company_id: CO2, doc_type: "cv", version: 1,
      content: cvDocFor("Tech Süd AG", "techsued"), created_at: ts, updated_at: ts,
    });
    for (const r of db.tables.auto_bewerb_companies) r.recipient_email = null;
    const res2 = await prepareAutoBewerbSend(USER, { companyId: CO2, schedule: FUTURE });
    expect(res2.ok).toBe(false);
    expect((res2 as { code?: string }).code).toBe("missing_letter");
    expect(db.tables.auto_bewerb_send_attempts.find((r) => r.company_id === CO2)).toBeUndefined();
    // CO1 (has both) is unaffected:
    expect((await prepareAutoBewerbSend(USER, { companyId: CO1, schedule: FUTURE })).ok).toBe(true);
  });

  it("SCHEDULED attempts preserve company-specific attachments (no separate path)", async () => {
    seed(ATTACH_ON);
    seedCompanyDocs(CO1, "Kältebau Nord GmbH", "kaltbau");
    seedCompanyDocs(CO2, "Tech Süd AG", "techsued");
    for (const r of db.tables.auto_bewerb_companies) r.recipient_email = null;
    await prepareAutoBewerbSend(USER, { companyId: CO1, schedule: FUTURE });
    await prepareAutoBewerbSend(USER, { companyId: CO2, schedule: FUTURE });
    const a1 = fullAttempt(CO1);
    const a2 = fullAttempt(CO2);
    expect(a1.scheduled_at).toBeTruthy();
    expect(a2.scheduled_at).toBeTruthy();
    // The frozen scheduled payload carries each company's OWN scoped paths:
    expect(a1.payload.attachments.find((x) => x.filename === CV_PDF_NAME)!.storagePath).toBe(`auto-bewerb/cv/${USER}/${CO1}.pdf`);
    expect(a2.payload.attachments.find((x) => x.filename === CV_PDF_NAME)!.storagePath).toBe(`auto-bewerb/cv/${USER}/${CO2}.pdf`);
    expect(a1.payload.attachments.find((x) => x.filename.startsWith("Anschreiben_"))!.storagePath).toBe(`auto-bewerb/letter/${USER}/${CO1}.pdf`);
    expect(a2.payload.attachments.find((x) => x.filename.startsWith("Anschreiben_"))!.storagePath).toBe(`auto-bewerb/letter/${USER}/${CO2}.pdf`);
    // ...with the SAME global subject/body:
    expect(a1.subject).toBe(GLOBAL_SUBJECT);
    expect(a2.subject).toBe(GLOBAL_SUBJECT);
    expect(a1.payload.text).toBe(a2.payload.text);
  });

  it("toggling attach flags OFF removes CV/letter without changing document ownership", async () => {
    seed(globalTemplate({ attach_cv: false, attach_letter: false }));
    seedCompanyDocs(CO1, "Kältebau Nord GmbH", "kaltbau");
    for (const r of db.tables.auto_bewerb_companies) r.recipient_email = null;
    const res = await prepareAutoBewerbSend(USER, { companyId: CO1, schedule: FUTURE });
    expect(res.ok).toBe(true);
    const a = fullAttempt(CO1);
    // Only the shared supporting document — no CV, no letter:
    expect(a.payload.attachments.map((x) => x.filename)).toEqual(["Abiturzeugnis.pdf"]);
    // The company's documents remain stored, ownership unchanged:
    expect(db.tables.auto_bewerb_documents.filter((d) => d.company_id === CO1).length).toBe(2);
  });

  it("no duplicate attachments within one mail (dedupe by real storage path + filename)", async () => {
    seed(ATTACH_ON);
    seedCompanyDocs(CO1, "Kältebau Nord GmbH", "kaltbau");
    for (const r of db.tables.auto_bewerb_companies) r.recipient_email = null;
    const res = await prepareAutoBewerbSend(USER, { companyId: CO1, schedule: FUTURE });
    expect(res.ok).toBe(true);
    const a = fullAttempt(CO1);
    const paths = a.payload.attachments.map((x) => x.storagePath);
    const names = a.payload.attachments.map((x) => x.filename);
    expect(new Set(paths).size).toBe(paths.length);
    expect(new Set(names).size).toBe(names.length);
    // Exactly cv + letter + the one shared library doc — real PDFs, no
    // temp/preview/thumbnail/system files:
    expect(paths).toHaveLength(3);
    for (const p of paths) {
      expect(p).toMatch(/\.pdf$/);
      expect(p).not.toMatch(/temp|preview|thumb/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Per-recipient personalization — ONE shared template, tokens substituted
// from VERIFIED data only (missing → empty, never invented, no leftovers)
// ---------------------------------------------------------------------------

const PERSONA_SUBJECT = "Bewerbung um einen Ausbildungsplatz – {{position}}";
const PERSONA_BODY =
  "<p>{{greeting}}</p><p>hiermit bewerbe ich mich bei {{company_name}} als {{position}}.</p><p>Mit freundlichen Grüßen</p><p>{{candidate_name}}</p>";

describe("per-recipient personalization (shared template, verified data only)", () => {
  it("3 companies → each gets ITS OWN position/company/greeting; candidate name identical; no placeholder survives", async () => {
    seed(globalTemplate({ subject: PERSONA_SUBJECT, body: PERSONA_BODY }));
    db.tables.profiles.push({ id: USER, full_name: "Mustapha Drif" } as never);
    // CO2's ad names a contact person → its greeting is personalized:
    const row2 = db.tables.auto_bewerb_companies.find((r) => r.id === CO2)! as { ad_extracted: { contactPerson: string } };
    row2.ad_extracted.contactPerson = "Frau Müller";
    for (const r of db.tables.auto_bewerb_companies) r.recipient_email = null;
    for (const id of [CO1, CO2, CO3]) {
      const res = await prepareAutoBewerbSend(USER, { companyId: id, schedule: FUTURE });
      expect(res.ok, JSON.stringify(res)).toBe(true);
    }
    const a1 = fullAttempt(CO1);
    const a2 = fullAttempt(CO2);
    const a3 = fullAttempt(CO3);
    // Subject: the SAME template, each with its OWN position:
    expect(a1.subject).toBe("Bewerbung um einen Ausbildungsplatz – Anlagenmechaniker SHK");
    expect(a2.subject).toBe("Bewerbung um einen Ausbildungsplatz – Fachinformatiker");
    expect(a3.subject).toBe("Bewerbung um einen Ausbildungsplatz – Anlagenmechaniker SHK");
    // Body: company + position personalized per recipient:
    expect(a1.payload.html).toContain("bei Kältebau Nord GmbH als Anlagenmechaniker SHK");
    expect(a2.payload.html).toContain("bei Tech Süd AG als Fachinformatiker");
    expect(a3.payload.html).toContain("bei Heizungsbau Ost GmbH als Anlagenmechaniker SHK");
    // Greeting: verified contact person when available, neutral default otherwise:
    expect(a1.payload.html).toContain("Sehr geehrte Damen und Herren,");
    expect(a2.payload.html).toContain("Sehr geehrte/r Frau Müller,");
    expect(a3.payload.html).toContain("Sehr geehrte Damen und Herren,");
    // Candidate name (from the profile) is the SAME for everyone; no
    // placeholder survives in the HTML or the text part:
    for (const a of [a1, a2, a3]) {
      expect(a.payload.html).toContain("Mustapha Drif");
      expect(a.payload.html).not.toContain("{{");
      expect(a.payload.text).not.toContain("{{");
    }
    expect(a2.payload.text).toContain("Tech Süd AG");
    expect(a2.payload.text).toContain("Frau Müller");
  });

  it("no profile row → candidate_name renders EMPTY (never invented, no leftover)", async () => {
    seed(globalTemplate({ subject: PERSONA_SUBJECT, body: PERSONA_BODY }));
    for (const r of db.tables.auto_bewerb_companies) r.recipient_email = null;
    const res = await prepareAutoBewerbSend(USER, { companyId: CO1, schedule: FUTURE });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const a = fullAttempt(CO1);
    expect(a.payload.html).not.toContain("{{");
    expect(a.payload.html).not.toContain("undefined");
    // The verified default greeting is still present:
    expect(a.payload.html).toContain("Sehr geehrte Damen und Herren,");
  });
});

// ---------------------------------------------------------------------------
// HTML sanitization — pure allowlist, on save (actions) and on send (engine)
// ---------------------------------------------------------------------------

describe("HTML sanitization (save + send + pure)", () => {
  it("the pure allowlist strips scripts/handlers/dangerous URLs, keeps formatting + safe links", () => {
    const out = sanitizeEmailHtml(
      '<p onclick="x()">hi</p><script>alert(1)</script><img src=x onerror=alert(1)>' +
        '<a href="javascript:alert(1)">bad</a><a href="https://ok.de">good</a><ul><li>one</li></ul><strong>b</strong>',
    );
    expect(out).not.toContain("<script");
    expect(out).not.toContain("onclick");
    expect(out).not.toContain("onerror");
    expect(out).not.toContain("<img");
    expect(out).not.toContain("javascript:");
    expect(out).toContain("hi");
    expect(out).toContain('<a href="https://ok.de"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain("noopener");
    expect(out).toContain("<li>one</li>");
    expect(out).toContain("<strong>b</strong>");
    expect(htmlToText(out)).not.toContain("<");
  });

  it("the SAVE actions persist sanitized HTML (template + settings saves)", async () => {
    seed(globalTemplate());
    (createClient as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      ...db.admin,
      auth: { getUser: async () => ({ data: { user: { id: USER } } }) },
    }));
    const evil = '<p onclick="x()">hallo</p><script>evil()</script><a href="javascript:alert(1)">x</a><a href="https://ok.de">link</a>';
    const r1 = await saveEmailTemplateAction(evil);
    expect(r1.ok).toBe(true);
    let saved = String(db.tables.auto_bewerb_email_templates[0].body);
    expect(saved).not.toContain("<script");
    expect(saved).not.toContain("onclick");
    expect(saved).not.toContain("javascript:");
    expect(saved).toContain("hallo");
    expect(saved).toContain("https://ok.de");

    const r2 = await saveEmailSettingsAction({
      body: evil,
      recipient: "",
      subject: "Bewerbung – {{position}}",
      accountId: ACCT_ID,
      attachCv: false,
      attachLetter: false,
    });
    expect(r2.ok).toBe(true);
    saved = String(db.tables.auto_bewerb_email_templates[0].body);
    expect(saved).not.toContain("<script");
    expect(saved).not.toContain("onclick");
    expect(saved).not.toContain("javascript:");
  });

  it("the SEND path re-sanitizes (defense in depth): a hostile stored body never reaches the payload", async () => {
    seed(globalTemplate({ body: "<p>hallo</p><script>evil()</script><img src=x onerror=alert(1)>" }));
    for (const r of db.tables.auto_bewerb_companies) r.recipient_email = null;
    const res = await prepareAutoBewerbSend(USER, { companyId: CO1, schedule: FUTURE });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const a = fullAttempt(CO1);
    expect(a.payload.html).not.toContain("<script");
    expect(a.payload.html).not.toContain("onerror");
    expect(a.payload.html).not.toContain("<img");
    expect(a.payload.html).toContain("hallo");
    expect(a.payload.text).not.toContain("<");
  });
});

// ---------------------------------------------------------------------------
// Pure recipient resolution — one global setting, N companies
// ---------------------------------------------------------------------------

describe("resolveAutoBewerbRecipient (pure)", () => {
  it("5 and 10 companies resolve deterministically — verified address per company", () => {
    const emails = Array.from({ length: 10 }, (_, i) => `a${i + 1}@firma-${i + 1}.de`);
    const resolved = emails.map((e) => resolveAutoBewerbRecipient("", null, extractFor("X", e, "Y")));
    expect(new Set(resolved).size).toBe(10);
    expect(resolved.slice(0, 5)).toEqual(emails.slice(0, 5));
  });
  it("a set global recipient → the same destination for all 10", () => {
    const resolved = Array.from({ length: 10 }, (_, i) =>
      resolveAutoBewerbRecipient("all@one.de", `legacy${i}@x.de`, extractFor("X", `a${i}@b.de`, "Y")),
    );
    expect(new Set(resolved).size).toBe(1);
    expect(resolved[0]).toBe("all@one.de");
  });
});

// ---------------------------------------------------------------------------
// Source contracts — exactly ONE source of truth, no substitution
// ---------------------------------------------------------------------------

describe("single global configuration (source contracts)", () => {
  it("the engine resolves EVERYTHING from the global settings (no client/company override)", () => {
    expect(ENGINE).toContain("const settings = await getAutoBewerbEmailSettings(userId);");
    expect(ENGINE).toContain("resolveAutoBewerbRecipient(settings.recipient, app.recipient_email, app.ad_extracted)");
    expect(ENGINE).toContain("subject = settings.subject.trim().slice(0, 200);");
    expect(ENGINE).toContain("accountId = settings.accountId;");
    expect(ENGINE).toContain("attachCv = settings.attachCv;");
    expect(ENGINE).toContain("attachLetter = settings.attachLetter;");
    // The legacy column is only ever written as null (never read):
    expect(ENGINE).toContain("email_body: null,");
    expect(ENGINE).not.toContain("app.email_body");
    // No per-company settings can come from the client:
    expect(ENGINE).not.toContain("input.recipientEmail");
    expect(ENGINE).not.toContain("input.emailAccountId");
    expect(ENGINE).not.toContain("input.subject");
    expect(ENGINE).not.toContain("input.attachCv");
    expect(ENGINE).not.toContain("bodyOverride");
    // No token substitution anywhere in the send path:
    expect(ENGINE).not.toContain("renderAutoBewerbEmailBody");
  });

  it("CV/letter attachments resolve PER COMPANY and BLOCK the send when missing (never silent)", () => {
    // Resolution is strictly company-scoped — never a global document reference:
    expect(ENGINE).toContain("getLatestAutoBewerbCv(userId, app.id)");
    expect(ENGINE).toContain("getLatestAutoBewerbDocument(userId, app.id, \"cover_letter\")");
    expect(ENGINE).toContain("autoBewerbCvPdfStoragePath(userId, app.id)");
    expect(ENGINE).toContain("autoBewerbLetterPdfStoragePath(userId, app.id)");
    // A missing/unrenderable document blocks this company (no silent drop, no substitution):
    expect(ENGINE).toContain("code: \"missing_cv\"");
    expect(ENGINE).toContain("code: \"missing_letter\"");
    expect(ENGINE).toContain("code: \"cv_render_failed\"");
    expect(ENGINE).toContain("code: \"letter_render_failed\"");
  });

  it("the schema is the single source of truth for tokens, substitution, greeting + defaults", () => {
    expect(SCHEMA).toContain("export const AUTO_BEWERB_EMAIL_TOKENS");
    expect(SCHEMA).toContain("export function substituteEmailTokens");
    expect(SCHEMA).toContain("export function buildAutoBewerbGreeting");
    expect(SCHEMA).toContain("export const AUTO_BEWERB_EMAIL_DEFAULT_SUBJECT");
    expect(SCHEMA).toContain("export const AUTO_BEWERB_EMAIL_DEFAULT_BODY");
    expect(SCHEMA).toContain("export function resolveAutoBewerbRecipient");
    expect(SCHEMA).not.toContain("renderAutoBewerbEmailBody");
    // The concise default subject from the spec:
    expect(SCHEMA).toContain("Bewerbung um einen Ausbildungsplatz – {{position}}");
  });

  it("Step 6 UI: rich-text editor + live preview + manifest; one global Save; no per-company email save path", () => {
    expect(STEP6).toContain("saveEmailSettingsAction");
    expect(STEP6).toContain("resolveAutoBewerbRecipient");
    expect(STEP6).toContain("ws.emailSettingsSupported");
    // The professional rich-text editor + the attachment manifest:
    expect(STEP6).toContain("EmailRichEditor");
    expect(STEP6).toContain("AttachmentManifest");
    // Client-side sanitization + personalization power the live preview:
    expect(STEP6).toContain("sanitizeEmailHtml");
    expect(STEP6).toContain("substituteEmailTokens");
    expect(STEP6).toContain("buildAutoBewerbGreeting");
    // The concise default German e-mail is pre-filled:
    expect(STEP6).toContain("AUTO_BEWERB_EMAIL_DEFAULT_BODY");
    expect(STEP6).toContain("AUTO_BEWERB_EMAIL_DEFAULT_SUBJECT");
    expect(STEP6).not.toContain("renderAutoBewerbEmailBody");
    expect(STEP6).not.toContain("updateCompanyAction"); // no per-company email save path
  });

  it("the global-recipient override is EXPLICIT everywhere (Step 6 warning + Step 7 banner/modal) — never silent", () => {
    // The field itself announces the override semantics:
    expect(STEP6).toContain('label={t("autoBewerb.globalRecipientLabel")}');
    // Step 6: a prominent warning renders ONLY while a recipient is set:
    expect(STEP6).toContain("globalRecipientOverrideWarning");
    expect(STEP6).toMatch(/recipient\.trim\(\)\s*!==\s*""/);
    // Step 7: the override is named in the review AND the confirmation modal:
    expect(STEP7).toContain("globalRecipientStep7Note");
    expect(STEP7).toMatch(/s\.recipient\.trim\(\)\s*!==\s*""/);
    expect(STEP7.match(/globalRecipientStep7Note/g)!.length).toBe(2);
    // The disclosure texts exist in all four languages:
    for (const key of ["globalRecipientOverrideWarning", "globalRecipientStep7Note"]) {
      expect(DICT.match(new RegExp(key + ":", "g"))!.length).toBe(4);
    }
    // Default routing (empty field) stays per-company verified:
    expect(SCHEMA).toContain("if (legacy) return legacy;");
    expect(SCHEMA).toContain("applicationEmail");
  });

  it("Step 7: inputs are company ids + confirmation only; the modal shows the exact shared config + per-company destination", () => {
    expect(STEP7).toContain("selectedViews.map((v) => ({ companyId: v.company.id, confirmed: true }))");
    expect(STEP7).not.toContain("recipientEmail");
    expect(STEP7).not.toContain("emailAccountId");
    expect(STEP7).not.toContain("renderAutoBewerbEmailBody");
    // The confirmation shows the shared body VERBATIM + the resolved destination:
    expect(STEP7).toContain("resolveAutoBewerbRecipient(s.recipient, r.recipient_email, r.ad_extracted)");
    expect(STEP7).toContain("t(\"autoBewerb.globalPreviewTitle\")");
    expect(STEP7).toContain("t(\"autoBewerb.previewCount\"");
  });

  it("server actions: no per-company e-mail fields anywhere", () => {
    expect(ACTIONS).not.toContain("bodyOverride");
    expect(ACTIONS).not.toContain("emailBody");
    expect(ACTIONS).not.toContain("recipientEmail");
    expect(ACTIONS).not.toContain("emailAccountId");
    expect(ACTIONS).toContain("saveEmailSettingsAction");
    // Both the immediate and the scheduled path pass only companyId (+ schedule):
    expect(ACTIONS).toContain("companyId: input.companyId,\n      schedule: input.schedule ?? null,");
    // The rich-text body is sanitized before persisting (the save path):
    expect(ACTIONS).toContain("sanitizeEmailHtml");
  });

  it("the i18n dictionaries have no token keys and document the global configuration", () => {
    expect(DICT).not.toContain("tokenCompany");
    expect(DICT).not.toContain("tokenPosition");
    expect(DICT).not.toContain("tokenContact");
    expect(DICT).toContain("emailSettingsTitle");
    expect(DICT).toContain("globalRecipientHint");
    expect(DICT).toContain("deliveryListTitle");
  });
});

// ---------------------------------------------------------------------------
// AI prompt — shared, company-neutral; ONLY the supported tokens allowed
// ---------------------------------------------------------------------------

describe("buildAutoBewerbEmailTemplatePrompt (shared template, supported tokens only)", () => {
  it("allows ONLY the supported tokens — no hard-coded company names", () => {
    const p = buildAutoBewerbEmailTemplatePrompt({ sharedAttachmentNames: [] });
    for (const token of ["{{company_name}}", "{{position}}", "{{contact_person}}", "{{greeting}}", "{{candidate_name}}"]) {
      expect(p).toContain(token);
    }
    expect(p).not.toContain("{company} →");
    expect(p).not.toContain("{position} →");
    expect(p).not.toContain("{contactName} →");
    expect(p).not.toContain("EXAKT denselben Text");
    expect(p).not.toContain("KEIN Platzhalter");
  });

  it("keeps the no-invention rules and the attachment contract", () => {
    const p = buildAutoBewerbEmailTemplatePrompt({ sharedAttachmentNames: ["Abiturzeugnis.pdf"] });
    expect(p).toContain("Erfinde NIEMALS");
    expect(p).toContain("Lebenslauf als PDF");
    expect(p).toContain("Anschreiben als PDF");
    expect(p).toContain("Abiturzeugnis.pdf");
    expect(p).toContain('{ "subject": string, "body": string }');
  });
});

// ---------------------------------------------------------------------------
// The generate-email route (global, metered, honest)
// ---------------------------------------------------------------------------

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
  subject: "Bewerbung um eine Ausbildungsstelle",
  body: "Sehr geehrte Damen und Herren,\n\nhiermit bewerbe ich mich um eine Ausbildungsstelle. Anbei erhalten Sie meinen Lebenslauf und mein Anschreiben als PDF.\n\nMit freundlichen Grüßen\nMustapha Drif",
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

describe("generate-email route (global, metered)", () => {
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

  it("success → 200 {subject, body} + the reservation is COMPLETED", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    const data = (await res.json()) as { subject: string; body: string };
    expect(data.subject).toBe("Bewerbung um eine Ausbildungsstelle");
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

  it("NO company input needed — the prompt is shared, token-aware, profile-grounded", async () => {
    await post({ attachmentNames: ["Abiturzeugnis.pdf"] });
    const p = lastPrompt();
    expect(p).not.toContain("{company} →");
    expect(p).toContain("Erfinde NIEMALS");
    expect(p).toContain("Kältebau Nord GmbH"); // the verified profile grounds the motivation
    expect(p).toContain("Abiturzeugnis.pdf");
  });

  it("missing profile → the prompt marks it unavailable (never invents)", async () => {
    (getAutoBewerbProfile as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await post();
    expect(lastPrompt()).toContain("KANDIDATENPROFIL: nicht verfügbar");
  });
});
