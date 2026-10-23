"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

interface AdminNavLabels {
  users: string;
}

/**
 * The /admin section nav — a single remaining surface (user/billing
 * management). Active state comes from the pathname (client-side,
 * cosmetic only — the page re-gates server-side).
 */
export function AdminNav({ labels }: { labels: AdminNavLabels }) {
  const pathname = usePathname();
  const items = [{ href: "/admin/users", label: labels.users }];

  return (
    <nav
      aria-label="Admin"
      className="mt-6 flex flex-wrap gap-2 border-b border-line pb-4"
    >
      {items.map((item) => {
        const active = pathname.startsWith(item.href);
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
