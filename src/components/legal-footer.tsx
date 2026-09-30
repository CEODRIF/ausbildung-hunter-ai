"use client";

import Link from "next/link";
import { useI18n } from "@/lib/i18n";
import { BrandLogo } from "@/components/brand-logo";
import { LEGAL_ORDER, LEGAL_ROUTES, type LegalSlug } from "@/lib/legal";

/**
 * Site footer with the Legal section (exactly the six legal pages).
 *
 *  - variant "bar":  slim bar for AppShell + AuthShell (authed + auth pages)
 *  - variant "full": full footer on the legal pages themselves
 *
 * Client component only because it reads the active language from the i18n
 * context; it renders no listeners and adds no meaningful JS.
 */

const LABEL_KEY: Record<LegalSlug, `legal.${string}`> = {
  privacy: "legal.privacyPolicy",
  terms: "legal.termsOfService",
  cookies: "legal.cookiePolicy",
  "ai-usage": "legal.aiUsage",
  "data-deletion": "legal.dataDeletion",
  contact: "legal.contact",
};

const LINK_CLASS =
  "rounded text-muted transition-colors hover:text-accent focus:outline-none focus-visible:ring-4 focus-visible:ring-accent/10";

function LegalLinks({ className }: { className?: string }) {
  const { t } = useI18n();
  return (
    <nav aria-label={t("legal.footerSection")}>
      <ul className={className}>
        {LEGAL_ORDER.map((slug) => (
          <li key={slug}>
            <Link href={LEGAL_ROUTES[slug]} className={LINK_CLASS}>
              {t(LABEL_KEY[slug])}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function LegalFooter({ variant = "bar" }: { variant?: "bar" | "full" }) {
  const { t } = useI18n();
  const year = new Date().getFullYear();
  const copyright = t("legal.copyright", { year });

  if (variant === "full") {
    return (
      <footer className="border-t border-line bg-surface">
        <div className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6">
          <div className="flex flex-col gap-8 sm:flex-row sm:items-start sm:justify-between">
            <div className="max-w-xs">
              <BrandLogo size={30} />
              <p className="mt-3 text-xs leading-5 text-muted">
                {t("legal.brandTagline")}
              </p>
            </div>
            <div>
              <p className="mb-3 text-xs font-bold uppercase tracking-wider text-faint">
                {t("legal.footerSection")}
              </p>
              <LegalLinks className="grid grid-cols-2 gap-x-8 gap-y-2 sm:grid-cols-3 [&_a]:text-sm" />
            </div>
          </div>
          <p className="mt-8 border-t border-line pt-5 text-xs text-faint">{copyright}</p>
        </div>
      </footer>
    );
  }

  return (
    <footer className="mt-auto border-t border-line bg-surface">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-2.5 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <p className="text-xs text-faint">{copyright}</p>
        <LegalLinks className="flex flex-wrap items-center gap-x-4 gap-y-1.5 [&_a]:text-xs [&_a]:font-medium" />
      </div>
    </footer>
  );
}
