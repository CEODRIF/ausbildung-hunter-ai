"use client";

import { memo } from "react";
import { Icon } from "@/components/icon";
import type { LocalMessage } from "@/lib/community";

/** "14:32" today, "12.03. 14:32" on other days (locale-aware). */
export function formatMessageTime(iso: string, locale: string): string {
  const date = new Date(iso);
  const time = date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  if (date.toDateString() === new Date().toDateString()) return time;
  return `${date.toLocaleDateString(locale, { day: "2-digit", month: "2-digit" })} ${time}`;
}

export interface MessageRowProps {
  message: LocalMessage;
  /** The row belongs to the current user (renders right-aligned). */
  mine: boolean;
  /** First row of a consecutive group from the same author. */
  firstOfGroup: boolean;
  /** Display name (trusted profile name, or the fallback label). */
  name: string;
  /** Predefined avatar URL, or null → initials fallback. */
  avatarUrl: string | null;
  locale: string;
  /**
   * Resolved image URL: the signed bucket URL once the server row exists, or
   * the local object URL while the optimistic row is still in flight.
   * null → loading skeleton.
   */
  imageUrl: string | null;
  t: (path: string, vars?: Record<string, string | number>) => string;
  onOpenImage: (url: string) => void;
  onRetry: (message: LocalMessage) => void;
  onRemove: (id: string) => void;
}

/**
 * One chat row. React.memo'd: with 50–200 rows in state, a realtime INSERT
 * must re-render ONLY the new/changed row, not the whole list. The parent
 * resolves every display value (name, avatar, image URL, time locale) so the
 * memo comparison stays a plain prop check.
 *
 * Text is rendered as a React text node — never as HTML (XSS-safe).
 */
function MessageRowInner({
  message: m,
  mine,
  firstOfGroup,
  name,
  avatarUrl,
  locale,
  imageUrl,
  t,
  onOpenImage,
  onRetry,
  onRemove,
}: MessageRowProps) {
  const time = formatMessageTime(m.created_at, locale);
  const failed = mine && m.sendStatus === "failed";
  const sending = mine && m.sendStatus === "sending";

  return (
    <div className={firstOfGroup ? "mt-3 first:mt-0" : "mt-[3px]"}>
      <div className={`flex items-end gap-2 ${mine ? "justify-end" : ""}`}>
        {!mine &&
          (firstOfGroup ? (
            avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- avatar: fixed 28px, static public path
              <img
                src={avatarUrl}
                alt={name}
                width={28}
                height={28}
                loading="lazy"
                className="h-7 w-7 shrink-0 rounded-full object-cover"
              />
            ) : (
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-2 text-[10px] font-bold text-muted">
                {name.charAt(0).toUpperCase()}
              </span>
            )
          ) : (
            // Keeps the continuation rows aligned under the group's avatar.
            <span className="w-7 shrink-0" aria-hidden="true" />
          ))}
        <div
          className={`flex max-w-[85%] flex-col sm:max-w-[70%] ${
            mine ? "items-end" : "items-start"
          }`}
        >
          {!mine && firstOfGroup && (
            <span className="mb-0.5 max-w-full truncate px-1 text-[11px] font-semibold text-muted">
              {name}
            </span>
          )}
          <div
            className={`rounded-2xl px-3 py-2 shadow-sm ${
              mine
                ? "rounded-br-md bg-accent text-white"
                : "rounded-bl-md border border-line bg-surface text-ink"
            }`}
          >
            {imageUrl && (
              <button
                type="button"
                onClick={() => onOpenImage(imageUrl)}
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
            {!imageUrl && m.image_path === null && (m.message === null || m.message === "") && (
              <span className="block h-32 w-44 animate-pulse rounded-xl bg-surface-2/70" aria-hidden="true" />
            )}
            {m.message && (
              <p
                className={`whitespace-pre-wrap break-words text-sm leading-relaxed ${
                  mine ? "text-white" : "text-ink"
                }`}
              >
                {m.message}
              </p>
            )}
            <span
              className={`mt-0.5 flex items-center justify-end gap-1 text-[10px] leading-none ${
                mine ? "text-white/75" : "text-faint"
              }`}
            >
              {time}
              {sending && <Icon name="clock" size={10} />}
              {mine && m.sendStatus === "sent" && <Icon name="check" size={10} />}
            </span>
          </div>
          {failed && (
            <div className="mt-0.5 flex items-center gap-1.5 px-1 text-[11px] font-medium text-danger">
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
                onClick={() => onRemove(m.id)}
                aria-label={t("common.close")}
                className="flex h-4 w-4 items-center justify-center opacity-70 hover:opacity-100"
              >
                <Icon name="x" size={10} />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export const MessageRow = memo(MessageRowInner);
