import Link from "next/link";
import { ArrowRight, Search } from "lucide-react";
import { Button } from "@/components/ui";
import { BrandLogo } from "@/components/brand-logo";
import { Icon, type IconName } from "@/components/icon";
import { GradientMesh } from "@/components/ui/surfaces";
import { getServerT } from "@/lib/i18n/server";
import {
  ThemeSwitcher,
} from "@/components/theme-switcher";
import { LanguageSwitcher } from "@/components/language-switcher";

const FEATURES: Array<{ icon: IconName; titleKey: string; textKey: string }> = [
  { icon: "search", titleKey: "landing.features.find.title", textKey: "landing.features.find.text" },
  { icon: "scan", titleKey: "landing.features.analyze.title", textKey: "landing.features.analyze.text" },
  { icon: "send", titleKey: "landing.features.apply.title", textKey: "landing.features.apply.text" },
  { icon: "bookmark", titleKey: "landing.features.organize.title", textKey: "landing.features.organize.text" },
];

const STEPS = [
  "landing.steps.step1",
  "landing.steps.step2",
  "landing.steps.step3",
  "landing.steps.step4",
  "landing.steps.step5",
] as const;

export default async function Home() {
  const t = await getServerT();
  return (
    <main className="min-h-screen bg-background text-ink">
      <GradientMesh />
      <header className="sticky top-0 z-20 border-b border-line bg-surface/70 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-10">
          <BrandLogo size={36} />
          <nav className="hidden items-center gap-7 text-sm font-semibold text-muted md:flex">
            <a href="#how-it-works" className="transition-colors hover:text-accent">
              {t("landing.navHow")}
            </a>
            <a href="#features" className="transition-colors hover:text-accent">
              {t("landing.navWhy")}
            </a>
            <Link
              href="/login"
              className="text-ink-soft transition-colors hover:text-accent"
            >
              {t("landing.navLogin")}
            </Link>
          </nav>
          <div className="flex items-center gap-1.5 sm:gap-2">
            <LanguageSwitcher />
            <ThemeSwitcher />
            <Link href="/register" className="hidden sm:block">
              <Button size="sm">{t("landing.ctaStart")}</Button>
            </Link>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="relative mx-auto max-w-7xl overflow-hidden px-4 pb-16 pt-14 sm:px-6 sm:pt-20 lg:px-10 lg:pb-24">
        <div className="hero-orb pointer-events-none absolute -end-24 -top-24 h-[520px] w-[520px] rounded-full" />
        <div className="grid-fade pointer-events-none absolute inset-x-0 bottom-0 h-64 opacity-40 [mask-image:linear-gradient(to_bottom,transparent,black)]" />
        <div className="relative grid items-center gap-12 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="max-w-3xl">
            <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-accent/20 bg-accent-soft px-3.5 py-1.5 text-xs font-bold text-accent anim-fade-up">
              <span className="h-1.5 w-1.5 rounded-full bg-accent" />
              {t("landing.heroBadge")}
            </div>
            <h1 className="display-title text-neon-gradient anim-fade-up text-5xl sm:text-7xl">
              {t("premium.hero.title")}
            </h1>
            <p className="anim-fade-up mt-5 max-w-xl text-base leading-7 text-muted sm:text-lg [animation-delay:80ms]">
              {t("premium.hero.subtitle")}
            </p>
            <div className="anim-fade-up mt-9 flex flex-col gap-3 [animation-delay:160ms] sm:flex-row">
              <Link href="/register">
                <Button size="lg">
                  {t("landing.ctaStart")}
                  <Icon name="arrowRight" size={16} className="rtl:-scale-x-100" />
                </Button>
              </Link>
              <Link href="/dashboard">
                <Button size="lg" variant="secondary">
                  {t("landing.ctaExplore")}
                </Button>
              </Link>
            </div>
          </div>

          {/* Decorative product glimpse — pure visual, no data, no interaction */}
          <div aria-hidden="true" className="relative hidden lg:block">
            <div className="hero-orb pointer-events-none absolute -start-16 -top-16 h-56 w-56 rounded-full opacity-70" />
            <div className="glass relative rounded-3xl p-6 shadow-[var(--shadow-float)]">
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-[var(--gradient-neon)] text-white shadow-[0_8px_18px_-6px_rgba(var(--glow-accent-rgb),0.5)]">
                  <Search size={18} strokeWidth={1.9} />
                </span>
                <div className="flex-1">
                  <div className="shimmer h-3.5 w-2/3 rounded-full" />
                  <div className="shimmer mt-2 h-2.5 w-1/2 rounded-full" />
                </div>
              </div>
              <div className="mt-5 space-y-2.5">
                <div className="shimmer h-3 w-full rounded-full" />
                <div className="shimmer h-3 w-11/12 rounded-full" />
                <div className="shimmer h-3 w-4/6 rounded-full" />
              </div>
              <div className="mt-6 grid grid-cols-3 gap-3">
                <div className="shimmer h-16 rounded-2xl" />
                <div className="shimmer h-16 rounded-2xl" />
                <div className="shimmer h-16 rounded-2xl" />
              </div>
            </div>
            <div className="glass absolute -bottom-7 -start-9 w-56 rounded-3xl p-4 shadow-[var(--shadow-float)]">
              <div className="shimmer h-3 w-1/2 rounded-full" />
              <div className="mt-3 flex gap-2">
                <span className="h-6 w-16 rounded-full bg-success-soft" />
                <span className="h-6 w-20 rounded-full bg-accent-soft" />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="border-y border-line bg-surface-2/50">
        <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-10 lg:py-20">
          <div className="max-w-2xl">
            <h2 className="display-title text-4xl text-ink">
              {t("landing.featureTitle")}
            </h2>
            <p className="mt-3 text-sm leading-6 text-muted">
              {t("landing.featureSubtitle")}
            </p>
          </div>
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {FEATURES.map((feature) => (
              <div
                key={feature.titleKey}
                className="surface-elevated group rounded-3xl p-5 transition-all duration-300 hover:-translate-y-1 hover:shadow-[var(--shadow-float)]"
              >
                <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-accent-soft text-accent transition-colors duration-300 group-hover:bg-[var(--gradient-neon)] group-hover:text-white">
                  <Icon name={feature.icon} size={20} strokeWidth={1.8} />
                </span>
                <h3 className="mt-4 text-base font-bold text-ink">
                  {t(feature.titleKey)}
                </h3>
                <p className="mt-2 text-sm leading-6 text-muted">
                  {t(feature.textKey)}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section id="how-it-works" className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-10 lg:py-20">
        <div className="max-w-2xl">
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-accent">
            {t("landing.howTitle")}
          </p>
          <h2 className="display-title mt-3 text-4xl text-ink">
            {t("landing.howSubtitle")}
          </h2>
        </div>
        <ol className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {STEPS.map((stepKey, index) => (
            <li
              key={stepKey}
              className="surface-elevated rounded-3xl p-5 transition-all duration-300 hover:-translate-y-1 hover:shadow-[var(--shadow-float)]"
            >
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[var(--gradient-neon)] text-sm font-extrabold text-white shadow-[0_6px_14px_-6px_rgba(var(--glow-accent-rgb),0.5)]">
                <span className="num">{String(index + 1).padStart(2, "0")}</span>
              </span>
              <p className="mt-4 text-sm font-bold leading-6 text-ink">
                {t(stepKey)}
              </p>
            </li>
          ))}
        </ol>
      </section>

      {/* CTA */}
      <section className="mx-auto max-w-7xl px-4 pb-20 sm:px-6 lg:px-10">
        <div className="glass relative overflow-hidden rounded-3xl p-8 sm:p-12">
          <div className="hero-orb pointer-events-none absolute -end-20 -top-20 h-72 w-72 rounded-full" />
          <div className="grid-fade pointer-events-none absolute inset-x-0 bottom-0 h-40 opacity-50 [mask-image:linear-gradient(to_bottom,transparent,black)]" />
          <div className="relative max-w-xl">
            <h2 className="display-title text-4xl text-ink sm:text-5xl">
              {t("premium.hero.title")}
            </h2>
            <p className="mt-3 text-sm leading-6 text-muted">
              {t("premium.hero.subtitle")}
            </p>
            <Link href="/register" className="mt-7 inline-block">
              <Button size="lg">
                {t("landing.ctaStart")}
                <ArrowRight size={16} className="rtl:rotate-180" />
              </Button>
            </Link>
          </div>
        </div>
      </section>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-8 text-xs text-muted sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-10">
          <span>© 2025 Ausbildung Hunter AI</span>
          <span>{t("landing.footerNote")}</span>
        </div>
      </footer>
    </main>
  );
}
