"use client";

/**
 * Step 1 — company data.
 *
 * Two input methods, one save path:
 *   1. Manual: edit the seeded rows directly (per-row save via
 *      `bewUpdateCompany` — only that row's letter is invalidated).
 *   2. Import: CSV / Excel in the browser (pure parsers) or PDF on the
 *      server (best-effort). EVERY path ends in an editable PREVIEW with
 *      validity + duplicate flags; nothing is stored without the explicit
 *      "Apply" — and the server re-validates the identical rules.
 */
import { useMemo, useRef, useState } from "react";
import {
  bewImportPdf,
  bewSaveCompanies,
  bewUpdateCompany,
} from "@/app/bewerbung-automation/actions";
import { useI18n } from "@/lib/i18n";
import {
  isValidEmail,
  recordsFromCsvMatrix,
} from "@/lib/bewerbung-automation";
import { Button, Card } from "@/components/ui";
import { Icon } from "@/components/icon";
import { StatusPill } from "@/components/ui/feedback";
import {
  initialMapping,
  parseImportFile,
  previewToRecords,
  recordsToPreview,
  type ColumnMapping,
} from "./import-parse";
import type { BewViewDTO, CompanyRecord } from "./types";

interface Props {
  view: BewViewDTO;
  refresh: () => Promise<void>;
  /** Wizard navigation: advance from Companies to Documents (step 2). */
  onNext: () => void;
  /** Exact reason advancing is blocked right now (null = ready to go). */
  nextBlockedReason: string | null;
}

type ImportPhase = "idle" | "preview";

interface ImportState {
  phase: ImportPhase;
  fileName: string;
  header: string[];
  /** The raw cell matrix (CSV/Excel). null for PDF (records come from the
   *  server extraction) and while idle. */
  matrix: string[][] | null;
  records: CompanyRecord[];
  mapping: ColumnMapping;
  fromPdf: boolean;
  error: string | null;
}

const IDLE_IMPORT: ImportState = {
  phase: "idle",
  fileName: "",
  header: [],
  matrix: null,
  records: [],
  mapping: {},
  fromPdf: false,
  error: null,
};

export function CompaniesStep({ view, refresh, onNext, nextBlockedReason }: Props) {
  const { t } = useI18n();
  const apps = view.applications;
  const [importState, setImportState] = useState<ImportState>(IDLE_IMPORT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, CompanyRecord>>({});
  const fileRef = useRef<HTMLInputElement>(null);

  const preview = useMemo(
    () =>
      importState.phase === "preview"
        ? recordsToPreview(importState.records)
        : null,
    [importState.phase, importState.records],
  );

  function setDraft(appId: string, patch: Partial<CompanyRecord>) {
    const app = apps.find((a) => a.id === appId);
    if (!app) return;
    setDrafts((d) => ({
      ...d,
      [appId]: {
        companyName: app.company_name,
        companyEmail: app.company_email,
        contactName: app.contact_name ?? "",
        companyAddress: app.company_address ?? "",
        ...patch,
      },
    }));
  }

  function rowValues(appId: string): CompanyRecord {
    const app = apps.find((a) => a.id === appId);
    if (!app)
      return { companyName: "", companyEmail: "", contactName: "", companyAddress: "" };
    return (
      drafts[appId] ?? {
        companyName: app.company_name,
        companyEmail: app.company_email,
        contactName: app.contact_name ?? "",
        companyAddress: app.company_address ?? "",
      }
    );
  }

  function rowDirty(appId: string): boolean {
    const app = apps.find((a) => a.id === appId);
    if (!app || !drafts[appId]) return false;
    const d = drafts[appId];
    return (
      d.companyName !== app.company_name ||
      d.companyEmail !== app.company_email ||
      (d.contactName || null) !== (app.contact_name ?? null) ||
      (d.companyAddress || null) !== (app.company_address ?? null)
    );
  }

  async function saveRow(appId: string) {
    const app = apps.find((a) => a.id === appId);
    if (!app) return;
    const values = rowValues(appId);
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.set("applicationId", appId);
      fd.set(
        "payload",
        JSON.stringify({
          companyName: values.companyName,
          companyEmail: values.companyEmail,
          contactName: values.contactName || null,
          companyAddress: values.companyAddress || null,
        }),
      );
      await bewUpdateCompany(fd);
      setDrafts((d) => {
        const next = { ...d };
        delete next[appId];
        return next;
      });
      await refresh();
      setNotice(t("bewauto.rowSaved"));
    } catch (e) {
      setError(errMessage(e, t));
    } finally {
      setBusy(false);
    }
  }

  async function handleFile(file: File) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
        const fd = new FormData();
        fd.set("file", file);
        const result = await bewImportPdf(fd);
        if (!result.candidates.length) {
          setImportState({ ...IDLE_IMPORT, phase: "idle", fileName: file.name, error: t("bewauto.pdfNoEmails") });
          return;
        }
        setImportState({
          phase: "preview",
          fileName: file.name,
          header: [],
          matrix: null,
          records: result.candidates.map((c) => ({
            companyName: c.companyName,
            companyEmail: c.email,
            contactName: "",
            companyAddress: "",
          })),
          mapping: {},
          fromPdf: true,
          error: null,
        });
      } else {
        const parsed = await parseImportFile(file);
        if (parsed.matrix.length < 2) {
          setImportState({ ...IDLE_IMPORT, fileName: file.name, error: t("bewauto.importEmpty") });
          return;
        }
        const mapping = initialMapping(parsed.header);
        const records = matrixRecords(parsed.matrix, mapping);
        setImportState({
          phase: "preview",
          fileName: file.name,
          header: parsed.header,
          matrix: parsed.matrix,
          records,
          mapping,
          fromPdf: false,
          error: null,
        });
      }
    } catch (e) {
      setImportState({ ...IDLE_IMPORT, fileName: file.name, error: errMessage(e, t) });
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function changeMapping(field: keyof ColumnMapping, value: string) {
    setImportState((s) => {
      if (s.fromPdf) return s;
      const mapping: ColumnMapping = { ...s.mapping };
      if (value === "") delete mapping[field];
      else mapping[field] = Number(value);
      // Re-derive records from the ORIGINAL matrix with the new mapping, so
      // the user's column reassignment takes effect immediately.
      const records = s.matrix ? matrixRecords(s.matrix, mapping) : s.records;
      return { ...s, mapping, records };
    });
  }

  async function applyImport() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.set("campaignId", view.campaign.id);
      fd.set("records", JSON.stringify(previewToRecords(preview)));
      const result = await bewSaveCompanies(fd);
      await refresh();
      setImportState(IDLE_IMPORT);
      setNotice(
        t("bewauto.importDone", {
          n: result.total,
          valid: result.valid,
        }),
      );
    } catch (e) {
      setError(errMessage(e, t));
    } finally {
      setBusy(false);
    }
  }

  const lockApp = view.campaign.status === "sending";

  /* The wizard footer button is disabled ONLY when a required operation is
     still in flight (busy) or the company data is genuinely incomplete
     (nextBlockedReason, computed from the stored rows by the wizard). The
     exact reason is rendered next to the button — never a silent disable. */
  const advanceBlocked = busy || nextBlockedReason !== null;
  const advanceReason = busy ? t("bewauto.continueDocsSaving") : nextBlockedReason;

  return (
    <div className="grid gap-6">
      <Card className="p-6">
        <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold text-ink">{t("bewauto.step1Title")}</h2>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">
              {t("bewauto.step1Body")}
            </p>
          </div>
          <a
            href="/api/bewerbung/template"
            className="inline-flex h-9 items-center gap-2 rounded-xl border border-line-strong bg-surface px-3.5 text-xs font-semibold text-ink-soft transition hover:bg-surface-2"
          >
            <Icon name="download" size={15} />
            {t("bewauto.templateLink")}
          </a>
        </div>

        {/* Import wizard */}
        <div className="rounded-2xl border border-dashed border-line-strong bg-surface-2/40 p-4">
          {importState.phase === "idle" ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-ink-soft">{t("bewauto.importTitle")}</p>
                <p className="mt-0.5 text-xs leading-5 text-muted">{t("bewauto.importHint")}</p>
              </div>
              <div>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".csv,.xlsx,.xls,.pdf,text/csv"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void handleFile(f);
                  }}
                />
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy || lockApp}
                  onClick={() => fileRef.current?.click()}
                >
                  <Icon name="upload" size={15} />
                  {t("bewauto.chooseFile")}
                </Button>
              </div>
            </div>
          ) : (
            importState.error ? null : (
              <ImportPreview
                fileName={importState.fileName}
                fromPdf={importState.fromPdf}
                header={importState.header}
                mapping={importState.mapping}
                onMap={changeMapping}
                preview={preview!}
                onChangeRecord={(index, patch) =>
                  setImportState((s) => ({
                    ...s,
                    records: s.records.map((r, i) => (i === index ? { ...r, ...patch } : r)),
                  }))
                }
                onRemoveRecord={(index) =>
                  setImportState((s) => ({
                    ...s,
                    records: s.records.filter((_, i) => i !== index),
                  }))
                }
                onApply={() => void applyImport()}
                onCancel={() => setImportState(IDLE_IMPORT)}
                busy={busy}
                t={t}
              />
            )
          )}
          {importState.error && (
            <p className="mt-2 text-xs font-medium text-danger">{importState.error}</p>
          )}
          {busy && importState.phase === "preview" && (
            <p className="mt-2 text-xs text-muted">{t("bewauto.saving")}</p>
          )}
        </div>

        {error && <AlertLine message={error} />}
        {notice && !error && <InfoLine message={notice} />}

        {/* Manual table */}
        <div className="mt-6">
          <p className="mb-2 text-sm font-semibold text-ink-soft">
            {t("bewauto.manageTitle")} ({apps.length})
          </p>
          <div className="max-h-96 overflow-auto rounded-2xl border border-line">
            <table className="w-full min-w-[760px] border-collapse text-sm">
              <thead className="sticky top-0 z-10 bg-surface-2 text-xs uppercase tracking-wide text-muted">
                <tr>
                  <Th>{t("bewauto.colRow")}</Th>
                  <Th>{t("bewauto.colCompany")}</Th>
                  <Th>{t("bewauto.colEmail")}</Th>
                  <Th>{t("bewauto.colContact")}</Th>
                  <Th>{t("bewauto.colAddress")}</Th>
                  <Th>{t("bewauto.colStatus")}</Th>
                </tr>
              </thead>
              <tbody>
                {apps.map((app) => {
                  const values = rowValues(app.id);
                  const dirty = rowDirty(app.id);
                  const emailOk = isValidEmail(values.companyEmail);
                  const nameOk = values.companyName.trim().length > 0;
                  return (
                    <tr key={app.id} className="border-t border-line align-top">
                      <td className="px-3 py-2.5 text-xs font-semibold text-faint">{app.seq}</td>
                      <td className="px-2 py-1.5">
                        <MiniInput
                          value={values.companyName}
                          disabled={lockApp}
                          error={!nameOk && values.companyName !== ""}
                          placeholder={t("bewauto.phCompany")}
                          onChange={(v) => setDraft(app.id, { companyName: v })}
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <MiniInput
                          value={values.companyEmail}
                          disabled={lockApp}
                          error={!emailOk}
                          placeholder={t("bewauto.phEmail")}
                          onChange={(v) => setDraft(app.id, { companyEmail: v })}
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <MiniInput
                          value={values.contactName}
                          disabled={lockApp}
                          placeholder={t("bewauto.phContact")}
                          onChange={(v) => setDraft(app.id, { contactName: v })}
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <MiniInput
                          value={values.companyAddress}
                          disabled={lockApp}
                          placeholder={t("bewauto.phAddress")}
                          onChange={(v) => setDraft(app.id, { companyAddress: v })}
                        />
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex flex-col items-start gap-2">
                          <RowStatus app={app} emailOk={emailOk} nameOk={nameOk} t={t} />
                          {dirty && !lockApp && (
                            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void saveRow(app.id)}>
                              {t("bewauto.save")}
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Wizard footer — the explicit, always-visible way forward.
            (Previously the ONLY navigation was the small stepper chip at the
            top; when its counter gate had not caught up it rendered disabled
            and unexplained, so users saw no way to reach Documents.) */}
        <div className="mt-6 flex flex-col-reverse gap-2 border-t border-line pt-5 sm:flex-row sm:items-center sm:justify-between">
          {advanceBlocked && (
            <p
              id="bew-continue-blocked"
              role="status"
              className="text-xs font-medium leading-5 text-muted"
            >
              {advanceReason}
            </p>
          )}
          <Button
            size="lg"
            disabled={advanceBlocked}
            onClick={onNext}
            aria-describedby={advanceBlocked ? "bew-continue-blocked" : undefined}
          >
            {t("bewauto.continueDocs")}
            <Icon name="arrowRight" size={18} />
          </Button>
        </div>
      </Card>
    </div>
  );
}

/* ---------------- sub-components ---------------- */

/** Matrix (rows 2..n) + mapping → editable records (pure, shared rules). */
function matrixRecords(
  matrix: string[][],
  mapping: ColumnMapping,
): CompanyRecord[] {
  const records = recordsFromCsvMatrix(matrix, mapping);
  return records.map((r) => ({
    companyName: r.companyName ?? "",
    companyEmail: r.companyEmail ?? "",
    contactName: r.contactName ?? "",
    companyAddress: r.companyAddress ?? "",
  }));
}

function Th({ children }: { children?: React.ReactNode }) {
  return <th className="px-3 py-2.5 text-start font-semibold">{children}</th>;
}

function MiniInput({
  value,
  onChange,
  error,
  placeholder,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  error?: boolean;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <input
      value={value}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className={`w-full min-w-40 rounded-xl border bg-surface px-2.5 py-1.5 text-sm text-ink outline-none transition placeholder:text-faint focus:border-accent focus:ring-2 focus:ring-accent/10 disabled:opacity-50 ${
        error ? "border-danger" : "border-line-strong"
      }`}
    />
  );
}

function RowStatus({
  app,
  emailOk,
  nameOk,
  t,
}: {
  app: { status: string; error_code: string | null };
  emailOk: boolean;
  nameOk: boolean;
  t: (k: string, v?: Record<string, string | number>) => string;
}) {
  if (app.status === "generated" || app.status === "sent")
    return <StatusPill tone="success" label={t("bewauto.rowReady")} />;
  if (app.status === "failed" || app.status === "needs_attention")
    return <StatusPill tone="blocked" label={t("bewauto.rowError")} />;
  if (app.status === "queued" || app.status === "sending")
    return <StatusPill tone="running" label={t("bewauto.rowQueued")} />;
  if (app.status === "excluded" || app.status === "cancelled")
    return <StatusPill tone="neutral" label={t("bewauto.rowExcluded")} />;
  if (!emailOk || !nameOk) return <StatusPill tone="unverified" label={t("bewauto.rowIncomplete")} />;
  return <StatusPill tone="neutral" label={t("bewauto.rowPending")} />;
}

/* ---------------- import preview ---------------- */

function ImportPreview({
  fileName,
  fromPdf,
  header,
  mapping,
  onMap,
  preview,
  onChangeRecord,
  onRemoveRecord,
  onApply,
  onCancel,
  busy,
  t,
}: {
  fileName: string;
  fromPdf: boolean;
  header: string[];
  mapping: ColumnMapping;
  onMap: (field: keyof ColumnMapping, value: string) => void;
  preview: NonNullable<ReturnType<typeof recordsToPreview>>;
  onChangeRecord: (index: number, patch: Partial<CompanyRecord>) => void;
  onRemoveRecord: (index: number) => void;
  onApply: () => void;
  onCancel: () => void;
  busy: boolean;
  t: (k: string, v?: Record<string, string | number>) => string;
}) {
  const dupSet = new Set(preview.duplicateEmails);
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-ink-soft">
            {t("bewauto.previewTitle")} — {fileName}
          </p>
          <p className="mt-0.5 text-xs leading-5 text-muted">
            {fromPdf ? t("bewauto.pdfBestEffort") : t("bewauto.previewHint")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            {t("bewauto.cancelImport")}
          </Button>
          <Button size="sm" onClick={onApply} disabled={busy || preview.rows.length === 0}>
            {t("bewauto.applyImport")}
          </Button>
        </div>
      </div>

      {/* column mapping (only when the file had a header row) */}
      {!fromPdf && header.length > 0 && (
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {(
            [
              ["companyName", t("bewauto.mapCompany")],
              ["companyEmail", t("bewauto.mapEmail")],
              ["contactName", t("bewauto.mapContact")],
              ["companyAddress", t("bewauto.mapAddress")],
            ] as const
          ).map(([field, label]) => (
            <label key={field} className="block">
              <span className="mb-1.5 block text-xs font-semibold text-ink-soft">{label}</span>
              <select
                value={mapping[field] ?? ""}
                onChange={(e) => onMap(field, e.target.value)}
                className="h-10 w-full rounded-xl border border-line-strong bg-surface px-2.5 text-sm text-ink outline-none focus:border-accent"
              >
                <option value="">{t("bewauto.mapSkip")}</option>
                {header.map((h, i) => (
                  <option key={i} value={i}>
                    {h || `#${i + 1}`}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      )}

      {/* summary chips */}
      <div className="mt-4 flex flex-wrap gap-2">
        <StatusPill tone="neutral" label={t("bewauto.rowsFound", { n: preview.rows.length })} />
        <StatusPill tone="success" label={t("bewauto.validCount", { n: preview.validCount })} />
        {preview.invalidEmailCount > 0 && (
          <StatusPill tone="blocked" label={t("bewauto.invalidWarning", { n: preview.invalidEmailCount })} />
        )}
        {preview.duplicateEmails.length > 0 && (
          <StatusPill tone="unverified" label={t("bewauto.dupWarning", { n: preview.duplicateEmails.length })} />
        )}
      </div>

      {/* preview table (editable, all rows kept) */}
      <div className="mt-3 max-h-80 overflow-auto rounded-2xl border border-line">
        <table className="w-full min-w-[640px] border-collapse text-sm">
          <thead className="sticky top-0 bg-surface-2 text-xs uppercase tracking-wide text-muted">
            <tr>
              <Th>{t("bewauto.colRow")}</Th>
              <Th>{t("bewauto.colCompany")}</Th>
              <Th>{t("bewauto.colEmail")}</Th>
              <Th>{t("bewauto.colStatus")}</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {preview.rows.map((row, i) => {
              const isDup = row.companyEmail !== "" && dupSet.has(row.companyEmail.toLowerCase());
              return (
                <tr key={row.seq} className="border-t border-line align-top">
                  <td className="px-3 py-2 text-xs font-semibold text-faint">{row.seq}</td>
                  <td className="px-2 py-1.5">
                    <MiniInput
                      value={row.companyName}
                      placeholder={t("bewauto.phCompany")}
                      onChange={(v) => onChangeRecord(i, { companyName: v })}
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <MiniInput
                      value={row.companyEmail}
                      error={!row.valid && row.problems.some((p) => p.startsWith("company_email"))}
                      placeholder={t("bewauto.phEmail")}
                      onChange={(v) => onChangeRecord(i, { companyEmail: v })}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <div className="text-xs leading-5">
                      {row.valid ? (
                        <StatusPill tone="success" label={t("bewauto.rowOk")} />
                      ) : (
                        <span className="text-danger">
                          {row.problems.map((p) => p.split(":")[0]).filter(Boolean).join(" · ")}
                          {isDup && ` · ${t("bewauto.dup")}`}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-2 py-2">
                    <button
                      type="button"
                      onClick={() => onRemoveRecord(i)}
                      className="rounded-lg p-1.5 text-faint hover:bg-surface-2 hover:text-danger"
                      aria-label={t("bewauto.removeRow")}
                    >
                      <Icon name="trash" size={15} />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AlertLine({ message }: { message: string }) {
  return (
    <p role="alert" className="mt-3 text-sm font-medium text-danger">
      {message}
    </p>
  );
}

function InfoLine({ message }: { message: string }) {
  return (
    <p role="status" className="mt-3 text-sm font-medium text-success">
      {message}
    </p>
  );
}

function errMessage(e: unknown, t: (k: string, v?: Record<string, string | number>) => string): string {
  const code = e instanceof Error ? e.message : "";
  const key = `bewauto.err.${code}`;
  const translated = t(key);
  return translated === key ? t("bewauto.err.UNKNOWN") : translated;
}
