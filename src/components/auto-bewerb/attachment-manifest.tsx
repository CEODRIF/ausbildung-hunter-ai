"use client";

/**
 * Step 6 — "Companies and documents to be sent" (the attachment manifest).
 *
 * A READ-ONLY, per-company breakdown of EXACTLY what each application email
 * will carry, computed from the same data the send engine uses (so the
 * manifest never disagrees with the dispatch):
 *   - the company's OWN tailored CV PDF (filename),
 *   - the company's OWN individualized Anschreiben PDF (filename),
 *   - every shared supporting document from the user's library,
 * with a per-company document count and a batch-wide total. Each company keeps
 * its verified recipient + a personalized subject preview. Missing required
 * documents surface as clear warnings (companies that can't send are flagged).
 * No cross-company file can appear: every entry is scoped to that company.
 */
import { useState } from "react";
import { ChevronDown, FileText, Layers } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import {
  buildAutoBewerbGreeting,
  resolveAutoBewerbRecipient,
  substituteEmailTokens,
  type AutoBewerbCompanyView,
  type AutoBewerbAttachmentRow,
} from "@/lib/auto-bewerb/schema";
import { companyLabel, statusPill, useAutoBewerb } from "./shared";

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

export function AttachmentManifest() {
  const { ws } = useAutoBewerb();
  const { t } = useI18n();
  const s = ws.emailSettings; // null = legacy (per-company flags)
  const [open, setOpen] = useState<Record<string, boolean>>({});

  if (ws.companies.length === 0) return null;

  const valuesFor = (v: AutoBewerbCompanyView) => {
    const contactPerson = String(v.company.ad_extracted?.contactPerson ?? "").trim();
    return {
      candidate_name: ws.candidateName,
      contact_person: contactPerson,
      company_name: String(v.company.ad_extracted?.company || v.company.company || "").trim(),
      greeting: buildAutoBewerbGreeting(contactPerson),
      position: String(v.company.ad_extracted?.jobTitle || v.company.ad_extracted?.occupation || "").trim(),
    };
  };

  const rows = ws.companies.map((v) => {
    const attachCv = s ? s.attachCv : v.company.email_attach_cv;
    const attachLetter = s ? s.attachLetter : v.company.email_attach_letter;
    const dest = resolveAutoBewerbRecipient(s?.recipient ?? "", v.company.recipient_email, v.company.ad_extracted);
    const subjectTemplate = s ? s.subject : (v.company.email_subject ?? "");
    const entries = buildEntries(v, attachCv, attachLetter, ws.attachments);
    const missing: string[] = [];
    if (!dest) missing.push(t("autoBewerb.missingRecipient"));
    if (attachCv && !v.cv) missing.push(t("autoBewerb.missingCv"));
    if (attachLetter && !v.letter) missing.push(t("autoBewerb.missingLetter"));
    return {
      v,
      dest,
      subject: substituteEmailTokens(subjectTemplate, valuesFor(v)).trim(),
      entries,
      missing,
      count: entries.length,
    };
  });
  const total = rows.reduce((n, r) => n + r.count, 0);
  const hasIssue = (id: string) => rows.find((r) => r.v.company.id === id)?.missing.length ?? 0 > 0;
  const isOpen = (id: string) => open[id] ?? hasIssue(id);

  const kindLabel = (k: Entry["kind"]) =>
    k === "cv" ? t("autoBewerb.attachCvPdf") : k === "letter" ? t("autoBewerb.attachLetterPdf") : t("autoBewerb.attachSharedDocs");

  return (
    <section className="rounded-3xl border border-line bg-surface p-4 shadow-[var(--shadow-card)] sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-base font-bold text-ink">
          <Layers size={18} className="text-accent" />
          {t("autoBewerb.manifestTitle")}
        </h3>
        <span className="rounded-full border border-line bg-surface-2 px-3 py-1 text-xs font-semibold text-ink-soft">
          {t("autoBewerb.manifestTotal", { count: total })}
        </span>
      </div>
      <p className="mt-1 text-xs text-muted">{t("autoBewerb.manifestHint")}</p>

      <ul className="mt-3 divide-y divide-line">
        {rows.map((r) => {
          const { name, job } = companyLabel(r.v.company);
          const id = r.v.company.id;
          const openNow = isOpen(id);
          return (
            <li key={id} className="py-2">
              <button
                type="button"
                onClick={() => setOpen((o) => ({ ...o, [id]: !openNow }))}
                className="flex w-full items-center gap-2 text-start"
                aria-expanded={openNow}
              >
                <ChevronDown size={15} className={`shrink-0 text-faint transition-transform ${openNow ? "" : "-rotate-90"}`} />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="truncate text-sm font-semibold text-ink">
                      {name} {job ? <span className="font-normal text-ink-soft">— {job}</span> : null}
                    </span>
                    {statusPill(r.v.company.status, t)}
                    <span className="rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[11px] font-semibold text-ink-soft">
                      {t("autoBewerb.manifestCount", { count: r.count })}
                    </span>
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-muted">
                    {t("autoBewerb.recipientLabel")}:{" "}
                    <span className={r.dest ? "font-mono text-ink-soft" : "font-semibold text-warning"}>{r.dest || t("autoBewerb.deliveryNoDest")}</span>
                    {r.subject && (
                      <>
                        {" · "}
                        {t("autoBewerb.subjectLabel")}: <span className="text-ink-soft">{r.subject}</span>
                      </>
                    )}
                  </span>
                </span>
              </button>

              {openNow && (
                <div className="mt-2 ml-6 rounded-2xl border border-line bg-surface-2/30 p-3">
                  {r.entries.length > 0 ? (
                    <ul className="space-y-1">
                      {r.entries.map((e) => (
                        <li key={`${e.kind}-${e.name}`} className="flex items-center gap-2 text-xs text-ink-soft">
                          <FileText size={13} className="shrink-0 text-faint" />
                          <span className="min-w-0 truncate font-mono">{e.name}</span>
                          <span className="ml-auto shrink-0 rounded-full border border-line bg-surface px-1.5 py-0.5 text-[10px] font-semibold text-muted">
                            {kindLabel(e.kind)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-xs text-muted">{t("autoBewerb.noAttachments")}</p>
                  )}
                  {r.missing.length > 0 && (
                    <p className="mt-2 text-xs font-semibold text-warning">{r.missing.join(" · ")}</p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
