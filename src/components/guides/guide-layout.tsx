/**
 * Shared layout for the guide pages (Neu in Deutschland / Nach dem Vertrag):
 * intro → interactive checklist (localStorage) → chronological sections with
 * optional official source links.
 *
 * Server component — it composes the client Checklist; no state of its own.
 */
import { Checklist, type ChecklistItem } from "./checklist";

export interface GuideStep {
  id: string;
  title: string;
  desc: string;
  source?: { label: string; url: string };
}

export interface GuideSection {
  title: string;
  steps: GuideStep[];
}

interface Props {
  intro: string;
  /** e.g. the prominent "contract ≠ visa" warning. */
  warning?: string;
  sections: GuideSection[];
  storageKey: string;
  checklistTitle: string;
  progressTemplate: string;
  resetLabel: string;
  doneAllLabel: string;
  sourceLabel: string;
}

export function GuideLayout({
  intro,
  warning,
  sections,
  storageKey,
  checklistTitle,
  progressTemplate,
  resetLabel,
  doneAllLabel,
  sourceLabel,
}: Props) {
  const items: ChecklistItem[] = sections.flatMap((s) =>
    s.steps.map((st) => ({
      id: st.id,
      title: st.title,
      desc: st.desc,
      source: st.source ? { label: st.source.label, url: st.source.url } : undefined,
    })),
  );

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <p className="text-sm leading-relaxed text-muted">{intro}</p>
      {warning && (
        <div className="rounded-2xl border border-warning/40 bg-warning-soft p-4 text-sm font-semibold leading-relaxed text-ink">
          <span className="text-warning">⚠ </span>
          {warning}
        </div>
      )}

      <Checklist
        storageKey={storageKey}
        title={checklistTitle}
        items={items}
        progressTemplate={progressTemplate}
        resetLabel={resetLabel}
        doneAllLabel={doneAllLabel}
      />

      {sections.map((s, si) => (
        <section key={si} className="surface-elevated rounded-3xl p-5 sm:p-6">
          <h2 className="text-base font-bold tracking-tight text-ink">{s.title}</h2>
          <ol className="mt-4 space-y-4">
            {s.steps.map((st) => (
              <li key={st.id} className="flex gap-3">
                <span
                  aria-hidden
                  className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[11px] font-extrabold text-accent"
                >
                  {st.id.charAt(st.id.length - 1)}
                </span>
                <div className="min-w-0">
                  <h3 className="text-sm font-bold text-ink">{st.title}</h3>
                  <p className="mt-1 text-sm leading-relaxed text-muted">{st.desc}</p>
                  {st.source && (
                    <a
                      href={st.source.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-1.5 inline-flex items-center gap-1 text-xs font-semibold text-accent underline-offset-2 hover:underline"
                    >
                      {sourceLabel}: {st.source.label}
                      <span aria-hidden className="rtl:-scale-x-100">↗</span>
                    </a>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}
