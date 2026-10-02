import ExcelJS from "exceljs";
import { NextResponse } from "next/server";
import { getCurrentUserAndProfile } from "@/lib/auth";
import {
  discoveryFailure,
  unauthorizedResponse,
} from "@/lib/company-discovery/api";
import { isEligiblePublicEmail } from "@/lib/company-discovery/accept";
import { classifyDiscoveryDbError } from "@/lib/company-discovery/errors";
import {
  getDiscoveryRunStrict,
  listRunCompaniesWithEmails,
} from "@/lib/company-discovery/runs";
import { SUPPORTED_LANGUAGES, type Language } from "@/lib/i18n/dictionaries";
import { translate } from "@/lib/i18n/core";

/**
 * GET /api/company-discovery/[runId]/export — the run as an .xlsx workbook.
 *
 * Content is EXACTLY what the run stored: companies, their published address
 * with the page it was read from, the offer facts and the run id.
 *
 * Column contract (§4.10): the owner's list and order —
 *   Company Name · Website · Public Email · Email Source · Email Source URL ·
 *   Role · Field · City · State · Offer Type · Beginn · Salary ·
 *   Offer Source · Offer URL · Discovery Run ID
 * — plus a final `Email Status` column ONLY when the workbook contains
 * companies without an address (`onlyPublicEmail=false`), so a blank email is
 * explainable. Every column of the previous release is still present and still
 * means the same thing.
 *
 * Injection safety: a cell whose text starts with `=`, `+`, `-`, `@`, TAB or CR
 * is written as plain text (prefixed with an apostrophe) so a scraped value can
 * never become a formula. UTF-8 is untouched (umlauts, Arabic).
 *
 * The workbook library (`exceljs`) is the dependency the project already
 * declares; no new package is added.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const INJECTION_PREFIX_RE = /^[=+\-@\t\r]/;

/** A scraped value can never become a formula. */
export function safeCell(value: string | null | undefined): string {
  const text = value ?? "";
  return INJECTION_PREFIX_RE.test(text) ? `'${text}` : text;
}

function normalizeLang(value: string | null): Language {
  const lang = (value ?? "").trim().toLowerCase();
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(lang)
    ? (lang as Language)
    : "de";
}

/** 2027 when the run asked for a concrete year, else the run's own year. */
function workbookYear(
  beginn: { mode: string; year?: number },
  createdAt: string,
): number {
  if (beginn.mode === "year" && typeof beginn.year === "number") {
    if (beginn.year >= 2000 && beginn.year <= 2100) return beginn.year;
  }
  const parsed = new Date(createdAt);
  return Number.isFinite(parsed.getTime())
    ? parsed.getUTCFullYear()
    : new Date().getUTCFullYear();
}

export async function GET(
  request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active")
    return unauthorizedResponse();

  const { runId } = await context.params;
  const lang = normalizeLang(new URL(request.url).searchParams.get("lang"));

  try {
    const run = await getDiscoveryRunStrict(runId, user.id);
    if (!run) return discoveryFailure("not_found", 404, "Run not found.");

    const companies = await listRunCompaniesWithEmails(runId, user.id);
    const exportable = companies.filter((company) => company.status === "accepted");
    // Only a workbook that actually contains an address-less company needs the
    // extra column — otherwise the target column list stays exactly as ordered.
    const includeEmailStatus = exportable.some(
      (company) => company.emails.length === 0,
    );

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Ausbildung Hunter AI";
    workbook.created = new Date();

    const sheet = workbook.addWorksheet("Companies");
    sheet.columns = [
      { header: "Company Name", key: "companyName", width: 34 },
      { header: "Website", key: "websiteUrl", width: 30 },
      { header: "Public Email", key: "email", width: 30 },
      { header: "Email Source", key: "emailSource", width: 34 },
      { header: "Email Source URL", key: "emailSourceUrl", width: 44 },
      { header: "Role", key: "role", width: 28 },
      { header: "Field", key: "field", width: 22 },
      { header: "City", key: "city", width: 18 },
      { header: "State", key: "state", width: 14 },
      { header: "Offer Type", key: "offerType", width: 14 },
      { header: "Beginn", key: "beginn", width: 14 },
      { header: "Salary", key: "salaryLabel", width: 20 },
      { header: "Offer Source", key: "offerSource", width: 18 },
      { header: "Offer URL", key: "offerUrl", width: 40 },
      { header: "Discovery Run ID", key: "runId", width: 38 },
      ...(includeEmailStatus
        ? [{ header: "Email Status", key: "emailStatus", width: 18 }]
        : []),
    ];
    sheet.getRow(1).font = { bold: true };

    for (const company of exportable) {
      // §4.6: with `onlyPublicEmail=true` only an address WITH provenance is
      // exported. A legacy row (BA-derived `offer`, or no source page) is
      // reported as unverified instead of being presented as a public address.
      const address = run.params.onlyPublicEmail
        ? (company.emails.find((entry) => isEligiblePublicEmail(entry)) ?? null)
        : (company.emails[0] ?? null);
      const legacy = address === null && company.emails.length > 0;
      sheet.addRow({
        companyName: safeCell(company.companyName),
        websiteUrl: safeCell(company.websiteUrl),
        // No address → a BLANK cell; the honest label lives in Email Status.
        email: safeCell(address?.email ?? ""),
        emailSource: address
          ? translate(lang, `companyDiscovery.results.emailSource.${address.sourceType}`)
          : "",
        emailSourceUrl: safeCell(address?.sourceUrls[0] ?? address?.sourceUrl ?? ""),
        role: safeCell(company.role),
        field: safeCell(company.field),
        city: safeCell(company.city),
        state: safeCell(company.state),
        offerType: safeCell(company.offerType),
        beginn: safeCell(company.beginn),
        salaryLabel: safeCell(company.salaryLabel),
        offerSource: safeCell(company.offerSource),
        offerUrl: safeCell(company.offerUrl),
        runId: run.runId,
        ...(includeEmailStatus
          ? {
              emailStatus: legacy
                ? "unverified_legacy"
                : (company.emailStatus ??
                  (address ? "email_found" : company.rejectReason ?? "no_public_email")),
            }
          : {}),
      });
    }

    // Second sheet: the run itself (params + real counters + the source
    // report), so the file is self-describing when it is forwarded.
    const meta = workbook.addWorksheet("Run");
    meta.columns = [
      { header: "Field", key: "field", width: 26 },
      { header: "Value", key: "value", width: 60 },
    ];
    meta.getRow(1).font = { bold: true };
    const beginnLabel =
      run.params.beginn.mode === "from_now"
        ? "from now"
        : run.params.beginn.mode === "date"
          ? run.params.beginn.date
          : run.params.beginn.mode === "month"
            ? run.params.beginn.month
            : String(run.params.beginn.year);
    for (const [field, value] of [
      ["Discovery Run ID", run.runId],
      ["Status", run.status],
      ["Field", run.params.field],
      ["Role", run.params.role],
      ["Beginn", beginnLabel],
      ["Offer type", run.params.goal],
      ["Only companies with a public email", run.params.onlyPublicEmail ? "yes" : "no"],
      ["Target companies", String(run.progress.targetCompanies)],
      ["Companies found", String(run.progress.foundCompanies)],
      ["Emails found", String(run.progress.emailsFound)],
      ["No public email", String(run.progress.noPublicEmail)],
      ["Sources blocked", String(run.progress.sourcesBlocked)],
      ["Offers analyzed", String(run.progress.offersAnalyzed)],
      ["Unique companies", String(run.progress.uniqueCompanies)],
      ["Duplicates removed", String(run.progress.duplicatesRemoved)],
      ["Companies rejected", String(run.progress.companiesRejected)],
      ["Created", run.createdAt],
      ["Finished", run.finishedAt ?? ""],
    ] as Array<[string, string]>) {
      meta.addRow({ field: safeCell(field), value: safeCell(value) });
    }
    for (const source of run.progress.sources) {
      meta.addRow({
        field: `Source: ${safeCell(source.displayName ?? source.id)}`,
        value: safeCell(
          `${source.status}${source.reason ? ` (${source.reason})` : ""} — offers: ${source.candidates ?? 0}`,
        ),
      });
    }

    const buffer = await workbook.xlsx.writeBuffer();
    const year = workbookYear(
      run.params.beginn.mode === "year"
        ? { mode: "year", year: run.params.beginn.year }
        : { mode: run.params.beginn.mode },
      run.createdAt,
    );
    const filename = `ausbildung-company-discovery-${year}-${run.runId.slice(0, 8)}.xlsx`;

    return new NextResponse(buffer as ArrayBuffer, {
      status: 200,
      headers: {
        "content-type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `attachment; filename="${filename}"`,
        "content-length": String(buffer.byteLength),
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    const code = classifyDiscoveryDbError(error);
    console.error(
      `[company-discovery] export failed run="${runId}" code="${code}"`,
      error,
    );
    return discoveryFailure(code, 500, "Failed to build the discovery export.");
  }
}
