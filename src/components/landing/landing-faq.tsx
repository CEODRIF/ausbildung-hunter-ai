import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { ALL_ITEMS } from "@/lib/faq";
import { getRequestLang, getServerT } from "@/lib/i18n/server";

/**
 * Landing FAQ — four REAL answers pulled from the single FAQ source of truth
 * (`src/lib/faq`), localized in all four languages. Nothing is invented for
 * the marketing page: the same text backs /dashboard/faq.
 *
 * Built on native <details>/<summary>: keyboard accessible, works before
 * hydration, needs no JavaScript at all.
 */
const FEATURED = [
  "general-what-is",
  "search-sources",
  "bl-free",
  "general-only-ausbildung",
] as const;

export async function LandingFaq() {
  const [t, lang] = await Promise.all([getServerT(), getRequestLang()]);
  const items = FEATURED.map((id) => ALL_ITEMS.find((item) => item.id === id)).filter(
    (item): item is (typeof ALL_ITEMS)[number] => Boolean(item),
  );

  return (
    <section id="faq" className="section-pad border-t border-line bg-surface">
      <div className="shell-x mx-auto max-w-7xl">
        <div className="grid gap-10 lg:grid-cols-[0.8fr_1.2fr] lg:gap-16">
          <div className="lg:sticky lg:top-24 lg:self-start">
            <p className="text-xs font-bold tracking-[0.16em] text-accent uppercase">
              {t("v2.faq.eyebrow")}
            </p>
            <h2 className="display-title mt-3 text-3xl text-ink sm:text-4xl">
              {t("v2.faq.title")}
            </h2>
            <p className="mt-3 max-w-sm text-sm leading-6 text-muted">
              {t("v2.faq.subtitle")}
            </p>
            <Link
              href="/dashboard/faq"
              className="mt-5 inline-flex items-center gap-1.5 text-sm font-bold text-accent transition-colors hover:text-accent-deep"
            >
              {t("v2.faq.more")}
            </Link>
          </div>

          <div className="divide-y divide-line overflow-hidden rounded-3xl border border-line bg-surface">
            {items.map((item) => (
              <details key={item.id} className="group px-5 py-4 sm:px-6">
                <summary className="flex cursor-pointer list-none items-start justify-between gap-4 text-sm font-bold text-ink sm:text-base">
                  <span>{item.question[lang]}</span>
                  <ChevronDown
                    size={18}
                    strokeWidth={2}
                    className="mt-0.5 shrink-0 text-faint transition-transform duration-200 group-open:rotate-180"
                  />
                </summary>
                <p className="mt-3 text-sm leading-6 text-muted">{item.answer[lang]}</p>
              </details>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
