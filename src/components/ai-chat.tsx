"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { memo, useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  ChatMessageWithFiles,
  Conversation,
  MessageFile,
} from "@/lib/ai-service";
import {
  AI_CHAT_ACCEPT_ATTR,
  canSendWith,
  checkClientFile,
  composerFileKey,
  fileBadge,
  formatFileSize,
  isImageMime,
} from "@/lib/ai-chat-files";

/**
 * AI Assistant — chat workspace.
 *
 * Behavior contract (kept from the original implementation, now fixed):
 * - Server-rendered conversation + messages are synced into client state
 *   ONLY when the selected conversation changes (fixes stale messages when
 *   switching/creating conversations).
 * - Uploads go to /api/ai/files BEFORE sending; the send request carries the
 *   resulting file ids, and the server validates ownership + content.
 * - A failed generation leaves a compact inline error with retry; the
 *   conversation state is never destroyed.
 * - Streaming renders progressively into a separate state slot so the
 *   committed history does not re-render on every chunk.
 */

type DisplayMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  created_at: string;
  files: MessageFile[];
};

type ComposerFile = {
  key: string;
  status: "uploading" | "ready" | "error";
  filename: string;
  sizeBytes: number;
  mimeType: string;
  previewUrl?: string;
  id?: string;
  error?: string;
};

const QUICK_ACTIONS = [
  "Analysiere meinen Lebenslauf",
  "Verbessere meine Bewerbung",
  "Schreibe ein Anschreiben",
  "Bereite mich auf ein Vorstellungsgespräch vor",
  "Finde passende Ausbildung",
  "Analysiere eine Stellenanzeige",
];

function Icon({
  name,
  size = 18,
  className = "",
}: {
  name:
    | "menu"
    | "plus"
    | "paperclip"
    | "arrowUp"
    | "stop"
    | "x"
    | "spark"
    | "file"
    | "image"
    | "alert"
    | "arrowLeft"
    | "activity";
  size?: number;
  className?: string;
}) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    className,
  };
  const paths = {
    menu: <path d="M4 7h16M4 12h16M4 17h16" />,
    plus: <path d="M12 5v14M5 12h14" />,
    paperclip: (
      <path d="M21 12.5l-8.5 8.5a5.5 5.5 0 0 1-7.8-7.8l8.4-8.4a3.7 3.7 0 0 1 5.2 5.2l-8.2 8.2a1.8 1.8 0 0 1-2.6-2.6l7.5-7.5" />
    ),
    arrowUp: <path d="M12 19V5M5 12l7-7 7 7" />,
    stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
    x: <path d="M6 6l12 12M18 6L6 18" />,
    spark: (
      <path d="m12 3 1.6 5.4L19 10l-5.4 1.6L12 17l-1.6-5.4L5 10l5.4-1.6L12 3ZM19 16l.7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7L19 16Z" />
    ),
    file: (
      <>
        <path d="M6 3.5h8l4 4V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z" />
        <path d="M14 3.5V8h4M8.5 12h7M8.5 16h5" />
      </>
    ),
    image: (
      <>
        <rect x="4" y="5" width="16" height="14" rx="2" />
        <circle cx="9" cy="10" r="1.4" />
        <path d="M20 15.5l-4.2-4.2L7 20" />
      </>
    ),
    alert: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7.5V13M12 16.5h.01" />
      </>
    ),
    arrowLeft: <path d="M19 12H5M11 6l-6 6 6 6" />,
    activity: <path d="M3 12h4l2-7 4 14 2-7h6" />,
  };
  return <svg {...common}>{paths[name]}</svg>;
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("de-DE", {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === now.toDateString()) return "Heute";
  if (date.toDateString() === yesterday.toDateString()) return "Gestern";
  return date.toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
  });
}

function ThinkingDots() {
  return (
    <span
      className="inline-flex items-center gap-1 py-2"
      role="status"
      aria-label="Die KI denkt nach"
    >
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent/55 [animation-delay:0ms]" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent/55 [animation-delay:150ms]" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent/55 [animation-delay:300ms]" />
    </span>
  );
}

/** Markdown rendering for assistant messages — clean, compact, consistent
 *  with the app's design tokens. */
function Markdown({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => (
          <p className="mb-3 leading-7 last:mb-0">{children}</p>
        ),
        h1: ({ children }) => (
          <h1 className="mb-2.5 mt-4 text-lg font-bold tracking-[-0.02em] first:mt-0">
            {children}
          </h1>
        ),
        h2: ({ children }) => (
          <h2 className="mb-2.5 mt-4 text-base font-bold first:mt-0">
            {children}
          </h2>
        ),
        h3: ({ children }) => (
          <h3 className="mb-2 mt-3 text-sm font-bold first:mt-0">
            {children}
          </h3>
        ),
        ul: ({ children }) => (
          <ul className="mb-3 list-disc space-y-1 pl-5 last:mb-0">
            {children}
          </ul>
        ),
        ol: ({ children }) => (
          <ol className="mb-3 list-decimal space-y-1 pl-5 last:mb-0">
            {children}
          </ol>
        ),
        li: ({ children }) => <li className="leading-7">{children}</li>,
        a: ({ children, href }) => (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="break-words text-accent underline underline-offset-2"
          >
            {children}
          </a>
        ),
        blockquote: ({ children }) => (
          <blockquote className="mb-3 border-l-2 border-line-strong pl-3 text-muted last:mb-0">
            {children}
          </blockquote>
        ),
        pre: ({ children }) => (
          <pre className="mb-3 overflow-x-auto rounded-xl bg-navy p-3.5 text-xs leading-6 text-[#dbe6f5] last:mb-0">
            {children}
          </pre>
        ),
        code: ({ className, children }) =>
          className ? (
            <code className={className}>{children}</code>
          ) : (
            <code className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[13px] font-semibold text-danger">
              {children}
            </code>
          ),
        table: ({ children }) => (
          <div className="mb-3 overflow-x-auto last:mb-0">
            <table className="w-full text-left text-[13px]">{children}</table>
          </div>
        ),
        th: ({ children }) => (
          <th className="border-b border-line-strong px-2.5 py-1.5 font-bold text-ink-soft">
            {children}
          </th>
        ),
        td: ({ children }) => (
          <td className="border-b border-line px-2.5 py-1.5 align-top">
            {children}
          </td>
        ),
        hr: () => <hr className="my-4 border-line" />,
        img: ({ src, alt }) => (
          // Markdown may reference arbitrary (external) URLs — next/image
          // would require a remote-domain allowlist, so a plain img is
          // the correct control here (content is AI-generated text).
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt={alt ?? ""}
            className="my-2 max-w-full rounded-xl"
          />
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

/**
 * A committed message bubble. Memoized: while a new answer streams, the
 * stream updates re-render ONLY the streaming bubble — the committed
 * history (and its Markdown parsing) is skipped entirely, which is what
 * keeps typing and the rest of the UI responsive.
 */
const MessageBubble = memo(function MessageBubble({
  message,
}: {
  message: DisplayMessage;
}) {
  if (message.role === "user") {
    return (
      <div className="flex flex-col items-end">
        {message.files.length > 0 && (
          <div className="mb-1.5 flex max-w-[85%] flex-wrap justify-end gap-1.5">
            {message.files.map((file, index) => (
              <span
                key={`${file.filename}-${index}`}
                className="flex items-center gap-1.5 rounded-lg border border-line-strong bg-surface py-1 pl-1.5 pr-2 shadow-sm"
              >
                <span className="flex h-6 w-6 items-center justify-center rounded-md bg-accent-soft text-accent">
                  <Icon
                    name={isImageMime(file.mime_type) ? "image" : "file"}
                    size={12}
                  />
                </span>
                <span className="max-w-[160px] truncate text-[11px] font-semibold text-ink-soft">
                  {file.filename}
                </span>
                <span className="text-[10px] text-faint">
                  {formatFileSize(file.size_bytes)}
                </span>
              </span>
            ))}
          </div>
        )}
        <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-[var(--gradient-neon)] px-4 py-2.5 text-sm leading-6 text-white shadow-[0_8px_20px_-6px_rgba(var(--glow-accent-rgb),0.45)]">
          {message.content}
        </div>
        <span className="mt-1 pr-1 text-[10px] text-faint">
          {formatTime(message.created_at)}
        </span>
      </div>
    );
  }
  return (
    <div className="flex gap-2.5">
      <span className="mt-5 flex h-7 w-7 shrink-0 items-center justify-center rounded-xl bg-[var(--gradient-neon)] text-white shadow-[0_4px_12px_-2px_rgba(var(--glow-accent-rgb),0.4)]">
        <Icon name="spark" size={14} />
      </span>
      <div className="min-w-0 max-w-[88%] flex-1">
        <div className="mb-1 flex items-baseline gap-2">
          <span className="text-[11px] font-bold text-ink-soft">
            Ausbildung Hunter AI
          </span>
          <span className="text-[10px] text-faint">
            {formatTime(message.created_at)}
          </span>
        </div>
        {message.content ? (
          <div className="text-sm text-ink-soft">
            <Markdown content={message.content} />
          </div>
        ) : null}
      </div>
    </div>
  );
});

export function AIChat({
  conversations: initialConversations,
  selectedConversation,
  initialMessages,
}: {
  conversations: Conversation[];
  selectedConversation: Conversation;
  initialMessages: ChatMessageWithFiles[];
}) {
  const router = useRouter();
  const { t } = useI18n();
  const [conversations, setConversations] = useState(initialConversations);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState("");
  const [composerFiles, setComposerFiles] = useState<ComposerFile[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [streamContent, setStreamContent] = useState("");
  const [pendingAssistant, setPendingAssistant] = useState(false);
  const [failedSend, setFailedSend] = useState<{
    message: string;
    content: string;
    fileIds: string[];
  } | null>(null);
  const [notice, setNotice] = useState("");
  const [drawer, setDrawer] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  // Synchronous in-flight lock. React state (`streaming`) is not updated
  // until the next render, so Enter auto-repeat / a double click within
  // one event batch could otherwise fire two concurrent streams for the
  // same question (duplicate user bubble + two near-identical answers).
  const sendingRef = useRef(false);
  // Mirror of the currently rendered conversation for async completions —
  // a stale response must never be committed into a newer conversation.
  const convIdRef = useRef(selectedConversation.id);
  convIdRef.current = selectedConversation.id;
  // Stream-text coalescing: the first chunk commits to state IMMEDIATELY
  // (no frame wait — the bubble must appear as soon as the first token
  // arrives), subsequent chunks flush at most once per animation frame so
  // the UI never renders more often than it can paint.
  const pendingStreamRef = useRef<string | null>(null);
  const rafRef = useRef<number | null>(null);
  const flushStreamRef = (text: string) => {
    pendingStreamRef.current = text;
    if (rafRef.current === null) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        if (pendingStreamRef.current !== null) {
          setStreamContent(pendingStreamRef.current);
        }
      });
    }
  };
  const cancelStreamFlush = () => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    pendingStreamRef.current = null;
  };
  // Never leak a pending frame after unmount.
  useEffect(() => () => cancelStreamFlush(), []);

  // Conversation switch (or first mount): reset the conversation-bound
  // client state when the selected conversation changes — React's
  // "adjusting state when props change" pattern (synchronous, during
  // render; no effect cascade). Composer text and attachments are
  // intentionally NOT reset: they follow the user, not the conversation.
  const [syncedConversationId, setSyncedConversationId] = useState<string | null>(
    null,
  );
  if (syncedConversationId !== selectedConversation.id) {
    setSyncedConversationId(selectedConversation.id);
    setConversations(initialConversations);
    setMessages(
      initialMessages.map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        created_at: message.created_at,
        files: message.files ?? [],
      })),
    );
    setStreamContent("");
    setPendingAssistant(false);
    setFailedSend(null);
    setNotice("");
    setStreaming(false);
  }
  // Abort the previous conversation's in-flight stream (network side
  // effect — cannot happen during render). Its partial answer is
  // persisted server-side via the stream's flush.
  useEffect(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    // A pending frame flush from the previous conversation must not paint
    // into the new one.
    cancelStreamFlush();
  }, [selectedConversation.id]);

  // Auto-scroll while the user is at the bottom; never fight scrollback.
  const onScrollArea = (event: React.UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    stickRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };
  useEffect(() => {
    if (stickRef.current && scrollRef.current)
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, streamContent]);

  // Textarea auto-grow (1 → 6 lines).
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 192)}px`;
  }, [input]);

  const revokePreviews = (items: ComposerFile[]) => {
    for (const item of items)
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
  };
  const clearComposerFiles = (items: ComposerFile[]) => {
    revokePreviews(items);
    setComposerFiles([]);
  };

  const uploadOne = async (file: File, key: string) => {
    try {
      const form = new FormData();
      form.set("file", file);
      const response = await fetch("/api/ai/files", {
        method: "POST",
        body: form,
      });
      const result = (await response.json().catch(() => ({}))) as {
        id?: string;
        filename?: string;
        mime_type?: string;
        size_bytes?: number;
        error?: string;
      };
      if (!response.ok) {
        const message =
          response.status === 401
            ? "Sitzung abgelaufen – bitte erneut anmelden."
            : response.status === 429
              ? "Zu viele Anfragen – bitte kurz warten und erneut versuchen."
              : result.error || "Upload fehlgeschlagen.";
        setComposerFiles((items) =>
          items.map((it) =>
            it.key === key ? { ...it, status: "error", error: message } : it,
          ),
        );
        return;
      }
      setComposerFiles((items) =>
        items.map((it) =>
          it.key === key
            ? {
                ...it,
                status: "ready",
                id: result.id,
                filename: result.filename ?? it.filename,
                mimeType: result.mime_type ?? it.mimeType,
                sizeBytes: result.size_bytes ?? it.sizeBytes,
              }
            : it,
        ),
      );
    } catch {
      setComposerFiles((items) =>
        items.map((it) =>
          it.key === key
            ? { ...it, status: "error", error: "Netzwerkfehler – bitte erneut versuchen." }
            : it,
        ),
      );
    }
  };

  const addFiles = (incoming: File[]) => {
    const seen = new Set(
      composerFiles.map((it) => composerFileKey(it.filename, it.sizeBytes)),
    );
    const rejected: string[] = [];
    const fresh: ComposerFile[] = [];
    const freshFiles: File[] = [];
    for (const file of incoming) {
      const check = checkClientFile(file);
      if (!check.ok) {
        rejected.push(check.reason);
        continue;
      }
      const dedupeKey = composerFileKey(file.name, file.size);
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      fresh.push({
        key: crypto.randomUUID(),
        status: "uploading",
        filename: file.name,
        sizeBytes: file.size,
        mimeType: file.type,
        previewUrl: isImageMime(file.type) ? URL.createObjectURL(file) : undefined,
      });
      freshFiles.push(file);
    }
    if (rejected.length) setNotice(rejected[0]);
    if (!fresh.length) return;
    setComposerFiles((items) => [...items, ...fresh]);
    fresh.forEach((entry, index) => void uploadOne(freshFiles[index], entry.key));
  };

  const removeComposerFile = (key: string) => {
    setComposerFiles((items) => {
      const target = items.find((it) => it.key === key);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return items.filter((it) => it.key !== key);
    });
  };

  const runChat = async (content: string, fileIds: string[]) => {
    if (sendingRef.current) return; // one stream per conversation, ever
    sendingRef.current = true;
    const requestConvId = selectedConversation.id;
    setStreaming(true);
    setFailedSend(null);
    setStreamContent("");
    setPendingAssistant(true);
    abortRef.current = new AbortController();
    try {
      const response = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          conversationId: requestConvId,
          content,
          fileIds,
        }),
        signal: abortRef.current.signal,
      });
      if (!response.ok || !response.body) {
        const result = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(result.error || "Die KI-Anfrage ist fehlgeschlagen.");
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let complete = "";
      let firstChunk = true;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        complete += decoder.decode(value, { stream: true });
        // Show only the model text — the server appends a NUL-delimited
        // metadata frame after the last token.
        const cut = complete.lastIndexOf("\u0000");
        const display = cut === -1 ? complete : complete.slice(0, cut);
        if (firstChunk) {
          // First token: paint now, do not wait for a frame or the rest
          // of the answer.
          firstChunk = false;
          setStreamContent(display);
        } else {
          flushStreamRef(display);
        }
      }
      cancelStreamFlush();
      // Extract the persisted assistant message id from the final metadata
      // frame so the committed bubble carries the real database identity
      // (stable across refreshes); fall back to a local id if absent.
      let text = complete;
      let messageId = `assistant-${Date.now()}`;
      const cut = complete.lastIndexOf("\u0000");
      if (cut !== -1) {
        try {
          const meta = JSON.parse(complete.slice(cut + 1)) as {
            aiMeta?: { messageId?: string | null; saved?: boolean };
          };
          text = complete.slice(0, cut);
          if (meta.aiMeta?.messageId) messageId = meta.aiMeta.messageId;
        } catch {
          // Marker malformed — keep the raw text and the local id.
        }
      }
      if (convIdRef.current !== requestConvId) return; // stale request
      setMessages((items) => [
        ...items,
        {
          id: messageId,
          role: "assistant",
          content: text,
          created_at: new Date().toISOString(),
          files: [],
        },
      ]);
      setPendingAssistant(false);
      setStreamContent("");
    } catch (error) {
      cancelStreamFlush();
      setPendingAssistant(false);
      setStreamContent("");
      if ((error as Error).name === "AbortError") return; // stopped: partial answer is persisted server-side
      if (convIdRef.current !== requestConvId) return; // stale request
      setFailedSend({
        message:
          error instanceof Error
            ? error.message
            : "Die KI-Anfrage ist fehlgeschlagen.",
        content,
        fileIds,
      });
    } finally {
      setStreaming(false);
      sendingRef.current = false;
      abortRef.current = null;
    }
  };

  const send = () => {
    const content = input.trim();
    const readyFiles = composerFiles.filter(
      (file) => file.status === "ready" && file.id,
    );
    const uploading = composerFiles.some((file) => file.status === "uploading");
    if (!canSendWith(!!content, readyFiles.length, uploading, streaming)) return;
    const files: MessageFile[] = readyFiles.map((file) => ({
      filename: file.filename,
      mime_type: file.mimeType,
      size_bytes: file.sizeBytes,
    }));
    const sentContent =
      content || "Bitte analysiere die angehängte(n) Datei(en).";
    setMessages((items) => [
      ...items,
      {
        id: `local-${Date.now()}`,
        role: "user",
        content: sentContent,
        created_at: new Date().toISOString(),
        files,
      },
    ]);
    setInput("");
    setNotice("");
    clearComposerFiles(composerFiles);
    void runChat(sentContent, readyFiles.map((file) => file.id as string));
  };

  const retry = () => {
    if (!failedSend || streaming) return;
    const { content, fileIds } = failedSend;
    setFailedSend(null);
    void runChat(content, fileIds);
  };

  const selectConversation = (id: string) => {
    setDrawer(false);
    if (id !== selectedConversation.id)
      router.push(`/ai?conversation=${id}`);
  };
  const createNew = async () => {
    setDrawer(false);
    const response = await fetch("/api/ai/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const conversation = (await response.json()) as Conversation;
    if (response.ok) {
      setConversations((items) => [conversation, ...items]);
      router.push(`/ai?conversation=${conversation.id}`);
    }
  };
  const removeConversation = async (id: string) => {
    const response = await fetch("/api/ai/conversations", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (response.ok) {
      setConversations((items) => items.filter((item) => item.id !== id));
      if (id === selectedConversation.id) router.push("/ai");
    }
  };

  const readyCount = composerFiles.filter(
    (file) => file.status === "ready",
  ).length;
  const uploading = composerFiles.some((file) => file.status === "uploading");

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between">
        <Link
          href="/"
          className="flex items-center gap-2.5"
          aria-label="Ausbildung Hunter AI – Startseite"
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent text-white shadow-[0_6px_14px_rgba(var(--glow-accent-rgb),0.25)]">
            <span className="text-lg font-bold">A</span>
          </span>
          <span className="text-sm font-bold tracking-[-0.02em] text-ink">
            Ausbildung Hunter <span className="text-accent">AI</span>
          </span>
        </Link>
        <button
          className="rounded-lg p-1.5 text-muted hover:bg-surface-2 lg:hidden"
          onClick={() => setDrawer(false)}
          aria-label="Schließen"
        >
          <Icon name="x" size={16} />
        </button>
      </div>
      <button
        onClick={() => void createNew()}
        className="btn-neon mt-6 flex h-11 w-full items-center justify-center gap-2 rounded-2xl text-xs font-bold text-white"
      >
        <Icon name="plus" size={15} />
        Neue Unterhaltung
      </button>
      <nav
        className="mt-5 flex-1 space-y-0.5 overflow-y-auto pb-2"
        aria-label="Unterhaltungen"
      >
        {conversations.length === 0 && (
          <p className="px-3 py-2 text-xs text-faint">
            Noch keine Unterhaltungen.
          </p>
        )}
        {conversations.map((conversation) => {
          const active = conversation.id === selectedConversation.id;
          return (
            <div
              key={conversation.id}
              className={`group relative flex items-center rounded-xl ${active ? "bg-accent-soft" : "hover:bg-surface-2"}`}
            >
              <button
                onClick={() => selectConversation(conversation.id)}
                className="min-w-0 flex-1 px-3 py-2.5 pr-8 text-left"
              >
                <span
                  className={`block truncate text-xs font-semibold ${active ? "text-accent" : "text-muted group-hover:text-ink-soft"}`}
                >
                  {conversation.title || "Neue Unterhaltung"}
                </span>
                <span className="block text-[10px] text-faint">
                  {formatDate(conversation.updated_at)}
                </span>
              </button>
              <button
                aria-label={`Unterhaltung „${conversation.title}“ löschen`}
                onClick={() => void removeConversation(conversation.id)}
                className="absolute right-2 top-1/2 hidden h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-faint transition hover:bg-surface hover:text-danger group-hover:flex"
              >
                <Icon name="x" size={12} />
              </button>
            </div>
          );
        })}
      </nav>
      <div className="mt-auto space-y-0.5 border-t border-line pt-4">
        <Link
          href="/dashboard"
          className="flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-xs font-semibold text-muted transition hover:bg-surface-2 hover:text-ink-soft"
        >
          <Icon name="arrowLeft" size={14} />
          Dashboard
        </Link>
        <Link
          href="/settings/usage"
          className="flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-xs font-semibold text-muted transition hover:bg-surface-2 hover:text-ink-soft"
        >
          <Icon name="activity" size={14} />
          KI-Nutzung
        </Link>
      </div>
    </div>
  );

  return (
    <div className="flex h-dvh overflow-hidden bg-background">
      {drawer && (
        <button
          className="fixed inset-0 z-30 bg-navy/35 lg:hidden"
          aria-label="Unterhaltungen schließen"
          onClick={() => setDrawer(false)}
        />
      )}
      <aside
        className={`${drawer ? "translate-x-0" : "-translate-x-full"} fixed inset-y-0 left-0 z-40 w-[280px] border-r border-line bg-surface p-4 transition-transform duration-200 lg:static lg:z-auto lg:w-72 lg:shrink-0 lg:translate-x-0 lg:p-5`}
      >
        {sidebar}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-line bg-surface/85 px-4 backdrop-blur-md sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <button
              className="rounded-lg border border-line-strong p-2 text-muted hover:bg-surface-2 lg:hidden"
              onClick={() => setDrawer(true)}
              aria-label="Unterhaltungen öffnen"
            >
              <Icon name="menu" size={16} />
            </button>
            <div className="min-w-0">
              <h1 className="truncate text-sm font-bold text-ink">
                AI Assistant
              </h1>
              <p className="hidden truncate text-[11px] text-faint sm:block">
                Dein Karriere-Assistent für Ausbildung &amp; Bewerbung
              </p>
            </div>
          </div>
          <Link
            href="/settings/usage"
            className="shrink-0 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-accent hover:bg-accent-soft"
          >
            Nutzung
          </Link>
        </header>

        <div
          ref={scrollRef}
          onScroll={onScrollArea}
          className="flex-1 overflow-y-auto overscroll-contain"
        >
          <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
             {messages.length === 0 && !pendingAssistant ? (
               <div className="flex min-h-[calc(100dvh-240px)] flex-col items-center justify-center pb-10 text-center">
                 <div className="relative">
                   <span
                     aria-hidden="true"
                     className="orb-ring absolute inset-0 rounded-full border-2 border-accent/25"
                   />
                   <div className="flex h-20 w-20 items-center justify-center rounded-3xl bg-[var(--gradient-neon)] shadow-[0_18px_40px_-10px_rgba(var(--glow-accent-rgb),0.55)]">
                     <Icon name="spark" size={34} className="text-white" />
                   </div>
                 </div>
                 <h2 className="display-title mt-7 text-3xl text-ink">
                   Dein persönlicher KI-Assistent
                 </h2>
                 <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-muted">
                   Für Ausbildung, Bewerbungen und Karriere – inklusive deines
                   Lebenslaufs und deiner Bewerbungs-Dokumente.
                 </p>
                 <div className="mt-9 flex max-w-xl flex-wrap justify-center gap-2.5">
                   {QUICK_ACTIONS.map((action) => (
                     <button
                       key={action}
                       onClick={() => {
                         setInput(action);
                         taRef.current?.focus();
                       }}
                       className="group rounded-full border border-line-strong bg-surface px-4.5 py-2.5 text-xs font-bold text-ink-soft shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-transparent hover:bg-accent hover:text-white hover:shadow-[0_8px_18px_-6px_rgba(var(--glow-accent-rgb),0.5)]"
                     >
                       {action}
                     </button>
                   ))}
                 </div>
               </div>
             ) : (
              <div className="space-y-6 pb-2">
                {messages.map((message) => (
                  <MessageBubble key={message.id} message={message} />
                ))}
                 {pendingAssistant && (
                   <div className="flex gap-2.5">
                     <span className="mt-5 flex h-7 w-7 shrink-0 items-center justify-center rounded-xl bg-[var(--gradient-neon)] text-white shadow-[0_4px_12px_-2px_rgba(var(--glow-accent-rgb),0.4)]">
                       <Icon name="spark" size={14} />
                     </span>
                    <div className="min-w-0 flex-1">
                      <div className="mb-1 text-[11px] font-bold text-ink-soft">
                        Ausbildung Hunter AI
                      </div>
                      {streamContent ? (
                        // Plain (unformatted) text while streaming: parsing
                        // full Markdown on every frame would stall the UI on
                        // long answers. The committed message (above) renders
                        // the final Markdown exactly once.
                        <div className="whitespace-pre-wrap break-words text-sm text-ink-soft">
                          {streamContent}
                        </div>
                      ) : (
                        <ThinkingDots />
                      )}
                    </div>
                  </div>
                )}
                {failedSend && (
                  <div className="flex flex-wrap items-center gap-3 rounded-xl border border-danger/25 bg-danger-soft px-4 py-3">
                    <Icon name="alert" size={17} className="shrink-0 text-danger" />
                    <span className="min-w-[180px] flex-1 text-sm leading-5 text-danger">
                      {failedSend.message}
                    </span>
                    <button
                      onClick={retry}
                      className="rounded-lg border border-danger/25 bg-surface px-3 py-1.5 text-xs font-bold text-danger transition hover:bg-danger-soft"
                    >
                      Nochmal versuchen
                    </button>
                    <button
                      onClick={() => setFailedSend(null)}
                      aria-label="Fehler schließen"
                      className="flex h-6 w-6 items-center justify-center rounded-md text-danger hover:bg-surface/70"
                    >
                      <Icon name="x" size={12} />
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="shrink-0 border-t border-line bg-surface px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 sm:px-6">
          <div className="mx-auto w-full max-w-3xl">
            {notice && (
              <div className="mb-2 flex items-center justify-between gap-3 rounded-lg border border-danger/25 bg-danger-soft px-3 py-2 text-xs text-danger">
                <span className="min-w-0 truncate">{notice}</span>
                <button
                  onClick={() => setNotice("")}
                  aria-label="Hinweis schließen"
                  className="shrink-0 rounded p-0.5 hover:bg-surface/70"
                >
                  <Icon name="x" size={11} />
                </button>
              </div>
            )}
            {composerFiles.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-2">
                {composerFiles.map((file) => (
                  <span
                    key={file.key}
                    className={`flex items-center gap-2 rounded-xl border py-1.5 pl-1.5 pr-2 shadow-sm ${file.status === "error" ? "border-danger/25 bg-danger-soft" : "border-line-strong bg-surface"}`}
                  >
                    {file.previewUrl && file.status !== "uploading" ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={file.previewUrl}
                        alt=""
                        className="h-9 w-9 rounded-lg object-cover"
                      />
                    ) : file.status === "uploading" ? (
                      <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent-soft">
                        <span className="h-4 w-4 animate-spin rounded-full border-2 border-line-strong border-t-accent" />
                      </span>
                    ) : (
                      <span className={`flex h-9 w-9 items-center justify-center rounded-lg ${file.status === "error" ? "bg-danger-soft text-danger" : "bg-accent-soft text-accent"}`}>
                        <Icon
                          name={isImageMime(file.mimeType) ? "image" : "file"}
                          size={15}
                        />
                      </span>
                    )}
                    <span className="min-w-0">
                      <span className={`block max-w-[150px] truncate text-xs font-semibold ${file.status === "error" ? "text-danger" : "text-ink-soft"}`}>
                        {file.filename}
                      </span>
                      <span className="block text-[10px] text-faint">
                        {file.status === "uploading"
                          ? "Wird hochgeladen…"
                          : file.status === "error"
                            ? (file.error ?? "Upload fehlgeschlagen")
                            : `${fileBadge(file.filename)} · ${formatFileSize(file.sizeBytes)}`}
                      </span>
                    </span>
                    <button
                      aria-label={`Anhang „${file.filename}“ entfernen`}
                      onClick={() => removeComposerFile(file.key)}
                      className="ml-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-faint transition hover:bg-surface-2 hover:text-danger"
                    >
                      <Icon name="x" size={12} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div
              onDragOver={(event) => {
                event.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node))
                  setDragOver(false);
              }}
              onDrop={(event) => {
                event.preventDefault();
                setDragOver(false);
                addFiles(Array.from(event.dataTransfer.files ?? []));
              }}
               className={`flex items-end gap-1.5 rounded-3xl border bg-surface p-2 shadow-sm transition ${dragOver ? "border-accent ring-4 ring-accent/10" : "border-line-strong focus-within:border-accent focus-within:ring-4 focus-within:ring-accent/10"}`}
            >
              <input
                ref={fileRef}
                className="hidden"
                type="file"
                multiple
                accept={AI_CHAT_ACCEPT_ATTR}
                onChange={(event) => {
                  addFiles(Array.from(event.target.files ?? []));
                  event.target.value = "";
                }}
              />
              <button
                type="button"
                aria-label="Datei anhängen"
                title="Datei anhängen"
                onClick={() => fileRef.current?.click()}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-muted transition hover:bg-surface-2 hover:text-accent"
              >
                <Icon name="paperclip" size={19} />
              </button>
              <textarea
                ref={taRef}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    send();
                  }
                }}
                onPaste={(event) => {
                  const pasted = Array.from(event.clipboardData?.files ?? []);
                  if (pasted.length) {
                    event.preventDefault();
                    addFiles(pasted);
                  }
                }}
                 placeholder="Nachricht senden …"
                 rows={1}
                 aria-label="Nachricht"
                 className="max-h-48 min-h-10 flex-1 resize-none bg-transparent px-1 py-2.5 text-base leading-6 text-ink-soft outline-none placeholder:text-faint lg:text-sm"
              />
              {streaming ? (
                <button
                  type="button"
                  aria-label="Generierung stoppen"
                  title="Stoppen"
                  onClick={() => abortRef.current?.abort()}
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-navy-soft text-white shadow-sm transition hover:bg-navy"
                >
                  <Icon name="stop" size={16} />
                </button>
              ) : (
                <button
                  type="button"
                  aria-label="Senden"
                  title="Senden (Enter)"
                  onClick={send}
                  disabled={
                    !canSendWith(
                      !!input.trim(),
                      readyCount,
                      uploading,
                      streaming,
                    )
                  }
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-[var(--gradient-neon)] text-white shadow-[0_8px_18px_-4px_rgba(var(--glow-accent-rgb),0.5)] transition hover:brightness-105 active:scale-95 disabled:cursor-not-allowed disabled:from-surface-2 disabled:to-surface-2 disabled:text-faint disabled:shadow-none"
                >
                  <Icon name="arrowUp" size={18} />
                </button>
              )}
            </div>
            <p className="mt-2 text-center text-[10px] leading-4 text-faint">
              {t("chat.fileHint")}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
