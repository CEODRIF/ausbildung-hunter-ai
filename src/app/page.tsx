import Link from "next/link";
import {
  ArrowRight,
  BookOpen,
  Briefcase,
  Check,
  FileText,
  LayoutGrid,
  ScanLine,
  Search,
  Send,
  Sparkles,
  Target,
} from "lucide-react";
import { getServerT } from "@/lib/i18n/server";
import { SiteHeader } from "@/components/landing/site-header";
import { SiteFooter } from "@/components/landing/site-footer";
import { LandingFaq } from "@/components/landing/landing-faq";
import { HeroFlight } from "@/components/landing/hero-flight";

/**
 * Public landing page — "Aircraft Green" redesign.
 *
 * Server component: the only client code in the hero is the 3D flight scene
 * (HeroFlight — WebGL aircraft + dynamic sky with a CSS fallback underneath).
 * The search is a plain GET form into the existing /opportunities route
 * (which already parses `keyword` server-side), so the primary call to action
 * works with JS disabled and needs no new endpoint.
 */

const BENEFITS = [
  { icon: Search, titleKey: "landing.features.find.title", textKey: "landing.features.find.text" },
  { icon: ScanLine, titleKey: "landing.features.analyze.title", textKey: "landing.features.analyze.text" },
  { icon: Send, titleKey: "landing.features.apply.title", textKey: "landing.features.apply.text" },
  { icon: Target, titleKey: "landing.features.organize.title", textKey: "landing.features.organize.text" },
] as const;

const STEPS = [
  "landing.steps.step1",
  "landing.steps.step2",
  "landing.steps.step3",
  "landing.steps.step4",
  "landing.steps.step5",
] as const;

/** Career entry points. Each one is a real keyword search against the live
 *  Bundesagentur source — no invented listings, no invented counts. */
const CAREERS = [
  { key: "v2.jobs.pflege", keyword: "Pflegefachkraft", icon: Target },
  { key: "v2.jobs.it", keyword: "Fachinformatiker", icon: LayoutGrid },
  { key: "v2.jobs.mechatronik", keyword: "Mechatroniker", icon: Sparkles },
  { key: "v2.jobs.buero", keyword: "Kaufmann Büromanagement", icon: FileText },
  { key: "v2.jobs.gastro", keyword: "Koch", icon: Briefcase },
  { key: "v2.jobs.handwerk", keyword: "Elektroniker", icon: ScanLine },
] as const;

const FEATURES = [
  { key: "ai", icon: Sparkles, href: "/ai" },
  { key: "scanner", icon: ScanLine, href: "/bewerbung-scanner" },
  { key: "auto", icon: Send, href: "/auto-bewerb" },
  { key: "library", icon: BookOpen, href: "/bibliothek" },
] as const;

const TRUST = ["v2.hero.trustBa", "v2.hero.trustMatch", "v2.hero.trustPrivacy"] as const;

export default async function Home() {
  const t = await getServerT();

  return (
    <main className="min-h-screen bg-background text-ink">
      {/* ---------------------------------------------------------- hero -- */}
      <div className="sky-hero relative isolate">
        <HeroFlight />
        <div className="hero-scrim" aria-hidden="true" />
        <SiteHeader />

        <section className="relative z-10 mx-auto flex max-w-4xl flex-col items-center px-4 pb-20 pt-24 text-center [min-height:86svh] sm:px-6 sm:pb-28 sm:pt-28">
          <span className="anim-fade-up inline-flex items-center gap-2 rounded-full bg-white/20 px-3.5 py-1.5 text-[11px] font-bold text-white ring-1 ring-white/35 backdrop-blur-sm sm:text-xs">
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--green-lime)]" />
            {t("v2.hero.badge")}
          </span>

          <h1
            className="display-title hero-shadow mt-6 text-balance text-[clamp(2.25rem,8vw,4.5rem)] text-white anim-fade-up"
            style={{ animationDelay: "90ms" }}
          >
            {t("v2.hero.lead")}{" "}
            <span className="text-[var(--green-lime)]">{t("v2.hero.accent")}</span>{" "}
            {t("v2.hero.tail")}
          </h1>

          <p
            className="hero-shadow mt-5 max-w-xl text-pretty text-sm leading-6 text-white/95 sm:text-base sm:leading-7 anim-fade-up"
            style={{ animationDelay: "180ms" }}
          >
            {t("v2.hero.subtitle")}
          </p>

          <form
            action="/opportunities"
            method="get"
            className="hero-search anim-fade-up mt-8 flex w-full max-w-2xl items-center gap-2 rounded-full bg-white/95 p-2 shadow-[0_22px_48px_-20px_rgba(11,31,51,0.6)] ring-1 ring-white/40 backdrop-blur-md"
            style={{ animationDelay: "270ms" }}
          >
            <label htmlFor="hero-keyword" className="sr-only">
              {t("v2.hero.searchPlaceholder")}
            </label>
            <Search
              size={19}
              strokeWidth={2}
              aria-hidden="true"
              className="ms-3 shrink-0 text-faint"
            />
            <input
              id="hero-keyword"
              name="keyword"
              type="search"
              autoComplete="off"
              placeholder={t("v2.hero.searchPlaceholder")}
              className="min-w-0 flex-1 bg-transparent px-2 py-2.5 text-sm text-ink outline-none placeholder:text-faint sm:text-base"
            />
            <button
              type="submit"
              className="btn-neon inline-flex shrink-0 items-center gap-2 rounded-full px-4 py-3 text-sm font-bold text-white sm:px-6"
            >
              <span className="hidden sm:inline">{t("v2.hero.searchCta")}</span>
              <ArrowRight size={17} strokeWidth={2.2} className="rtl:rotate-180" />
            </button>
          </form>

          <div
            className="anim-fade-up mt-5 flex flex-wrap items-center justify-center gap-x-5 gap-y-2"
            style={{ animationDelay: "340ms" }}
          >
            <Link
              href="/opportunities"
              className="inline-flex items-center gap-1.5 text-sm font-bold text-white underline decoration-white/40 underline-offset-4 transition-colors hover:decoration-white"
            >
              {t("v2.hero.secondaryCta")}
            </Link>
          </div>

          <ul
            className="anim-fade-up mt-9 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-[11px] font-semibold text-white/90 sm:text-xs"
            style={{ animationDelay: "420ms" }}
          >
            {TRUST.map((key) => (
              <li key={key} className="inline-flex items-center gap-1.5">
                <Check size={13} strokeWidth={3} className="text-[var(--green-lime)]" />
                {t(key)}
              </li>
            ))}
          </ul>
        </section>
      </div>

      {/* ------------------------------------------------------ benefits -- */}
      <section className="section-pad bg-background">
        <div className="shell-x mx-auto max-w-7xl">
          <div className="max-w-2xl">
            <p className="text-xs font-bold tracking-[0.16em] text-accent uppercase">
              {t("v2.features.eyebrow")}
            </p>
            <h2 className="display-title mt-3 text-3xl text-ink sm:text-4xl">
              {t("landing.featureTitle")}
            </h2>
            <p className="mt-3 text-sm leading-6 text-muted sm:text-base">
              {t("landing.featureSubtitle")}
            </p>
          </div>

          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {BENEFITS.map((benefit) => {
              const Icon = benefit.icon;
              return (
                <div
                  key={benefit.titleKey}
                  className="card-interactive rounded-3xl p-6"
                >
                  <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-accent-soft text-accent">
                    <Icon size={20} strokeWidth={1.9} />
                  </span>
                  <h3 className="mt-4 text-base font-bold text-ink">
                    {t(benefit.titleKey)}
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-muted">
                    {t(benefit.textKey)}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* --------------------------------------------------- how it works -- */}
      <section id="how" className="section-pad border-y border-line bg-surface">
        <div className="shell-x mx-auto max-w-7xl">
          <div className="grid gap-10 lg:grid-cols-[0.85fr_1.15fr] lg:gap-16">
            <div className="lg:sticky lg:top-24 lg:self-start">
              <p className="text-xs font-bold tracking-[0.16em] text-accent uppercase">
                {t("v2.how.eyebrow")}
              </p>
              <h2 className="display-title mt-3 text-3xl text-ink sm:text-4xl">
                {t("v2.how.title")}
              </h2>
              <p className="mt-3 max-w-sm text-sm leading-6 text-muted sm:text-base">
                {t("v2.how.subtitle")}
              </p>
              <Link href="/register" className="mt-7 inline-flex">
                <span className="btn-neon inline-flex items-center gap-2 rounded-full px-5 py-3 text-sm font-bold text-white">
                  {t("v2.cta.button")}
                  <ArrowRight size={16} strokeWidth={2.2} className="rtl:rotate-180" />
                </span>
              </Link>
            </div>

            <ol className="relative space-y-2">
              {STEPS.map((stepKey, index) => (
                <li
                  key={stepKey}
                  className="flex items-start gap-4 rounded-2xl p-4 transition-colors hover:bg-surface-2 sm:gap-5 sm:p-5"
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-navy text-xs font-extrabold text-white">
                    <span className="num">{String(index + 1).padStart(2, "0")}</span>
                  </span>
                  <p className="pt-1.5 text-sm font-semibold leading-6 text-ink sm:text-base">
                    {t(stepKey)}
                  </p>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------- careers -- */}
      <section id="jobs" className="section-pad bg-background">
        <div className="shell-x mx-auto max-w-7xl">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="max-w-2xl">
              <p className="text-xs font-bold tracking-[0.16em] text-accent uppercase">
                {t("v2.jobs.eyebrow")}
              </p>
              <h2 className="display-title mt-3 text-3xl text-ink sm:text-4xl">
                {t("v2.jobs.title")}
              </h2>
              <p className="mt-3 text-sm leading-6 text-muted sm:text-base">
                {t("v2.jobs.subtitle")}
              </p>
            </div>
            <Link
              href="/opportunities"
              className="inline-flex items-center gap-1.5 text-sm font-bold text-accent transition-colors hover:text-accent-deep"
            >
              {t("v2.jobs.all")}
              <ArrowRight size={15} strokeWidth={2.2} className="rtl:rotate-180" />
            </Link>
          </div>

          <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {CAREERS.map((career) => {
              const Icon = career.icon;
              return (
                <Link
                  key={career.key}
                  href={`/opportunities?keyword=${encodeURIComponent(career.keyword)}`}
                  className="card-interactive group flex items-center gap-4 rounded-2xl p-5"
                >
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-ink-soft transition-colors group-hover:bg-accent-soft group-hover:text-accent">
                    <Icon size={19} strokeWidth={1.9} />
                  </span>
                  <span className="min-w-0 flex-1 text-sm font-bold text-ink">
                    {t(career.key)}
                  </span>
                  <ArrowRight
                    size={16}
                    strokeWidth={2.2}
                    className="shrink-0 text-faint transition-all group-hover:translate-x-0.5 group-hover:text-accent rtl:rotate-180 rtl:group-hover:-translate-x-0.5"
                  />
                </Link>
              );
            })}
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------ features -- */}
      <section id="features" className="section-pad border-y border-line bg-surface">
        <div className="shell-x mx-auto max-w-7xl">
          <div className="max-w-2xl">
            <p className="text-xs font-bold tracking-[0.16em] text-accent uppercase">
              {t("v2.features.eyebrow")}
            </p>
            <h2 className="display-title mt-3 text-3xl text-ink sm:text-4xl">
              {t("v2.features.title")}
            </h2>
            <p className="mt-3 text-sm leading-6 text-muted sm:text-base">
              {t("v2.features.subtitle")}
            </p>
          </div>

          <div className="mt-10 grid gap-4 sm:grid-cols-2">
            {FEATURES.map((feature) => {
              const Icon = feature.icon;
              return (
                <Link
                  key={feature.key}
                  href={feature.href}
                  className="card-interactive group flex flex-col rounded-3xl p-6 sm:p-7"
                >
                  <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-soft text-accent transition-colors group-hover:bg-accent group-hover:text-white">
                    <Icon size={22} strokeWidth={1.9} />
                  </span>
                  <h3 className="mt-5 text-lg font-bold text-ink">
                    {t(`v2.features.${feature.key}.title`)}
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-muted">
                    {t(`v2.features.${feature.key}.text`)}
                  </p>
                  <span className="mt-5 inline-flex items-center gap-1.5 text-xs font-bold text-accent">
                    {t("v2.nav.jobs")}
                    <ArrowRight
                      size={14}
                      strokeWidth={2.2}
                      className="transition-transform group-hover:translate-x-0.5 rtl:rotate-180 rtl:group-hover:-translate-x-0.5"
                    />
                  </span>
                </Link>
              );
            })}
          </div>
        </div>
      </section>

      {/* --------------------------------------------------------- plans -- */}
      <section id="plans" className="section-pad bg-background">
        <div className="shell-x mx-auto max-w-7xl">
          <div className="max-w-2xl">
            <p className="text-xs font-bold tracking-[0.16em] text-accent uppercase">
              {t("v2.pricing.eyebrow")}
            </p>
            <h2 className="display-title mt-3 text-3xl text-ink sm:text-4xl">
              {t("v2.pricing.title")}
            </h2>
            <p className="mt-3 text-sm leading-6 text-muted sm:text-base">
              {t("v2.pricing.subtitle")}
            </p>
          </div>

          {/* Plan NAMES only — prices and entitlements live in the billing
              area (real, server-resolved data). Nothing is invented here. */}
          <div className="mt-10 grid gap-4 sm:grid-cols-3">
            {(["free", "plus", "pro"] as const).map((tier) => (
              <div
                key={tier}
                className={`rounded-3xl border p-6 ${
                  tier === "plus"
                    ? "border-accent/40 bg-surface shadow-[var(--shadow-float)]"
                    : "border-line bg-surface shadow-[var(--shadow-card)]"
                }`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="text-lg font-bold text-ink">{t(`v2.pricing.${tier}`)}</h3>
                  {tier === "plus" && (
                    <span className="rounded-full bg-accent-soft px-2.5 py-1 text-[10px] font-bold tracking-wide text-accent uppercase">
                      {t("v2.pricing.plusText")}
                    </span>
                  )}
                </div>
                <p className="mt-2 text-sm leading-6 text-muted">
                  {t(`v2.pricing.${tier}Text`)}
                </p>
              </div>
            ))}
          </div>

          <div className="mt-6 flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="max-w-xl text-xs leading-5 text-faint">
              {t("v2.pricing.note")}
            </p>
            <Link href="/settings/billing" className="inline-flex shrink-0">
              <span className="inline-flex items-center gap-2 rounded-full border border-accent/45 px-5 py-2.5 text-sm font-bold text-accent transition-colors hover:bg-accent-soft">
                {t("v2.pricing.cta")}
                <ArrowRight size={15} strokeWidth={2.2} className="rtl:rotate-180" />
              </span>
            </Link>
          </div>
        </div>
      </section>

      {/* ----------------------------------------------------------- faq -- */}
      <LandingFaq />

      {/* ------------------------------------------------------ final cta -- */}
      <section className="bg-background pb-16 pt-2 sm:pb-24">
        <div className="shell-x mx-auto max-w-7xl">
          <div className="relative overflow-hidden rounded-[2rem] bg-navy px-6 py-12 text-center sm:px-12 sm:py-16">
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 opacity-40"
              style={{
                background:
                  "radial-gradient(30rem 18rem at 15% 0%, rgba(23,164,94,0.55) 0%, rgba(23,164,94,0) 70%), radial-gradient(26rem 16rem at 90% 100%, rgba(43,120,205,0.45) 0%, rgba(43,120,205,0) 70%)",
              }}
            />
            <div className="relative mx-auto max-w-2xl">
              <h2 className="display-title text-3xl text-white sm:text-4xl">
                {t("v2.cta.title")}
              </h2>
              <p className="mt-3 text-sm leading-6 text-white/75 sm:text-base">
                {t("v2.cta.subtitle")}
              </p>
              <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
                <Link href="/register" className="w-full sm:w-auto">
                  <span className="btn-neon inline-flex w-full items-center justify-center gap-2 rounded-full px-6 py-3.5 text-sm font-bold text-white sm:w-auto">
                    {t("v2.cta.button")}
                    <ArrowRight size={16} strokeWidth={2.2} className="rtl:rotate-180" />
                  </span>
                </Link>
                <Link href="/opportunities" className="w-full sm:w-auto">
                  <span className="inline-flex w-full items-center justify-center gap-2 rounded-full border border-white/25 px-6 py-3.5 text-sm font-bold text-white transition-colors hover:bg-white/10 sm:w-auto">
                    {t("v2.cta.secondary")}
                  </span>
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
