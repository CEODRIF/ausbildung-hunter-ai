import Link from "next/link";
import { BrandLogo } from "@/components/brand-logo";
import { LegalFooter } from "@/components/legal-footer";
import { getServerT } from "@/lib/i18n/server";

/**
 * Layout for the six public legal pages (route group → URLs /privacy,
 * /terms, /cookies, /ai-usage, /data-deletion, /contact).
 *
 * Public (no auth), server-rendered, no client JS beyond the shared
 * i18n/theme providers. Header: brand + back-to-app; footer: Legal section.
 */
export default async function LegalLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const t = await getServerT();

  return (
    <div className="flex min-h-screen flex-col bg-surface">
      <header className="sticky top-0 z-40 border-b border-line bg-surface/90 backdrop-blur-md">
        <div className="mx-auto flex h-16 w-full max-w-5xl items-center justify-between gap-4 px-4 sm:px-6">
          <BrandLogo size={30} />
          <Link
            href="/dashboard"
            className="rounded-lg px-2 py-1.5 text-sm font-semibold text-muted transition-colors hover:text-ink focus:outline-none focus-visible:ring-4 focus-visible:ring-accent/10"
          >
            {t("legal.backToApp")}
          </Link>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6 sm:py-12">
        {children}
      </main>

      <LegalFooter variant="full" />
    </div>
  );
}
