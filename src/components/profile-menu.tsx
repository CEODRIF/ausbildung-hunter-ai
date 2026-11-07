"use client";

/**
 * Account menu — the premium panel from the reference: identity header,
 * upgrade affordance, the account's real destinations, the language selector
 * and logout, in one surface.
 *
 * Every entry points at a route that exists in this product. Deckblatt AI and
 * the Settings hub stay deliberately absent (product decision, 2026-11): they
 * remain reachable by URL, they are simply not offered in navigation.
 */
import { useState } from "react";
import Link from "next/link";
import type { Profile } from "@/lib/auth";
import { logout } from "@/app/login/actions";
import { useI18n } from "@/lib/i18n";
import { useDismiss } from "@/lib/use-dismiss";
import { Icon, type IconName } from "@/components/icon";
import { UserAvatar } from "@/components/user-avatar";
import { LANGUAGE_META, type Language } from "@/lib/i18n/dictionaries";

const ITEMS: Array<{ href: string; labelKey: string; icon: IconName }> = [
  { href: "/opportunities/saved", labelKey: "nav.savedOpportunities", icon: "bookmark" },
  { href: "/dashboard/templates", labelKey: "nav.templates", icon: "file" },
  { href: "/settings/email", labelKey: "nav.emailAssistant", icon: "mail" },
  { href: "/dashboard/cover-letter", labelKey: "nav.coverLetter", icon: "edit" },
  { href: "/settings/billing", labelKey: "nav.billing", icon: "idCard" },
];

export function ProfileMenu({ profile }: { profile: Profile }) {
  const { t, lang, setLang, supportedLanguages } = useI18n();
  const [open, setOpen] = useState(false);
  const rootRef = useDismiss<HTMLDivElement>(open, () => setOpen(false));
  const displayName = profile.full_name || "Guest user";

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("header.profile")}
        className={`flex items-center gap-2 rounded-full border bg-surface p-1 transition-colors sm:pe-2.5 ${
          open ? "border-accent/40" : "border-line hover:border-line-strong"
        }`}
      >
        <UserAvatar
          avatar={profile.avatar}
          avatarUrl={profile.avatar_url}
          fullName={displayName}
          className="h-8 w-8 bg-accent-soft ring-2 ring-accent/15"
          imgClassName="h-8 w-8 object-cover"
          initialsClassName="text-[11px] font-bold text-accent"
          label={displayName}
        />
        <span className="hidden max-w-28 truncate text-xs font-bold text-ink sm:block">
          {displayName}
        </span>
        <Icon
          name="chevron"
          size={14}
          className={`hidden text-faint transition-transform sm:block ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div
          role="menu"
          aria-label={t("header.profile")}
          className="absolute end-0 top-[calc(100%+0.5rem)] z-50 w-[19rem] max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-3xl border border-line bg-surface p-2 shadow-[var(--shadow-float)]"
        >
          {/* identity */}
          <div className="flex items-center gap-3 rounded-2xl px-1.5 py-1.5">
            <UserAvatar
              avatar={profile.avatar}
              avatarUrl={profile.avatar_url}
              fullName={displayName}
              className="h-11 w-11 shrink-0 bg-accent-soft ring-2 ring-accent/15"
              imgClassName="h-11 w-11 object-cover"
              initialsClassName="text-sm font-bold text-accent"
              label={displayName}
            />
            <div className="min-w-0">
              <p className="truncate text-sm font-bold text-ink">{displayName}</p>
              <p className="truncate text-xs text-muted">{profile.email}</p>
            </div>
          </div>

          {/* upgrade */}
          <Link
            href="/settings/billing"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="btn-neon mt-1.5 flex items-center justify-center gap-1.5 rounded-2xl px-3 py-2.5 text-xs font-bold text-white"
          >
            <Icon name="spark" size={14} />
            {t("quota.upgrade")}
          </Link>

          {/* destinations */}
          <div className="mt-1.5 space-y-0.5">
            <Link
              href="/settings/profile"
              role="menuitem"
              onClick={() => setOpen(false)}
              className="flex min-h-10 items-center gap-3 rounded-xl px-2.5 py-2 text-sm font-semibold text-ink-soft transition-colors hover:bg-surface-2 hover:text-ink"
            >
              <Icon name="user" size={17} className="shrink-0 text-faint" />
              <span className="truncate">{t("pages.settingsProfile.title")}</span>
            </Link>
            {ITEMS.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                role="menuitem"
                onClick={() => setOpen(false)}
                className="flex min-h-10 items-center gap-3 rounded-xl px-2.5 py-2 text-sm font-semibold text-ink-soft transition-colors hover:bg-surface-2 hover:text-ink"
              >
                <Icon name={item.icon} size={17} className="shrink-0 text-faint" />
                <span className="truncate">{t(item.labelKey)}</span>
              </Link>
            ))}
          </div>

          {/* language */}
          <div className="mt-2 border-t border-line pt-2">
            <p className="px-2 pb-1.5 text-[10px] font-bold tracking-[0.12em] text-faint uppercase">
              {t("lang.label")}
            </p>
            <div className="flex items-center gap-1 rounded-2xl bg-surface-2 p-1">
              {supportedLanguages.map((code: Language) => {
                const active = code === lang;
                return (
                  <button
                    key={code}
                    type="button"
                    role="menuitemradio"
                    aria-checked={active}
                    onClick={() => setLang(code)}
                    className={`flex-1 rounded-xl px-1 py-1.5 text-[11px] font-bold uppercase transition-colors ${
                      active
                        ? "bg-surface text-ink shadow-[var(--shadow-card)]"
                        : "text-muted hover:text-ink"
                    }`}
                  >
                    {LANGUAGE_META[code].code}
                  </button>
                );
              })}
            </div>
          </div>

          {/* logout */}
          <div className="mt-2 border-t border-line pt-2">
            <form action={logout}>
              <button
                type="submit"
                role="menuitem"
                className="flex min-h-10 w-full items-center gap-3 rounded-xl px-2.5 py-2 text-sm font-bold text-danger transition-colors hover:bg-danger-soft"
              >
                <Icon name="logout" size={17} className="shrink-0 rtl:-scale-x-100" />
                {t("profile.signOut")}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
