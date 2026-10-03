"use client";

/**
 * Global authenticated shell — Premium 2026 layout:
 *
 *  - Desktop: floating glass top navigation (brand, primary items, a
 *    "More" menu for the secondary sections, language/theme/notifications/
 *    profile) inside a sticky header bar.
 *  - Mobile: compact floating bottom navigation (Dashboard, Discover,
 *    Applications, AI, More) + the full off-canvas drawer for everything.
 *
 *  All colors come from the design tokens; layout uses logical properties
 *  (start/end, ps/pe, ms/me) so Arabic (dir=rtl) mirrors automatically.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  BarChart3,
  Bell,
  Bookmark,
  Briefcase,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Clock,
  type LucideIcon,
  Download,
  ExternalLink,
  FileText,
  Folder,
  Globe,
  Image as ImageIcon,
  LayoutGrid,
  Lock,
  LogOut,
  Mail,
  Menu,
  Monitor,
  Moon,
  MoreHorizontal,
  Paperclip,
  PanelLeftClose,
  PanelLeftOpen,
  PenLine,
  Plus,
  ScanLine,
  Search,
  Send,
  Settings,
  Sparkles,
  Square,
  Sun,
  Target,
  Trash2,
  Upload,
  User,
  X,
} from "lucide-react";
import type { Profile } from "@/lib/auth";
import { useI18n } from "@/lib/i18n";
import { relativeTime } from "@/lib/relative-time";
import { useDismiss } from "@/lib/use-dismiss";
import { Icon, type IconName } from "@/components/icon";
import { BrandLogo } from "@/components/brand-logo";
import { GradientMesh } from "@/components/ui/surfaces";
import { LegalFooter } from "@/components/legal-footer";
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
      { labelKey: "nav.opportunities", href: "/opportunities", icon: "target" },
      {
        labelKey: "nav.companyDiscovery",
        href: "/company-discovery",
        icon: "globe",
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
    items: [
      { labelKey: "nav.profile", href: "/settings/profile", icon: "user" },
      { labelKey: "nav.settings", href: "/settings/usage", icon: "settings" },
    ],
  },
  {
    titleKey: "nav.help",
    items: [{ labelKey: "nav.faq", href: "/dashboard/faq", icon: "help" }],
  },
];

/** Canonical icon set for the shell (lucide, 1.8 stroke to match Icon). */
const LUCIDE: Record<IconName, LucideIcon> = {
  grid: LayoutGrid,
  search: Search,
  bookmark: Bookmark,
  file: FileText,
  folder: Folder,
  settings: Settings,
  help: CircleHelp,
  menu: Menu,
  bell: Bell,
  mail: Mail,
  spark: Sparkles,
  user: User,
  scan: ScanLine,
  edit: PenLine,
  send: Send,
  activity: Activity,
  target: Target,
  briefcase: Briefcase,
  plus: Plus,
  paperclip: Paperclip,
  arrowUp: ArrowUp,
  stop: Square,
  x: X,
  image: ImageIcon,
  alert: AlertTriangle,
  arrowLeft: ArrowLeft,
  arrowRight: ArrowRight,
  arrow: ArrowRight,
  chevron: ChevronDown,
  chevronLeft: ChevronLeft,
  chevronRight: ChevronRight,
  check: Check,
  sun: Sun,
  moon: Moon,
  monitor: Monitor,
  globe: Globe,
  external: ExternalLink,
  trash: Trash2,
  download: Download,
  upload: Upload,
  lock: Lock,
  clock: Clock,
  logout: LogOut,
  chart: BarChart3,
};

/** Primary items in the floating top bar (Desktop). */
const PRIMARY_NAV: NavItem[] = [
  { labelKey: "nav.dashboard", href: "/dashboard", icon: "grid" },
  {
    labelKey: "nav.companyDiscovery",
    href: "/company-discovery",
    icon: "globe",
  },
  { labelKey: "nav.aiAssistant", href: "/ai", icon: "spark" },
  { labelKey: "nav.bewerbungen", href: "/applications", icon: "briefcase" },
  { labelKey: "nav.emailAssistant", href: "/settings/email", icon: "mail" },
];

/** Mobile floating bottom bar: the four most-used destinations + More. */
const MOBILE_NAV: NavItem[] = [
  { labelKey: "nav.dashboard", href: "/dashboard", icon: "grid" },
  {
    labelKey: "nav.companyDiscovery",
    href: "/company-discovery",
    icon: "globe",
  },
  { labelKey: "nav.bewerbungen", href: "/applications", icon: "briefcase" },
  { labelKey: "nav.aiAssistant", href: "/ai", icon: "spark" },
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
    match: (p) => p === "/dashboard/faq",
    heading: { titleKey: "pages.faq.title", subtitleKey: "pages.faq.subtitle" },
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
    match: (p) => p === "/company-discovery" || p.startsWith("/company-discovery/"),
    heading: { titleKey: "pages.companyDiscovery.title", subtitleKey: "pages.companyDiscovery.subtitle" },
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
    match: (p) => p === "/settings/profile" || p.startsWith("/settings/profile/"),
    heading: { titleKey: "pages.settingsProfile.title", subtitleKey: "pages.settingsProfile.subtitle" },
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
// Secondary navigation list (drawer + "More" menu)
// ---------------------------------------------------------------------------

const NAV_COLLAPSED_KEY = "aha:navCollapsed";

function NavSectionList({
  sections,
  pathname,
  onNavigate,
}: {
  sections: NavSection[];
  pathname: string;
  onNavigate: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex-1 space-y-6 overflow-y-auto px-3 py-4">
      {sections.map((section, index) => (
        <div key={section.titleKey}>
          {index > 0 && <div className="mb-4 ms-1.5 me-4 border-t border-line" />}
          <p className="mb-2 px-3 text-[10px] font-bold tracking-[0.16em] text-faint uppercase">
            {t(section.titleKey)}
          </p>
          <nav aria-label={t(section.titleKey)} className="space-y-0.5">
            {section.items.map((item) => {
              const label = t(item.labelKey);
              const active = !item.soon && isActive(pathname, item.href);
              const IconCmp = LUCIDE[item.icon];
              if (item.soon) {
                return (
                  <div
                    key={item.labelKey}
                    aria-disabled="true"
                    className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold text-faint"
                  >
                    <IconCmp size={18} strokeWidth={1.8} className="shrink-0" />
                    <span className="flex-1">{label}</span>
                    <span className="text-[9px] font-bold tracking-[0.08em] uppercase">
                      {t("nav.soon")}
                    </span>
                  </div>
                );
              }
              return (
                <Link
                  key={item.labelKey}
                  href={item.href}
                  onClick={onNavigate}
                  aria-current={active ? "page" : undefined}
                  className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold transition-colors ${
                    active
                      ? "bg-accent-soft text-accent"
                      : "text-muted hover:bg-surface-2 hover:text-ink"
                  }`}
                >
                  <IconCmp size={18} strokeWidth={1.8} className="shrink-0" />
                  <span className="truncate flex-1">{label}</span>
                </Link>
              );
            })}
          </nav>
        </div>
      ))}
    </div>
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

// Short module-level TTL cache: AppShell remounts on every section
// navigation, so a fresh /api/notifications fetch per remount would be pure
// duplicate traffic. 30 s is comfortably fresh for an unread badge; the
// cache is invalidated when the user marks a notification read. All mutation
// happens in these plain module-level accessors (not in component code).
const notificationCache: {
  at: number;
  items: ShellNotification[] | null;
} = { at: 0, items: null };
const NOTIFICATION_TTL_MS = 30_000;

function readNotificationCache(): ShellNotification[] | null {
  if (notificationCache.items && Date.now() - notificationCache.at < NOTIFICATION_TTL_MS)
    return notificationCache.items;
  return null;
}
function writeNotificationCache(items: ShellNotification[]) {
  notificationCache.at = Date.now();
  notificationCache.items = items;
}
function invalidateNotificationCache() {
  notificationCache.at = 0;
  notificationCache.items = null;
}

function NotificationsBell() {
  const { t, lang } = useI18n();
  const locale =
    lang === "de" ? "de-DE" : lang === "fr" ? "fr-FR" : lang === "ar" ? "ar" : "en-US";
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ShellNotification[] | null>(null);
  const rootRef = useDismiss<HTMLDivElement>(open, useCallback(() => setOpen(false), []));

  const refresh = useCallback(async () => {
    const cached = readNotificationCache();
    if (cached) {
      setItems(cached);
      return;
    }
    try {
      const response = await fetch("/api/notifications", { cache: "no-store" });
      if (!response.ok) return;
      const data = (await response.json()) as { items: ShellNotification[] };
      writeNotificationCache(data.items);
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
    // Poll only while the tab is visible — a background tab needs no polls
    // (visibilitychange already refreshes on return).
    const interval = setInterval(() => {
      if (document.hidden) return;
      void refresh();
    }, 60_000);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(interval);
    };
  }, [refresh]);

  const unread = (items ?? []).filter((item) => !item.read).length;

  const markRead = async (item: ShellNotification) => {
    if (item.read) return;
    // Optimistic: the read state is per-user and idempotent server-side.
    // Invalidate the shared cache so a remount re-reads the fresh state
    // instead of resurrecting the stale unread flag.
    invalidateNotificationCache();
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
        className="relative flex h-10 w-10 items-center justify-center rounded-2xl text-muted transition-colors hover:bg-surface-2 hover:text-ink"
      >
        <Bell size={18} strokeWidth={1.8} />
        {unread > 0 && (
          <span className="absolute top-0.5 end-0.5 flex h-4.5 min-w-4.5 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-bold text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>
      {open && (
        <div
          role="menu"
          aria-label={t("header.notifications")}
          className="glass absolute top-12 end-0 z-50 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-3xl"
        >
          <div className="border-b border-line px-4 py-3 text-sm font-bold text-ink">
            {t("header.notifications")}
          </div>
          {items === null || items.length === 0 ? (
            <div className="flex flex-col items-center gap-2.5 px-5 py-7 text-center">
              <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-accent-soft text-accent">
                <Bell size={18} strokeWidth={1.8} />
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
                          <span className="shrink-0 rounded bg-surface-2 px-1 py-px text-[9px] font-bold tracking-wide text-faint uppercase">
                            {t(NOTIF_TYPE_KEYS[item.type])}
                          </span>
                        </span>
                        <span className="mt-0.5 line-clamp-2 block text-xs leading-5 text-muted">
                          {item.content}
                        </span>
                        <span className="mt-1 block text-[10px] font-semibold tracking-wide text-faint uppercase">
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
   *  ONLY the secondary entry; /admin and every admin API re-verify
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
  const closeMobile = useCallback(() => setMobileOpen(false), []);

  // Top-nav compact mode: icon-only links (labels hidden, tooltips on).
  // Persisted like the old sidebar state; server render starts expanded so
  // server + first client render agree.
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try {
      // Intentional post-hydration restore of the persisted nav state
      // (localStorage); the server render uses the expanded layout on purpose.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCollapsed(window.localStorage.getItem(NAV_COLLAPSED_KEY) === "collapsed");
    } catch {
      /* ignore */
    }
  }, []);

  const toggleCollapsed = () => {
    setCollapsed((value) => {
      const next = !value;
      try {
        window.localStorage.setItem(NAV_COLLAPSED_KEY, next ? "collapsed" : "expanded");
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

  return (
    <div className="app-shell-root min-h-screen bg-background">
      <GradientMesh />
      <div className="relative z-10 flex min-h-screen flex-col">
        {/* ------------------------------------------------ top bar -------- */}
        <header className="sticky top-0 z-20 flex h-16 items-center px-3 sm:px-6">
          <div className="glass mx-auto flex h-14 w-full max-w-7xl items-center justify-between gap-2 rounded-3xl ps-3 pe-2">
            {/* brand + mobile drawer trigger */}
            <div className="flex min-w-0 items-center gap-2">
              <button
                className="flex h-10 w-10 items-center justify-center rounded-2xl text-muted transition-colors hover:bg-surface-2 hover:text-ink lg:hidden"
                onClick={() => setMobileOpen(true)}
                aria-label={t("nav.expand")}
              >
                <MoreHorizontal size={19} strokeWidth={1.8} className="rotate-90" />
              </button>
              <BrandLogo
                variant={pathname === "/dashboard" ? "mark" : "full"}
                size={32}
                href="/dashboard"
                wordmarkClassName="hidden sm:inline"
              />
            </div>

            {/* primary items (desktop) */}
            <nav
              aria-label={t("nav.workspace")}
              className="hidden items-center gap-1 lg:flex"
            >
              {PRIMARY_NAV.map((item) => {
                const label = t(item.labelKey);
                const active = isActive(pathname, item.href);
                const IconCmp = LUCIDE[item.icon];
                return (
                  <Link
                    key={`${item.href}-top`}
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    title={collapsed ? label : undefined}
                    className={`flex h-10 items-center gap-2 rounded-2xl px-3.5 text-sm font-semibold transition-all ${
                      active
                        ? "bg-accent-soft text-accent shadow-[inset_0_1px_0_rgba(255,255,255,0.6)]"
                        : "text-muted hover:bg-surface-2 hover:text-ink"
                    } ${collapsed ? "justify-center px-3" : ""}`}
                  >
                    <IconCmp size={17} strokeWidth={1.8} />
                    <span className={collapsed ? "hidden" : "hidden xl:inline"}>
                      {label}
                    </span>
                  </Link>
                );
              })}
            </nav>

            {/* right cluster */}
            <div className="flex shrink-0 items-center gap-0.5 sm:gap-1.5">
              {heading && (
                <div className="me-1 hidden min-w-0 md:block">
                  <h1 className="max-w-44 truncate text-sm font-bold text-ink">
                    {t(heading.titleKey)}
                  </h1>
                  <p className="max-w-44 truncate text-[11px] text-muted">
                    {t(heading.subtitleKey)}
                  </p>
                </div>
              )}
              <button
                type="button"
                onClick={toggleCollapsed}
                aria-label={collapsed ? t("nav.expand") : t("nav.collapse")}
                className="hidden h-10 w-10 items-center justify-center rounded-2xl text-muted transition-colors hover:bg-surface-2 hover:text-ink lg:flex"
              >
                {collapsed ? (
                  <PanelLeftOpen size={18} strokeWidth={1.8} />
                ) : (
                  <PanelLeftClose size={18} strokeWidth={1.8} />
                )}
              </button>
              <SecondaryMenu sections={sections} pathname={pathname} />
              <span className="ms-1 hidden h-7 w-px bg-line sm:block" />
              <span className="hidden sm:block">
                <LanguageSwitcher />
              </span>
              <span className="hidden sm:block">
                <ThemeSwitcher />
              </span>
              <NotificationsBell />
              {profile ? (
                <span className="ms-0.5">
                  <ProfileMenu profile={profile} />
                </span>
              ) : (
                <span className="text-xs text-faint">
                  {t("account.accountFallback")}
                </span>
              )}
            </div>
          </div>
        </header>

        {/* ------------------------------------------------ content -------- */}
        {/* pb-28 keeps page content clear of the fixed bottom nav on phones;
            the footer wrapper below gets its own spacer because it sits
            after the main element and would otherwise be covered by the nav. */}
        <main className="flex-1 pb-28 lg:pb-0">{children}</main>
        <div className="pb-24 lg:pb-0">
          <LegalFooter variant="bar" />
        </div>
      </div>

      {/* ------------------------------------------------ mobile drawer ---- */}
      {mobileOpen && (
        <button
          className="fixed inset-0 z-30 bg-navy/45 lg:hidden dark:bg-black/60"
          aria-label={t("common.close")}
          onClick={closeMobile}
        />
      )}
      {/* Off-canvas drawer — mobile only. `hidden max-lg:flex` keeps it out
          of the desktop flow entirely (no content leak), while on phones it
          slides from the logical start edge (left LTR, right RTL). The fixed
          290px width + opaque bg-surface + z-40 keeps it inside the viewport
          above the scrim and the bottom nav. */}
      <aside
        className={`fixed inset-y-0 start-0 z-40 hidden max-lg:flex w-[290px] max-w-[calc(100vw-1.5rem)] flex-col border-e border-line bg-surface transition-transform duration-200 rounded-e-3xl ${
          mobileOpen
            ? "max-lg:translate-x-0"
            : "ltr:max-lg:-translate-x-full rtl:max-lg:translate-x-full"
        } max-lg:shadow-2xl`}
      >
        <div className="flex items-center justify-between px-4 py-4">
          <BrandLogo variant="full" size={30} />
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
          onNavigate={closeMobile}
        />
        {/* Language + theme at the bottom of a FULL-HEIGHT drawer: the
            menus must open UPWARD (dropUp), otherwise they render below
            the viewport bottom and the tap looks dead on iPhone. */}
        <div className="shrink-0 border-t border-line p-3">
          <div className="flex items-center gap-1">
            <span className="flex-1">
              <LanguageSwitcher dropUp />
            </span>
            <span>
              <ThemeSwitcher dropUp />
            </span>
          </div>
        </div>
      </aside>

      {/* ------------------------------------------------ bottom nav ------- */}
      <nav
        aria-label={t("nav.workspace")}
        className="glass fixed inset-x-3 bottom-3 z-30 flex items-center justify-around rounded-3xl px-2 py-2 lg:hidden"
        style={{ paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))" }}
      >
        {MOBILE_NAV.map((item) => {
          const label = t(item.labelKey);
          const active = isActive(pathname, item.href);
          const IconCmp = LUCIDE[item.icon];
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={`flex w-14 flex-col items-center gap-1 rounded-2xl px-1 py-1.5 transition-colors ${
                active ? "bg-accent-soft text-accent" : "text-muted"
              }`}
            >
              <IconCmp size={20} strokeWidth={active ? 2.1 : 1.8} />
              <span className="max-w-full truncate text-[10px] font-semibold">
                {label}
              </span>
            </Link>
          );
        })}
        <button
          type="button"
          onClick={() => setMobileOpen(true)}
          className="flex w-14 flex-col items-center gap-1 rounded-2xl px-1 py-1.5 text-muted transition-colors"
        >
          <MoreHorizontal size={20} strokeWidth={1.8} />
          <span className="text-[10px] font-semibold">{t("premium.nav.more")}</span>
        </button>
      </nav>
    </div>
  );
}

// ---------------------------------------------------------------------------
// "More" menu (desktop) — the secondary sections in one floating panel
// ---------------------------------------------------------------------------

function SecondaryMenu({
  sections,
  pathname,
}: {
  sections: NavSection[];
  pathname: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const rootRef = useDismiss<HTMLDivElement>(open, useCallback(() => setOpen(false), []));
  // Secondary = everything that is not in the primary top bar.
  const primaryHrefs = new Set(PRIMARY_NAV.map((item) => item.href));
  return (
    <div ref={rootRef} className="relative hidden lg:block">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label={t("premium.nav.more")}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex h-10 items-center gap-1.5 rounded-2xl px-3 text-sm font-semibold text-muted transition-colors hover:bg-surface-2 hover:text-ink"
      >
        <MoreHorizontal size={17} strokeWidth={1.8} />
        <span className="hidden xl:inline">{t("premium.nav.more")}</span>
      </button>
      {open && (
        <div
          role="menu"
          aria-label={t("premium.nav.more")}
          className="glass absolute top-12 end-0 z-50 w-72 rounded-3xl p-2"
        >
          {sections.map((section) => {
            const items = section.items.filter(
              (item) => !primaryHrefs.has(item.href),
            );
            if (items.length === 0) return null;
            return (
              <div key={section.titleKey} className="mb-1">
                <p className="px-3 pt-2 pb-1 text-[10px] font-bold tracking-[0.16em] text-faint uppercase">
                  {t(section.titleKey)}
                </p>
                {items.map((item) => {
                  const label = t(item.labelKey);
                  const active = !item.soon && isActive(pathname, item.href);
                  const IconCmp = LUCIDE[item.icon];
                  const row = (
                    <>
                      <span
                        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${
                          active ? "bg-accent-soft text-accent" : "bg-surface-2 text-muted"
                        }`}
                      >
                        <IconCmp size={16} strokeWidth={1.8} />
                      </span>
                      <span
                        className={`min-w-0 flex-1 truncate text-sm font-semibold ${
                          item.soon ? "text-faint" : "text-ink"
                        }`}
                      >
                        {label}
                      </span>
                      {item.soon && (
                        <span className="text-[9px] font-bold tracking-[0.08em] text-faint uppercase">
                          {t("nav.soon")}
                        </span>
                      )}
                    </>
                  );
                  return item.soon ? (
                    <div
                      key={item.labelKey}
                      role="menuitem"
                      aria-disabled="true"
                      className="flex items-center gap-3 rounded-2xl px-3 py-1.5"
                    >
                      {row}
                    </div>
                  ) : (
                    <Link
                      key={item.labelKey}
                      role="menuitem"
                      href={item.href}
                      onClick={() => setOpen(false)}
                      className={`flex items-center gap-3 rounded-2xl px-3 py-1.5 transition-colors hover:bg-surface-2 ${
                        active ? "bg-accent-soft/60" : ""
                      }`}
                    >
                      {row}
                    </Link>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
