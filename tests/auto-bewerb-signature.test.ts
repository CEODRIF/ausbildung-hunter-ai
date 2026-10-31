/**
 * AUTO BEWERB — the candidate's GENUINE handwritten signature (global).
 *
 * Regression tests for the signature pipeline the cover-letter workflow relies
 * on:
 *   - magic-byte validation (PNG/JPEG only, ≤ 5 MB, empty / wrong-format rejected);
 *   - private, owner-scoped storage (upload / retrieve / replace / delete);
 *   - owner isolation — a user can never read another user's signature;
 *   - the GLOBAL signature is embedded into EVERY cover-letter PDF (all
 *     companies, including the bulk set), with no signature → no image;
 *   - CV PDFs NEVER contain the signature (the CV renderer has no signature
 *     input — only the optional Bewerbungsfoto).
 *
 * Follows the profile-photo testing conventions: engine storage runs against
 * the in-memory studio DB (mocked `createAdminClient`); PDF assertions run the
 * real renderer output. The HTTP contract lives in auto-bewerb-signature-route.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStudioDb, type StudioDb } from "./helpers-studio";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/email-providers", () => ({ createEmailProvider: vi.fn() }));

import { createAdminClient } from "@/lib/supabase/admin";
import {
  deleteAutoBewerbSignature,
  getAutoBewerbSignatureImage,
  uploadAutoBewerbSignature,
} from "@/lib/auto-bewerb/engine";
import {
  SIGNATURE_MAX_BYTES,
  detectSignatureType,
  validateSignature,
} from "@/lib/auto-bewerb/signature";
import { buildLetterFolio, generateLetterPdf } from "@/lib/bew-letter-pdf";
import { generateCvPdf } from "@/lib/auto-bewerb/cv-pdf";
import { cvEmpty, type CvDocument } from "@/lib/templates/cv";
import { PDFDocument } from "pdf-lib";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "99999999-9999-4999-8999-999999999999";

/** Small but valid magic-byte payloads (the engine only inspects the prefix). */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8]);
const GIF = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 1, 2, 3, 4]);
const TEXT = Buffer.from("definitely not an image at all");

/** pdf-lib writes `/Subtype /Image` for every embedded image XObject. */
const hasImage = (bytes: Uint8Array): boolean =>
  Buffer.from(bytes).toString("latin1").includes("/Subtype /Image");

describe("validation — magic bytes (independent of any declared MIME)", () => {
  it("accepts PNG and JPEG", () => {
    expect(validateSignature(PNG)).toEqual({ ok: true, type: "png" });
    expect(validateSignature(JPEG)).toEqual({ ok: true, type: "jpeg" });
  });

  it("rejects invalid formats (GIF, arbitrary bytes, text)", () => {
    expect(validateSignature(GIF)).toEqual({ ok: false, code: "invalid_type" });
    expect(validateSignature(TEXT)).toEqual({ ok: false, code: "invalid_type" });
    expect(validateSignature(Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]))).toEqual({ ok: false, code: "invalid_type" });
  });

  it("rejects empty files", () => {
    expect(validateSignature(Buffer.alloc(0))).toEqual({ ok: false, code: "empty" });
  });

  it("rejects files exceeding 5 MB", () => {
    const big = Buffer.alloc(SIGNATURE_MAX_BYTES + 1, 0);
    big.set(PNG); // valid magic, but over the cap
    expect(validateSignature(big)).toEqual({ ok: false, code: "too_large" });
  });

  it("exposes the detected format from magic bytes", () => {
    expect(detectSignatureType(PNG)).toBe("png");
    expect(detectSignatureType(JPEG)).toBe("jpeg");
    expect(detectSignatureType(GIF)).toBeNull();
    expect(detectSignatureType(Buffer.alloc(0))).toBeNull();
  });
});

describe("storage — private and owner-scoped (fixed per-user path)", () => {
  let db: StudioDb;
  beforeEach(() => {
    db = createStudioDb({ activity_logs: [] });
    (createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(db.admin);
  });

  const storageOps = (op: "upload" | "remove" | "download") =>
    db.calls.filter((c) => c.op === "storage" && Object.keys(c.filters).includes(op)) as Array<{ filters: Record<string, unknown> }>;

  it("upload stores the PNG at the owner path and returns mime + size (POST engine)", async () => {
    const res = await uploadAutoBewerbSignature(USER_A, PNG);
    expect(res).toEqual({ ok: true, value: { mime: "image/png", sizeBytes: PNG.length } });
    expect(db.uploaded).toEqual([{ bucket: "application-attachments", path: `${USER_A}/auto-bewerb/signature/signature.png` }]);
  });

  it("retrieval returns the EXACT stored bytes + mime (GET engine)", async () => {
    await uploadAutoBewerbSignature(USER_A, PNG);
    const got = await getAutoBewerbSignatureImage(USER_A);
    expect(got).not.toBeNull();
    expect(got!.mime).toBe("image/png");
    expect(Buffer.from(got!.bytes).equals(PNG)).toBe(true);
  });

  it("retrieval returns null when no signature exists (missing handled, no error)", async () => {
    expect(await getAutoBewerbSignatureImage(USER_A)).toBeNull();
  });

  it("replacing removes the previous format/object (exactly one signature)", async () => {
    await uploadAutoBewerbSignature(USER_A, PNG);
    const res = await uploadAutoBewerbSignature(USER_A, JPEG);
    expect(res).toEqual({ ok: true, value: { mime: "image/jpeg", sizeBytes: JPEG.length } });
    // Uploading the JPEG removed the opposite-format (PNG) object.
    const removed = storageOps("remove").flatMap((c) => (c.filters.remove as string[]));
    expect(removed).toContain(`${USER_A}/auto-bewerb/signature/signature.png`);
    const got = await getAutoBewerbSignatureImage(USER_A);
    expect(got!.mime).toBe("image/jpeg");
    expect(Buffer.from(got!.bytes).equals(JPEG)).toBe(true);
  });

  it("delete removes both fixed paths (DELETE engine)", async () => {
    await uploadAutoBewerbSignature(USER_A, PNG);
    expect(await getAutoBewerbSignatureImage(USER_A)).not.toBeNull();
    const res = await deleteAutoBewerbSignature(USER_A);
    expect(res).toEqual({ ok: true });
    const last = storageOps("remove").at(-1)!;
    expect(last.filters.remove).toEqual([
      `${USER_A}/auto-bewerb/signature/signature.png`,
      `${USER_A}/auto-bewerb/signature/signature.jpg`,
    ]);
    expect(await getAutoBewerbSignatureImage(USER_A)).toBeNull();
  });

  it("owner isolation: user B can never read user A's signature", async () => {
    await uploadAutoBewerbSignature(USER_A, PNG);
    expect(await getAutoBewerbSignatureImage(USER_A)).not.toBeNull();
    // B has none, even though A's signature exists…
    const callsBefore = db.calls.length;
    expect(await getAutoBewerbSignatureImage(USER_B)).toBeNull();
    // …and every download B's read triggers targets B's OWN path — never A's.
    const bDownloads = db.calls
      .slice(callsBefore)
      .filter((c) => c.op === "storage" && "download" in c.filters)
      .map((c) => String((c.filters as { download: unknown }).download));
    expect(bDownloads.length).toBeGreaterThan(0);
    for (const p of bDownloads) expect(p.startsWith(`${USER_B}/`)).toBe(true);
  });

  it("rejects a non-image BEFORE any storage write", async () => {
    const res = await uploadAutoBewerbSignature(USER_A, GIF);
    expect(res).toMatchObject({ ok: false, code: "invalid_file_type" });
    expect(db.uploaded).toHaveLength(0);
  });

  it("rejects an oversized image BEFORE any storage write", async () => {
    const big = Buffer.alloc(SIGNATURE_MAX_BYTES + 1, 0);
    big.set(PNG);
    const res = await uploadAutoBewerbSignature(USER_A, big);
    expect(res).toMatchObject({ ok: false, code: "file_too_large" });
    expect(db.uploaded).toHaveLength(0);
  });
});

describe("global signature → every cover-letter PDF, never the CV", () => {
  /** A VALID 1×1 PNG — pdf-lib must actually decode it to embed it (the magic-only
   *  `PNG` above passes validation/storage but is not decodable). */
  const VALID_PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  /** The one global signature, read once per user (as export-pdf/send do). */
  const sig = { bytes: new Uint8Array(VALID_PNG), mime: "image/png" };

  const letterFor = (companyName: string, contactName: string) =>
    buildLetterFolio({
      applicantName: "Mustapha Drif",
      applicantEmail: "mustapha.drif@example.de",
      applicantStreet: "Hafenstraße 1",
      applicantPostalCode: "20457",
      applicantCity: "Hamburg",
      applicantCountry: "Deutschland",
      applicantPhone: "+49 151 2345678",
      companyName,
      companyContactName: contactName,
      companyAddress: `${companyName}, Hafenstraße 1, 20457 Hamburg`,
      subject: "Bewerbung",
      bodyHtml:
        "<p>Sehr geehrte Person,</p>" +
        "<p>hiermit bewerbe ich mich um den Ausbildungsplatz. Ich bringe Erfahrung im Anlagenbau mit.</p>" +
        "<p>Über eine Einladung zu einem persönlichen Gespräch würde ich mich freuen.</p>" +
        "<p>Mit freundlichen Grüßen</p>" +
        "<p>Mustapha Drif</p>",
      signatureImage: sig,
    });

  it("an individual letter embeds the signature and stays a valid single-page A4 PDF", async () => {
    const bytes = await generateLetterPdf(letterFor("Kältebau Nord GmbH", "Frau Schneider"), { singlePage: true });
    expect(hasImage(bytes)).toBe(true);
    // A valid, re-parseable single A4 page (the signature image + letter body).
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(1);
  });

  it("bulk: the SAME global signature is embedded in EVERY company's letter", async () => {
    const companies: Array<[string, string]> = [
      ["Kältebau Nord GmbH", "Frau Schneider"],
      ["Tech Süd AG", "Herr Berger"],
      ["Pflege West gGmbH", "Frau Krüger"],
    ];
    for (const [co, contact] of companies) {
      const bytes = await generateLetterPdf(letterFor(co, contact), { singlePage: true });
      expect(hasImage(bytes), `${co} letter must carry the global signature`).toBe(true);
    }
  });

  it("a letter with NO signature carries no embedded image (optional)", async () => {
    const folio = buildLetterFolio({
      applicantName: "Mustapha Drif",
      applicantEmail: "mustapha.drif@example.de",
      applicantStreet: "Hafenstraße 1",
      applicantPostalCode: "20457",
      applicantCity: "Hamburg",
      applicantCountry: "Deutschland",
      applicantPhone: "+49 151 2345678",
      companyName: "Kältebau Nord GmbH",
      companyContactName: "Frau Schneider",
      companyAddress: "Kältebau Nord GmbH, Hafenstraße 1, 20457 Hamburg",
      subject: "Bewerbung",
      bodyHtml:
        "<p>Sehr geehrte Frau Schneider,</p>" +
        "<p>hiermit bewerbe ich mich um den Ausbildungsplatz.</p>" +
        "<p>Mit freundlichen Grüßen</p>" +
        "<p>Mustapha Drif</p>",
      // no signatureImage
    });
    const bytes = await generateLetterPdf(folio, { singlePage: true });
    expect(hasImage(bytes)).toBe(false);
  });

  it("CV PDFs never contain the signature (the CV renderer has no signature input)", async () => {
    const cv: CvDocument = cvEmpty();
    cv.personal = { ...cv.personal, fullName: "Mustapha Drif" };
    // No photo → no image at all; if a regression ever embedded the signature
    // into CVs, an image XObject would appear here and this would fail.
    const bytes = await generateCvPdf(cv);
    expect(hasImage(bytes)).toBe(false);
  });
});
