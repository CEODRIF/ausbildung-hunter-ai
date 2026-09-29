import Link from "next/link";
import { Button } from "@/components/ui";
import { BrandLogo } from "@/components/brand-logo";
import { Icon, type IconName } from "@/components/icon";
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
      <header className="sticky top-0 z-20 border-b border-line bg-surface/90 backdrop-blur-md">
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
        <div className="relative max-w-3xl">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-accent/20 bg-accent-soft px-3.5 py-1.5 text-xs font-bold text-accent">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" />
            {t("landing.heroBadge")}
          </div>
          <h1 className="text-4xl font-bold leading-[1.06] tracking-[-0.05em] text-ink sm:text-6xl">
            {t("landing.heroTitle")}
          </h1>
          <p className="mt-6 max-w-xl text-base leading-7 text-muted sm:text-lg">
            {t("landing.heroSubtitle")}
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
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
      </section>

      {/* Features */}
      <section id="features" className="border-y border-line bg-surface-2/50">
        <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-10 lg:py-20">
          <div className="max-w-2xl">
            <h2 className="text-3xl font-bold tracking-[-0.04em] text-ink">
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
                className="rounded-2xl border border-line bg-surface p-5 transition-[transform,border-color] duration-200 hover:-translate-y-0.5 hover:border-line-strong card-shadow"
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-soft text-accent">
                  <Icon name={feature.icon} size={19} />
                </span>
                <h3 className="mt-4 font-bold text-ink">{t(feature.titleKey)}</h3>
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
          <h2 className="mt-3 text-3xl font-bold tracking-[-0.04em] text-ink">
            {t("landing.howSubtitle")}
          </h2>
        </div>
        <ol className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {STEPS.map((stepKey, index) => (
            <li
              key={stepKey}
              className="rounded-2xl border border-line bg-surface p-5"
            >
              <span className="text-xs font-bold tracking-[0.12em] text-accent">
                {String(index + 1).padStart(2, "0")}
              </span>
              <p className="mt-3 text-sm font-bold leading-6 text-ink">
                {t(stepKey)}
              </p>
            </li>
          ))}
        </ol>
      </section>

      {/* CTA */}
      <section className="mx-auto max-w-7xl px-4 pb-20 sm:px-6 lg:px-10">
        <div className="relative overflow-hidden rounded-3xl border border-line bg-surface p-8 sm:p-12">
          <div className="hero-orb pointer-events-none absolute -end-20 -top-20 h-72 w-72 rounded-full" />
          <div className="relative max-w-xl">
            <h2 className="text-2xl font-bold tracking-[-0.03em] text-ink sm:text-3xl">
              {t("landing.heroTitle")}
            </h2>
            <p className="mt-3 text-sm leading-6 text-muted">
              {t("landing.heroSubtitle")}
            </p>
            <Link href="/register" className="mt-6 inline-block">
              <Button size="lg">
                {t("landing.ctaStart")}
                <Icon name="arrowRight" size={16} className="rtl:-scale-x-100" />
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
