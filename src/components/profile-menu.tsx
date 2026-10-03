"use client";

import { useState } from "react";
import type { Profile } from "@/lib/auth";
import { logout } from "@/app/login/actions";
import { useI18n } from "@/lib/i18n";
import { useDismiss } from "@/lib/use-dismiss";
import { Icon } from "@/components/icon";

export function ProfileMenu({ profile }: { profile: Profile }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const rootRef = useDismiss<HTMLDivElement>(open, () => setOpen(false));
  const displayName = profile.full_name || "Guest user";
  const initials = displayName
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("header.profile")}
        className="flex items-center gap-2 rounded-xl p-1 pe-2 transition-colors hover:bg-surface-2"
      >
        <span className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-full bg-accent-soft text-xs font-bold text-accent">
          {profile.avatar_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={profile.avatar_url}
              alt=""
              className="h-8 w-8 object-cover"
            />
          ) : (
            initials
          )}
        </span>
        <span className="hidden max-w-32 truncate text-sm font-semibold text-ink-soft sm:block">
          {displayName}
        </span>
        <Icon
          name="chevron"
          size={15}
          className="hidden text-faint sm:block"
        />
      </button>
      {open && (
        <div
          role="menu"
          aria-label={t("header.profile")}
          className="absolute end-0 top-12 z-50 w-60 overflow-hidden rounded-xl border border-line bg-surface p-1 card-shadow"
        >
          <div className="border-b border-line px-3 py-2.5">
            <p className="truncate text-sm font-bold text-ink">{displayName}</p>
            <p className="truncate text-xs text-muted">{profile.email}</p>
          </div>
          <div className="pt-1">
            <form action={logout}>
              <button
                type="submit"
                role="menuitem"
                className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-semibold text-ink-soft transition-colors hover:bg-danger-soft hover:text-danger"
              >
                <Icon name="logout" size={16} className="rtl:-scale-x-100" />
                {t("profile.signOut")}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
