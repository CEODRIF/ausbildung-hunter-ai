"use client";

import { useI18n } from "@/lib/i18n";
import { BrandLogo } from "@/components/brand-logo";
import { Icon } from "@/components/icon";
import { LegalFooter } from "@/components/legal-footer";

/**
 * Auth screen layout: dark navy brand panel (constant across themes — it is
 * the brand surface, not a theme surface) + form column on the themed side.
 */
export function AuthShell({
  children,
  title,
  subtitle,
}: {
  children: React.ReactNode;
  title: string;
  subtitle: string;
}) {
  const { t } = useI18n();
  return (
    <main className="grid min-h-screen bg-background dark:bg-surface lg:grid-cols-[0.95fr_1.05fr]">
      <section className="relative hidden overflow-hidden bg-navy px-12 py-12 text-white lg:flex lg:flex-col lg:justify-between xl:px-20">
        <div className="absolute -right-32 top-8 h-[500px] w-[500px] rounded-full hero-orb" />
        <div className="relative">
          <BrandLogo tone="light" size={36} />
        </div>
        <div className="relative max-w-md pb-10">
          <div className="mb-7 flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-soft text-accent">
            <Icon name="chart" size={24} strokeWidth={1.7} />
          </div>
          <h2 className="text-4xl font-bold leading-[1.08] tracking-[-0.04em]">
            {t("auth.pitchTitle")}
          </h2>
          <p className="mt-5 max-w-sm text-[15px] leading-7 text-[#b7c4d7]">
            {t("auth.pitchBody")}
          </p>
          <div className="mt-10 flex items-center gap-3 text-sm text-[#d8e1ef]">
            <span className="flex -space-x-2 rtl:space-x-reverse">
              <span className="h-7 w-7 rounded-full border-2 border-navy bg-[#f1c7ab]" />
              <span className="h-7 w-7 rounded-full border-2 border-navy bg-[#9db8d5]" />
              <span className="h-7 w-7 rounded-full border-2 border-navy bg-[#d7a6c4]" />
            </span>
            <span>{t("auth.chapter")}</span>
          </div>
        </div>
        <p className="relative text-xs text-[#8d9db4]">
          © 2026 AusbildungsWeg
        </p>
      </section>
      <section className="flex items-center justify-center px-5 py-10 sm:px-8">
        <div className="w-full max-w-[430px]">
          <div className="mb-10 lg:hidden">
            <BrandLogo size={36} />
          </div>
          <div className="mb-8">
            <h1 className="text-3xl font-bold tracking-[-0.035em] text-ink">
              {title}
            </h1>
            <p className="mt-2 text-sm leading-6 text-muted">{subtitle}</p>
          </div>
          {children}
          <LegalFooter variant="bar" />
        </div>
      </section>
    </main>
  );
}
