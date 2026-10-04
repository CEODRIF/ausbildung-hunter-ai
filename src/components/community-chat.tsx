"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createClient } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n";
import { Icon } from "@/components/icon";
import { Button } from "@/components/ui";
import { markCommunityRead } from "@/app/community/actions";
import {
  COMMUNITY_IMAGE_MIMES,
  COMMUNITY_MAX_IMAGE_BYTES,
  COMMUNITY_MAX_MESSAGE_LENGTH,
  COMMUNITY_PAGE_SIZE,
  communityAvatarUrl,
  mergeCommunityMessages,
  type CommunityAuthor,
  type CommunityMessage,
  type CommunityMessageView,
} from "@/lib/community";

interface CommunityChatProps {
  me: { userId: string; displayName: string; avatarId: string };
  initialMessages: CommunityMessageView[];
  /**
   * The server could not prefetch the history (DB outage / incomplete server
   * env). The chat still opens, Realtime keeps streaming, and the user gets an
   * explicit notice with a retry that resyncs through the API route — instead
   * of the whole page failing.
   */
  historyUnavailable?: boolean;
}

type ConnectionState = "connected" | "disconnected";

function localeFor(lang: string): string {
  return lang === "de" ? "de-DE" : lang === "fr" ? "fr-FR" : lang === "ar" ? "ar" : "en-US";
}

/** "14:32" today, "12.03. 14:32" on other days (locale-aware). */
function formatMessageTime(iso: string, locale: string): string {
  const date = new Date(iso);
  const time = date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  if (date.toDateString() === new Date().toDateString()) return time;
  return `${date.toLocaleDateString(locale, { day: "2-digit", month: "2-digit" })} ${time}`;
}

/**
 * The community group chat.
 *
 *  - Real-time via Supabase Realtime (postgres_changes INSERT on
 *    community_messages). All merges go through mergeCommunityMessages,
 *    which dedupes by id — the sender's own POST response, the realtime
 *    INSERT and a post-reconnect resync can never create duplicates.
 *  - After a dropped connection the channel re-subscribes and the most
 *    recent page is re-fetched and merged (no replay guarantee from
 *    Postgres changes, so we resync explicitly).
 *  - "Load older" pages backwards on scroll-up (50 per page); no polling.
 *  - Messages render as plain text (React text nodes) — never as HTML.
 *  - Read state: opening the page (and receiving while viewing) advances
 *    the user's read cursor, which drives the sidebar badge.
 */
export function CommunityChat({
  me,
  initialMessages,
  historyUnavailable = false,
}: CommunityChatProps) {
  const { t, lang } = useI18n();
  const locale = useMemo(() => localeFor(lang), [lang]);
  const supabase = useMemo(() => createClient(), []);

  const [messages, setMessages] = useState<CommunityMessageView[]>(initialMessages);
  const [authors, setAuthors] = useState<Record<string, CommunityAuthor>>(() => {
    const seed: Record<string, CommunityAuthor> = {};
    for (const m of initialMessages) {
      if (m.author && !seed[m.user_id]) seed[m.user_id] = m.author;
    }
    return seed;
  });
  const [connection, setConnection] = useState<ConnectionState>("connected");
  const [historyMissing, setHistoryMissing] = useState(historyUnavailable);
  const [olderLoading, setOlderLoading] = useState(false);
  const [hasMoreOlder, setHasMoreOlder] = useState(
    initialMessages.length >= COMMUNITY_PAGE_SIZE,
  );
  const [text, setText] = useState("");
  const [pendingImage, setPendingImage] = useState<{ file: File; url: string } | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({});

  const listRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const knownIds = useRef<Set<string>>(new Set(initialMessages.map((m) => m.id)));
  // Latest-authors mirror for async callbacks (realtime INSERTs, resync).
  // Synced in an effect — refs are never written during render.
  const authorsRef = useRef(authors);
  useEffect(() => {
    authorsRef.current = authors;
  }, [authors]);
  const stickToBottom = useRef(true);
  const restoreScroll = useRef<{ prevHeight: number; prevTop: number } | null>(null);
  const markReadTimer = useRef<number | null>(null);
  const sawDisconnected = useRef(false);

  const authorOf = useCallback((m: CommunityMessage): CommunityAuthor | null => {
    if (m.user_id === me.userId) {
      return { user_id: me.userId, display_name: me.displayName, avatar_id: me.avatarId };
    }
    return authorsRef.current[m.user_id] ?? null;
  }, [me]);

  const ensureAuthor = useCallback(
    async (userId: string) => {
      if (userId in authorsRef.current) return;
      const { data } = await supabase
        .from("community_profiles")
        .select("user_id,display_name,avatar_id")
        .eq("user_id", userId)
        .maybeSingle();
      if (data) {
        setAuthors((prev) => ({
          ...prev,
          [userId]: {
            user_id: data.user_id,
            display_name: data.display_name,
            avatar_id: data.avatar_id,
          },
        }));
      }
    },
    [supabase],
  );

  const scheduleMarkRead = useCallback((messageId: string) => {
    if (markReadTimer.current) window.clearTimeout(markReadTimer.current);
    // Throttled: the cursor only needs to reach the newest message, not
    // every intermediate one.
    markReadTimer.current = window.setTimeout(() => {
      void markCommunityRead(messageId);
    }, 600);
  }, []);

  // Mark the latest message read when the page is actually opened.
  useEffect(() => {
    const latest = messages[messages.length - 1];
    if (latest) void markCommunityRead(latest.id);
    if (markReadTimer.current) window.clearTimeout(markReadTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Resync the newest page after a dropped connection has recovered.
  const resyncRecent = useCallback(async () => {
    try {
      const response = await fetch(`/api/community/messages`, { cache: "no-store" });
      if (!response.ok) return;
      const data = (await response.json()) as { items: CommunityMessageView[] };
      // A successful (RLS-backed) fetch clears the degraded-history notice.
      setHistoryMissing(false);
      for (const m of data.items) knownIds.current.add(m.id);
      setMessages((prev) => mergeCommunityMessages(prev, data.items));
      for (const m of data.items) {
        if (m.author) authorsRef.current = { ...authorsRef.current, [m.user_id]: m.author };
      }
      setAuthors((prev) => {
        const next = { ...prev };
        for (const m of data.items) if (m.author) next[m.user_id] = m.author;
        return next;
      });
    } catch {
      /* keep the current state; the next reconnect retries */
    }
  }, []);

  // Realtime subscription (event-driven; no polling).
  useEffect(() => {
    const channel = supabase
      .channel("community-messages")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "community_messages" },
        (payload) => {
          const incoming = payload.new as CommunityMessage;
           if (!incoming?.id || knownIds.current.has(incoming.id)) return;
           knownIds.current.add(incoming.id);
           // Realtime rows carry no author; ensureAuthor() fills the display
           // data into the authors map (the render reads from there).
           setMessages((prev) =>
             mergeCommunityMessages(prev, [{ ...incoming, author: null }]),
           );
          if (!authorOf(incoming)) void ensureAuthor(incoming.user_id);
          // Scrolling follows stickToBottom (updated on scroll) — a user
          // reading history is not yanked to the bottom by new messages.
          scheduleMarkRead(incoming.id);
        },
      )
       .subscribe((status) => {
         if (status === "SUBSCRIBED") {
           setConnection("connected");
           if (sawDisconnected.current) void resyncRecent();
         } else {
           // TIMED_OUT / CLOSED / CHANNEL_ERROR: the realtime client retries
           // on its own; the banner ("reconnecting") stays up until the next
           // SUBSCRIBED, and a resync then covers any missed INSERTs.
           sawDisconnected.current = true;
           setConnection("disconnected");
         }
       });
    return () => {
      void supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase]);

  // Resolve signed URLs for message images (private bucket). Each path is
  // signed at most once per session (3600 s expiry ≫ page lifetime).
  const signedPaths = useRef<Set<string>>(new Set());
  useEffect(() => {
    const toSign = messages.filter(
      (m) => m.image_path && !signedPaths.current.has(m.image_path),
    );
    if (toSign.length === 0) return;
    for (const m of toSign) signedPaths.current.add(m.image_path as string);
    let cancelled = false;
    void (async () => {
      for (const m of toSign) {
        const { data } = await supabase.storage
          .from("community-images")
          .createSignedUrl(m.image_path as string, 3600);
        if (data?.signedUrl && !cancelled) {
          setImageUrls((prev) =>
            prev[m.image_path as string]
              ? prev
              : { ...prev, [m.image_path as string]: data.signedUrl as string },
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [messages, supabase]);

  const loadOlder = useCallback(async () => {
    const oldest = messages[0];
    if (!oldest || olderLoading || !hasMoreOlder) return;
    const el = listRef.current;
    if (el) restoreScroll.current = { prevHeight: el.scrollHeight, prevTop: el.scrollTop };
    setOlderLoading(true);
    try {
      const response = await fetch(
        `/api/community/messages?before_at=${encodeURIComponent(oldest.created_at)}`,
        { cache: "no-store" },
      );
      if (!response.ok) return;
      const data = (await response.json()) as { items: CommunityMessageView[] };
      for (const m of data.items) knownIds.current.add(m.id);
      setMessages((prev) => mergeCommunityMessages(data.items, prev));
      setHasMoreOlder(data.items.length >= COMMUNITY_PAGE_SIZE);
      setAuthors((prev) => {
        const next = { ...prev };
        for (const m of data.items) if (m.author) next[m.user_id] = m.author;
        return next;
      });
    } catch {
      restoreScroll.current = null;
    } finally {
      setOlderLoading(false);
    }
  }, [hasMoreOlder, olderLoading, messages]);

  // Scroll behaviour: stick to the bottom for new messages; restore the
  // reading position when older pages are prepended.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (restoreScroll.current) {
      el.scrollTop = el.scrollHeight - restoreScroll.current.prevHeight + restoreScroll.current.prevTop;
      restoreScroll.current = null;
    } else if (stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  });

  const onScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (el.scrollTop < 60) void loadOlder();
  }, [loadOlder]);

  const onPickImage = (file: File | null | undefined) => {
    setImageError(null);
    if (!file) return;
    if (!(COMMUNITY_IMAGE_MIMES as readonly string[]).includes(file.type)) {
      setImageError("invalid_image");
      return;
    }
    if (file.size > COMMUNITY_MAX_IMAGE_BYTES) {
      setImageError("image_too_large");
      return;
    }
    if (pendingImage) URL.revokeObjectURL(pendingImage.url);
    setPendingImage({ file, url: URL.createObjectURL(file) });
  };

  const clearPendingImage = useCallback(() => {
    if (pendingImage) URL.revokeObjectURL(pendingImage.url);
    setPendingImage(null);
    if (fileRef.current) fileRef.current.value = "";
  }, [pendingImage]);

  const send = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed && !pendingImage) {
      setSendError("empty_message");
      return;
    }
    if (sending) return;
    setSending(true);
    setSendError(null);
    try {
      const form = new FormData();
      form.set("message", trimmed);
      if (pendingImage) {
        // Fixed, server-ignored filename — the storage path is generated
        // server-side from the session user id + a fresh message id.
        form.set("image", pendingImage.file, "image");
      }
      const response = await fetch("/api/community/messages", {
        method: "POST",
        body: form,
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        const code = body?.error;
        setSendError(
          response.status === 429
            ? "rate_limited"
            : code === "empty_message"
              ? "empty_message"
              : code === "text_too_long"
                ? "text_too_long"
                : code === "image_too_large"
                  ? "image_too_large"
                  : code === "invalid_image"
                    ? "invalid_image"
                    : "send_failed",
        );
        return;
      }
      const data = (await response.json()) as { message: CommunityMessage };
      const view: CommunityMessageView = {
        ...data.message,
        author: { user_id: me.userId, display_name: me.displayName, avatar_id: me.avatarId },
      };
      if (!knownIds.current.has(view.id)) {
        knownIds.current.add(view.id);
        setMessages((prev) => mergeCommunityMessages(prev, [view]));
      }
      setText("");
      clearPendingImage();
      stickToBottom.current = true;
      scheduleMarkRead(view.id);
    } catch {
      setSendError("send_failed");
    } finally {
      setSending(false);
    }
  }, [clearPendingImage, pendingImage, scheduleMarkRead, sending, text, me]);

  const onTextKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  const errorText = (code: string | null): string | null => {
    switch (code) {
      case "empty_message":
        return t("community.emptyMessage");
      case "text_too_long":
        return t("community.textTooLong");
      case "image_too_large":
        return t("community.imageTooLarge");
      case "invalid_image":
        return t("community.invalidImage");
      case "rate_limited":
        return t("community.rateLimited");
      case "profile_required":
        return t("community.profileRequired");
      case "send_failed":
        return t("community.sendFailed");
      default:
        return null;
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Message list */}
      <div
        ref={listRef}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto overscroll-contain"
      >
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 py-5 sm:px-6">
          {connection !== "connected" && (
            <div className="flex justify-center">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-warning/30 bg-warning-soft px-3 py-1 text-xs font-semibold text-warning">
                <Icon name="alert" size={12} />
                {t("community.reconnecting")}
              </span>
            </div>
          )}

          {historyMissing && (
            <div className="flex justify-center">
              <span className="inline-flex flex-wrap items-center justify-center gap-1.5 rounded-full border border-warning/30 bg-warning-soft px-3 py-1 text-xs font-semibold text-warning">
                <Icon name="alert" size={12} />
                {t("community.historyUnavailable")}
                <button
                  type="button"
                  onClick={() => void resyncRecent()}
                  className="underline underline-offset-2"
                >
                  {t("community.historyUnavailableRetry")}
                </button>
              </span>
            </div>
          )}

          {messages.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 py-16 text-center">
              <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-soft text-accent">
                <Icon name="users" size={26} />
              </span>
              <h2 className="text-lg font-bold text-ink">{t("community.emptyTitle")}</h2>
              <p className="max-w-sm text-sm leading-6 text-muted">{t("community.emptyText")}</p>
              <p className="text-xs font-semibold text-faint">{t("community.emptyCta")}</p>
            </div>
          ) : (
            <>
              {olderLoading && (
                <p className="py-1 text-center text-xs font-medium text-faint">
                  {t("common.loading")}
                </p>
              )}
              {messages.map((m) => {
                const mine = m.user_id === me.userId;
                const author: CommunityAuthor | null = mine
                  ? {
                      user_id: me.userId,
                      display_name: me.displayName,
                      avatar_id: me.avatarId,
                    }
                  : authors[m.user_id] ?? null;
                const name = mine ? me.displayName : author?.display_name ?? t("community.member");
                const avatarUrl = mine
                  ? communityAvatarUrl(me.avatarId)
                  : author
                    ? communityAvatarUrl(author.avatar_id)
                    : null;
                return (
                  <div
                    key={m.id}
                    className={`flex items-end gap-2.5 ${mine ? "justify-end" : "justify-start"}`}
                  >
                    {!mine && (
                      avatarUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element -- avatar: fixed 34px, static public path
                        <img
                          src={avatarUrl}
                          alt={name}
                          width={34}
                          height={34}
                          loading="lazy"
                          className="h-[34px] w-[34px] shrink-0 rounded-full object-cover"
                        />
                      ) : (
                        <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full bg-surface-2 text-xs font-bold text-muted">
                          {name.charAt(0).toUpperCase()}
                        </span>
                      )
                    )}
                    <div
                      className={`max-w-[82%] rounded-2xl border px-3.5 py-2.5 sm:max-w-[70%] ${
                        mine
                          ? "rounded-ee-md border-accent/25 bg-accent-soft"
                          : "rounded-es-md border-line bg-surface"
                      }`}
                    >
                      <div className="mb-1 flex items-baseline gap-2">
                        <span className={`text-xs font-bold ${mine ? "text-accent" : "text-ink"}`}>
                          {name}
                          {mine && (
                            <span className="ms-1.5 font-semibold text-faint">
                              {t("community.you")}
                            </span>
                          )}
                        </span>
                        <span className="text-[10px] font-medium text-faint">
                          {formatMessageTime(m.created_at, locale)}
                        </span>
                      </div>
                      {m.message && (
                        <p className="whitespace-pre-wrap break-words text-sm leading-6 text-ink">
                          {m.message}
                        </p>
                      )}
                      {m.image_path && (
                        // eslint-disable-next-line @next/next/no-img-element -- signed URL from the private bucket
                        <img
                          src={imageUrls[m.image_path]}
                          alt={t("community.imageAlt")}
                          loading="lazy"
                          className={`mt-1.5 max-h-72 w-full min-w-40 rounded-xl border border-line object-contain ${
                            imageUrls[m.image_path] ? "" : "min-h-24 bg-surface-2"
                          }`}
                        />
                      )}
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </div>
      </div>

      {/* Composer */}
      <div className="border-t border-line bg-surface/95 px-4 pb-4 pt-3 sm:px-6">
        <div className="mx-auto w-full max-w-3xl">
          {imageError && (
            <p role="alert" className="mb-2 text-xs font-medium text-danger">
              {errorText(imageError)}
            </p>
          )}
          {pendingImage && (
            <div className="mb-2 flex items-center gap-2.5">
              {/* eslint-disable-next-line @next/next/no-img-element -- local object-URL preview */}
              <img
                src={pendingImage.url}
                alt={t("community.imageAlt")}
                className="h-14 w-14 rounded-lg border border-line object-cover"
              />
              <button
                type="button"
                onClick={clearPendingImage}
                className="inline-flex items-center gap-1.5 rounded-lg border border-line-strong px-2.5 py-1.5 text-xs font-semibold text-muted transition-colors hover:bg-surface-2 hover:text-ink"
              >
                <Icon name="x" size={12} />
                {t("community.removeImage")}
              </button>
            </div>
          )}
          <div className="flex items-end gap-2">
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={(event) => onPickImage(event.target.files?.[0])}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              aria-label={t("community.attachImage")}
              title={t("community.attachImage")}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-line-strong text-muted transition-colors hover:bg-surface-2 hover:text-ink"
            >
              <Icon name="image" size={18} />
            </button>
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value.slice(0, COMMUNITY_MAX_MESSAGE_LENGTH))}
              onKeyDown={onTextKeyDown}
              rows={1}
              placeholder={t("community.placeholder")}
              aria-label={t("community.placeholder")}
              className="max-h-32 min-h-11 flex-1 resize-none rounded-xl border border-line-strong bg-surface px-3.5 py-2.5 text-sm text-ink outline-none transition placeholder:text-faint focus:border-accent focus:ring-1 focus:ring-accent"
            />
            <Button
              onClick={() => void send()}
              disabled={sending || (!text.trim() && !pendingImage)}
              aria-label={t("community.send")}
              title={t("community.send")}
              className="h-11 w-11 shrink-0 px-0"
            >
              <Icon name="send" size={18} />
            </Button>
          </div>
          {sendError && (
            <p role="alert" className="mt-2 text-xs font-medium text-danger">
              {errorText(sendError)}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}