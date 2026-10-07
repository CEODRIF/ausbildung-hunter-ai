"use client";

import Link from "next/link";
import { Icon, type IconName } from "@/components/icon";
import { useI18n } from "@/lib/i18n";
import {
  communityAvatarUrl,
  type CommunityRoomGroup,
} from "@/lib/community";

/**
 * The community room navigation — Discord-inspired but data-driven:
 * categories + rooms come from the DB (never hard-coded), unread dots from
 * the per-room read state, active state from the URL.
 *
 * Rendered twice from ONE component: the desktop sidebar and the mobile
 * room sheet (onNavigate closes the sheet after a click).
 */

const KNOWN_ICONS: ReadonlySet<string> = new Set([
  "grid", "search", "bookmark", "file", "folder", "settings", "help", "menu",
  "bell", "mail", "spark", "user", "users", "scan", "edit", "send", "activity",
  "target", "briefcase", "plus", "paperclip", "arrowUp", "stop", "x", "image",
  "alert", "arrowLeft", "arrowRight", "arrow", "chevron", "chevronLeft",
  "chevronRight", "check", "sun", "moon", "monitor", "globe", "external",
  "trash", "download", "upload", "lock", "clock", "logout", "chart", "hash",
  "book", "idCard", "message", "at", "smile", "reply", "pin", "mic", "shield",
  "flag", "award",
]);

function roomIcon(icon: string | null | undefined): IconName {
  return icon && KNOWN_ICONS.has(icon) ? (icon as IconName) : "hash";
}

export interface RoomNavProps {
  me: { userId: string; displayName: string; avatarId: string };
  categories: CommunityRoomGroup[];
  /** room_id → unread count (0/missing = read). */
  unread: Record<string, number>;
  /** The room in the URL (null = the community home). */
  activeSlug: string | null;
  /** The current pathname (Phase 2 social-section active state). */
  activePath?: string | null;
  /** Phase 2 social badges (null = render without badges). */
  socialUnread?: { dms: number; friendRequests: number; notifications: number } | null;
  onOpenIdentity: () => void;
  /** Phase 3: open the presence + notification settings sheet. */
  onOpenSettings?: () => void;
  /** Phase 3: the viewer's muted rooms (bell state per room row). */
  mutedRooms?: Set<string>;
  onToggleMute?: (roomId: string) => void;
  /** Mobile sheet: called after every navigation (closes the sheet). */
  onNavigate?: () => void;
  /** Phase 4: the ACTIVE room's voice aggregate (count only — the nav never
   *  exposes participant identities to outsiders). */
  voiceMeta?: { active: boolean; count: number } | null;
  /** Phase 5: the viewer is moderator+ (computed server-side, never a
   *  client claim) — reveals the Moderation entry. */
  showModeration?: boolean;
}

export function RoomNav({
  me,
  categories,
  unread,
  activeSlug,
  activePath = null,
  socialUnread = null,
  onOpenIdentity,
  onOpenSettings,
  mutedRooms,
  onToggleMute,
  onNavigate,
  voiceMeta = null,
  showModeration = false,
}: RoomNavProps) {
  const { t } = useI18n();
  const totalUnread = Object.values(unread).reduce((sum, n) => sum + n, 0);

  const socialItem = (
    href: string,
    icon: IconName,
    label: string,
    count: number,
    countLabel: string,
  ) => (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={activePath?.startsWith(href) ? "page" : undefined}
      aria-label={count > 0 ? `${label} (${t(countLabel, { count })})` : label}
      className={`group flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] font-medium transition-colors ${
        activePath?.startsWith(href)
          ? "bg-accent-soft text-accent"
          : count > 0
            ? "text-ink hover:bg-surface-2"
            : "text-muted hover:bg-surface-2 hover:text-ink"
      }`}
    >
      <Icon name={icon} size={13} className={`shrink-0 ${activePath?.startsWith(href) ? "text-accent" : "text-faint"}`} />
      <span className="flex-1 truncate">{label}</span>
      {count > 0 && (
        <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-danger px-1.5 text-[10px] font-bold text-white">
          {count > 99 ? "99+" : count}
        </span>
      )}
    </Link>
  );

  return (
    <nav aria-label={t("nav.community")} className="flex h-full min-h-0 flex-col">
      {/* Server-style header */}
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-4">
        <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-accent-soft text-accent">
          <Icon name="users" size={16} />
        </span>
        <span className="truncate text-sm font-bold text-ink">{t("nav.community")}</span>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-2 py-3">
        {/* Home */}
        <Link
          href="/community"
          onClick={onNavigate}
          aria-current={activeSlug === null ? "page" : undefined}
          className={`flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-sm font-semibold transition-colors ${
            activeSlug === null
              ? "bg-accent-soft text-accent"
              : "text-muted hover:bg-surface-2 hover:text-ink"
          }`}
        >
          <Icon name="grid" size={16} className="shrink-0" />
          <span className="flex-1 truncate">{t("community.homeTitle")}</span>
          {totalUnread > 0 && (
            <span
              className="flex h-5 min-w-5 items-center justify-center rounded-full bg-danger px-1.5 text-[10px] font-bold text-white"
              aria-label={t("community.unreadBadge")}
            >
              {totalUnread > 99 ? "99+" : totalUnread}
            </span>
          )}
        </Link>

        {/* Phase 5: global search (every member) + moderation queue
            (moderator+, revealed by a SERVER-computed flag). */}
        <div>
          <ul className="space-y-0.5">
            <li>
              {socialItem(
                "/community/search",
                "search",
                t("community.navSearch"),
                0,
                "community.unreadBadge",
              )}
            </li>
            {showModeration && (
              <li>
                {socialItem(
                  "/community/moderation",
                  "shield",
                  t("community.navModeration"),
                  0,
                  "community.unreadBadge",
                )}
              </li>
            )}
          </ul>
        </div>

        {/* Phase 2 social section (Friends / Messages / Notifications) */}
        <div>
          <p className="mb-1 px-2.5 text-[10px] font-bold tracking-[0.14em] text-faint uppercase">
            {t("nav.social")}
          </p>
          <ul className="space-y-0.5">
            <li>
              {socialItem(
                "/community/friends",
                "user",
                t("community.navFriends"),
                socialUnread?.friendRequests ?? 0,
                "community.friendsBadge",
              )}
            </li>
            <li>
              {socialItem(
                "/community/messages",
                "message",
                t("community.navMessages"),
                socialUnread?.dms ?? 0,
                "community.messagesBadge",
              )}
            </li>
            <li>
              {socialItem(
                "/community/notifications",
                "bell",
                t("community.navNotifications"),
                socialUnread?.notifications ?? 0,
                "community.notificationsBadge",
              )}
            </li>
          </ul>
        </div>

        {categories.map((category) => (
          <div key={category.id}>
            <p className="mb-1 px-2.5 text-[10px] font-bold tracking-[0.14em] text-faint uppercase">
              {category.name}
            </p>
            <ul className="space-y-0.5">
              {category.rooms.map((room) => {
                const active = activeSlug === room.slug;
                const roomUnread = unread[room.id] ?? 0;
                const isMuted = Boolean(mutedRooms?.has(room.id));
                return (
                  <li key={room.id} className="group flex items-center">
                    <Link
                      href={`/community/${room.slug}`}
                      onClick={onNavigate}
                      aria-current={active ? "page" : undefined}
                      aria-label={
                        roomUnread > 0
                          ? `${room.name} (${t("community.newMessages", {})} ${roomUnread})`
                          : room.name
                      }
                      className={`flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] font-medium transition-colors ${
                        active
                          ? "bg-accent-soft text-accent"
                          : roomUnread > 0
                            ? "text-ink hover:bg-surface-2"
                            : isMuted
                              ? "text-faint hover:bg-surface-2 hover:text-muted"
                              : "text-muted hover:bg-surface-2 hover:text-ink"
                      }`}
                    >
                      <Icon
                        name={roomIcon(room.icon)}
                        size={13}
                        className={`shrink-0 ${active ? "text-accent" : "text-faint"}`}
                      />
                      <span className="flex-1 truncate">{room.name}</span>
                      {active && voiceMeta && voiceMeta.active && (
                        <span
                          className="flex shrink-0 items-center gap-1 rounded-md bg-accent-soft px-1.5 py-0.5 text-[10px] font-bold text-accent"
                          aria-label={`${t("community.voiceTitle")}: ${
                            voiceMeta.count === 1
                              ? t("community.voiceParticipantsOne")
                              : t("community.voiceParticipants", {
                                  count: voiceMeta.count,
                                })
                          }`}
                        >
                          <Icon name="mic" size={10} aria-hidden="true" />
                          {voiceMeta.count}
                        </span>
                      )}
                      {isMuted && (
                        <Icon name="bell" size={11} className="shrink-0 text-faint" />
                      )}
                      {roomUnread > 0 && !active && !isMuted && (
                        <span
                          className="h-2 w-2 shrink-0 rounded-full bg-danger"
                          aria-hidden="true"
                        />
                      )}
                    </Link>
                    {onToggleMute && (
                      <button
                        type="button"
                        onClick={() => onToggleMute(room.id)}
                        aria-label={
                          isMuted
                            ? t("community.roomUnmute", { room: room.name })
                            : t("community.roomMute", { room: room.name })
                        }
                        title={
                          isMuted
                            ? t("community.roomUnmute", { room: room.name })
                            : t("community.roomMute", { room: room.name })
                        }
                        className={`mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-faint hover:bg-surface-2 hover:text-ink focus-visible:opacity-100 lg:opacity-0 lg:group-hover:opacity-100 lg:group-focus-within:opacity-100 ${
                          isMuted ? "opacity-100" : ""
                        }`}
                      >
                        <Icon name="bell" size={12} />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>

      {/* Identity footer (rename / change avatar) */}
      <div className="flex shrink-0 items-center gap-2 border-t border-line p-2.5">
        {/* eslint-disable-next-line @next/next/no-img-element -- avatar: fixed 32px, static public asset */}
        <img
          src={communityAvatarUrl(me.avatarId)}
          alt=""
          width={32}
          height={32}
          className="h-8 w-8 rounded-lg object-cover"
        />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">
          {me.displayName}
        </span>
        <button
          type="button"
          onClick={onOpenIdentity}
          aria-label={t("community.editIdentity")}
          title={t("community.editIdentity")}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-ink"
        >
          <Icon name="edit" size={15} />
        </button>
        {onOpenSettings && (
          <button
            type="button"
            onClick={onOpenSettings}
            aria-label={t("community.settings.title")}
            title={t("community.settings.title")}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-ink"
          >
            <Icon name="settings" size={15} />
          </button>
        )}
      </div>
    </nav>
  );
}
