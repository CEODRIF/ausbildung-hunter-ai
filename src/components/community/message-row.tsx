"use client";

import { memo, useRef, useState } from "react";
import { Icon } from "@/components/icon";
import { Button } from "@/components/ui";
import type { LocalMessage } from "@/lib/community";
import { COMMUNITY_REACTION_EMOJIS } from "@/lib/community";
import { MentionText } from "./mention-text";
import { AdminBadge } from "./admin-badge";

/** "14:32" today, "12.03. 14:32" on other days (locale-aware). */
export function formatMessageTime(iso: string, locale: string): string {
  const date = new Date(iso);
  const time = date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  if (date.toDateString() === new Date().toDateString()) return time;
  return `${date.toLocaleDateString(locale, { day: "2-digit", month: "2-digit" })} ${time}`;
}

export interface MessageRowProps {
  message: LocalMessage;
  /**
   * The row belongs to the current user — computed by the parent via
   * `isOwnMessage(m.user_id, me.userId)` (stable-ID comparison, never a
   * display name / locale / direction). Drives the Messenger-style
   * alignment: own = RIGHT (blue bubble), other = LEFT (neutral bubble).
   */
  mine: boolean;
  /** First row of a consecutive group (same author, < 5 min gap). */
  firstOfGroup: boolean;
  /** Display name (trusted profile name, or the fallback label). */
  name: string;
  /**
   * Phase 10 (server-computed): the author is the platform admin — render
   * the red verification badge next to the name. Never set from the client.
   */
  authorIsAdmin?: boolean;
  /** Predefined avatar URL, or null → initials fallback. */
  avatarUrl: string | null;
  locale: string;
  /** Resolved image URL (signed or local object URL); null → no image. */
  imageUrl: string | null;
  /** Lower-cased member usernames (mention chips). */
  knownMembers: ReadonlySet<string>;
  t: (path: string, vars?: Record<string, string | number>) => string;
  /** Touch devices: the tap-selected row (action bar visible). */
  active: boolean;
  /** Phase 3 deep link: the row is the ?message= target (brief highlight). */
  highlight?: boolean;
  onActivate: (messageId: string | null) => void;
  onOpenImage: (url: string) => void;
  onJumpToMessage: (messageId: string) => void;
  onRetry: (message: LocalMessage) => void;
  onRemoveFailed: (id: string) => void;
  onReply: (message: LocalMessage) => void;
  onToggleReaction: (messageId: string, emoji: string) => void;
  onSaveEdit: (messageId: string, text: string) => void;
  onCancelEdit: () => void;
  onDelete: (messageId: string) => void;
  /**
   * Phase 2: open the author's profile card (other members only). Omitted →
   * the name stays plain text (Phase 1 behavior, unchanged).
   */
  onOpenAuthor?: (userId: string) => void;
  /**
   * Phase 5 (server-computed): the viewer may pin/unpin — the actions are
   * affordances only, the server re-checks the role on every call.
   */
  canModerate?: boolean;
  /** Phase 5: this message is currently pinned. */
  isPinned?: boolean;
  /** Phase 5: pin toggle (moderator+). */
  onPinToggle?: (messageId: string) => void;
  /** Phase 5: open the report dialog for this message (non-own only). */
  onReportMessage?: (messageId: string) => void;
}

/**
 * One community message row — Messenger/Facebook-style alignment:
 *
 *   - OTHER users: avatar + name/time on the LEFT, neutral light bubble.
 *   - OWN messages: RIGHT, blue (app accent) bubble, white text, no avatar
 *     and no repeated username — a small timestamp sits under the bubble.
 *
 * ALIGNMENT IS SENDER-BASED, NOT DIRECTION-BASED. The cluster uses PHYSICAL
 * auto margins (`ml-auto` / `mr-auto`) plus a forced `direction: ltr` on the
 * avatar/content order, so in Arabic (RTL) own messages are STILL on the
 * right and other users' on the left — CSS `dir` never flips the semantics.
 * The message TEXT re-establishes its own bidi flow with `dir="auto"`.
 *
 * Grouping: consecutive same-author messages (< 5 min) drop the avatar and
 * tighten to 2px — bubbles stack, reactions/replies/attachments stay inside
 * the row and follow the alignment.
 *
 * React.memo'd: with dozens of rows per room, a realtime INSERT must
 * re-render ONLY the new/changed row. The parent resolves every display
 * value so the memo comparison stays a plain prop check.
 *
 * Text renders through <MentionText> — plain text nodes + safe mention chips
 * + http(s) links; never HTML (XSS-safe, see mention-text.tsx).
 */
function MessageRowInner({
  message: m,
   mine,
   firstOfGroup,
   name,
   authorIsAdmin = false,
   avatarUrl,
  locale,
  imageUrl,
  knownMembers,
   t,
   active,
   highlight = false,
   onActivate,
   onOpenImage,
   onJumpToMessage,
  onRetry,
  onRemoveFailed,
  onReply,
  onToggleReaction,
  onSaveEdit,
  onCancelEdit,
  onDelete,
  onOpenAuthor,
  canModerate = false,
  isPinned = false,
  onPinToggle,
  onReportMessage,
}: MessageRowProps) {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(m.message ?? "");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);

  // Switching the selected row (or the message list) resets transient state —
  // during RENDER on the prop change (the React-recommended "state derived
  // from props" pattern: no effect, no cascading render).
  const [prevActive, setPrevActive] = useState(active);
  if (prevActive !== active) {
    setPrevActive(active);
    if (!active) {
      setEmojiOpen(false);
      setConfirmDelete(false);
    }
  }

  const time = formatMessageTime(m.created_at, locale);
  const failed = mine && m.sendStatus === "failed";
  const sending = mine && m.sendStatus === "sending";
  const edited =
    m.updated_at !== m.created_at &&
    Date.parse(m.updated_at) - Date.parse(m.created_at) > 2000;

  const replyAuthorName = m.replyTo
    ? m.replyTo.user_id === m.user_id
      ? t("community.you")
      : (m.replyTo.author?.display_name ?? t("community.member"))
    : "";
  const replySnippet = m.replyTo
    ? m.replyTo.message?.trim().slice(0, 90) ??
      (m.replyTo.image_path ? t("community.imageAlt") : "")
    : "";

  const showActions = (active || undefined) && !editing && !failed;

  const avatar =
    firstOfGroup &&
    (avatarUrl ? (
      // eslint-disable-next-line @next/next/no-img-element -- avatar: fixed 40px, static public asset
      <img
        src={avatarUrl}
        alt={name}
        width={40}
        height={40}
        loading="lazy"
        className="h-10 w-10 shrink-0 rounded-xl object-cover"
      />
    ) : (
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-xs font-bold text-muted">
        {name.charAt(0).toUpperCase()}
      </span>
    ));

  return (
    <div
      ref={rowRef}
      id={`cm-${m.id}`}
      role="group"
      aria-label={`${name}: ${m.message ?? t("community.imageAlt")}`}
      onClick={() => onActivate(active ? null : m.id)}
      className={`group relative ${
        firstOfGroup ? "mt-2.5 first:mt-0" : "mt-[2px]"
      } rounded-xl px-3 py-0.5 transition-colors hover:bg-surface-2/40 ${
        highlight
          ? "bg-accent-soft/70 ring-1 ring-accent/40"
          : active
            ? "bg-surface-2/60"
            : ""
      }`}
    >
      {/*
        The message cluster (avatar + content). PHYSICAL auto margins keep
        the sender-based side in every locale: own → right (ml-auto), other
        → left (mr-auto). [direction:ltr] pins the avatar/content ORDER
        physically (the avatar stays on the left even in Arabic); the text
        itself flows via dir="auto" below.
      */}
      <div
        className={`relative flex w-fit items-start gap-2 [direction:ltr] ${
          mine ? "ml-auto" : "mr-auto"
        } max-w-[78%] md:max-w-[68%] lg:max-w-[56%]`}
      >
        {/* Own messages: no avatar (Messenger-style); others: start column. */}
        {!mine && avatar}

        <div className="min-w-0">
          {/* Name + time header — OTHER users only (own rows skip the
              username; the timestamp lives under the bubble instead). */}
          {firstOfGroup && !mine && (
            <p className="flex flex-wrap items-baseline gap-x-2 pb-0.5 leading-tight">
              {onOpenAuthor ? (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpenAuthor(m.user_id);
                  }}
                  className="text-sm font-bold text-ink underline-offset-2 hover:text-accent hover:underline"
                >
                  {name}
                </button>
              ) : (
                <span className="text-sm font-bold text-ink">{name}</span>
              )}
              {authorIsAdmin && <AdminBadge label={t("community.adminBadge")} />}
              <time dateTime={m.created_at} className="text-[11px] text-faint">
                {time}
              </time>
              {isPinned && (
                <span
                  className="inline-flex items-center gap-0.5 text-[10px] font-bold text-accent"
                  title={t("community.pinnedBy", { name })}
                  aria-label={t("community.pinnedBy", { name })}
                >
                  <Icon name="pin" size={10} />
                </span>
              )}
            </p>
          )}
          {/* Pinned marker for own rows (header is hidden on own). */}
          {firstOfGroup && mine && isPinned && (
            <p className="flex justify-end pb-0.5">
              <span
                className="inline-flex items-center gap-0.5 text-[10px] font-bold text-accent"
                title={t("community.pinnedBy", { name })}
                aria-label={t("community.pinnedBy", { name })}
              >
                <Icon name="pin" size={10} />
              </span>
            </p>
          )}

          {editing ? (
            <div className="mt-1" onClick={(event) => event.stopPropagation()}>
              <textarea
                value={editText}
                onChange={(event) => setEditText(event.target.value.slice(0, 2000))}
                rows={2}
                autoFocus
                dir="auto"
                aria-label={t("community.editMessage")}
                className="w-72 max-w-full resize-none rounded-xl border border-line-strong bg-surface p-2.5 text-sm text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/25"
              />
              <div className="mt-1 flex items-center gap-2">
                <Button
                  size="sm"
                  onClick={() => {
                    onSaveEdit(m.id, editText);
                    setEditing(false);
                  }}
                  disabled={editText.trim().length === 0}
                >
                  {t("community.saveEdit")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setEditing(false);
                    setEditText(m.message ?? "");
                    onCancelEdit();
                  }}
                >
                  {t("community.cancelEdit")}
                </Button>
              </div>
            </div>
          ) : (
            /* The bubble — Messenger geometry: strong rounding, the OUTER
               corner (bottom-right for own / bottom-left for other) tighter.
               Own: app accent (blue) + white text; other: neutral surface. */
            <div
              className={`px-3 py-1.5 shadow-sm ${
                mine
                  ? "rounded-2xl rounded-br-md bg-accent"
                  : "rounded-2xl rounded-bl-md bg-surface-2"
              }`}
            >
              {m.replyTo && (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onJumpToMessage(m.replyTo!.id);
                  }}
                  aria-label={t("community.replyToLabel", { name: replyAuthorName })}
                  className={`-ms-1.5 me-1.5 mt-0.5 flex max-w-full items-center gap-1.5 rounded-md border-s-2 ps-2 pe-1 py-0.5 text-xs ${
                    mine
                      ? "border-white/60 bg-white/15 text-white hover:bg-white/25"
                      : "border-accent text-muted hover:bg-surface"
                  }`}
                >
                  <span className={`font-semibold ${mine ? "text-white" : "text-ink-soft"}`}>
                    @{replyAuthorName}
                  </span>
                  <span className={`truncate ${mine ? "text-white/75" : "text-faint"}`}>
                    {replySnippet}
                  </span>
                </button>
              )}

              {imageUrl && (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpenImage(imageUrl);
                  }}
                  aria-label={t("community.viewImage")}
                  className="mb-1 block cursor-zoom-in overflow-hidden rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- signed URL from the private bucket */}
                  <img
                    src={imageUrl}
                    alt={t("community.imageAlt")}
                    loading="lazy"
                    className="max-h-60 w-auto max-w-full object-contain"
                  />
                </button>
              )}
              {!imageUrl &&
                m.image_path === null &&
                (m.message === null || m.message === "") && (
                  <span className="block h-32 w-44 animate-pulse rounded-xl bg-surface-2/70" aria-hidden="true" />
                )}
              {m.message && (
                <p
                  dir="auto"
                  className={`whitespace-pre-wrap break-words text-sm leading-relaxed ${
                    mine ? "text-white" : "text-ink"
                  }`}
                >
                  <MentionText
                    text={m.message}
                    knownMembers={knownMembers}
                    tone={mine ? "on-accent" : undefined}
                  />
                </p>
              )}
            </div>
          )}

          {/* Reactions — stay with the bubble and follow the alignment. */}
          {m.reactions.length > 0 && (
            <div
              className={`mt-1 flex flex-wrap gap-1 ${mine ? "justify-end" : ""}`}
              role="group"
              aria-label={t("community.reactionAria")}
            >
              {m.reactions.map((r) => (
                <button
                  key={r.emoji}
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onToggleReaction(m.id, r.emoji);
                  }}
                  aria-pressed={r.mine}
                  aria-label={`${r.emoji} ${r.count}`}
                  className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors ${
                    r.mine
                      ? "border-accent/60 bg-accent-soft text-accent"
                      : "border-line bg-surface text-muted hover:border-line-strong"
                  }`}
                >
                  <span aria-hidden="true">{r.emoji}</span>
                  <span className="font-semibold tabular-nums">{r.count}</span>
                </button>
              ))}
            </div>
          )}

          {/* Failed send (own optimistic row) — right-aligned with the row. */}
          {failed && (
            <div
              className="mt-1 flex items-center justify-end gap-1.5 px-0.5 text-[11px] font-medium text-danger"
              onClick={(event) => event.stopPropagation()}
            >
              <Icon name="alert" size={11} />
              <span>{t("community.notSent")}</span>
              <button
                type="button"
                onClick={() => onRetry(m)}
                className="font-bold underline underline-offset-2 hover:opacity-80"
              >
                {t("community.retry")}
              </button>
              <button
                type="button"
                onClick={() => onRemoveFailed(m.id)}
                aria-label={t("common.close")}
                className="flex h-4 w-4 items-center justify-center opacity-70 hover:opacity-100"
              >
                <Icon name="x" size={10} />
              </button>
            </div>
          )}

          {/* Own rows: timestamp (or "sending…") under the bubble, right. */}
          {mine && (
            <div className="mt-0.5 flex items-center justify-end gap-1 px-0.5">
              {sending && !failed ? (
                <span className="flex items-center gap-1 text-[10px] text-faint">
                  <Icon name="clock" size={10} />
                  {t("community.sending")}
                </span>
              ) : (
                <time dateTime={m.created_at} className="text-[10px] text-faint">
                  {time}
                </time>
              )}
              {edited && !failed && (
                <span className="text-[10px] text-faint">({t("community.editedLabel")})</span>
              )}
            </div>
          )}
          {/* Other rows: "edited" hint stays left, under the bubble. */}
          {!mine && edited && !failed && (
            <span className="ms-1 mt-0.5 inline-block text-[10px] text-faint">
              ({t("community.editedLabel")})
            </span>
          )}
        </div>

        {/* Action bar: hover on pointer devices, tap-selected on touch.
            Anchored to the CLUSTER (not the row) so it hugs the bubble
            side it belongs to. */}
        {showActions && (
          <div
            className="absolute -top-3.5 end-3 z-10 hidden items-center overflow-visible rounded-xl border border-line bg-surface shadow-sm group-hover:flex data-[active]:flex"
            data-active={active ? "" : undefined}
            onClick={(event) => event.stopPropagation()}
            role="toolbar"
            aria-label={t("community.editMessage")}
          >
            <RowAction icon="reply" label={t("community.replyToLabel", { name })} onClick={() => onReply(m)} />
            <div className="relative">
              <RowAction
                icon="smile"
                label={t("community.addReaction")}
                onClick={() => setEmojiOpen((v) => !v)}
              />
              {emojiOpen && (
                <div className="absolute -bottom-10 end-0 flex gap-0.5 rounded-xl border border-line bg-surface p-1 shadow-md">
                  {COMMUNITY_REACTION_EMOJIS.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      onClick={() => {
                        setEmojiOpen(false);
                        onToggleReaction(m.id, emoji);
                      }}
                      aria-label={emoji}
                      className="flex h-7 w-7 items-center justify-center rounded-lg text-base hover:bg-surface-2"
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {mine && (
              <RowAction icon="edit" label={t("community.editMessage")} onClick={() => setEditing(true)} />
            )}
            {mine &&
              (confirmDelete ? (
                <span className="flex items-center gap-1 px-1 text-[11px] font-semibold text-danger">
                  {t("community.confirmDeleteTitle")}
                  <button
                    type="button"
                    onClick={() => onDelete(m.id)}
                    className="rounded-lg bg-danger px-2 py-0.5 text-white hover:opacity-90"
                  >
                    {t("community.confirmDeleteAction")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(false)}
                    aria-label={t("community.cancelReply")}
                    className="rounded-lg px-1.5 py-0.5 text-muted hover:bg-surface-2"
                  >
                    {t("community.cancelReply")}
                  </button>
                </span>
              ) : (
                <RowAction icon="trash" label={t("community.deleteMessage")} onClick={() => setConfirmDelete(true)} danger />
              ))}
            {canModerate && onPinToggle && (
              <RowAction
                icon="pin"
                label={isPinned ? t("community.unpinMessage") : t("community.pinMessage")}
                onClick={() => onPinToggle(m.id)}
              />
            )}
            {!mine && onReportMessage && (
              <RowAction icon="flag" label={t("community.report")} onClick={() => onReportMessage(m.id)} />
            )}
           </div>
         )}
      </div>
    </div>
  );
}

function RowAction({
  icon,
  label,
  onClick,
  danger = false,
}: {
  icon: "reply" | "smile" | "edit" | "trash" | "pin" | "flag";
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`flex h-7 w-7 items-center justify-center rounded-lg ${
        danger ? "text-danger hover:bg-danger-soft" : "text-muted hover:bg-surface-2 hover:text-ink"
      }`}
    >
      <Icon name={icon} size={14} />
    </button>
  );
}

export const MessageRow = memo(MessageRowInner);
