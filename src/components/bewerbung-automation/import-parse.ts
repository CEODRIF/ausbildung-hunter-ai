"use client";

/**
 * Client-side import pipeline for the company list (step 1).
 *
 * The file is read in the browser (CSV text or XLSX bytes), parsed into a
 * plain string matrix, mapped (auto-detected + user-correctable) and reduced
 * to a PREVIEW through the SAME pure functions the server uses
 * (`recordsFromCsvMatrix` + `buildImportResult`). Nothing is stored until the
 * user confirms the preview — and then the server re-runs the identical
 * validation, so the client can never smuggle an unvalidated row in.
 */
import * as XLSX from "xlsx";
import {
  autoMapColumns,
  buildImportResult,
  mergeColumnMapping,
  parseCompaniesCsv,
  recordsFromCsvMatrix,
  type CompanyField,
} from "@/lib/bewerbung-automation";
import type { CompanyRecord, PreviewResult } from "./types";

export type ColumnMapping = Partial<Record<CompanyField, number>>;

export interface ParsedFile {
  matrix: string[][];
  header: string[];
}

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const XLS_LEGACY_MIME = "application/vnd.ms-excel";

function isExcel(file: File): boolean {
  return (
    /\.(xlsx|xlsm|xls)$/i.test(file.name) ||
    file.type === XLSX_MIME ||
    file.type === XLS_LEGACY_MIME
  );
}

/** Read a CSV or Excel file into a cell matrix (first row = header). */
export async function parseImportFile(file: File): Promise<ParsedFile> {
  if (isExcel(file)) {
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer);
    const firstSheetName = workbook.SheetNames[0];
    const sheet = firstSheetName ? workbook.Sheets[firstSheetName] : undefined;
    if (!sheet) throw new Error("EMPTY_WORKBOOK");
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      raw: false,
      defval: "",
    });
    const matrix = rows.map((row) =>
      row.map((cell) => String(cell ?? "").trim()),
    );
    // Drop rows that are entirely empty.
    const clean = matrix.filter((r) => r.some((c) => c !== ""));
    return { matrix: clean, header: clean[0] ?? [] };
  }
  const text = await file.text();
  const matrix = parseCompaniesCsv(text);
  return { matrix, header: matrix[0] ?? [] };
}

/** Auto-detect the column mapping from the header row. */
export function initialMapping(header: readonly string[]): ColumnMapping {
  return autoMapColumns(header);
}

/** Re-detect but keep the user's explicit choices. */
export function remap(
  header: readonly string[],
  explicit: ColumnMapping | null,
): ColumnMapping {
  return mergeColumnMapping(autoMapColumns(header), explicit);
}

/** Reduce matrix + mapping to the preview (validity, duplicates, counts).
 *  Uses the SAME builder options as the server save path, so what the user
 *  previews is byte-for-byte what gets stored (including flagged name
 *  suggestions). */
export function buildPreview(
  matrix: string[][],
  mapping: ColumnMapping,
): PreviewResult {
  const records = recordsFromCsvMatrix(matrix, mapping);
  const result = buildImportResult(records, 1);
  return {
    rows: result.rows.map((r) => ({
      seq: r.seq,
      companyName: r.companyName,
      companyEmail: r.companyEmail,
      contactName: r.contactName,
      companyAddress: r.companyAddress,
      valid: r.valid,
      problems: r.problems,
    })),
    validCount: result.validCount,
    invalidEmailCount: result.invalidEmailCount,
    duplicateEmails: result.duplicateEmails,
  };
}

/** Preview from already-mapped records (used by the PDF candidate path and
 *  when the user edits a preview row). Same builder as the matrix path. */
export function recordsToPreview(records: CompanyRecord[]): PreviewResult {
  const result = buildImportResult(
    records.map((r) => ({
      companyName: r.companyName,
      companyEmail: r.companyEmail,
      contactName: r.contactName,
      companyAddress: r.companyAddress,
    })),
    1,
  );
  return {
    rows: result.rows.map((r) => ({
      seq: r.seq,
      companyName: r.companyName,
      companyEmail: r.companyEmail,
      contactName: r.contactName,
      companyAddress: r.companyAddress,
      valid: r.valid,
      problems: r.problems,
    })),
    validCount: result.validCount,
    invalidEmailCount: result.invalidEmailCount,
    duplicateEmails: result.duplicateEmails,
  };
}

/** Convert a preview into the record payload the save action expects. */
export function previewToRecords(
  preview: PreviewResult,
): Array<{
  companyName: string;
  companyEmail: string;
  contactName: string | null;
  companyAddress: string | null;
}> {
  return preview.rows.map((r) => ({
    companyName: r.companyName,
    companyEmail: r.companyEmail,
    contactName: r.contactName,
    companyAddress: r.companyAddress,
  }));
}
