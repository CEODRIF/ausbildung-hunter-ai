"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n";

/** Mirror of the server-side ANNOUNCEMENT_TYPES (the server re-validates
 *  every value — this list only drives the option labels). */
const ANNOUNCEMENT_TYPES = [
  "announcement",
  "info",
  "important",
  "maintenance",
  "improvement",
] as const;

const TYPE_LABEL_KEYS: Record<string, string> = {
  announcement: "admin.notifTypeAnnouncement",
  info: "admin.notifTypeInfo",
  important: "admin.notifTypeImportant",
  maintenance: "admin.notifTypeMaintenance",
  improvement: "admin.notifTypeImprovement",
};

/**
 * Announcement composer (platform admin only — the route re-gates).
 *
 * Idempotency: the sendKey is generated ONCE per logical send and reused
 * on retry (a lost response → same key → the unique index converges to
 * "already sent" instead of a duplicate). A fresh key is minted after a
 * successful send so the SAME text may legitimately be re-sent later.
 */
export function AnnouncementsForm() {
  const { t } = useI18n();
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [type, setType] = useState<string>("announcement");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<"sent" | "duplicate" | "failed" | null>(null);
  // The idempotency key for the CURRENT logical send (stable across retries).
  const sendKeyRef = useRef<string>(crypto.randomUUID());

  const valid =
    title.trim().length >= 3 &&
    title.trim().length <= 120 &&
    content.trim().length >= 3 &&
    content.trim().length <= 2000 &&
    (linkUrl.trim() === "" || linkUrl.trim().startsWith("https://"));

  const reset = (fresh: boolean) => {
    setTitle("");
    setContent("");
    setLinkUrl("");
    setType("announcement");
    if (fresh) sendKeyRef.current = crypto.randomUUID();
  };

  const send = async () => {
    if (busy) return;
    setBusy(true);
    setResult(null);
    try {
      const response = await fetch("/api/admin/announcements", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          content: content.trim(),
          linkUrl: linkUrl.trim(),
          type,
          sendKey: sendKeyRef.current,
        }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        duplicate?: boolean;
        error?: string;
      };
      if (response.ok) {
        setResult(data.duplicate ? "duplicate" : "sent");
        reset(true);
        setConfirming(false);
        router.refresh();
      } else {
        setResult("failed");
      }
    } catch {
      setResult("failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div>
        <label className="block text-xs font-semibold uppercase tracking-[0.08em] text-faint">
          {t("admin.titleLabel")}
        </label>
        <input
          type="text"
          value={title}
          maxLength={120}
          onChange={(e) => {
            setTitle(e.target.value);
            setResult(null);
          }}
          className="mt-1 w-full rounded-xl border border-line-strong bg-surface px-3 py-2 text-sm"
        />
      </div>
      <div className="flex flex-wrap gap-3">
        <div>
          <label className="block text-xs font-semibold uppercase tracking-[0.08em] text-faint">
            {t("admin.typeLabel")}
          </label>
          <select
            value={type}
            onChange={(e) => setType(e.target.value)}
            className="mt-1 rounded-xl border border-line-strong bg-surface px-3 py-2 text-sm"
          >
            {ANNOUNCEMENT_TYPES.map((option) => (
              <option key={option} value={option}>
                {t(TYPE_LABEL_KEYS[option])}
              </option>
            ))}
          </select>
        </div>
        <div className="min-w-56 flex-1">
          <label className="block text-xs font-semibold uppercase tracking-[0.08em] text-faint">
            {t("admin.linkLabel")}
          </label>
          <input
            type="url"
            value={linkUrl}
            maxLength={500}
            onChange={(e) => {
              setLinkUrl(e.target.value);
              setResult(null);
            }}
            placeholder={t("admin.linkPlaceholder")}
            className="mt-1 w-full rounded-xl border border-line-strong bg-surface px-3 py-2 text-sm"
          />
        </div>
      </div>
      <div>
        <label className="block text-xs font-semibold uppercase tracking-[0.08em] text-faint">
          {t("admin.messageLabel")}
        </label>
        <textarea
          value={content}
          maxLength={2000}
          rows={4}
          onChange={(e) => {
            setContent(e.target.value);
            setResult(null);
          }}
          className="mt-1 w-full rounded-xl border border-line-strong bg-surface px-3 py-2 text-sm"
        />
      </div>

      {!confirming ? (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          disabled={!valid || busy}
          className="self-start rounded-xl bg-accent px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
        >
          {t("admin.sendNotification")}
        </button>
      ) : (
        <div className="rounded-xl border border-line bg-surface-2 px-4 py-3">
          <p className="text-sm font-bold text-ink">
            {t("admin.confirmTitle")}
          </p>
          <p className="mt-1 text-sm text-muted">{t("admin.confirmAll")}</p>
          <p className="mt-2 text-sm text-ink-soft">
            <strong>{title.trim()}</strong>
            {content.trim() ? ` — ${content.trim().slice(0, 120)}${content.trim().length > 120 ? "…" : ""}` : ""}
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={send}
              disabled={busy}
              className="rounded-xl bg-accent px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
            >
              {busy ? t("admin.sending") : t("admin.send")}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={busy}
              className="rounded-xl border border-line-strong px-4 py-2 text-sm font-semibold text-ink-soft"
            >
              {t("admin.cancel")}
            </button>
          </div>
        </div>
      )}

      {result === "sent" && (
        <p className="text-sm font-semibold text-success">{t("admin.sent")}</p>
      )}
      {result === "duplicate" && (
        <p className="text-sm font-semibold text-success">
          {t("admin.duplicateSent")}
        </p>
      )}
      {result === "failed" && (
        <p className="text-sm font-semibold text-danger">
          {t("admin.sendFailed")}
        </p>
      )}
    </div>
  );
}
