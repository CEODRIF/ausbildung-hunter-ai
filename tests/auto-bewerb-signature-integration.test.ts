/**
 * AUTO BEWERB — GLOBAL signature → generated Anschreiben PDF INTEGRATION.
 *
 * Complements tests/auto-bewerb-signature.test.ts (which builds folios
 * manually around the renderer) by exercising the REAL send pipeline
 * (prepareAutoBewerbSend, in-memory DB, real pdf-lib rendering) end to end:
 *
 *   upload signature (Step 1) → individual send → stored letter PDF carries
 *   the embedded image; bulk send → EVERY company's stored letter PDF carries
 *   the SAME global signature; no signature → text-only closing (no fake
 *   image); replace/delete update the next rendered PDFs; CV PDFs NEVER
 *   contain the signature; another user's signature is never embedded.
 *
 * The stored letter PDF bytes are read back from the in-memory storage mock
 * (the exact objects the e-mail attachment path would send).
 */
import { describe, expect, it, vi } from "vitest";
import type { StudioDb } from "./helpers-studio";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/email-providers", () => ({ createEmailProvider: vi.fn() }));

const { createAdminClient } = await import("@/lib/supabase/admin");
const {
  deleteAutoBewerbSignature,
  prepareAutoBewerbSend,
  uploadAutoBewerbSignature,
} = await import("@/lib/auto-bewerb/engine");
const { createStudioDb } = await import("./helpers-studio");
const { cvEmpty } = await import("@/lib/templates/cv");

const USER = "11111111-1111-4111-8111-111111111111";
const USER_B = "99999999-9999-4999-8999-999999999999";
const CO1 = "44444444-4444-4444-8444-444444444444";
const CO2 = "55555555-5555-4555-8555-555555555555";
const CO3 = "66666666-6666-4666-8666-666666666666";
const ACCT_ID = "33333333-3333-4333-8333-333333333333";
const ACCT_B = "33333333-3333-4333-8333-333333333999";
const D1 = "77777777-7777-4777-8777-777777777777";
const BUCKET = "application-attachments";

/** A VALID 1×1 black PNG — pdf-lib decodes it to embed (magic bytes alone
 *  would pass validation but not embedding). */
const VALID_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
/** A VALID 1×1 JPEG (baseline, 1 byte per component). */
const VALID_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==",
  "base64",
);

/** pdf-lib writes `/Subtype /Image` for every embedded image XObject. */
const hasImage = (bytes: Uint8Array): boolean =>
  Buffer.from(bytes).toString("latin1").includes("/Subtype /Image");

const FUTURE = { timeZone: "Europe/Berlin", year: 2030, month: 6, day: 10, hour: 9, minute: 0 };

function extractFor(company: string, applicationEmail: string, jobTitle: string) {
  return {
    jobTitle,
    occupation: jobTitle,
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
    contactPerson: "",
    applicationEmail,
    companyNotes: [],
    missingOrAmbiguous: [],
  };
}

function companyRow(id: string, company: string, email: string, job: string) {
  const ts = "2026-12-01T00:00:00.000Z";
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
    status: "ready",
    recipient_email: null,
    email_subject: null,
    email_body: null,
    email_attach_cv: true,
    email_attach_letter: true,
    email_account_id: null,
    idempotency_key: null,
    approved: true,
    approved_at: ts,
    scheduled_at: null,
    schedule_timezone: null,
    sent_at: null,
    provider_message_id: null,
    last_failure_code: null,
    ad_confirmed_at: ts,
    cv_reviewed_at: null,
    letter_reviewed_at: null,
    created_at: ts,
    updated_at: ts,
  };
}

function cvDocFor(company: string) {
  const cv = cvEmpty();
  cv.personal = {
    ...cv.personal,
    fullName: "Mustapha Drif",
    professionalTitle: `Auszubildende:r — ${company}`,
    email: "mustapha.drif@example.de",
    phone: "+49 151 23456789",
    location: "Hamburg, Deutschland",
  };
  cv.summary = `Maßgeschneiderte Zusammenfassung für ${company}.`;
  cv.skills = ["Schaltpläne lesen", "Montage"];
  cv.languages = [{ id: "l1", language: "Deutsch", level: "C1" }];
  return cv;
}

/** A multi-paragraph letter with the classic closing (schema-compliant). */
function letterDocFor(company: string) {
  return {
    text:
      `Sehr geehrte Damen und Herren,\n\n` +
      `hiermit bewerbe ich mich bei ${company} um die ausgeschriebene Stelle. ` +
      "Ich bringe Erfahrung im Anlagenbau mit und arbeite zuverlässig und strukturiert.\n\n" +
      "Über eine Einladung zu einem persönlichen Gespräch würde ich mich sehr freuen.\n\n" +
      "Mit freundlichen Grüßen\n" +
      "Mustapha Drif",
    tone: "professional" as const,
  };
}

let db: StudioDb;

function seed() {
  const ts = "2026-12-01T00:00:00.000Z";
  db = createStudioDb({
    auto_bewerb_profiles: [],
    auto_bewerb_companies: [
      companyRow(CO1, "Kältebau Nord GmbH", "jobs@kaltbau-nord.de", "Anlagenmechaniker SHK"),
      companyRow(CO2, "Tech Süd AG", "bewerbung@tech-sued.de", "Fachinformatiker"),
      companyRow(CO3, "Heizungsbau Ost GmbH", "hr@heizung-ost.de", "Anlagenmechaniker SHK"),
    ],
    auto_bewerb_documents: [
      { id: `cv-${CO1}`, user_id: USER, company_id: CO1, doc_type: "cv", version: 1, content: cvDocFor("Kältebau Nord GmbH"), created_at: ts, updated_at: ts },
      { id: `letter-${CO1}`, user_id: USER, company_id: CO1, doc_type: "cover_letter", version: 1, content: letterDocFor("Kältebau Nord GmbH"), created_at: ts, updated_at: ts },
      { id: `cv-${CO2}`, user_id: USER, company_id: CO2, doc_type: "cv", version: 1, content: cvDocFor("Tech Süd AG"), created_at: ts, updated_at: ts },
      { id: `letter-${CO2}`, user_id: USER, company_id: CO2, doc_type: "cover_letter", version: 1, content: letterDocFor("Tech Süd AG"), created_at: ts, updated_at: ts },
      { id: `cv-${CO3}`, user_id: USER, company_id: CO3, doc_type: "cv", version: 1, content: cvDocFor("Heizungsbau Ost GmbH"), created_at: ts, updated_at: ts },
      { id: `letter-${CO3}`, user_id: USER, company_id: CO3, doc_type: "cover_letter", version: 1, content: letterDocFor("Heizungsbau Ost GmbH"), created_at: ts, updated_at: ts },
    ],
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
        created_at: ts,
        updated_at: ts,
      },
    ],
    auto_bewerb_company_attachments: [],
    auto_bewerb_email_templates: [
      {
        user_id: USER,
        body: "Sehr geehrte Damen und Herren,\n\nanbei meine Bewerbungsunterlagen.\n\nMit freundlichen Grüßen\nMustapha Drif",
        recipient: "",
        subject: "Bewerbung um einen Ausbildungsplatz",
        account_id: ACCT_ID,
        attach_cv: true,
        attach_letter: true,
      },
    ],
    auto_bewerb_send_attempts: [],
    email_accounts: [{ id: ACCT_ID, user_id: USER, provider: "gmail", email: "mail@example.de", is_active: true, requires_reconnect: false }],
    activity_logs: [],
    profiles: [
      {
        id: USER,
        full_name: "Mustapha Drif",
        email: "mustapha.drif@example.de",
        phone: "+49 151 23456789",
        street: "Hafenstraße 1",
        postal_code: "20457",
        city: "Hamburg",
        country: "Deutschland",
      },
    ],
  });
  (createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(db.admin);
}

const letterPath = (companyId: string) => `auto-bewerb/letter/${USER}/${companyId}.pdf`;
const cvPath = (companyId: string) => `auto-bewerb/cv/${USER}/${companyId}.pdf`;

async function storedBytes(path: string): Promise<Uint8Array> {
  const { data } = (await db.admin.storage.from(BUCKET).download(path)) as { data: Blob | null };
  expect(data, `stored object at ${path}`).toBeTruthy();
  return new Uint8Array(await (data as Blob).arrayBuffer());
}

async function send(companyId: string) {
  const res = await prepareAutoBewerbSend(USER, { companyId, schedule: FUTURE });
  expect(res.ok, JSON.stringify(res)).toBe(true);
}

describe("global signature → EVERY generated Anschreiben PDF (real engine, fake DB)", () => {
  it("individual: the stored letter PDF embeds the uploaded signature (single A4 page)", async () => {
    seed();
    expect((await uploadAutoBewerbSignature(USER, VALID_PNG)).ok).toBe(true);
    await send(CO1);
    const bytes = await storedBytes(letterPath(CO1));
    expect(hasImage(bytes), "letter PDF must carry the embedded signature image").toBe(true);
    // Still a valid, single A4 page (the image is kept within its reserved space).
    const { PDFDocument } = await import("pdf-lib");
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(1);
  });

  it("bulk: the SAME global signature is embedded in EVERY company's stored letter PDF", async () => {
    seed();
    expect((await uploadAutoBewerbSignature(USER, VALID_PNG)).ok).toBe(true);
    for (const id of [CO1, CO2, CO3]) await send(id);
    const l1 = await storedBytes(letterPath(CO1));
    const l2 = await storedBytes(letterPath(CO2));
    const l3 = await storedBytes(letterPath(CO3));
    for (const [bytes, id] of [[l1, CO1], [l2, CO2], [l3, CO3]] as const) {
      expect(hasImage(bytes), `company ${id} letter must carry the global signature`).toBe(true);
    }
  });

  it("no signature → the stored letter PDF carries NO image (text-only closing, nothing invented)", async () => {
    seed();
    await send(CO1);
    const bytes = await storedBytes(letterPath(CO1));
    expect(hasImage(bytes)).toBe(false);
  });

  it("replacing the signature (PNG → JPEG) changes what the NEXT letter embeds", async () => {
    seed();
    expect((await uploadAutoBewerbSignature(USER, VALID_PNG)).ok).toBe(true);
    await send(CO1);
    const before = await storedBytes(letterPath(CO1));
    expect(hasImage(before)).toBe(true);
    // Replace with a JPEG: the old PNG object is removed, the JPEG is live.
    expect((await uploadAutoBewerbSignature(USER, VALID_JPEG)).ok).toBe(true);
    const { data: pngLeft } = (await db.admin.storage
      .from(BUCKET)
      .download(`${USER}/auto-bewerb/signature/signature.png`)) as { data: Blob | null };
    expect(pngLeft, "the replaced PNG must be gone").toBeNull();
    // The stored letter was generated before the replacement (upsert keeps the
    // earlier bytes) — but a NEW render for another company embeds the JPEG:
    await send(CO2);
    expect(hasImage(await storedBytes(letterPath(CO2)))).toBe(true);
  });

  it("deleting the signature → the next letter renders text-only again", async () => {
    seed();
    expect((await uploadAutoBewerbSignature(USER, VALID_PNG)).ok).toBe(true);
    expect((await deleteAutoBewerbSignature(USER)).ok).toBe(true);
    await send(CO1);
    expect(hasImage(await storedBytes(letterPath(CO1)))).toBe(false);
  });

  it("CV PDFs NEVER contain the signature (even with it uploaded; no photo → no image at all)", async () => {
    seed();
    expect((await uploadAutoBewerbSignature(USER, VALID_PNG)).ok).toBe(true);
    for (const id of [CO1, CO2]) await send(id);
    for (const id of [CO1, CO2]) {
      expect(hasImage(await storedBytes(cvPath(id))), `CV for ${id} must never embed the signature`).toBe(false);
    }
  });

  it("owner isolation: USER_B (no signature of their own) never embeds USER's signature", async () => {
    seed();
    // A complete second user with their own company + letter + settings:
    const CO_B = "88888888-8888-4888-8888-888888888888";
    const ts = "2026-12-01T00:00:00.000Z";
    const rowB = companyRow(CO_B, "Muster Werk GmbH", "jobs@muster-werk.de", "Anlagenmechaniker SHK");
    rowB.user_id = USER_B;
    rowB.company_key = "muster werk";
    db.tables.auto_bewerb_companies.push(rowB);
    db.tables.auto_bewerb_documents.push(
      { id: `cv-${CO_B}`, user_id: USER_B, company_id: CO_B, doc_type: "cv", version: 1, content: cvDocFor("Muster Werk GmbH"), created_at: ts, updated_at: ts },
      { id: `letter-${CO_B}`, user_id: USER_B, company_id: CO_B, doc_type: "cover_letter", version: 1, content: letterDocFor("Muster Werk GmbH"), created_at: ts, updated_at: ts },
    );
    db.tables.auto_bewerb_email_templates.push({
      user_id: USER_B,
      body: "Sehr geehrte Damen und Herren,\n\nanbei meine Bewerbungsunterlagen.\n\nMit freundlichen Grüßen\nAndere Person",
      recipient: "",
      subject: "Bewerbung um einen Ausbildungsplatz",
      account_id: ACCT_B,
      attach_cv: true,
      attach_letter: true,
    });
    db.tables.email_accounts.push({
      id: ACCT_B,
      user_id: USER_B,
      provider: "gmail",
      email: "andere@example.de",
      is_active: true,
      requires_reconnect: false,
    });
    db.tables.profiles.push({
      id: USER_B,
      full_name: "Andere Person",
      email: "andere@example.de",
      phone: "+49 151 0000000",
      street: "Beispielweg 2",
      postal_code: "20000",
      city: "Hamburg",
      country: "Deutschland",
    });
    // Only USER has a signature — USER_B's fixed path is empty:
    expect((await uploadAutoBewerbSignature(USER, VALID_PNG)).ok).toBe(true);
    await send(CO1);
    const resB = await prepareAutoBewerbSend(USER_B, { companyId: CO_B, schedule: FUTURE });
    expect(resB.ok, JSON.stringify(resB)).toBe(true);
    // USER's letter carries USER's signature…
    expect(hasImage(await storedBytes(letterPath(CO1)))).toBe(true);
    // …while USER_B's letter stays text-only (never reads USER's object):
    const letterB = await storedBytes(`auto-bewerb/letter/${USER_B}/${CO_B}.pdf`);
    expect(hasImage(letterB), "USER_B must never embed USER's signature").toBe(false);
  });
});
