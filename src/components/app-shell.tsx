"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { CloseIcon } from "@/components/ui";
import type { Profile } from "@/lib/auth";
import { ProfileMenu } from "@/components/profile-menu";

function Icon({
  name,
  size = 18,
}: {
  name:
    | "grid"
    | "search"
    | "bookmark"
    | "file"
    | "settings"
    | "help"
    | "menu"
    | "bell"
    | "arrow"
    | "chevron"
    | "mail"
    | "spark"
    | "user"
    | "scan"
    | "edit"
    | "send"
    | "activity";
  size?: number;
}) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  const paths = {
    grid: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <rect x="14" y="14" width="7" height="7" rx="1" />
      </>
    ),
    search: (
      <>
        <circle cx="11" cy="11" r="6.5" />
        <path d="m16 16 4.5 4.5" />
      </>
    ),
    bookmark: (
      <path d="M6 4.8A1.8 1.8 0 0 1 7.8 3h8.4A1.8 1.8 0 0 1 18 4.8V21l-6-3.6L6 21V4.8Z" />
    ),
    file: (
      <>
        <path d="M6 3.5h8l4 4V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z" />
        <path d="M14 3.5V8h4M8.5 12h7M8.5 16h5" />
      </>
    ),
    settings: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-1.8 1.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5v.2h-2.6v-.2a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1-1.8-1.8.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H6.3v-2.6h.2a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1 1.8-1.8.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.5v-.2H15v.2a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1 1.8 1.8-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.5 1h.2V14h-.2a1.7 1.7 0 0 0-1.5 1Z" />
      </>
    ),
    help: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M9.6 9a2.5 2.5 0 1 1 4.1 1.9c-.9.8-1.7 1.2-1.7 2.6M12 17h.01" />
      </>
    ),
    menu: (
      <>
        <path d="M4 7h16M4 12h16M4 17h16" />
      </>
    ),
    bell: (
      <>
        <path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
      </>
    ),
    arrow: (
      <>
        <path d="M5 12h14M13 6l6 6-6 6" />
      </>
    ),
    chevron: <path d="m7 10 5 5 5-5" />,
    mail: (
      <>
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="m3 7 9 6 9-6" />
      </>
    ),
    spark: (
      <>
        <path d="m12 3 1.6 5.4L19 10l-5.4 1.6L12 17l-1.6-5.4L5 10l5.4-1.6L12 3ZM19 16l.7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7L19 16Z" />
      </>
    ),
    user: (
      <>
        <circle cx="12" cy="8" r="3.5" />
        <path d="M5 20c.7-3.4 3-5 7-5s6.3 1.6 7 5" />
      </>
    ),
    scan: (
      <>
        <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" />
        <path d="M8 12h8M12 8v8" />
      </>
    ),
    edit: (
      <>
        <path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17l-1 3Z" />
        <path d="m14 7 3 3" />
      </>
    ),
    send: (
      <>
        <path d="m21 3-7.5 18-3.5-7-7-3.5L21 3Z" />
        <path d="M10 14 21 3" />
      </>
    ),
    activity: (
      <>
        <path d="M3 12h4l2-7 4 14 2-7h6" />
      </>
    ),
  };
  return <svg {...common}>{paths[name]}</svg>;
}

const navItems = [
  {
    label: "Dashboard",
    href: "/dashboard",
    icon: "grid" as const,
    enabled: true,
  },
  { label: "Bewerbungen", href: "#", icon: "file" as const, enabled: false },
  { label: "AI Assistant", href: "/ai", icon: "spark" as const, enabled: true },
  {
    label: "Bewerbung Scanner",
    href: "/bewerbung-scanner",
    icon: "scan" as const,
    enabled: true,
  },
  {
    label: "Opportunities",
    href: "/opportunities",
    icon: "search" as const,
    enabled: true,
  },
  {
    label: "Settings",
    href: "/settings/email",
    icon: "settings" as const,
    enabled: true,
  },
];

function Logo() {
  return (
    <Link
      href="/"
      className="flex items-center gap-2.5"
      aria-label="Ausbildung Hunter AI home"
    >
      <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#2f6fed] text-white shadow-[0_6px_14px_rgba(47,111,237,0.25)]">
        <span className="text-lg font-bold">A</span>
      </span>
      <span className="text-sm font-bold tracking-[-0.02em] text-[#10203b]">
        Ausbildung Hunter <span className="text-[#2f6fed]">AI</span>
      </span>
    </Link>
  );
}

export function AppShell({
  children,
  profile,
}: {
  children: React.ReactNode;
  profile?: Profile | null;
}) {
  const pathname = usePathname();
  const displayName = profile?.full_name || "Guest user";
  const initials = displayName
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  const [mobileOpen, setMobileOpen] = useState(false);
  const closeMobile = () => setMobileOpen(false);

  return (
    <div className="min-h-screen bg-[#f6f8fb]">
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-[260px] -translate-x-full flex-col border-r border-[#e5ebf3] bg-white px-5 py-6 transition-transform lg:translate-x-0 ${mobileOpen ? "translate-x-0" : ""}`}
      >
        <div className="flex items-center justify-between">
          <Logo />
          <button
            className="rounded-lg p-1.5 text-[#7d8da5] hover:bg-[#f2f5f9] lg:hidden"
            onClick={closeMobile}
            aria-label="Close navigation"
          >
            <CloseIcon />
          </button>
        </div>
        <div className="mt-10">
          <p className="mb-3 px-3 text-[10px] font-bold uppercase tracking-[0.16em] text-[#9aa8ba]">
            Workspace
          </p>
          <nav className="space-y-1" aria-label="Main navigation">
            {navItems.map((item) => {
              const active =
                pathname === "/dashboard" && item.href === "/dashboard";
              return item.enabled ? (
                <Link
                  key={item.label}
                  href={item.href}
                  onClick={closeMobile}
                  className={`flex items-center gap-3 rounded-xl px-3 py-3 text-sm font-semibold ${active ? "bg-[#edf3ff] text-[#2f6fed]" : "text-[#6d7d96] hover:bg-[#f5f7fa] hover:text-[#1d3458]"}`}
                >
                  <Icon name={item.icon} />
                  {item.label}
                </Link>
              ) : (
                <div
                  key={item.label}
                  className="flex cursor-not-allowed items-center justify-between rounded-xl px-3 py-3 text-sm font-semibold text-[#a8b4c4]"
                >
                  <span className="flex items-center gap-3">
                    <Icon name={item.icon} />
                    {item.label}
                  </span>
                  <span className="text-[9px] font-bold uppercase tracking-[0.08em] text-[#b4bfcd]">
                    Soon
                  </span>
                </div>
              );
            })}
          </nav>
        </div>
        <div className="mt-auto space-y-1 border-t border-[#edf0f4] pt-5">
          <div className="flex cursor-not-allowed items-center justify-between rounded-xl px-3 py-3 text-sm font-semibold text-[#a8b4c4]">
            <span className="flex items-center gap-3">
              <Icon name="help" />
              Help center
            </span>
            <span className="text-[9px] font-bold uppercase tracking-[0.08em] text-[#b4bfcd]">
              Soon
            </span>
          </div>
          <div className="mt-5 rounded-2xl bg-[#f4f7fc] p-3.5">
            <div className="flex items-center gap-2.5">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[#dbe7ff] text-xs font-bold text-[#2f6fed]">
                {initials}
              </span>
              <div className="min-w-0">
                <p className="truncate text-xs font-bold text-[#1d3458]">
                  {displayName}
                </p>
                <p className="text-[11px] text-[#8b9ab0]">
                  {profile?.email ?? "Account"}
                </p>
              </div>
            </div>
          </div>
        </div>
      </aside>
      {mobileOpen && (
        <button
          className="fixed inset-0 z-30 bg-[#10203b]/35 lg:hidden"
          aria-label="Close navigation overlay"
          onClick={closeMobile}
        />
      )}
      <div className="lg:pl-[260px]">
        <header className="sticky top-0 z-20 flex h-[72px] items-center justify-between border-b border-[#e5ebf3] bg-white/90 px-5 backdrop-blur-md sm:px-8">
          <div className="flex items-center gap-3">
            <h1 className="hidden text-base font-bold text-[#1d3458] sm:block">
              Dashboard
            </h1>
            <button
              className="rounded-xl border border-[#e2e8f1] p-2 text-[#58708f] lg:hidden"
              onClick={() => setMobileOpen(true)}
              aria-label="Open navigation"
            >
              <Icon name="menu" />
            </button>
            <div className="hidden h-9 w-px bg-[#e7ecf2] sm:block" />
            <span className="hidden text-sm font-semibold text-[#6d7d96] sm:block">
              Your career workspace
            </span>
            <span className="text-sm font-semibold text-[#6d7d96] sm:hidden">
              Workspace
            </span>
          </div>
          <div className="flex items-center gap-3">
            <button
              className="relative rounded-xl p-2.5 text-[#72839c] hover:bg-[#f3f6fa]"
              aria-label="Notifications"
            >
              <Icon name="bell" size={19} />
              <span className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-[#2f6fed]" />
            </button>
            <div className="hidden h-7 w-px bg-[#e7ecf2] sm:block" />
            {profile ? (
              <ProfileMenu profile={profile} />
            ) : (
              <span className="text-xs text-[#8b9ab0]">Account</span>
            )}
          </div>
        </header>
        <main>{children}</main>
      </div>
    </div>
  );
}

export { Icon };
