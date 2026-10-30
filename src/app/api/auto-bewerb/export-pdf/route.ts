import { NextResponse } from "next/server";
import {
  buildLetterFolio,
  BEW_LETTER_PDF_MIME,
  generateLetterPdf,
  letterPdfFilename,
} from "@/lib/bew-letter-pdf";
import { emailBodyToHtml } from "@/lib/studio";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { autoBewerbLetterSchema } from "@/lib/auto-bewerb/schema";
import { generateCvPdf, cvPdfFilename } from "@/lib/auto-bewerb/cv-pdf";
import {
  getAutoBewerbCompany,
  getLatestAutoBewerbCv,
  getLatestAutoBewerbDocument,
  resolveAutoBewerbPhotoDataUrl,
} from "@/lib/auto-bewerb/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * AUTO BEWERB — PDF export of a company's REVIEWED documents (preview /
 * download). Renders deterministically with the existing pdf-lib pipeline
 * (same renderer the send path uses), reads only the stored, user-reviewed
 * version — nothing is re-generated or invented. No storage write: the PDF
 * is produced on demand and streamed to the owner.
 *
 *  - GET ?companyId=…&doc=cv     → the tailored Lebenslauf (A4, Helvetica)
 *  - GET ?companyId=…&doc=letter → the Anschreiben (letter folio)
 */

export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const companyId = url.searchParams.get("companyId") ?? "";
  const doc = url.searchParams.get("doc");
  if (!companyId || (doc !== "cv" && doc !== "letter")) {
    return NextResponse.json({ error: "companyId and doc (cv|letter) are required." }, { status: 400 });
  }

  const bundle = await getAutoBewerbCompany(user.id, companyId);
  if (!bundle) return NextResponse.json({ error: "Unternehmen nicht gefunden." }, { status: 404 });

  try {
    if (doc === "cv") {
      const cv = await getLatestAutoBewerbCv(user.id, companyId);
      if (!cv) {
        return NextResponse.json(
          { error: "Es ist noch kein Lebenslauf für dieses Unternehmen generiert.", code: "no_document" },
          { status: 404 },
        );
      }
      // The stored photo reference is resolved ownership-scoped HERE (the
      // renderer only ever receives verified bytes; a missing object simply
      // means "no photo"). Preview and export use the SAME resolution —
      // the document is byte-identical by construction.
      const photoDataUrl = await resolveAutoBewerbPhotoDataUrl(user.id, cv.personal.photo).catch(
        () => null,
      );
      const bytes = await generateCvPdf(cv, { photoDataUrl });
      return new NextResponse(Buffer.from(bytes), {
        status: 200,
        headers: {
          "Content-Type": BEW_LETTER_PDF_MIME,
          "Content-Disposition": `attachment; filename="${encodeURIComponent(cvPdfFilename(cv.personal.fullName))}"`,
          "Cache-Control": "no-store",
        },
      });
    }

    // letter
    const letterDoc = await getLatestAutoBewerbDocument(user.id, companyId, "cover_letter");
    const letter = letterDoc ? autoBewerbLetterSchema.safeParse(letterDoc.content) : null;
    if (!letter?.success) {
      return NextResponse.json(
        { error: "Es ist noch kein Anschreiben für dieses Unternehmen generiert.", code: "no_document" },
        { status: 404 },
      );
    }
    const extract = bundle.company.ad_extracted;
    // Letterhead facts from the account profile (profiles is keyed by `id`).
    const { data: prof } = await createAdminClient()
      .from("profiles")
      .select("full_name, email, phone, street, postal_code, city, country")
      .eq("id", user.id)
      .maybeSingle();
    const pr = (prof ?? {}) as Record<string, string | null | undefined>;
    const folio = buildLetterFolio({
      applicantName: pr.full_name ?? null,
      applicantEmail: pr.email ?? null,
      applicantStreet: pr.street ?? null,
      applicantPostalCode: pr.postal_code ?? null,
      applicantCity: pr.city ?? null,
      applicantCountry: pr.country ?? null,
      applicantPhone: pr.phone ?? null,
      companyName: extract?.company ?? bundle.company.company,
      companyContactName: extract?.contactPerson || null,
      companyAddress: extract?.companyAddress || null,
      subject: bundle.company.email_subject || `Bewerbung als ${extract?.jobTitle || extract?.occupation || "Auszubildende:r"}`,
      bodyHtml: emailBodyToHtml(letter.data.text),
    });
    const bytes = await generateLetterPdf(folio);
    return new NextResponse(Buffer.from(bytes), {
      status: 200,
      headers: {
        "Content-Type": BEW_LETTER_PDF_MIME,
        "Content-Disposition": `attachment; filename="${encodeURIComponent(letterPdfFilename(extract?.company || bundle.company.company))}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("[auto-bewerb] PDF export failed:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "PDF konnte nicht erstellt werden." }, { status: 502 });
  }
}
