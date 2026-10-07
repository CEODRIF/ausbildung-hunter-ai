"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

interface AdminNavLabels {
  overview: string;
  announcements: string;
  community: string;
  users: string;
}

/**
 * The /admin section nav. The PLATFORM sections (overview / announcements /
 * community) are rendered ONLY when the server computed isPlatformAdmin —
 * a regular (billing) admin sees only Users. Active state comes from the
 * pathname (client-side, cosmetic only — the pages re-gate server-side).
 */
export function AdminNav({
  isPlatformAdmin,
  labels,
}: {
  isPlatformAdmin: boolean;
  labels: AdminNavLabels;
}) {
  const pathname = usePathname();
  const items = [
    ...(isPlatformAdmin
      ? ([
          { href: "/admin", label: labels.overview, exact: true },
          { href: "/admin/announcements", label: labels.announcements, exact: false },
          { href: "/admin/community", label: labels.community, exact: false },
        ] as const)
      : []),
    { href: "/admin/users", label: labels.users, exact: false },
  ];

  return (
    <nav
      aria-label="Admin"
      className="mt-6 flex flex-wrap gap-2 border-b border-line pb-4"
    >
      {items.map((item) => {
        const active = item.exact
          ? pathname === item.href
          : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={`rounded-full px-4 py-1.5 text-sm font-semibold transition-colors ${
              active
                ? "bg-accent-soft text-accent"
                : "text-muted hover:bg-surface-2 hover:text-ink"
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
