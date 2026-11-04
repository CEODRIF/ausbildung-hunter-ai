/**
 * AUTO BEWERB — regression suite for the red "Der Lebenslauf ist zu
 * umfangreich für eine A4-Seite" error in the Step-7 result panel.
 *
 * Root cause fixed by this branch:
 *  1. SEND PATH (engine.ts prepareAutoBewerbSend): the one-page policy made
 *     an overflowing CV a hard `cv_overflow` failure that blocked the whole
 *     application — while the PDF EXPORT route already fell back to the
 *     renderer's multi-page mode. The send path now uses the SAME fallback:
 *     nothing is deleted, shortened or clipped; the complete CV (running
 *     header + page numbers) is attached.
 *  2. PAGE-HEIGHT CALCULATION (cv-pdf.ts entry()): the right-stacked
 *     dates/location block was reserved as `n × lineH` — under-reserving the
 *     meta-only case (dates hidden, location shown), where the meta ink
 *     overprinted the following element, and over-reserving the others.
 *
 * Verified here with SHORT / MEDIUM / LONG CVs:
 *  - exact page counts, all pages true A4
 *  - full content preservation (every entry, every bullet sentence,
 *    every section) in the multi-page fallback
 *  - no clipping (all ink inside the outer margins / page bounds)
 *  - no overlap (pairwise ink-box check of every rendered text run)
 *  - the real engine send pipeline: long CV → `ok: true`, stored CV PDF is
 *    the complete multi-page document (no `cv_overflow` code anymore)
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { inflateSync } from "node:zlib";
import type { StudioDb } from "./helpers-studio";
import type { CvDocument } from "@/lib/templates/cv";
import type { PDFFont, PDFDocument as PDFDocumentCls } from "pdf-lib";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/email-providers", () => ({ createEmailProvider: vi.fn() }));

const { createAdminClient } = await import("@/lib/supabase/admin");
const { prepareAutoBewerbSend } = await import("@/lib/auto-bewerb/engine");
const { createStudioDb } = await import("./helpers-studio");
const { CvPdfOverflowError, generateCvPdf } = await import("@/lib/auto-bewerb/cv-pdf");
const { cvEmpty, emptyEducation, emptyExperience } = await import("@/lib/templates/cv");
const { PDFDocument, StandardFonts } = await import("pdf-lib");

/* ------------------------------------------------------------------ */
/* A4 constants (mirror src/lib/auto-bewerb/cv-pdf.ts)                 */
/* ------------------------------------------------------------------ */

const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;
const MM = 72 / 25.4;
/** Densest tier margins — the outer bound every run must respect. */
const OUTER_LEFT = 9 * MM - 1.5;
const OUTER_RIGHT = A4_WIDTH - 9 * MM + 1.5;

/* ------------------------------------------------------------------ */
/* Fixtures: SHORT / MEDIUM / LONG CVs                                 */
/* ------------------------------------------------------------------ */

/** SHORT: lean profile — must render on exactly one page. */
function shortCv(): CvDocument {
  const cv = cvEmpty();
  cv.personal = {
    ...cv.personal,
    fullName: "Mustapha Drif",
    professionalTitle: "Fachinformatiker — Bewerbung bei Tech GmbH",
    email: "mustapha.drif@example.de",
    phone: "+49 151 23456789",
    location: "Düsseldorf, Deutschland",
    nationality: "deutscher",
  };
  cv.summary = "Motivierter Fachinformatiker mit Erfahrung in Systemintegration und Netzwerktechnik.";
  cv.skills = ["Java", "Netzwerktechnik", "Systemintegration"];
  cv.languages = [{ id: "l1", language: "Deutsch", level: "verhandlungssicher" }];
  return cv;
}

/** MEDIUM: realistic content-rich profile (every section filled). */
function mediumCv(): CvDocument {
  const cv = shortCv();
  cv.personal = { ...cv.personal, linkedin: "linkedin.com/in/mustapha-drif", dateOfBirth: "04.06.2007", availability: "ab 01.09.2026" };
  const e1 = emptyExperience();
  e1.jobTitle = "Praktikant Kältetechnik";
  e1.company = "Kältebau Nord GmbH";
  e1.location = "Hamburg";
  e1.start = "06/2025";
  e1.end = "08/2025";
  e1.responsibilities = ["Montage von Heizungsanlagen", "Wartung der IT-Infrastruktur", "Erfassung von Schaltplänen"];
  e1.achievements = ["Eigenständige Abnahme einer Anlage"];
  const e2 = emptyExperience();
  e2.jobTitle = "Auszubildender Fachinformatiker";
  e2.company = "Tech Süd AG";
  e2.location = "Düsseldorf";
  e2.start = "09/2023";
  e2.isCurrent = true;
  e2.responsibilities = ["Systemintegration kleiner Netzwerke", "Support der Endanwender"];
  cv.experience = [e1, e2];
  const ed1 = emptyEducation();
  ed1.degree = "Abitur — Gymnasium";
  ed1.institution = "Berthold-Brecht-Schule";
  ed1.location = "Düsseldorf";
  ed1.start = "2022";
  ed1.end = "2025";
  ed1.description = "Fächer: Mathematik, Informatik, Physik.";
  const ed2 = emptyEducation();
  ed2.degree = "Schulvorbereitung";
  ed2.institution = "Realschule";
  ed2.location = "Düsseldorf";
  ed2.end = "2022";
  cv.education = [ed1, ed2];
  cv.skills = ["Java", "Netzwerktechnik", "Systemintegration", "Kubernetes", "Linux", "Teamarbeit"];
  cv.languages = [
    { id: "l1", language: "Deutsch", level: "verhandlungssicher" },
    { id: "l2", language: "Englisch", level: "sehr gut" },
    { id: "l3", language: "Arabisch", level: "Muttersprache" },
  ];
  cv.certificates = [
    { id: "c1", name: "IT-Support-Zertifikat", issuer: "Tech Süd AG", date: "2025", description: "" },
    { id: "c2", name: "Erste Hilfe", issuer: "DRK", date: "2024", description: "" },
  ];
  cv.interests = ["IT-Projekte", "Fußball", "Musik"];
  return cv;
}

/** LONG: 14 jobs × 5 bullets — overflows even the densest readable tier. */
function longCv(): CvDocument {
  const cv = mediumCv();
  cv.summary = "Langes Profil mit vielen früheren Tätigkeiten.";
  cv.experience = Array.from({ length: 14 }, (_, i) => {
    const e = emptyExperience();
    e.jobTitle = `Systemadministrator (${i + 1})`;
    e.company = `Firma ${i + 1} GmbH`;
    e.location = "Berlin";
    e.start = "2020";
    e.end = "2024";
    e.responsibilities = Array.from(
      { length: 5 },
      (_, j) => `Verantwortungsbereich ${j + 1}: Wartung, Betrieb und Ausweitung der IT-Infrastruktur inklusive Netzwerk, Server und Endgeräte.`,
    );
    return e;
  });
  return cv;
}

/** Two entries with LOCATION but NO dates — the meta-only right stack
 *  (showDates off / no date range). Entry 1's first bullet is a single
 *  word wider than the bullet wrap width, so the renderer's
 *  breakLongWord fills line 1 to the FULL content width — deterministically
 *  running under the right-aligned location line. Before the measurement
 *  fix (rightH under-reserved for meta-only entries) that line overprinted
 *  the location ink; after the fix the entry reserves the true ink extent
 *  and the bullet starts below it. */
const LONG_GEOMETRY_PROBE_WORD =
  "Warmwasserzirkulationskreislaufdruckverlustberechnungsprotokollneubaugebäudebestandsdokumentationsverzeichnisanlagenkatalog";

function metaOnlyCv(): CvDocument {
  const cv = shortCv();
  cv.summary = "";
  const mk = (title: string, company: string, responsibilities: string[]) => {
    const e = emptyExperience();
    e.jobTitle = title;
    e.company = company;
    e.location = "Düsseldorf";
    e.responsibilities = responsibilities;
    return e;
  };
  cv.experience = [
    mk("Monteur SHK", "Heizungsbau Süd GmbH", [LONG_GEOMETRY_PROBE_WORD, "Installation und Wartung von Heizungsanlagen"]),
    mk("Helfer SHK", "Kältebau Nord GmbH", ["Installation und Wartung von Heizungsanlagen"]),
  ];
  cv.skills = [];
  cv.languages = [];
  return cv;
}

/* ------------------------------------------------------------------ */
/* Content-stream parsing (positions, fonts, widths → ink boxes)       */
/* ------------------------------------------------------------------ */

/** Standard 14 fonts use WinAnsiEncoding — map the 0x80–0x9F block. */
const WINANSI: Record<number, string> = {
  0x80: "€", 0x82: "‘", 0x83: "‚", 0x84: "„", 0x85: "…", 0x86: "†", 0x87: "‡",
  0x88: "ˆ", 0x89: "‰", 0x8a: "Š", 0x8b: "‹", 0x8c: "Œ", 0x8e: "Ž", 0x91: "‘",
  0x92: "’", 0x93: "“", 0x94: "”", 0x95: "•", 0x96: "–", 0x97: "—", 0x98: "˜",
  0x99: "™", 0x9a: "š", 0x9b: "›", 0x9c: "œ", 0x9e: "ž", 0x9f: "Ÿ",
};

function decodeWinAnsiHex(hex: string): string {
  const buf = Buffer.from(hex, "hex");
  let out = "";
  for (const b of buf) out += b >= 0x80 && b <= 0x9f && WINANSI[b] ? WINANSI[b] : String.fromCharCode(b);
  return out;
}

interface Run {
  x: number;
  y: number; // baseline
  size: number;
  font: string;
  text: string;
  width: number;
}

let fonts: Record<string, PDFFont>;
beforeAll(async () => {
  const doc = await PDFDocument.create();
  fonts = {
    "Helvetica": await doc.embedFont(StandardFonts.Helvetica),
    "Helvetica-Bold": await doc.embedFont(StandardFonts.HelveticaBold),
    "Helvetica-Oblique": await doc.embedFont(StandardFonts.HelveticaOblique),
  };
});

function fontFor(name: string): PDFFont {
  return name.startsWith("Helvetica-Bold")
    ? fonts["Helvetica-Bold"]
    : name.startsWith("Helvetica-Oblique")
      ? fonts["Helvetica-Oblique"]
      : fonts["Helvetica"];
}

function pageStream(pdf: PDFDocumentCls, pageIndex: number): string {
  const node = pdf.getPage(pageIndex).node as unknown as { Contents: () => unknown };
  const arr = node.Contents() as unknown as { size: () => number; get: (i: number) => unknown };
  const ctx = (pdf as unknown as { context: { lookup: (r: unknown) => unknown } }).context;
  let stream = "";
  for (let i = 0; i < arr.size(); i += 1) {
    const item = arr.get(i);
    const s =
      item && typeof item === "object" && (item as { constructor?: { name?: string } }).constructor?.name === "PDFRef"
        ? ctx.lookup(item)
        : item;
    const raw = (s as { getContents: () => Uint8Array }).getContents();
    try {
      stream += inflateSync(raw).toString("latin1");
    } catch {
      stream += Buffer.from(raw).toString("latin1");
    }
  }
  return stream;
}

function pageRuns(pdf: PDFDocumentCls, pageIndex: number): Run[] {
  const runs: Run[] = [];
  for (const block of pageStream(pdf, pageIndex).matchAll(/BT([\s\S]*?)ET/g)) {
    const body = block[1];
    const font = body.match(/\/(Helvetica[^ ]*|Times[^ ]*) ([\d.]+) Tf/);
    const pos = body.match(/1 0 0 1 ([\d.]+) ([\d.]+) Tm/);
    const hex = body.match(/<([0-9A-Fa-f]+)> Tj/);
    if (!font || !pos || !hex) continue;
    const text = decodeWinAnsiHex(hex[1]);
    runs.push({
      x: Number(pos[1]),
      y: Number(pos[2]),
      size: Number(font[2]),
      font: font[1],
      text,
      width: fontFor(font[1]).widthOfTextAtSize(text, Number(font[2])),
    });
  }
  return runs;
}

const allRuns = (pdf: PDFDocumentCls): Run[][] =>
  Array.from({ length: pdf.getPageCount() }, (_, i) => pageRuns(pdf, i));

const fullText = (pdf: PDFDocumentCls): string =>
  allRuns(pdf).map((runs) => runs.map((r) => r.text).join(" ")).join(" ");

/** Ink box of a text run (Helvetica ascent 0.72 em / descent 0.28 em —
 *  the renderer's own convention). */
const ink = (r: Run) => ({ top: r.y + 0.72 * r.size, bottom: r.y - 0.28 * r.size, left: r.x, right: r.x + r.width });

/** True when two ink boxes overlap by more than the tolerance (both axes). */
function overlaps(a: ReturnType<typeof ink>, b: ReturnType<typeof ink>, tol = 1.0): boolean {
  return Math.min(a.right, b.right) - Math.max(a.left, b.left) > tol &&
    Math.min(a.top, b.top) - Math.max(a.bottom, b.bottom) > tol;
}

/** Every pair of text runs of a page must not overprint each other. */
function assertNoOverlap(pdf: PDFDocumentCls) {
  for (let p = 0; p < pdf.getPageCount(); p += 1) {
    const runs = pageRuns(pdf, p);
    for (let i = 0; i < runs.length; i += 1) {
      for (let j = i + 1; j < runs.length; j += 1) {
        const a = ink(runs[i]);
        const b = ink(runs[j]);
        expect(
          overlaps(a, b),
          `page ${p + 1}: "${runs[i].text}" overprints "${runs[j].text}"`,
        ).toBe(false);
      }
    }
  }
}

/** No run may leave the outer (densest-tier) margins or the page itself. */
function assertNoClipping(pdf: PDFDocumentCls) {
  for (let p = 0; p < pdf.getPageCount(); p += 1) {
    for (const r of pageRuns(pdf, p)) {
      const box = ink(r);
      expect(box.left, `page ${p + 1}: "${r.text}" left of margin`).toBeGreaterThanOrEqual(OUTER_LEFT);
      expect(box.right, `page ${p + 1}: "${r.text}" right of margin`).toBeLessThanOrEqual(OUTER_RIGHT);
      expect(box.top, `page ${p + 1}: "${r.text}" above page`).toBeLessThanOrEqual(A4_HEIGHT);
      expect(box.bottom, `page ${p + 1}: "${r.text}" below page`).toBeGreaterThanOrEqual(0);
    }
  }
}

function assertAllA4(pdf: PDFDocumentCls) {
  for (let i = 0; i < pdf.getPageCount(); i += 1) {
    const { width, height } = pdf.getPage(i).getSize();
    expect(width, `page ${i + 1} width`).toBeCloseTo(595.28, 0);
    expect(height, `page ${i + 1} height`).toBeCloseTo(841.89, 0);
  }
}

/* ------------------------------------------------------------------ */
/* A. Renderer contract (short / medium / long)                        */
/* ------------------------------------------------------------------ */

describe("CV renderer — short / medium / long regression", () => {
  it("SHORT CV: exactly one A4 page, readable typography, no clip/overlap", async () => {
    const pdf = await PDFDocument.load(await generateCvPdf(shortCv()));
    expect(pdf.getPageCount()).toBe(1);
    assertAllA4(pdf);
    assertNoClipping(pdf);
    assertNoOverlap(pdf);
    const name = pageRuns(pdf, 0).find((r) => r.text === "Mustapha Drif")!;
    expect(name, "name run missing").toBeTruthy();
    expect(name.size).toBeGreaterThanOrEqual(19); // comfortable/compact tier
  });

  it("MEDIUM CV (every section): exactly one A4 page, no clip/overlap", async () => {
    const pdf = await PDFDocument.load(await generateCvPdf(mediumCv()));
    expect(pdf.getPageCount()).toBe(1);
    assertAllA4(pdf);
    assertNoClipping(pdf);
    assertNoOverlap(pdf);
    const text = fullText(pdf);
    for (const s of ["Berufserfahrung", "Ausbildung & Studium", "Kenntnisse", "Sprachen", "Zertifikate", "Interessen"]) {
      expect(text, `heading "${s}" missing`).toContain(s);
    }
    expect(text).toContain("Montage von Heizungsanlagen");
    expect(text).toContain("Fächer: Mathematik, Informatik, Physik.");
  });

  it("LONG CV: the default render still reports the explicit overflow error (contract unchanged)", async () => {
    await expect(generateCvPdf(longCv())).rejects.toBeInstanceOf(CvPdfOverflowError);
    await expect(generateCvPdf(longCv())).rejects.toMatchObject({ code: "cv_overflow" });
  });

  it("LONG CV multi-page fallback: ≥2 A4 pages, EVERYTHING preserved, running header + page numbers", async () => {
    const cv = longCv();
    const pdf = await PDFDocument.load(await generateCvPdf(cv, { allowMultiPage: true }));
    const pages = pdf.getPageCount();
    expect(pages).toBeGreaterThanOrEqual(2);
    assertAllA4(pdf);
    assertNoClipping(pdf);
    assertNoOverlap(pdf);
    const text = fullText(pdf);
    // all 14 experience entries + all 70 bullet sentences survive
    for (let i = 1; i <= 14; i += 1) expect(text, `entry ${i} missing`).toContain(`Systemadministrator (${i})`);
    for (let i = 1; i <= 14; i += 1) {
      for (let j = 1; j <= 5; j += 1) {
        expect(text, `entry ${i} bullet ${j} missing`).toContain(
          `Verantwortungsbereich ${j}: Wartung, Betrieb und Ausweitung der IT-Infrastruktur inklusive Netzwerk, Server und Endgeräte.`,
        );
      }
    }
    // every section of the source document is still present
    for (const s of ["Profil", "Berufserfahrung", "Ausbildung & Studium", "Kenntnisse", "Sprachen", "Zertifikate", "Interessen"]) {
      expect(text, `section "${s}" missing`).toContain(s);
    }
    // running header on every continuation page
    for (let p = 1; p < pages; p += 1) {
      expect(pageRuns(pdf, p).some((r) => r.text === "Mustapha Drif — Lebenslauf"), `page ${p + 1}: running header missing`).toBe(true);
    }
    // "Seite i von n" on every page
    for (let p = 0; p < pages; p += 1) {
      expect(pageRuns(pdf, p).some((r) => r.text === `Seite ${p + 1} von ${pages}`), `page ${p + 1}: page number missing`).toBe(true);
    }
  });

  it("meta-only entries (location without dates): no overprint of the following entry (measurement fix)", async () => {
    const pdf = await PDFDocument.load(await generateCvPdf(metaOnlyCv()));
    expect(pdf.getPageCount()).toBe(1);
    assertNoClipping(pdf);
    assertNoOverlap(pdf);
    const runs = pageRuns(pdf, 0);
    const metaRuns = runs.filter((r) => r.text === "Düsseldorf" && r.size < 10);
    expect(metaRuns.length).toBe(2); // both entries' location line
    // the location line sits on the SECOND stack slot: one full line step
    // (metaLh 1.3–1.5 across tiers) below its lead line's baseline
    // (PDF y grows upward → the lead baseline has the LARGER y)
    for (const m of metaRuns) {
      const lead = runs.find((r) => r.size > m.size && r.y > m.y && r.y - m.y >= 1.25 * m.size && r.y - m.y <= 1.55 * m.size);
      expect(lead, "meta run must sit one line-step below its lead line").toBeTruthy();
    }
  });
});

/* ------------------------------------------------------------------ */
/* B. Real send pipeline (engine + in-memory DB, real pdf-lib)         */
/* ------------------------------------------------------------------ */

const USER = "11111111-1111-4111-8111-111111111111";
const CO1 = "44444444-4444-4444-8444-444444444444";
const CO2 = "55555555-5555-4555-8555-555555555555";
const ACCT_ID = "33333333-3333-4333-8333-333333333333";
const BUCKET = "application-attachments";

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

function smallCvDocFor(company: string): CvDocument {
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

function longCvDocFor(company: string): CvDocument {
  const cv = longCv();
  cv.personal = { ...cv.personal, professionalTitle: `Auszubildende:r — ${company}` };
  return cv;
}

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

function seed(cvFor: (company: string) => CvDocument) {
  const ts = "2026-12-01T00:00:00.000Z";
  db = createStudioDb({
    auto_bewerb_profiles: [],
    auto_bewerb_companies: [
      companyRow(CO1, "Mousert GmbH", "jobs@mousert.de", "Anlagenmechaniker SHK"),
      companyRow(CO2, "Tech Süd AG", "bewerbung@tech-sued.de", "Fachinformatiker"),
    ],
    auto_bewerb_documents: [
      { id: `cv-${CO1}`, user_id: USER, company_id: CO1, doc_type: "cv", version: 1, content: cvFor("Mousert GmbH"), created_at: ts, updated_at: ts },
      { id: `letter-${CO1}`, user_id: USER, company_id: CO1, doc_type: "cover_letter", version: 1, content: letterDocFor("Mousert GmbH"), created_at: ts, updated_at: ts },
      { id: `cv-${CO2}`, user_id: USER, company_id: CO2, doc_type: "cv", version: 1, content: cvFor("Tech Süd AG"), created_at: ts, updated_at: ts },
      { id: `letter-${CO2}`, user_id: USER, company_id: CO2, doc_type: "cover_letter", version: 1, content: letterDocFor("Tech Süd AG"), created_at: ts, updated_at: ts },
    ],
    auto_bewerb_attachments: [],
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

const cvPath = (companyId: string) => `auto-bewerb/cv/${USER}/${companyId}.pdf`;

async function storedBytes(path: string): Promise<Uint8Array> {
  const { data } = (await db.admin.storage.from(BUCKET).download(path)) as { data: Blob | null };
  expect(data, `stored object at ${path}`).toBeTruthy();
  return new Uint8Array(await (data as Blob).arrayBuffer());
}

describe("send pipeline — CV overflow must not block the application", () => {
  it("LONG CV: prepareAutoBewerbSend succeeds (no cv_overflow) and stores the COMPLETE multi-page CV", async () => {
    seed(longCvDocFor);
    const res = await prepareAutoBewerbSend(USER, { companyId: CO1, schedule: FUTURE });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(res.code).toBeUndefined();
    expect(res.scheduledAt, "scheduled inside the 07:30–10:30 window").toBeTruthy();

    const pdf = await PDFDocument.load(await storedBytes(cvPath(CO1)));
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(2);
    assertAllA4(pdf);
    assertNoClipping(pdf);
    assertNoOverlap(pdf);
    const text = fullText(pdf);
    for (let i = 1; i <= 14; i += 1) expect(text, `entry ${i} missing from attached CV`).toContain(`Systemadministrator (${i})`);
    expect(text).toContain("Fächer: Mathematik, Informatik, Physik.");
    // page numbering present on every page
    const pages = pdf.getPageCount();
    for (let p = 0; p < pages; p += 1) {
      expect(pageRuns(pdf, p).some((r) => r.text === `Seite ${p + 1} von ${pages}`)).toBe(true);
    }
  });

  it("SHORT CV: the same pipeline still attaches a single one-page CV (fallback not triggered)", async () => {
    seed(smallCvDocFor);
    const res = await prepareAutoBewerbSend(USER, { companyId: CO2, schedule: FUTURE });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const pdf = await PDFDocument.load(await storedBytes(cvPath(CO2)));
    expect(pdf.getPageCount()).toBe(1);
    assertAllA4(pdf);
    assertNoClipping(pdf);
    assertNoOverlap(pdf);
    expect(fullText(pdf)).toContain("Maßgeschneiderte Zusammenfassung für Tech Süd AG.");
  });
});
