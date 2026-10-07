"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/icon";
import { Button } from "@/components/ui";
import {
  COMMUNITY_IMAGE_MIMES,
  COMMUNITY_MAX_MESSAGE_LENGTH,
  communityAvatarUrl,
  type CommunityAuthor,
  type LocalMessage,
} from "@/lib/community";

/**
 * The room composer: auto-growing textarea, @-mention autocomplete
 * (keyboard navigable), image attach (≤ 2 MB, jpeg/png/webp) and the
 * reply-to context bar.
 *
 * All STATE lives in the parent (RoomChat): the text must be restorable
 * after a failed send, and the typing sender is owned there too. This
 * component is the presentation + caret/autocomplete machinery.
 */

interface MentionCandidate {
  query: string;
  /** Index in `value` of the "@" that opens the token. */
  start: number;
  caret: number;
}

/** The open @-token at the caret (if any): `@` + 0–23 letters/digits. */
function detectMention(value: string, caret: number): MentionCandidate | null {
  const before = value.slice(0, caret);
  const match = before.match(/(^|[\s([{>"'])@([A-Za-z0-9]{0,23})$/);
  if (!match) return null;
  return { query: match[2], start: caret - match[2].length - 1, caret };
}

const MAX_SUGGESTIONS = 8;

export interface ComposerProps {
  members: CommunityAuthor[];
  text: string;
  onTextChange: (value: string) => void;
  /** One call per composer change — drives the typing indicator. */
  onTyping: (hasText: boolean) => void;
  replyTo: LocalMessage | null;
  onCancelReply: () => void;
  pendingImage: { file: File; url: string } | null;
  onPickImage: (file: File | null) => void;
  onClearImage: () => void;
  onSend: () => void;
  submitting: boolean;
  /** Send-phase error, ALREADY translated (null = none). */
  error: string | null;
  /** Image-phase error, ALREADY translated (null = none). */
  imageError: string | null;
  /**
   * Monotonic focus signal: each INCREMENT re-focuses the textarea (the
   * reply flow bumps it, so the composer follows the user's intent).
   */
  focusSignal?: number;
  t: (path: string, vars?: Record<string, string | number>) => string;
}

export function Composer({
  members,
  text,
  onTextChange,
  onTyping,
  replyTo,
  onCancelReply,
  pendingImage,
  onPickImage,
  onClearImage,
  onSend,
  submitting,
  error,
  imageError,
  focusSignal,
  t,
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [mention, setMention] = useState<MentionCandidate | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  // A focus-signal bump re-focuses the textarea (e.g. "Reply" was pressed).
  // focus() on an external element is the legitimate use of an effect here.
  const lastFocusSignal = useRef(focusSignal ?? 0);
  useEffect(() => {
    const next = focusSignal ?? 0;
    if (next !== lastFocusSignal.current) {
      lastFocusSignal.current = next;
      textareaRef.current?.focus();
    }
  }, [focusSignal]);

  const membersByName = useMemo(() => {
    const map = new Map<string, CommunityAuthor>();
    for (const m of members) map.set(m.display_name.toLowerCase(), m);
    return map;
  }, [members]);

  const suggestions = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    const all = [...membersByName.values()].sort((a, b) =>
      a.display_name.localeCompare(b.display_name),
    );
    const matched = q
      ? all.filter((m) => m.display_name.toLowerCase().startsWith(q))
      : all;
    return matched.slice(0, MAX_SUGGESTIONS);
  }, [mention, membersByName]);

  const closeMention = () => {
    setMention(null);
    setActiveIndex(0);
  };

  const completeMention = (index: number) => {
    const el = textareaRef.current;
    if (!el || !mention) return;
    const member = suggestions[index];
    if (!member) return;
    const next =
      text.slice(0, mention.start) +
      `@${member.display_name} ` +
      text.slice(mention.caret);
    onTextChange(next);
    closeMention();
    // The value is controlled (parent state) — restore the caret AFTER the
    // re-render painted the new text.
    requestAnimationFrame(() => {
      const pos = mention.start + member.display_name.length + 2;
      el.focus();
      try {
        el.setSelectionRange(pos, pos);
      } catch {
        /* older engines: caret at end is acceptable */
      }
    });
  };

  const handleTextChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = event.target.value.slice(0, COMMUNITY_MAX_MESSAGE_LENGTH);
    onTextChange(value);
    onTyping(value.length > 0);
    const detected = detectMention(value, event.target.selectionStart ?? value.length);
    if (detected) {
      setMention(detected);
      setActiveIndex(0);
    } else {
      closeMention();
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention && suggestions.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((i) => (i + 1) % suggestions.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        completeMention(activeIndex);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeMention();
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      closeMention();
      onSend();
    }
  };

  const placeholder = replyTo
    ? t("community.replyPlaceholder", {
        name:
          replyTo.author?.display_name ??
          t("community.mentionNotFound"),
      })
    : t("community.placeholder");

  return (
    <div className="shrink-0 border-t border-line bg-surface/95 px-3 pb-3 pt-1.5 sm:px-6">
      <div className="mx-auto w-full max-w-3xl">
        {imageError && (
          <p role="alert" className="mb-1.5 px-1.5 text-xs font-medium text-danger">
            {imageError}
          </p>
        )}
        {pendingImage && (
          <div className="mb-2 flex items-center gap-2.5 px-1.5">
            {/* eslint-disable-next-line @next/next/no-img-element -- local object-URL preview */}
            <img
              src={pendingImage.url}
              alt={t("community.imageAlt")}
              className="h-16 w-16 rounded-xl border border-line object-cover"
            />
            <button
              type="button"
              onClick={onClearImage}
              className="inline-flex items-center gap-1.5 rounded-lg border border-line-strong px-2.5 py-1.5 text-xs font-semibold text-muted transition-colors hover:bg-surface-2 hover:text-ink"
            >
              <Icon name="x" size={12} />
              {t("community.removeImage")}
            </button>
          </div>
        )}
        {replyTo && (
          <div className="mb-1.5 flex items-center gap-2 px-1.5 text-xs text-muted">
            <Icon name="reply" size={13} className="shrink-0 text-accent" />
            <span className="min-w-0 truncate">
              {t("community.replyToLabel", {
                name:
                  replyTo.user_id &&
                  replyTo.author?.display_name
                    ? replyTo.author.display_name
                    : t("community.mentionNotFound"),
              })}
            </span>
            <button
              type="button"
              onClick={onCancelReply}
              aria-label={t("community.cancelReply")}
              className="ms-auto flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-faint hover:bg-surface-2 hover:text-ink"
            >
              <Icon name="x" size={12} />
            </button>
          </div>
        )}
        <div className="relative">
          {/* Mention autocomplete — above the field (never below the keyboard). */}
          {mention && suggestions.length > 0 && (
            <div
              role="listbox"
              aria-label={t("community.membersTitle")}
              className="absolute bottom-full start-0 z-20 mb-1.5 max-h-64 w-72 max-w-full overflow-y-auto rounded-xl border border-line bg-surface p-1 shadow-lg"
            >
              {suggestions.map((member, i) => (
                <button
                  key={member.user_id}
                  type="button"
                  role="option"
                  aria-selected={i === activeIndex}
                  onMouseEnter={() => setActiveIndex(i)}
                  onClick={() => completeMention(i)}
                  className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-start text-sm ${
                    i === activeIndex ? "bg-accent-soft text-accent" : "text-ink"
                  }`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- avatar: fixed 24px, static public asset */}
                  <img
                    src={communityAvatarUrl(member.avatar_id)}
                    alt=""
                    width={24}
                    height={24}
                    loading="lazy"
                    className="h-6 w-6 rounded-md object-cover"
                  />
                  <span className="truncate font-medium">@{member.display_name}</span>
                </button>
              ))}
            </div>
          )}
          <div className="flex items-end gap-1.5 rounded-2xl border border-line-strong bg-surface p-1.5 transition focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/25">
            <input
              ref={fileRef}
              type="file"
              accept={COMMUNITY_IMAGE_MIMES.join(",")}
              className="hidden"
              onChange={(event) => onPickImage(event.target.files?.[0] ?? null)}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              aria-label={t("community.attachImage")}
              title={t("community.attachImage")}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-muted transition-colors hover:bg-surface-2 hover:text-ink"
            >
              <Icon name="image" size={18} />
            </button>
            <textarea
              ref={textareaRef}
              value={text}
              onChange={handleTextChange}
              onKeyDown={handleKeyDown}
              onBlur={closeMention}
              rows={1}
              placeholder={placeholder}
              aria-label={placeholder}
              className="max-h-36 min-h-9 flex-1 resize-none bg-transparent px-1.5 py-2 text-sm text-ink outline-none placeholder:text-faint"
            />
            <Button
              onClick={onSend}
              disabled={submitting || (text.trim().length === 0 && !pendingImage)}
              aria-label={t("community.send")}
              title={t("community.send")}
              className="h-9 w-9 shrink-0 rounded-xl px-0"
            >
              <Icon name="send" size={16} />
            </Button>
          </div>
        </div>
        {error && (
          <p role="alert" className="mt-1.5 px-1.5 text-xs font-medium text-danger">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
