import Link from "next/link";
import { BrandLogo } from "@/components/brand-logo";
import { LEGAL_ORDER, LEGAL_ROUTES } from "@/lib/legal";
import { getServerT } from "@/lib/i18n/server";

/**
 * Public footer. Every link points at a real route — no placeholder hrefs, no
 * invented sections. The legal column is generated from the single legal
 * registry that the legal pages themselves use, so the two can never drift.
 */
const LEGAL_KEYS = {
  privacy: "legal.privacyPolicy",
  terms: "legal.termsOfService",
  cookies: "legal.cookiePolicy",
  "ai-usage": "legal.aiUsage",
  "data-deletion": "legal.dataDeletion",
  contact: "legal.contact",
} as const;

export async function SiteFooter() {
  const t = await getServerT();
  const year = new Date().getFullYear();

  return (
    <footer className="border-t border-line bg-surface">
      <div className="shell-x mx-auto max-w-7xl py-14">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1fr]">
          <div className="max-w-xs">
            <BrandLogo size={34} />
            <p className="mt-4 text-sm leading-6 text-muted">
              {t("v2.footer.tagline")}
            </p>
          </div>

          <div>
            <p className="text-xs font-bold tracking-[0.14em] text-faint uppercase">
              {t("v2.footer.product")}
            </p>
            <ul className="mt-4 space-y-2.5 text-sm text-ink-soft">
              <li>
                <Link href="/opportunities" className="transition-colors hover:text-accent">
                  {t("v2.footer.jobs")}
                </Link>
              </li>
              <li>
                <Link href="/opportunities/saved" className="transition-colors hover:text-accent">
                  {t("v2.footer.saved")}
                </Link>
              </li>
              <li>
                <Link href="/dashboard" className="transition-colors hover:text-accent">
                  {t("v2.footer.dashboard")}
                </Link>
              </li>
              <li>
                <Link href="/register" className="transition-colors hover:text-accent">
                  {t("v2.nav.register")}
                </Link>
              </li>
            </ul>
          </div>

          <div>
            <p className="text-xs font-bold tracking-[0.14em] text-faint uppercase">
              {t("v2.footer.resources")}
            </p>
            <ul className="mt-4 space-y-2.5 text-sm text-ink-soft">
              <li>
                <Link href="/bibliothek" className="transition-colors hover:text-accent">
                  {t("v2.nav.library")}
                </Link>
              </li>
              <li>
                <Link href="/wohnen/gehalt" className="transition-colors hover:text-accent">
                  {t("guides.nav.gehalt")}
                </Link>
              </li>
              <li>
                <Link href="/dashboard/faq" className="transition-colors hover:text-accent">
                  {t("v2.nav.faq")}
                </Link>
              </li>
            </ul>
          </div>

          <div>
            <p className="text-xs font-bold tracking-[0.14em] text-faint uppercase">
              {t("v2.footer.legal")}
            </p>
            <ul className="mt-4 space-y-2.5 text-sm text-ink-soft">
              {LEGAL_ORDER.map((slug) => (
                <li key={slug}>
                  <Link href={LEGAL_ROUTES[slug]} className="transition-colors hover:text-accent">
                    {t(LEGAL_KEYS[slug])}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="mt-12 flex flex-col gap-2 border-t border-line pt-6 text-xs text-faint sm:flex-row sm:items-center sm:justify-between">
          <p>© {year} AusbildungsWeg</p>
          <p>{t("v2.footer.rights")}</p>
        </div>
      </div>
    </footer>
  );
}
