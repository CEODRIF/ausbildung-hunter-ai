"use client";

import type { ReactNode } from "react";
import { AlertTriangle, Building2, FileText } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import {
  resolveAutoBewerbRecipient,
  type AutoBewerbCompanyView,
  type AutoBewerbAttachmentRow,
} from "@/lib/auto-bewerb/schema";
import { companyLabel, useAutoBewerb } from "./shared";

/**
 * Step 6 — "Companies and attachments": the clean, READ-ONLY company list.
 *
 * Each row shows exactly what the reference layout requires: company name,
 * the applied position, the company's OWN cover-letter PDF, the shared
 * supporting documents — as compact attachment chips with filenames.
 *
 * Recipient handling (deliberately unchanged business logic):
 *   - the verified per-company recipient stays in the DATA (the send engine
 *     resolves it via `resolveAutoBewerbRecipient` exactly as before);
 *   - the address itself is no longer shown next to each company;
 *   - a company WITHOUT a verified recipient gets a clear warning pointing
 *     back to Step 2 (nothing is invented, nothing is silent).
 *
 * Computed from the same inputs as the send engine (saved settings flags,
 * per-company documents, shared library) — the list never disagrees with
 * the dispatch. `footer` hosts the ONE global sending-account selector.
 */

type Entry = { name: string; kind: "cv" | "letter" | "shared" };

function buildEntries(v: AutoBewerbCompanyView, attachCv: boolean, attachLetter: boolean, shared: AutoBewerbAttachmentRow[]): Entry[] {
  const seen = new Set<string>();
  const out: Entry[] = [];
  const push = (name: string | null | undefined, kind: Entry["kind"]) => {
    const n = (name ?? "").trim();
    if (!n || seen.has(n)) return; // never attach a duplicate filename
    seen.add(n);
    out.push({ name: n, kind });
  };
  if (attachCv) push(v.cvPdfName, "cv");
  if (attachLetter) push(v.letterPdfName, "letter");
  for (const a of shared) push(a.display_name, "shared");
  return out;
}

export function AttachmentManifest({ footer }: { footer?: ReactNode }) {
  const { ws } = useAutoBewerb();
  const { t } = useI18n();
  const s = ws.emailSettings; // null = legacy (per-company flags)

  if (ws.companies.length === 0) return null;

  const kindLabel = (k: Entry["kind"]) =>
    k === "cv" ? t("autoBewerb.attachCvPdf") : k === "letter" ? t("autoBewerb.attachLetterPdf") : t("autoBewerb.attachSharedDocs");

  const rows = ws.companies.map((v) => {
    const attachCv = s ? s.attachCv : v.company.email_attach_cv;
    const attachLetter = s ? s.attachLetter : v.company.email_attach_letter;
    const dest = resolveAutoBewerbRecipient(s?.recipient ?? "", v.company.recipient_email, v.company.ad_extracted);
    const entries = buildEntries(v, attachCv, attachLetter, ws.attachments);
    const missing: string[] = [];
    if (!dest) missing.push(t("autoBewerb.missingRecipientStep2"));
    if (attachCv && !v.cv) missing.push(t("autoBewerb.missingCv"));
    if (attachLetter && !v.letter) missing.push(t("autoBewerb.missingLetter"));
    return { v, entries, missing, count: entries.length };
  });
  const total = rows.reduce((n, r) => n + r.count, 0);

  return (
    <section className="rounded-3xl border border-line bg-surface p-4 shadow-[var(--shadow-card)] sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-bold text-ink">{t("autoBewerb.companiesTitle")}</h3>
        <span className="rounded-full border border-line bg-surface-2 px-3 py-1 text-xs font-semibold text-ink-soft">
          {t("autoBewerb.manifestTotal", { count: total })}
        </span>
      </div>
      <p className="mt-1 text-xs text-muted">{t("autoBewerb.companiesHint")}</p>

      {/* Column header (desktop); on mobile the two columns stack */}
      <div className="mt-4 hidden grid-cols-[minmax(0,5fr)_minmax(0,7fr)] gap-4 border-b border-line pb-2 text-xs font-semibold text-muted sm:grid">
        <span>{t("autoBewerb.companiesColCompany")}</span>
        <span>{t("autoBewerb.companiesColAttachments")}</span>
      </div>

      <ul className="divide-y divide-line">
        {rows.map((r) => {
          const { name, job } = companyLabel(r.v.company);
          return (
            <li key={r.v.company.id} className="grid grid-cols-1 gap-2 py-3 sm:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] sm:gap-4">
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-line bg-surface-2">
                  <Building2 size={16} className="text-accent" strokeWidth={1.8} />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold text-ink">{name}</span>
                  {job ? <span className="block truncate text-xs text-muted">{job}</span> : null}
                </span>
              </div>

              <div className="min-w-0">
                {r.entries.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {r.entries.map((e) => (
                      <span
                        key={`${e.kind}-${e.name}`}
                        title={kindLabel(e.kind)}
                        className="flex max-w-full items-center gap-1.5 rounded-full border border-line bg-surface-2 px-2.5 py-1 text-[11px] font-medium text-ink-soft"
                      >
                        <FileText size={12} className="shrink-0 text-faint" />
                        <span className="max-w-[220px] truncate">{e.name}</span>
                      </span>
                    ))}
                  </div>
                ) : (
                  <span className="text-xs text-muted">{t("autoBewerb.noAttachments")}</span>
                )}
                {r.missing.length > 0 && (
                  <p className="mt-1.5 flex items-center gap-1.5 text-xs font-semibold leading-5 text-warning">
                    <AlertTriangle size={12} className="shrink-0" />
                    {r.missing.join(" · ")}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {footer && <div className="mt-3">{footer}</div>}
    </section>
  );
}
