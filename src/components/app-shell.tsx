"use client";

/**
 * Global authenticated shell: sidebar (WORKSPACE / TOOLS / ACCOUNT) +
 * consistent header (page title, language switcher, theme switcher,
 * notifications, profile).
 *
 *  - Desktop: collapsible sidebar (state persisted to localStorage),
 *    tooltips when collapsed.
 *  - Mobile: off-canvas drawer with overlay (slides from the inline-start
 *    side, RTL-aware).
 *  - All colors come from design tokens; layout uses logical properties
 *    (start/end, ps/pe, ms/me) so Arabic (dir=rtl) mirrors automatically.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import type { Profile } from "@/lib/auth";
import { useI18n } from "@/lib/i18n";
import { relativeTime } from "@/lib/relative-time";
import { useDismiss } from "@/lib/use-dismiss";
import { Icon, type IconName } from "@/components/icon";
import { BrandLogo } from "@/components/brand-logo";
import { LanguageSwitcher } from "@/components/language-switcher";
import { ThemeSwitcher } from "@/components/theme-switcher";
import { ProfileMenu } from "@/components/profile-menu";

export { Icon } from "@/components/icon"; // compat re-export

// ---------------------------------------------------------------------------
// Navigation model (sections + items; i18n label keys, canonical icons)
// ---------------------------------------------------------------------------

interface NavItem {
  labelKey: string;
  href: string;
  icon: IconName;
  soon?: boolean;
}

interface NavSection {
  titleKey: string;
  items: NavItem[];
}

const NAV_SECTIONS: NavSection[] = [
  {
    titleKey: "nav.workspace",
    items: [
      { labelKey: "nav.dashboard", href: "/dashboard", icon: "grid" },
      { labelKey: "nav.aiAssistant", href: "/ai", icon: "spark" },
      {
        labelKey: "nav.ausbildungSearch",
        href: "/opportunities/ai-search",
        icon: "search",
      },
      {
        labelKey: "nav.bewerbungScanner",
        href: "/bewerbung-scanner",
        icon: "scan",
      },
      { labelKey: "nav.bewerbungen", href: "/applications", icon: "briefcase" },
      {
        labelKey: "nav.savedOpportunities",
        href: "/opportunities/saved",
        icon: "bookmark",
      },
    ],
  },
  {
    titleKey: "nav.tools",
    items: [
      { labelKey: "nav.emailAssistant", href: "/settings/email", icon: "mail" },
      { labelKey: "nav.templates", href: "/dashboard/templates", icon: "file" },
      { labelKey: "nav.coverLetter", href: "/dashboard/cover-letter", icon: "send" },
    ],
  },
  {
    titleKey: "nav.account",
    items: [{ labelKey: "nav.settings", href: "/settings/usage", icon: "settings" }],
  },
];

// ---------------------------------------------------------------------------
// Route → header title/subtitle (i18n keys)
// ---------------------------------------------------------------------------

interface PageHeading {
  titleKey: string;
  subtitleKey: string;
}

const PAGE_HEADINGS: Array<{ match: (pathname: string) => boolean; heading: PageHeading }> = [
  {
    match: (p) => p === "/dashboard/templates",
    heading: { titleKey: "pages.templates.title", subtitleKey: "pages.templates.subtitle" },
  },
  {
    match: (p) => p === "/dashboard/cover-letter",
    heading: { titleKey: "pages.coverLetter.title", subtitleKey: "pages.coverLetter.subtitle" },
  },
  {
    match: (p) => p === "/dashboard" || p.startsWith("/dashboard/"),
    heading: { titleKey: "pages.dashboard.title", subtitleKey: "pages.dashboard.subtitle" },
  },
  {
    match: (p) => p === "/ai" || p.startsWith("/ai/"),
    heading: { titleKey: "pages.aiAssistant.title", subtitleKey: "pages.aiAssistant.subtitle" },
  },
  {
    match: (p) => p === "/opportunities/ai-search" || p.startsWith("/opportunities/ai-search/"),
    heading: { titleKey: "pages.ausbildungSearch.title", subtitleKey: "pages.ausbildungSearch.subtitle" },
  },
  {
    match: (p) => p === "/opportunities/saved" || p.startsWith("/opportunities/saved/"),
    heading: { titleKey: "pages.opportunitiesSaved.title", subtitleKey: "pages.opportunitiesSaved.subtitle" },
  },
  {
    match: (p) => p.startsWith("/opportunities/"),
    heading: { titleKey: "pages.opportunityDetail.title", subtitleKey: "pages.opportunityDetail.subtitle" },
  },
  {
    match: (p) => p === "/opportunities",
    heading: { titleKey: "pages.opportunities.title", subtitleKey: "pages.opportunities.subtitle" },
  },
  {
    match: (p) => p === "/applications/new" || p.startsWith("/applications/new/"),
    heading: { titleKey: "pages.newApplication.title", subtitleKey: "pages.newApplication.subtitle" },
  },
  {
    match: (p) => p.startsWith("/applications/campaign/"),
    heading: { titleKey: "pages.campaign.title", subtitleKey: "pages.campaign.subtitle" },
  },
  {
    match: (p) => p === "/applications" || p.startsWith("/applications/"),
    heading: { titleKey: "pages.bewerbungen.title", subtitleKey: "pages.bewerbungen.subtitle" },
  },
  {
    match: (p) => p === "/bewerbung-scanner" || p.startsWith("/bewerbung-scanner/"),
    heading: { titleKey: "pages.scanner.title", subtitleKey: "pages.scanner.subtitle" },
  },
  {
    match: (p) => p === "/settings/email" || p.startsWith("/settings/email/"),
    heading: { titleKey: "pages.settingsEmail.title", subtitleKey: "pages.settingsEmail.subtitle" },
  },
  {
    match: (p) => p === "/settings/usage" || p.startsWith("/settings/usage/"),
    heading: { titleKey: "pages.settingsUsage.title", subtitleKey: "pages.settingsUsage.subtitle" },
  },
  {
    match: (p) => p === "/settings/data" || p.startsWith("/settings/data/"),
    heading: { titleKey: "pages.settingsData.title", subtitleKey: "pages.settingsData.subtitle" },
  },
  {
    match: (p) => p === "/settings/billing" || p.startsWith("/settings/billing/"),
    heading: { titleKey: "pages.settingsBilling.title", subtitleKey: "pages.settingsBilling.subtitle" },
  },
  {
    match: (p) => p === "/settings" || p.startsWith("/settings/"),
    heading: { titleKey: "pages.settings.title", subtitleKey: "pages.settings.subtitle" },
  },
];

function isActive(pathname: string, href: string): boolean {
  if (href === "/dashboard") return pathname === href || pathname.startsWith(`${href}/`);
  return pathname === href || pathname.startsWith(`${href}/`);
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

const SIDEBAR_STORAGE_KEY = "aha:sidebar";

function NavSectionList({
  sections,
  pathname,
  collapsed,
  onNavigate,
}: {
  sections: NavSection[];
  pathname: string;
  collapsed: boolean;
  onNavigate: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className={`flex-1 space-y-6 overflow-y-auto py-2 ${collapsed ? "px-3" : "px-2"}`}>
      {sections.map((section, index) => (
        <div key={section.titleKey}>
          {index > 0 && (
            <div className={`mb-4 border-t border-line ${collapsed ? "mx-1" : "ms-1.5 me-4"}`} />
          )}
          {!collapsed && (
            <p className="mb-2 px-3 text-[10px] font-bold uppercase tracking-[0.16em] text-faint">
              {t(section.titleKey)}
            </p>
          )}
          <nav
            aria-label={t(section.titleKey)}
            className="space-y-0.5"
          >
            {section.items.map((item) => {
              const label = t(item.labelKey);
              const active = !item.soon && isActive(pathname, item.href);
              if (item.soon) {
                return (
                  <div
                    key={item.labelKey}
                    title={collapsed ? label : undefined}
                    aria-disabled="true"
                    className={`group relative flex items-center gap-3 rounded-xl text-sm font-semibold text-faint ${
                      collapsed ? "justify-center px-0 py-2.5" : "px-3 py-2.5"
                    }`}
                  >
                    <Icon name={item.icon} className="shrink-0" />
                    {!collapsed && <span className="flex-1">{label}</span>}
                    {!collapsed && (
                      <span className="text-[9px] font-bold uppercase tracking-[0.08em]">
                        {t("nav.soon")}
                      </span>
                    )}
                    {collapsed && (
                      <Tooltip label={label} />
                    )}
                  </div>
                );
              }
              return (
                <Link
                  key={item.labelKey}
                  href={item.href}
                  onClick={onNavigate}
                  aria-current={active ? "page" : undefined}
                  title={collapsed ? label : undefined}
                  className={`group relative flex items-center gap-3 rounded-xl text-sm font-semibold transition-colors ${
                    collapsed ? "justify-center px-0 py-2.5" : "px-3 py-2.5"
                  } ${
                    active
                      ? "bg-accent-soft text-accent"
                      : "text-muted hover:bg-surface-2 hover:text-ink"
                  }`}
                >
                  <Icon name={item.icon} className="shrink-0" />
                  {!collapsed && <span className="truncate flex-1">{label}</span>}
                  {collapsed && <Tooltip label={label} />}
                </Link>
              );
            })}
          </nav>
        </div>
      ))}
    </div>
  );
}

function Tooltip({ label }: { label: string }) {
  return (
    <span
      className="pointer-events-none absolute start-full top-1/2 z-50 ms-3 -translate-y-1/2 whitespace-nowrap rounded-lg bg-navy px-2.5 py-1.5 text-xs font-semibold text-white opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100 rtl:-scale-x-100 dark:bg-surface-2 dark:text-ink"
    >
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Notifications (in-app: global platform updates + targeted owner messages)
// ---------------------------------------------------------------------------

interface ShellNotification {
  id: string;
  title: string;
  content: string;
  type: "info" | "important" | "maintenance" | "improvement";
  created_at: string;
  read: boolean;
  read_at: string | null;
}

const NOTIF_TYPE_KEYS = {
  info: "admin.notifTypeInfo",
  important: "admin.notifTypeImportant",
  maintenance: "admin.notifTypeMaintenance",
  improvement: "admin.notifTypeImprovement",
} as const;

function NotificationsBell() {
  const { t, lang } = useI18n();
  const locale =
    lang === "de" ? "de-DE" : lang === "fr" ? "fr-FR" : lang === "ar" ? "ar" : "en-US";
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ShellNotification[] | null>(null);
  const rootRef = useDismiss<HTMLDivElement>(open, useCallback(() => setOpen(false), []));

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/notifications", { cache: "no-store" });
      if (!response.ok) return;
      const data = (await response.json()) as { items: ShellNotification[] };
      setItems(data.items);
    } catch {
      // Keep whatever we already show; the bell is non-critical chrome.
    }
  }, []);

  useEffect(() => {
    // Initial notification list load: fetch → setState after await (async,
    // not a synchronous cascading update).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);
  // Refresh when the tab becomes visible again + a slow 60 s poll.
  useEffect(() => {
    const onVisible = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    const interval = setInterval(() => void refresh(), 60_000);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(interval);
    };
  }, [refresh]);

  const unread = (items ?? []).filter((item) => !item.read).length;

  const markRead = async (item: ShellNotification) => {
    if (item.read) return;
    // Optimistic: the read state is per-user and idempotent server-side.
    setItems((current) =>
      (current ?? []).map((row) =>
        row.id === item.id
          ? { ...row, read: true, read_at: new Date().toISOString() }
          : row,
      ),
    );
    try {
      await fetch("/api/notifications/read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ notification_id: item.id }),
      });
    } catch {
      // Next refresh reconciles.
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label={t("header.notifications")}
        aria-haspopup="menu"
        aria-expanded={open}
        className="relative flex h-9 w-9 items-center justify-center rounded-xl text-muted transition-colors hover:bg-surface-2 hover:text-ink"
      >
        <Icon name="bell" size={18} />
        {unread > 0 && (
          <span className="absolute -end-0.5 -top-0.5 flex h-4.5 min-w-4.5 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-bold text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>
      {open && (
        <div
          role="menu"
          aria-label={t("header.notifications")}
          className="absolute end-0 top-11 z-50 w-80 overflow-hidden rounded-xl border border-line bg-surface card-shadow"
        >
          <div className="border-b border-line px-4 py-3 text-sm font-bold text-ink">
            {t("header.notifications")}
          </div>
          {items === null || items.length === 0 ? (
            <div className="flex flex-col items-center gap-2.5 px-5 py-7 text-center">
              <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-surface-2 text-faint">
                <Icon name="bell" size={18} />
              </span>
              <p className="text-sm font-bold text-ink">{t("header.noNotifications")}</p>
              <p className="text-xs leading-5 text-muted">
                {t("header.noNotificationsHint")}
              </p>
            </div>
          ) : (
            <ul className="max-h-96 divide-y divide-line overflow-y-auto">
              {items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => void markRead(item)}
                    className={`block w-full px-4 py-3 text-start transition-colors hover:bg-surface-2 ${
                      item.read ? "" : "bg-surface-2/50"
                    }`}
                  >
                    <span className="flex items-start gap-2">
                      <span
                        className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                          item.read ? "bg-transparent" : "bg-accent"
                        }`}
                      />
                      <span className="min-w-0">
                        <span className="flex items-baseline gap-2">
                          <span className="truncate text-sm font-semibold text-ink">
                            {item.title}
                          </span>
                          <span className="shrink-0 rounded bg-surface-2 px-1 py-px text-[9px] font-bold uppercase tracking-wide text-faint">
                            {t(NOTIF_TYPE_KEYS[item.type])}
                          </span>
                        </span>
                        <span className="mt-0.5 line-clamp-2 block text-xs leading-5 text-muted">
                          {item.content}
                        </span>
                        <span className="mt-1 block text-[10px] font-semibold uppercase tracking-wide text-faint">
                          {relativeTime(item.created_at, t, locale)}
                        </span>
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

export function AppShell({
  children,
  profile,
  isPlatformOwner,
}: {
  children: React.ReactNode;
  profile?: Profile | null;
  /** Server-computed (layout) by comparing the AUTHENTICATED session UID
   *  against the platform-owner constant — never client-supplied. Controls
   *  ONLY the sidebar entry; /admin and every admin API re-verify
   *  server-side (requireAdmin + requirePlatformOwner). */
  isPlatformOwner?: boolean;
}) {
  const pathname = usePathname();
  const { t } = useI18n();
  const [mobileOpen, setMobileOpen] = useState(false);
  // The Platform section (→ /admin, where Platform Updates lives) is offered
  // ONLY to the platform owner — regular users never see the admin entry
  // point at all. Visibility is decided server-side (layout); /admin and
  // every admin API re-verify the UID server-side regardless.
  const sections: NavSection[] = isPlatformOwner
    ? [
        ...NAV_SECTIONS,
        {
          titleKey: "nav.platform",
          items: [{ labelKey: "nav.platformUpdates", href: "/admin", icon: "bell" }],
        },
      ]
    : NAV_SECTIONS;
  const [collapsed, setCollapsed] = useState(false);
  const closeMobile = useCallback(() => setMobileOpen(false), []);

  // Restore the persisted collapse state after hydration (no mismatch:
  // server + first client render both use the expanded layout).
  useEffect(() => {
    try {
      // Intentional post-hydration restore of the persisted sidebar state
      // (localStorage); the server render uses the expanded layout on purpose.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCollapsed(window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === "collapsed");
    } catch {
      /* ignore */
    }
  }, []);

  const toggleCollapsed = () => {
    setCollapsed((value) => {
      const next = !value;
      try {
        window.localStorage.setItem(SIDEBAR_STORAGE_KEY, next ? "collapsed" : "expanded");
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  // Close the mobile drawer on route change.
  useEffect(() => {
    // Intentional: reset transient UI state on navigation (route-driven).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMobileOpen(false);
  }, [pathname]);

  const heading = PAGE_HEADINGS.find((entry) => entry.match(pathname))?.heading;
  const displayName = profile?.full_name || "";
  const initials = displayName
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className="app-shell-root min-h-screen bg-background">
      <aside
        className={`fixed inset-y-0 start-0 z-40 flex w-[280px] flex-col border-e border-line bg-surface transition-[width,transform] duration-200 lg:w-[264px] ${
          collapsed ? "lg:w-[76px]" : ""
        } ${
          mobileOpen
            ? "max-lg:translate-x-0"
            : "ltr:max-lg:-translate-x-full rtl:max-lg:translate-x-full"
        } lg:translate-x-0`}
      >
        <div className={`flex items-center justify-between px-4 py-4 ${collapsed ? "lg:justify-center lg:px-2" : ""}`}>
          <BrandLogo variant={collapsed ? "mark" : "full"} size={34} />
          <button
            className="rounded-lg p-1.5 text-faint hover:bg-surface-2 hover:text-ink lg:hidden"
            onClick={closeMobile}
            aria-label={t("common.close")}
          >
            <Icon name="x" />
          </button>
        </div>

        <NavSectionList
          sections={sections}
          pathname={pathname}
          collapsed={collapsed}
          onNavigate={closeMobile}
        />

        <div className={`border-t border-line pt-3 ${collapsed ? "px-3" : "px-2"}`}>
          {profile && !collapsed && (
            <div className="mb-2 flex items-center gap-2.5 rounded-xl bg-surface-2 px-3 py-2.5">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[11px] font-bold text-accent">
                {initials}
              </span>
              <div className="min-w-0">
                <p className="truncate text-xs font-bold text-ink">{displayName}</p>
                <p className="truncate text-[11px] text-muted">{profile.email}</p>
              </div>
            </div>
          )}
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label={collapsed ? t("nav.expand") : t("nav.collapse")}
            className={`hidden w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold text-muted transition-colors hover:bg-surface-2 hover:text-ink lg:flex ${
              collapsed ? "justify-center" : ""
            }`}
          >
            <Icon
              name={collapsed ? "chevronRight" : "chevronLeft"}
              className="rtl:-scale-x-100"
            />
            {!collapsed && <span>{t("nav.collapse")}</span>}
          </button>
        </div>
      </aside>

      {mobileOpen && (
        <button
          className="fixed inset-0 z-30 bg-navy/45 lg:hidden dark:bg-black/60"
          aria-label={t("common.close")}
          onClick={closeMobile}
        />
      )}

      <div className={`transition-[padding] duration-200 ${collapsed ? "lg:ps-[76px]" : "lg:ps-[264px]"}`}>
        <header className="sticky top-0 z-20 flex h-16 items-center justify-between gap-3 border-b border-line bg-surface/90 px-4 backdrop-blur-md sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <button
              className="rounded-xl border border-line-strong p-2 text-muted transition-colors hover:bg-surface-2 hover:text-ink lg:hidden"
              onClick={() => setMobileOpen(true)}
              aria-label={t("nav.expand")}
            >
              <Icon name="menu" />
            </button>
            {heading && (
              <div className="min-w-0">
                <h1 className="truncate text-base font-bold text-ink">
                  {t(heading.titleKey)}
                </h1>
                <p className="hidden truncate text-xs text-muted sm:block">
                  {t(heading.subtitleKey)}
                </p>
              </div>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
            <LanguageSwitcher />
            <ThemeSwitcher />
            <NotificationsBell />
            <div className="mx-1 hidden h-6 w-px bg-line sm:block" />
            {profile ? (
              <ProfileMenu profile={profile} />
            ) : (
              <span className="text-xs text-faint">
                {t("account.accountFallback")}
              </span>
            )}
          </div>
        </header>
        <main>{children}</main>
      </div>
    </div>
  );
}
