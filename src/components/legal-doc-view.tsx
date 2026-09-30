import Link from "next/link";
import type { LegalDoc, Language } from "@/lib/legal";

/**
 * Server-rendered legal document view (no client JS):
 *  - h1 + intro
 *  - sticky table of contents (desktop) / collapsible <details> (mobile)
 *  - sections with anchor ids (scroll-mt for the sticky header)
 *  - optional contact email card (Contact page)
 *
 * Layout uses logical properties only, so Arabic (dir=rtl) mirrors cleanly.
 */
export function LegalDocView({
  doc,
  lang,
  tocLabel,
  tocAriaLabel,
  emailLabel,
}: {
  doc: LegalDoc;
  lang: Language;
  tocLabel: string;
  tocAriaLabel: string;
  emailLabel: string;
}) {
  return (
    <div className="grid gap-10 lg:grid-cols-[230px_minmax(0,1fr)]">
      {/* Table of contents — desktop (sticky) */}
      <nav className="hidden lg:block" aria-label={tocAriaLabel}>
        <div className="sticky top-8">
          <p className="mb-3 text-xs font-bold uppercase tracking-wider text-faint">
            {tocLabel}
          </p>
          <ul className="space-y-0.5 border-s-2 border-line ps-4">
            {doc.sections.map((section) => (
              <li key={section.id}>
                <a
                  href={`#${section.id}`}
                  className="block rounded-lg px-2 py-1 text-[13px] leading-5 text-muted transition-colors hover:bg-surface-2 hover:text-ink focus:outline-none focus-visible:ring-4 focus-visible:ring-accent/10"
                >
                  {section.title[lang]}
                </a>
              </li>
            ))}
          </ul>
        </div>
      </nav>

      {/* Content */}
      <article className="min-w-0">
        {/* Table of contents — mobile (collapsible, no JS) */}
        <details className="mb-8 rounded-xl border border-line bg-surface lg:hidden">
          <summary className="cursor-pointer select-none list-none px-4 py-3 text-sm font-semibold text-ink [&::-webkit-details-marker]:hidden">
            {tocLabel}
          </summary>
          <ul className="space-y-0.5 border-t border-line p-3">
            {doc.sections.map((section) => (
              <li key={section.id}>
                <a
                  href={`#${section.id}`}
                  className="block rounded-lg px-2 py-1 text-[13px] leading-5 text-muted hover:bg-surface-2 hover:text-ink focus:outline-none focus-visible:ring-4 focus-visible:ring-accent/10"
                >
                  {section.title[lang]}
                </a>
              </li>
            ))}
          </ul>
        </details>

        <h1 className="text-3xl font-bold tracking-[-0.03em] text-ink sm:text-4xl">
          {doc.title[lang]}
        </h1>
        <p className="mt-4 text-[15px] leading-7 text-muted">{doc.intro[lang]}</p>

        {/* Contact card (Contact page only) */}
        {doc.contactEmail && (
          <div className="mt-6 rounded-xl border border-accent/30 bg-accent-soft/50 p-5">
            <p className="text-xs font-bold uppercase tracking-wider text-accent">
              {emailLabel}
            </p>
            <a
              href={`mailto:${doc.contactEmail}`}
              className="mt-1.5 inline-block break-all text-lg font-bold text-accent underline-offset-4 hover:underline focus:outline-none focus-visible:ring-4 focus-visible:ring-accent/20"
            >
              {doc.contactEmail}
            </a>
          </div>
        )}

        {doc.sections.map((section) => (
          <section key={section.id} id={section.id} className="mt-10 scroll-mt-24 sm:mt-12">
            <h2 className="text-xl font-bold tracking-[-0.02em] text-ink sm:text-[22px]">
              {section.title[lang]}
            </h2>
            {section.p?.map((paragraph, i) => (
              <p key={i} className="mt-3 text-[15px] leading-7 text-ink/85">
                {paragraph[lang]}
              </p>
            ))}
            {section.li && (
              <ul className="mt-4 space-y-2.5">
                {section.li.map((bullet, i) => (
                  <li
                    key={i}
                    className="flex gap-3 text-[15px] leading-7 text-ink/85"
                  >
                    <span
                      aria-hidden="true"
                      className="mt-[11px] h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                    />
                    <span>{bullet[lang]}</span>
                  </li>
                ))}
              </ul>
            )}
            {section.pAfter?.map((paragraph, i) => (
              <p key={`after-${i}`} className="mt-3 text-[15px] leading-7 text-ink/85">
                {paragraph[lang]}
              </p>
            ))}
            {section.to && (
              <p className="mt-5">
                <Link
                  href={section.to}
                  className="inline-block rounded-lg font-semibold text-accent underline-offset-4 hover:underline focus:outline-none focus-visible:ring-4 focus-visible:ring-accent/10"
                >
                  {section.toLabel?.[lang]}
                </Link>
              </p>
            )}
          </section>
        ))}
      </article>
    </div>
  );
}
