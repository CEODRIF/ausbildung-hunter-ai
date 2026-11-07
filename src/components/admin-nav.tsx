"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

interface AdminNavLabels {
  users: string;
  books: string;
}

/**
 * The /admin section nav — user/billing management + the Deutsch
 * Bibliothek book management. Active state comes from the pathname
 * (client-side, cosmetic only — every page re-gates server-side).
 */
export function AdminNav({ labels }: { labels: AdminNavLabels }) {
  const pathname = usePathname();
  const items = [
    { href: "/admin/users", label: labels.users },
    { href: "/admin/books", label: labels.books },
  ];

  return (
    <nav
      aria-label="Admin"
      className="mt-6 flex w-fit flex-wrap items-center gap-1 rounded-2xl border border-line bg-surface p-1 shadow-[var(--shadow-card)]"
    >
      {items.map((item) => {
        const active = pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={`rounded-xl px-4 py-2 text-sm font-semibold transition-colors ${
              active
                ? "bg-navy text-white shadow-sm"
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
