"use client";

/**
 * "Dokumente für den Konsulatstermin" explorer.
 *
 * Data source: src/lib/guides/consulate-docs.ts — every entry was fetched and
 * reviewed from the mission's own official page on the stated date. The UI
 * never invents document lists: entries without verified per-document detail
 * point to the official page instead (see `docs`/`notes` arrays).
 */
import { useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { CONSULATES, GENERAL_LINKS, type ConsulateEntry } from "@/lib/guides/consulate-docs";

type VisaType = "ausbildung" | "arbeit" | "sonstiges";

export function ConsulateExplorer() {
  const { t, lang } = useI18n();
  const [visaType, setVisaType] = useState<VisaType>("ausbildung");
  const [countryId, setCountryId] = useState<string>("");

  const entry: ConsulateEntry | undefined = useMemo(
    () => CONSULATES.find((c) => c.id === countryId),
    [countryId],
  );

  const selectCls =
    "w-full rounded-xl border border-line-strong bg-surface px-3 py-2 text-sm font-semibold text-ink outline-none transition-colors focus:border-accent";
  const labelCls = "mb-1 block text-[11px] font-bold uppercase tracking-[0.08em] text-faint";

  return (
    <div className="space-y-5">
      <div className="surface-elevated rounded-3xl p-5 sm:p-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className={labelCls} htmlFor="con-visa">
              {t("guides.konsulat.visaTypeLabel")}
            </label>
            <select
              id="con-visa"
              className={selectCls}
              value={visaType}
              onChange={(e) => setVisaType(e.target.value as VisaType)}
            >
              <option value="ausbildung">{t("guides.konsulat.vtAusbildung")}</option>
              <option value="arbeit">{t("guides.konsulat.vtArbeit")}</option>
              <option value="sonstiges">{t("guides.konsulat.vtSonstiges")}</option>
            </select>
          </div>
          <div>
            <label className={labelCls} htmlFor="con-country">
              {t("guides.konsulat.countryLabel")}
            </label>
            <select
              id="con-country"
              className={selectCls}
              value={countryId}
              onChange={(e) => setCountryId(e.target.value)}
            >
              <option value="">{t("guides.konsulat.searchCountry")}</option>
              {CONSULATES.map((c) => (
                <option key={c.id} value={c.id}>
                  {lang === "ar" ? c.countryAr : lang === "en" ? c.countryEn : c.countryDe}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {visaType === "sonstiges" && (
        <div className="rounded-2xl border border-warning/40 bg-warning-soft p-4 text-xs leading-relaxed text-ink-soft">
          <p className="font-bold text-warning">i {t("guides.konsulat.noMatch")}</p>
          <p className="mt-2">
            <a
              href={GENERAL_LINKS.generalRules}
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-accent underline-offset-2 hover:underline"
            >
              {t("guides.konsulat.generalRules")} ↗
            </a>
          </p>
        </div>
      )}

      {entry ? (
        <article className="surface-elevated rounded-3xl p-5 sm:p-6">
          <header className="border-b border-line pb-4">
            <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-faint">
              {t("guides.konsulat.mission")}
            </p>
            <h2 className="mt-1 text-lg font-extrabold tracking-tight text-ink">
              {lang === "ar" ? entry.missionAr : entry.missionDe}
            </h2>
            <p className="mt-0.5 text-sm font-semibold text-muted">
              {lang === "ar" ? entry.cityAr : entry.cityDe}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
              <span className="rounded-full bg-success-soft px-3 py-1 font-bold text-success">
                {t("guides.konsulat.lastReviewed")}: {entry.lastReviewed}
              </span>
              <a
                href={entry.url}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-full bg-accent px-4 py-1.5 font-bold text-white transition-colors hover:bg-accent-deep"
              >
                {t("guides.konsulat.openOfficial")} ↗
              </a>
            </div>
          </header>

          {entry.jurisdiction && (
            <section className="mt-4">
              <h3 className="text-[10px] font-bold uppercase tracking-[0.1em] text-faint">
                {t("guides.konsulat.jurisdiction")}
              </h3>
              <p className="mt-1 text-sm leading-relaxed text-ink-soft">
                {lang === "ar" ? entry.jurisdiction.ar : entry.jurisdiction.de}
              </p>
            </section>
          )}

          {(entry.fee || entry.appointment) && (
            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
              {entry.fee && (
                <div className="rounded-2xl border border-line bg-surface p-3">
                  <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-faint">
                    {t("guides.konsulat.fee")}
                  </p>
                  <p className="mt-1 text-sm font-semibold text-ink-soft">
                    {lang === "ar" ? entry.fee.ar : entry.fee.de}
                  </p>
                </div>
              )}
              {entry.appointment && (
                <div className="rounded-2xl border border-line bg-surface p-3">
                  <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-faint">
                    {t("guides.konsulat.appointment")}
                  </p>
                  <p className="mt-1 text-sm font-semibold text-ink-soft">
                    {lang === "ar" ? entry.appointment.ar : entry.appointment.de}
                  </p>
                </div>
              )}
            </div>
          )}

          {entry.docs.length > 0 && (
            <section className="mt-4">
              <h3 className="text-[10px] font-bold uppercase tracking-[0.1em] text-faint">
                {t("guides.konsulat.docsTitle")}
              </h3>
              <ul className="mt-2 space-y-2">
                {entry.docs.map((d, i) => (
                  <li
                    key={i}
                    className="flex items-start gap-2 rounded-2xl border border-line bg-surface p-3 text-sm leading-relaxed text-ink-soft"
                  >
                    <span aria-hidden className="mt-0.5 shrink-0 text-accent">
                      ✓
                    </span>
                    {lang === "ar" ? d.ar : d.de}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {entry.notes.length > 0 && (
            <section className="mt-4">
              <h3 className="text-[10px] font-bold uppercase tracking-[0.1em] text-faint">
                {t("guides.konsulat.notes")}
              </h3>
              <ul className="mt-2 space-y-2">
                {entry.notes.map((n, i) => (
                  <li key={i} className="text-sm leading-relaxed text-muted">
                    • {lang === "ar" ? n.ar : n.de}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {entry.languageNote && (
            <p className="mt-4 rounded-2xl bg-surface-2 p-3 text-xs leading-relaxed text-muted">
              ℹ {lang === "ar" ? entry.languageNote.ar : entry.languageNote.de}
            </p>
          )}
        </article>
      ) : (
        !visaType.startsWith("sonstiges") && (
          <div className="rounded-2xl border border-line bg-surface p-5 text-sm text-muted">
            {t("guides.konsulat.otherCountryDesc")}
            <div className="mt-3 flex flex-wrap gap-2">
              <a
                href={GENERAL_LINKS.allMissions}
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold text-accent underline-offset-2 hover:underline"
              >
                {t("guides.konsulat.allMissions")} ↗
              </a>
              <a
                href={GENERAL_LINKS.auslandsportal}
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold text-accent underline-offset-2 hover:underline"
              >
                {t("guides.konsulat.auslandsportal")} ↗
              </a>
            </div>
          </div>
        )
      )}

      <p className="rounded-2xl border border-line bg-surface-2 p-4 text-xs leading-relaxed text-muted">
        <span className="font-bold text-warning">⚠ </span>
        {t("guides.konsulat.disclaimer")}
      </p>
    </div>
  );
}
