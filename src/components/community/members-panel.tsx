"use client";

import { useMemo } from "react";
import { Icon } from "@/components/icon";
import { useI18n } from "@/lib/i18n";
import { communityAvatarUrl, type CommunityAuthor } from "@/lib/community";
import { presenceDotClass } from "./presence-indicator";
import { AdminBadge } from "./admin-badge";

/**
 * The members panel — identity only (avatar + username). NO real names, no
 * email, no profile data: the community profile IS the public identity.
 *
 * Two surfaces from one component: the collapsible desktop column and the
 * mobile end-side sheet. (Presence dots arrive with Phase 3 voice.)
 */

export interface MembersPanelProps {
  me: { userId: string; displayName: string; avatarId: string; platformAdmin?: boolean };
  members: CommunityAuthor[];
  variant: "desktop" | "sheet";
  onClose: () => void;
  /** Phase 2: open the profile card (other members only; omitted → plain rows). */
  onOpenProfile?: (userId: string) => void;
}

export function MembersPanel({ me, members, variant, onClose, onOpenProfile }: MembersPanelProps) {
  const { t } = useI18n();

  // "You" first, then alphabetical — stable, deterministic.
  const ordered = useMemo(() => {
    const others = members
      .filter((m) => m.user_id !== me.userId)
      .sort((a, b) => a.display_name.localeCompare(b.display_name));
    const meEntry: CommunityAuthor = {
      user_id: me.userId,
      display_name: me.displayName,
      avatar_id: me.avatarId,
      // Server-stamped in the page (session user id → admins table).
      platform_admin: me.platformAdmin === true,
    };
    return [meEntry, ...others];
  }, [members, me]);

  const list = (
    <>
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
        <Icon name="users" size={15} className="text-muted" />
        <span className="text-xs font-bold tracking-[0.08em] text-ink uppercase">
          {t("community.membersTitle")}
        </span>
        <span className="ms-auto text-[11px] font-semibold text-faint">
          {ordered.length}
        </span>
      </div>
      <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
        {ordered.map((member) => {
          const self = member.user_id === me.userId;
          const openable = !self && onOpenProfile;
          // Phase 3: presence is server-mapped (privacy-safe). "You" is by
          // definition online — the viewer is literally here.
          const state = self ? "online" : (member.presence ?? "offline");
          return (
            <li key={member.user_id} className="rounded-lg">
              <button
                type="button"
                disabled={!openable}
                onClick={openable ? () => onOpenProfile(member.user_id) : undefined}
                aria-label={openable ? t("community.openProfile") : undefined}
                title={t(`community.presence.${state}`)}
                className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-start ${
                  self
                    ? "bg-surface-2/70"
                    : openable
                      ? "cursor-pointer transition-colors hover:bg-surface-2/70"
                      : ""
                }`}
              >
                <span className="relative shrink-0">
                  {/* eslint-disable-next-line @next/next/no-img-element -- avatar: fixed 30px, static public asset */}
                  <img
                    src={communityAvatarUrl(member.avatar_id)}
                    alt=""
                    width={30}
                    height={30}
                    loading="lazy"
                    className="h-[30px] w-[30px] rounded-lg object-cover"
                  />
                  <span
                    aria-hidden="true"
                    className={`absolute -bottom-0.5 -end-0.5 rounded-full ring-2 ring-surface ${presenceDotClass(state, "h-2.5 w-2.5")}`}
                  />
                </span>
                 <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
                   {member.display_name}
                   {member.platform_admin === true && (
                     <AdminBadge
                       size={12}
                       label={t("community.adminBadge")}
                       className="ms-1"
                     />
                   )}
                 </span>
                {self && (
                  <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-bold text-accent">
                    {t("community.you")}
                  </span>
                )}
              </button>
            </li>
          );
        })}
        {ordered.length <= 1 && (
          <li className="px-2 py-6 text-center text-xs text-faint">
            {t("community.membersEmpty")}
          </li>
        )}
      </ul>
    </>
  );

  if (variant === "desktop") {
    return (
      <aside
        aria-label={t("community.membersTitle")}
        className="hidden w-[240px] shrink-0 flex-col border-s border-line bg-surface/60 lg:flex"
      >
        {list}
      </aside>
    );
  }

  // Mobile: end-side sheet + scrim (logical props → RTL-safe).
  return (
    <>
      <button
        type="button"
        aria-label={t("community.closeRoomList")}
        onClick={onClose}
        className="fixed inset-0 z-40 bg-navy/45 lg:hidden dark:bg-black/60"
      />
      <aside
        aria-label={t("community.membersTitle")}
        className="fixed inset-y-0 end-0 z-50 flex w-[280px] max-w-[85vw] flex-col border-s border-line bg-surface shadow-2xl"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label={t("common.close")}
          className="absolute end-2 top-2 flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-surface-2"
        >
          <Icon name="x" size={15} />
        </button>
        {list}
      </aside>
    </>
  );
}
