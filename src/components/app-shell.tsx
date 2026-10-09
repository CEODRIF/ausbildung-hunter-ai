"use client";

/**
 * Global authenticated shell — Premium 2026 layout:
 *
 *  - Desktop (lg+): fixed full-height SIDEBAR on the logical start edge
 *    (brand, ALL navigation sections, language/theme switchers) + a slim
 *    sticky utility bar in the content area (page title, sidebar collapse
 *    toggle, notifications, profile). The content column offsets with a
 *    matching logical margin, so Arabic mirrors the whole layout.
 *  - Mobile / tablet (<lg): compact floating bottom navigation (Dashboard,
 *    Discover, Applications, AI, More) + the full off-canvas drawer for
 *    everything + the floating glass top bar with brand and switchers.
 *
 *  One navigation model (NAV_SECTIONS + NavSectionList) is shared by the
 *  sidebar and the drawer — no duplicated item lists. All colors come from
 *  the design tokens; layout uses logical properties (start/end, ps/pe,
 *  ms/me) so Arabic (dir=rtl) mirrors automatically.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  AtSign,
  BarChart3,
  Bell,
  Bookmark,
  BookOpen,
  Briefcase,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Clock,
  CornerUpLeft,
  type LucideIcon,
  Download,
  ExternalLink,
  FileText,
  Flag,
  Award,
  Folder,
  Globe,
  Hash,
  Home,
  IdCard,
  Image as ImageIcon,
  LayoutGrid,
  Lock,
  LogOut,
  Mail,
  Menu,
  Mic,
  MicOff,
  Monitor,
  Moon,
  MoreHorizontal,
  MessageCircle,
  Music2,
  Paperclip,
  PanelLeftClose,
  PanelLeftOpen,
  PenLine,
  PhoneOff,
  Pin,
  Plus,
  ScanLine,
  Search,
  Send,
  Settings,
  Share2,
  Shield,
  Smile,
  Sparkles,
  Square,
  Sun,
  Target,
  Trash2,
  Upload,
  User,
  Users,
  Volume2,
  Wifi,
  X,
} from "lucide-react";
import type { Profile } from "@/lib/auth";
import { useI18n } from "@/lib/i18n";
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
  /** Unread counter (Community). Rendered only when > 0. */
  badge?: number;
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
      { labelKey: "nav.community", href: "/community", icon: "users" },
    ],
  },
  {
    // Housing / Wohnen (MVP). Labels come from the housing.* i18n block.
    titleKey: "housing.nav.section",
    items: [
      { labelKey: "housing.nav.find", href: "/wohnen", icon: "home" },
      { labelKey: "housing.nav.kosten", href: "/wohnen/kostenrechner", icon: "chart" },
      { labelKey: "housing.nav.suchen", href: "/wohnen/suchen", icon: "search" },
      {
        labelKey: "housing.nav.gespeichert",
        href: "/wohnen/gespeichert",
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
      { labelKey: "nav.deckblatt", href: "/deckblatt", icon: "image" },
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
  users: Users,
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
  home: Home,
  hash: Hash,
  book: BookOpen,
  idCard: IdCard,
  message: MessageCircle,
  at: AtSign,
  smile: Smile,
  reply: CornerUpLeft,
  pin: Pin,
  mic: Mic,
  micOff: MicOff,
  phoneOff: PhoneOff,
  volume: Volume2,
  wifi: Wifi,
  shield: Shield,
  flag: Flag,
  award: Award,
  // Brand marks: the shell never renders these — the profile social tiles
  // use the filled official glyphs from the Icon component. These are
  // stroke-set placeholders that keep the Record exhaustive.
  whatsapp: MessageCircle,
  facebook: Share2,
  tiktok: Music2,
};

/** Mobile floating bottom bar: the most-used destinations + More. */
const MOBILE_NAV: NavItem[] = [
  { labelKey: "nav.dashboard", href: "/dashboard", icon: "grid" },
  { labelKey: "nav.opportunities", href: "/opportunities", icon: "target" },
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
    match: (p) => p === "/wohnen/wg-zimmer",
    heading: { titleKey: "housing.page.wg.title", subtitleKey: "housing.page.wg.subtitle" },
  },
  {
    match: (p) => p === "/wohnen/moebliert",
    heading: {
      titleKey: "housing.page.moebliert.title",
      subtitleKey: "housing.page.moebliert.subtitle",
    },
  },
  {
    match: (p) => p === "/wohnen/miet-check",
    heading: {
      titleKey: "housing.page.mietCheck.title",
      subtitleKey: "housing.page.mietCheck.subtitle",
    },
  },
  {
    match: (p) => p === "/wohnen/kostenrechner",
    heading: {
      titleKey: "housing.page.kosten.title",
      subtitleKey: "housing.page.kosten.subtitle",
    },
  },
  {
    match: (p) => p === "/wohnen/suchen",
    heading: { titleKey: "housing.page.suchen.title", subtitleKey: "housing.page.suchen.subtitle" },
  },
  {
    match: (p) => p === "/wohnen/gespeichert",
    heading: {
      titleKey: "housing.page.gespeichert.title",
      subtitleKey: "housing.page.gespeichert.subtitle",
    },
  },
  {
    match: (p) => p === "/wohnen/tipps",
    heading: { titleKey: "housing.page.tipps.title", subtitleKey: "housing.page.tipps.subtitle" },
  },
  {
    match: (p) => p === "/wohnen",
    heading: { titleKey: "housing.page.find.title", subtitleKey: "housing.page.find.subtitle" },
  },
  {
    match: (p) => p === "/dashboard/templates",
    heading: { titleKey: "pages.templates.title", subtitleKey: "pages.templates.subtitle" },
  },
  {
    match: (p) => p === "/dashboard/cover-letter",
    heading: { titleKey: "pages.coverLetter.title", subtitleKey: "pages.coverLetter.subtitle" },
  },
  {
    match: (p) => p === "/deckblatt" || p.startsWith("/deckblatt/"),
    heading: { titleKey: "pages.deckblatt.title", subtitleKey: "pages.deckblatt.subtitle" },
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
    match: (p) => p === "/community" || p.startsWith("/community/"),
    heading: { titleKey: "pages.community.title", subtitleKey: "pages.community.subtitle" },
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

/**
 * Shared section list — rendered by BOTH the mobile drawer and the desktop
 * sidebar (one navigation model, two surfaces). `collapsed` switches to the
 * icon-only rail (labels become tooltips) for the narrow desktop sidebar.
 */
function NavSectionList({
  sections,
  pathname,
  onNavigate,
  collapsed = false,
}: {
  sections: NavSection[];
  pathname: string;
  onNavigate: () => void;
  collapsed?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div
      className={`flex-1 space-y-6 overflow-y-auto ${collapsed ? "px-2" : "px-3"} py-4`}
    >
      {sections.map((section, index) => (
        <div key={section.titleKey}>
          {index > 0 && (
            <div className={`mb-4 border-t border-line ${collapsed ? "mx-2" : "ms-1.5 me-4"}`} />
          )}
          {!collapsed && (
            <p className="mb-2 px-3 text-[10px] font-bold tracking-[0.16em] text-faint uppercase">
              {t(section.titleKey)}
            </p>
          )}
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
                    title={collapsed ? label : undefined}
                    className={`flex items-center gap-3 rounded-xl py-2.5 text-sm font-semibold text-faint ${
                      collapsed ? "justify-center px-0" : "px-3"
                    }`}
                  >
                    <IconCmp size={18} strokeWidth={1.8} className="shrink-0" />
                    {!collapsed && <span className="flex-1">{label}</span>}
                    {!collapsed && (
                      <span className="text-[9px] font-bold tracking-[0.08em] uppercase">
                        {t("nav.soon")}
                      </span>
                    )}
                  </div>
                );
              }
              const hasBadge = typeof item.badge === "number" && item.badge > 0;
              return (
                <Link
                  key={item.labelKey}
                  href={item.href}
                  onClick={onNavigate}
                  aria-current={active ? "page" : undefined}
                  title={collapsed ? label : undefined}
                  className={`flex items-center gap-3 rounded-xl py-2.5 text-sm font-semibold transition-colors ${
                    collapsed ? "justify-center px-0" : "px-3"
                  } ${
                    active
                      ? "bg-accent-soft text-accent"
                      : "text-muted hover:bg-surface-2 hover:text-ink"
                  }`}
                >
                  <span className="relative shrink-0">
                    <IconCmp size={18} strokeWidth={1.8} />
                    {collapsed && hasBadge && (
                      <span
                        aria-hidden
                        className="absolute -end-1 -top-1 h-2.5 w-2.5 rounded-full bg-danger ring-2 ring-surface"
                      />
                    )}
                  </span>
                  {!collapsed && <span className="truncate flex-1">{label}</span>}
                  {!collapsed && hasBadge && (
                    <span
                      className="ms-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-danger px-1.5 text-[10px] font-bold text-white"
                      aria-label={`${item.badge}`}
                    >
                      {item.badge}
                    </span>
                  )}
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
// Shell
// ---------------------------------------------------------------------------

export function AppShell({
  children,
  profile,
  communityUnread,
  fill = false,
}: {
  children: React.ReactNode;
  profile?: Profile | null;
  /** Server-computed unread count shown as the Community nav badge. */
  communityUnread?: number;
  /**
   * Bound the content column to exactly the visible viewport so a page can own
   * its own internal scrolling (chat). Used by /community only; every other
   * route keeps the normal, document-scrolling shell.
   */
  fill?: boolean;
}) {
  const pathname = usePathname();
  const { t } = useI18n();
  const [mobileOpen, setMobileOpen] = useState(false);
  // The Community entry carries the unread counter (server-computed per
  // section layout); every other item is passed through untouched.
  const sections = useMemo(
    () => {
      const base = NAV_SECTIONS.map((section) => ({
        ...section,
        items: section.items.map((item) =>
          item.href === "/community" ? { ...item, badge: communityUnread } : item,
        ),
      }));
      // Phase 10: the Admin entry exists in the NAV DATA only for the
      // platform admin — the flag is the SERVER-computed profile field
      // (session user id → admins table), never CSS hiding, never a client
      // claim. Ordinary users never receive the section at all. The /admin
      // route itself stays gated by requirePlatformAdmin regardless.
      if (profile?.isPlatformAdmin === true) {
        base.push({
          titleKey: "nav.admin",
          items: [{ labelKey: "nav.admin", href: "/admin", icon: "shield" }],
        });
      }
      return base;
    },
    [communityUnread, profile],
  );
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
      {/* ------------------------------------------------ desktop sidebar -- */}
      {/* lg+ only: fixed full-height rail on the logical start edge (left
          in LTR, right in RTL — `start-0` mirrors automatically). The
          content column offsets with a matching logical margin below.
          Same NavSectionList + switchers as the mobile drawer — one nav
          model, no duplicate items. z-30: above page content and the
          sticky header (z-20), below the mobile drawer (z-40) and modals
          (z-50). Hidden from print by the cv/cl-builder-active rules. */}
      <aside
        aria-label={t("nav.workspace")}
        className={`fixed inset-y-0 start-0 z-30 hidden flex-col border-e border-line bg-surface/85 backdrop-blur-xl transition-[width] duration-200 lg:flex ${
          collapsed ? "w-[84px]" : "w-[272px]"
        }`}
      >
        <div
          className={`flex h-16 shrink-0 items-center border-b border-line ${
            collapsed ? "justify-center px-2" : "gap-2 px-4"
          }`}
        >
          <BrandLogo
            variant={collapsed ? "mark" : "full"}
            size={30}
            href="/dashboard"
            wordmarkClassName="truncate"
          />
        </div>
        <NavSectionList
          sections={sections}
          pathname={pathname}
          onNavigate={() => {}}
          collapsed={collapsed}
        />
        {/* Same functional switchers as the drawer footer; dropUp because
            they sit at the bottom of a full-height rail. */}
        <div className="shrink-0 border-t border-line p-3">
          <div className={`flex items-center gap-1 ${collapsed ? "flex-col" : ""}`}>
            <span className={collapsed ? "flex" : "flex-1"}>
              <LanguageSwitcher dropUp compact={collapsed} />
            </span>
            <span>
              <ThemeSwitcher dropUp />
            </span>
          </div>
        </div>
      </aside>

      {/* Logical margin-inline-start mirrors for RTL automatically. */}
      <div
        className={`relative z-10 flex min-h-screen flex-col transition-[margin] duration-200 ${
          fill ? "h-[100dvh] min-h-0 overflow-hidden" : ""
        } ${
          collapsed ? "lg:ms-[84px]" : "lg:ms-[272px]"
        }`}
      >
        {/* ------------------------------------------------ top bar -------- */}
        <header className="sticky top-0 z-20 flex h-16 items-center px-3 sm:px-6">
          <div className="glass mx-auto flex h-14 w-full max-w-7xl items-center justify-between gap-2 rounded-3xl ps-3 pe-2">
            {/* brand + mobile drawer trigger (desktop shows the brand in
                the sidebar instead — the top bar is a slim utility bar) */}
            <div className="flex min-w-0 items-center gap-2 lg:hidden">
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
              {/* Secondary sections live in the desktop sidebar now —
                  no "More" dropdown on lg+ (no duplicate navigation). */}
              <span className="ms-1 hidden h-7 w-px bg-line sm:block" />
              {/* Language/theme: in the header for mobile/tablet, in the
                  sidebar footer for desktop. */}
              <span className="hidden sm:block lg:hidden">
                <LanguageSwitcher />
              </span>
              <span className="hidden sm:block lg:hidden">
                <ThemeSwitcher />
              </span>
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
        {/* Normal routes: pb-28 keeps page content clear of the fixed bottom
            nav on phones; the footer wrapper below gets its own spacer
            because it sits after the main element and would otherwise be
            covered by the nav.
            Fill routes (/community): main becomes the EXACT, definite chat
            box — a positioned (relative) containing block with no padding —
            and the bottom-nav reservation moves to the flex SIBLING spacer
            below. The chat root then fills main via `absolute inset-0`:
            zero percentage-height resolution, so no engine (notably iOS
            Safari) can collapse or clip it and hide the composer. */}
        <main
          className={`flex-1 ${fill ? "relative min-h-0 overflow-hidden" : "pb-28 lg:pb-0"}`}
        >
          {children}
        </main>
        {/* Fill mode, phones only: the fixed bottom nav's reservation
            (h-28 = the old pb-28 value, which already covered the nav's
            footprint: bottom-3 + bar height + safe-area inset) as a flex
            sibling, so main's box ends exactly where the nav begins. */}
        {fill && <div aria-hidden className="h-28 max-lg:block shrink-0" />}
        {/* In full-height mode the phone keeps the space for the chat itself;
            the legal bar stays on every other route and on desktop. */}
        <div className={`pb-24 lg:pb-0 ${fill ? "max-lg:hidden" : ""}`}>
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
