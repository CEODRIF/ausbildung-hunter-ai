"use client";

/**
 * Public site header — a floating white pill that sits on the sky.
 *
 * It is `sticky` and lives INSIDE the sky wrapper on the landing page, so the
 * bar stays visible across the whole hero and then scrolls away with it (the
 * same pattern the reference uses). No scroll listener, no layout shift: the
 * pill is part of the normal flow.
 *
 * Responsive contract:
 *   < sm  brand + menu only — everything else lives in the panel, which keeps
 *         the 320 px bar uncluttered and every touch target at least 40 px
 *   sm+   + language selector and the primary CTA
 *   lg+   + inline section navigation and the log-in link
 */
import { useState } from "react";
import Link from "next/link";
import { Menu, X } from "lucide-react";
import { BrandLogo } from "@/components/brand-logo";
import { LanguageSwitcher } from "@/components/language-switcher";
import { ThemeSwitcher } from "@/components/theme-switcher";
import { useI18n } from "@/lib/i18n";

const LINKS = [
  { href: "#how", key: "v2.nav.how" },
  { href: "/opportunities", key: "v2.nav.jobs" },
  { href: "#plans", key: "v2.nav.pricing" },
  { href: "#faq", key: "v2.nav.faq" },
  { href: "/bibliothek", key: "v2.nav.library" },
] as const;

export function SiteHeader() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-40 px-3 pt-3 sm:px-5 sm:pt-4">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 rounded-full bg-surface/95 px-2.5 py-2 shadow-[var(--shadow-float)] ring-1 ring-navy/5 backdrop-blur-md sm:px-4">
        <BrandLogo size={32} className="ps-1" />

        <nav className="hidden items-center gap-6 text-sm font-semibold text-ink-soft lg:flex">
          {LINKS.map((link) => (
            <a key={link.href} href={link.href} className="transition-colors hover:text-accent">
              {t(link.key)}
            </a>
          ))}
        </nav>

        <div className="flex items-center gap-1.5">
          <span className="hidden sm:flex">
            <LanguageSwitcher />
          </span>
          <span className="hidden md:flex">
            <ThemeSwitcher />
          </span>
          <Link
            href="/login"
            className="hidden rounded-full px-3 py-2 text-sm font-semibold text-ink-soft transition-colors hover:text-accent lg:block"
          >
            {t("v2.nav.login")}
          </Link>
          <Link
            href="/register"
            className="btn-neon hidden items-center rounded-full px-4 py-2.5 text-xs font-bold text-white sm:inline-flex sm:text-sm"
          >
            {t("v2.nav.register")}
          </Link>

          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            aria-controls="site-mobile-menu"
            aria-label={t("v2.nav.menu")}
            className="flex h-10 w-10 items-center justify-center rounded-full border border-line-strong text-ink transition-colors hover:bg-surface-2 lg:hidden"
          >
            {open ? <X size={18} strokeWidth={2} /> : <Menu size={18} strokeWidth={2} />}
          </button>
        </div>
      </div>

      {open && (
        <div
          id="site-mobile-menu"
          className="mx-auto mt-2 max-w-6xl overflow-hidden rounded-3xl bg-surface p-2 shadow-[var(--shadow-float)] ring-1 ring-navy/5 lg:hidden"
        >
          <nav className="grid">
            {LINKS.map((link) => (
              <a
                key={link.href}
                href={link.href}
                onClick={() => setOpen(false)}
                className="rounded-2xl px-4 py-3 text-sm font-semibold text-ink-soft transition-colors hover:bg-surface-2 hover:text-ink"
              >
                {t(link.key)}
              </a>
            ))}
          </nav>

          <div className="mt-2 grid gap-2 border-t border-line pt-3">
            <div className="flex items-center justify-between gap-2 px-2">
              <LanguageSwitcher />
              <ThemeSwitcher />
            </div>
            <Link
              href="/login"
              onClick={() => setOpen(false)}
              className="rounded-2xl px-4 py-3 text-sm font-semibold text-ink-soft transition-colors hover:bg-surface-2"
            >
              {t("v2.nav.login")}
            </Link>
            <Link
              href="/register"
              onClick={() => setOpen(false)}
              className="btn-neon rounded-2xl px-4 py-3 text-center text-sm font-bold text-white"
            >
              {t("v2.nav.register")}
            </Link>
          </div>
        </div>
      )}
    </header>
  );
}
