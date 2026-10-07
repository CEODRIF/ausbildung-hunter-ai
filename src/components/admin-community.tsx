"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n";
import { localeForLang } from "@/lib/i18n/core";

/**
 * Admin → Community moderation (platform admin only; the pages + routes
 * re-gate server-side). URL-driven state (?q= search, ?user= detail) so
 * every view is a normal server render — the client only performs the
 * privileged POSTs and refreshes.
 */

interface UserRow {
  userId: string;
  email: string | null;
  fullName: string | null;
  communityDisplayName: string | null;
  communityJoinedAt: string | null;
  communityRole: string;
  suspended: boolean;
  mutedUntil: string | null;
  banned: boolean;
  banReason: string | null;
  banExpiresAt: string | null;
  isPlatformAdmin: boolean;
}

interface MessageRow {
  messageId: string;
  roomSlug: string | null;
  text: string | null;
  hasImage: boolean;
  hiddenBy: string | null;
  createdAt: string;
}

const DURATION_KEYS = ["", "24h", "7d", "30d"] as const;

export function AdminCommunityClient(props: {
  mode: "search" | "results" | "detail";
  initialQuery: string;
  results?: UserRow[];
  searchFailed?: boolean;
  userDetail?: UserRow | null;
  messages?: MessageRow[];
  messagesUnavailable?: boolean;
}) {
  const { t, lang } = useI18n();
  const router = useRouter();
  const locale = localeForLang(lang);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [confirmBan, setConfirmBan] = useState(false);
  const [banReason, setBanReason] = useState("");
  const [banDuration, setBanDuration] = useState<string>("");
  const [confirmUnban, setConfirmUnban] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<MessageRow | null>(null);

  const fmt = (iso: string | null) =>
    iso ? new Date(iso).toLocaleString(locale) : null;

  const post = async (url: string, body: unknown, key: string) => {
    setBusy(key);
    setResult(null);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await response.json().catch(() => ({}))) as {
        alreadyHidden?: boolean;
        error?: string;
      };
      if (!response.ok) {
        const map: Record<string, string> = {
          already_banned: t("admin.alreadyBanned"),
          not_banned: t("admin.notBanned"),
          self_ban: t("admin.selfBanBlocked"),
          admin_protected: t("admin.adminProtected"),
          not_found: t("admin.userNotFoundBan"),
          invalid: t("admin.banFailed"),
          failed: t("admin.banFailed"),
        };
        setResult({
          kind: "error",
          text: map[data.error ?? ""] ?? t("admin.actionFailed", { error: data.error ?? String(response.status) }),
        });
        return;
      }
      if (key === "delete") {
        setResult({
          kind: "ok",
          text: data.alreadyHidden ? t("admin.messageAlreadyHidden") : t("admin.messageDeleted"),
        });
      } else if (key === "ban") {
        setResult({
          kind: "ok",
          text: banDuration ? t("admin.banDone") : t("admin.banDone"),
        });
      } else {
        setResult({ kind: "ok", text: t("admin.unbanDone") });
      }
      setConfirmBan(false);
      setConfirmUnban(false);
      setDeleteTarget(null);
      setBanReason("");
      setBanDuration("");
      router.refresh();
    } catch {
      setResult({ kind: "error", text: t("admin.networkError") });
    } finally {
      setBusy(null);
    }
  };

  // ---- Search mode --------------------------------------------------------
  if (props.mode === "search" || props.mode === "results") {
    return (
      <div className="mt-6">
        <form
          action="/admin/community"
          method="GET"
          className="flex flex-wrap items-center gap-2"
        >
          <input
            type="search"
            name="q"
            defaultValue={props.initialQuery}
            placeholder={t("admin.searchPlaceholder")}
            aria-label={t("admin.searchPlaceholder")}
            className="w-full max-w-sm rounded-xl border border-line-strong bg-surface px-3 py-2 text-sm"
          />
          <button
            type="submit"
            className="rounded-xl bg-accent px-4 py-2 text-sm font-bold text-white"
          >
            {t("admin.searchBtn")}
          </button>
        </form>

        {props.mode === "results" && (
          <div className="mt-4">
            {props.searchFailed ? (
              <p className="rounded-xl bg-surface-2 px-4 py-3 text-sm text-muted">
                {t("admin.searchFailed")}
              </p>
            ) : (props.results ?? []).length === 0 ? (
              <p className="rounded-xl bg-surface-2 px-4 py-3 text-sm text-muted">
                {t("admin.noResults")}
              </p>
            ) : (
              <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
                {(props.results ?? []).map((u) => (
                  <li key={u.userId} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-bold text-ink">
                        {u.communityDisplayName ?? u.fullName ?? u.email ?? u.userId}
                        {u.isPlatformAdmin && (
                          <span className="ms-2 rounded-md bg-danger px-1.5 py-0.5 text-[10px] font-bold text-white">
                            {t("community.adminBadge")}
                          </span>
                        )}
                      </span>
                      <span className="block truncate text-xs text-muted">
                        {u.email ?? "—"}
                        {u.communityDisplayName ? ` · ${u.communityDisplayName}` : ""}
                      </span>
                    </span>
                    {u.banned && (
                      <span className="rounded-md bg-danger-soft px-1.5 py-0.5 text-[10px] font-bold text-danger">
                        {t("admin.statusBanned")}
                      </span>
                    )}
                    {u.suspended && (
                      <span className="rounded-md bg-warning-soft px-1.5 py-0.5 text-[10px] font-bold text-warning">
                        {t("admin.statusSuspended")}
                      </span>
                    )}
                    <a
                      href={`/admin/community?user=${u.userId}`}
                      className="rounded-xl border border-line-strong px-3 py-1.5 text-xs font-semibold text-ink-soft hover:bg-surface-2"
                    >
                      {t("admin.fieldCommunityName")} →
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    );
  }

  // ---- Detail mode --------------------------------------------------------
  const u = props.userDetail;
  if (!u) {
    return (
      <div className="mt-6">
        <p className="rounded-xl bg-surface-2 px-4 py-3 text-sm text-muted">
          {t("admin.notFound")}
        </p>
        <a
          href="/admin/community"
          className="mt-3 inline-block text-sm font-semibold text-accent"
        >
          ← {t("admin.backToList")}
        </a>
      </div>
    );
  }

  const banUrl = `/api/admin/community/users/${u.userId}/ban`;
  const displayName = u.communityDisplayName ?? u.fullName ?? u.email ?? u.userId;
  const statusLine = u.banned
    ? t("admin.statusBanned")
    : u.suspended
      ? t("admin.statusSuspended")
      : u.mutedUntil
        ? t("admin.statusMuted", { date: fmt(u.mutedUntil) ?? "" })
        : t("admin.statusActive");

  return (
    <div className="mt-6">
      <a
        href={props.initialQuery ? `/admin/community?q=${encodeURIComponent(props.initialQuery)}` : "/admin/community"}
        className="text-sm font-semibold text-accent"
      >
        ← {t("admin.backToList")}
      </a>

      <div className="mt-4 rounded-xl border border-line bg-surface px-5 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-bold text-ink">
            {displayName}
            {u.isPlatformAdmin && (
              <span className="ms-2 rounded-md bg-danger px-1.5 py-0.5 text-[10px] font-bold text-white align-middle">
                {t("community.adminBadge")}
              </span>
            )}
          </h2>
          <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-bold text-accent">
            {statusLine}
          </span>
        </div>
        <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          <div className="flex gap-2">
            <dt className="text-muted">{t("admin.fieldEmail")}:</dt>
            <dd className="min-w-0 truncate text-ink-soft">{u.email ?? "—"}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-muted">{t("admin.fieldFullName")}:</dt>
            <dd className="min-w-0 truncate text-ink-soft">{u.fullName ?? "—"}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-muted">{t("admin.fieldCommunityName")}:</dt>
            <dd className="min-w-0 truncate text-ink-soft">
              {u.communityDisplayName ?? t("admin.noCommunityProfile")}
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-muted">{t("admin.fieldRole")}:</dt>
            <dd className="text-ink-soft">{u.communityRole}</dd>
          </div>
          {u.communityJoinedAt && (
            <div className="flex gap-2">
              <dt className="text-muted">{t("admin.fieldMemberSince")}:</dt>
              <dd className="text-ink-soft">{fmt(u.communityJoinedAt)}</dd>
            </div>
          )}
        </dl>

        {u.banned && (
          <div className="mt-3 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
            <p className="font-bold">{t("admin.bannedLabel")}</p>
            <p>
              {u.banExpiresAt
                ? t("admin.bannedUntil", { date: fmt(u.banExpiresAt) ?? "" })
                : t("admin.permanent")}
            </p>
            {u.banReason && (
              <p className="mt-1">{t("admin.banReasonShown", { reason: u.banReason })}</p>
            )}
          </div>
        )}

        {!u.isPlatformAdmin && (
          <div className="mt-4">
            {!u.banned ? (
              <>
                <button
                  type="button"
                  onClick={() => setConfirmBan(true)}
                  disabled={busy !== null}
                  className="rounded-xl bg-danger px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
                >
                  {t("admin.banAction")}
                </button>
                {confirmBan && (
                  <div className="mt-3 rounded-xl border border-line bg-surface-2 px-4 py-3">
                    <p className="text-sm font-bold text-ink">
                      {t("admin.banConfirmTitle")}
                    </p>
                    <p className="mt-1 text-sm text-muted">
                      {t("admin.banConfirmBody", { name: displayName })}
                    </p>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <select
                        value={banDuration}
                        onChange={(e) => setBanDuration(e.target.value)}
                        aria-label={t("admin.banDurationLabel")}
                        className="rounded-xl border border-line-strong bg-surface px-3 py-2 text-sm"
                      >
                        {DURATION_KEYS.map((d) => (
                          <option key={d || "permanent"} value={d}>
                            {d ? t(`admin.duration${d}`) : t("admin.durationPermanent")}
                          </option>
                        ))}
                      </select>
                      <input
                        type="text"
                        value={banReason}
                        maxLength={500}
                        onChange={(e) => setBanReason(e.target.value)}
                        placeholder={t("admin.banReasonPlaceholder")}
                        aria-label={t("admin.banReasonLabel")}
                        className="w-56 rounded-xl border border-line-strong bg-surface px-3 py-2 text-sm"
                      />
                      <button
                        type="button"
                        onClick={() =>
                          post(banUrl, { ban: true, reason: banReason, durationKey: banDuration || null }, "ban")
                        }
                        disabled={busy !== null}
                        className="rounded-xl bg-danger px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
                      >
                        {busy === "ban" ? t("admin.sending") : t("admin.send")}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmBan(false)}
                        disabled={busy !== null}
                        className="rounded-xl border border-line-strong px-4 py-2 text-sm font-semibold text-ink-soft"
                      >
                        {t("admin.cancel")}
                      </button>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => setConfirmUnban(true)}
                  disabled={busy !== null}
                  className="rounded-xl bg-success px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
                >
                  {t("admin.unbanAction")}
                </button>
                {confirmUnban && (
                  <div className="mt-3 flex items-center gap-2 rounded-xl border border-line bg-surface-2 px-4 py-3">
                    <p className="text-sm font-bold text-ink">{t("admin.unbanAction")}?</p>
                    <button
                      type="button"
                      onClick={() => post(banUrl, { ban: false }, "unban")}
                      disabled={busy !== null}
                      className="rounded-xl bg-success px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
                    >
                      {busy === "unban" ? t("admin.sending") : t("admin.send")}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmUnban(false)}
                      disabled={busy !== null}
                      className="rounded-xl border border-line-strong px-4 py-2 text-sm font-semibold text-ink-soft"
                    >
                      {t("admin.cancel")}
                    </button>
                  </div>
                )}
              </>
            )}
            {result && (
              <p
                className={`mt-2 text-sm font-semibold ${
                  result.kind === "ok" ? "text-success" : "text-danger"
                }`}
              >
                {result.text}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Messages */}
      <div className="mt-6 overflow-hidden rounded-xl border border-line bg-surface">
        <div className="border-b border-line px-5 py-4">
          <h3 className="text-base font-bold text-ink">{t("admin.messagesTitle")}</h3>
        </div>
        {props.messagesUnavailable ? (
          <p className="px-6 py-8 text-center text-sm text-muted">
            {t("admin.messagesFailed")}
          </p>
        ) : (props.messages ?? []).length === 0 ? (
          <p className="px-6 py-8 text-center text-sm text-muted">
            {t("admin.noMessages")}
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {(props.messages ?? []).map((m) => (
              <li key={m.messageId} className="flex items-start gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <p
                    className={`truncate text-sm ${
                      m.hiddenBy ? "text-faint line-through" : "text-ink-soft"
                    }`}
                  >
                    {m.text ?? (m.hasImage ? "🖼" : "—")}
                  </p>
                  <p className="mt-0.5 text-xs text-faint">
                    {m.roomSlug ?? ""} · {fmt(m.createdAt)}
                    {m.hiddenBy && ` · ${t("admin.hiddenLabel")}`}
                  </p>
                </div>
                {!m.hiddenBy && (
                  <button
                    type="button"
                    onClick={() => setDeleteTarget(m)}
                    disabled={busy !== null}
                    className="shrink-0 rounded-xl border border-line-strong px-3 py-1.5 text-xs font-semibold text-danger hover:bg-danger-soft disabled:opacity-50"
                  >
                    {t("admin.deleteAction")}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {deleteTarget && (
        <div className="mt-4 rounded-xl border border-line bg-surface-2 px-4 py-3">
          <p className="text-sm font-bold text-ink">{t("admin.deleteConfirmTitle")}</p>
          <p className="mt-1 text-sm text-muted">{t("admin.deleteConfirmBody")}</p>
          <p className="mt-1 truncate text-xs text-faint">
            “{deleteTarget.text?.slice(0, 120) ?? "🖼"}”
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() =>
                post(`/api/admin/community/messages/${deleteTarget.messageId}`, { reason: "" }, "delete")
              }
              disabled={busy !== null}
              className="rounded-xl bg-danger px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
            >
              {busy === "delete" ? t("admin.sending") : t("admin.deleteAction")}
            </button>
            <button
              type="button"
              onClick={() => setDeleteTarget(null)}
              disabled={busy !== null}
              className="rounded-xl border border-line-strong px-4 py-2 text-sm font-semibold text-ink-soft"
            >
              {t("admin.cancel")}
            </button>
          </div>
          {result && busy === null && (
            <p
              className={`mt-2 text-sm font-semibold ${
                result.kind === "ok" ? "text-success" : "text-danger"
              }`}
            >
              {result.text}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
