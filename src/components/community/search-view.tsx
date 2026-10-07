"use client";

import { useCallback, useRef, useState } from "react";
import Link from "next/link";
import { Icon, type IconName } from "@/components/icon";
import { useI18n } from "@/lib/i18n";
import { Button, LoadingState } from "@/components/ui";
import { EmptyState, ErrorState } from "@/components/ui/feedback";
import { AdminBadge } from "./admin-badge";

/**
 * Community Phase 5 — the global search UI (client island inside the shell).
 *
 * Architecture contract:
 *   * the FIRST page is rendered by the server (the page runs ONE search),
 *   * every filter change / "Load more" is a USER-INITIATED fetch against
 *     GET /api/community/search (session-authenticated, rate-limited) —
 *     no polling, no setInterval, no timers of any kind,
 *   * pagination is KEYSET (before_at + before_id cursor returned by the
 *     server) — there is no offset anywhere in this view,
 *   * the search itself runs in Postgres (`community_search`): direct
 *     messages are NOT part of the result set by construction.
 */

/** Structural mirror of the server's SearchResultItem (this file must stay
 *  import-safe for the client — no server-only module references). */
export interface SearchViewItem {
  kind: "message" | "question" | "answer" | "user" | "room";
  id: string;
  roomId: string | null;
  roomSlug: string | null;
  roomName: string | null;
  authorId: string | null;
  authorName: string | null;
  /** Phase 10: server-trusted platform-admin flag of the author (badge). */
  authorIsAdmin?: boolean;
  content: string;
  createdAt: string;
  questionId: string | null;
}

export interface SearchRoomOption {
  id: string;
  slug: string;
  name: string;
}

type SearchTab = "all" | "message" | "question" | "answer";
type SearchDate = "all" | "week" | "month" | "year";

export interface SearchViewProps {
  rooms: SearchRoomOption[];
  initialQuery: string;
  initialKind: SearchTab;
  initialRoomSlug: string;
  initialDate: SearchDate;
  initialItems: SearchViewItem[];
  initialCursor: { createdAt: string; id: string } | null;
  unavailable: boolean;
}

const KIND_ICON: Record<SearchViewItem["kind"], IconName> = {
  message: "message",
  question: "help",
  answer: "reply",
  user: "user",
  room: "hash",
};

/** Where a result row deep-links (null = no link target exists). */
function itemHref(item: SearchViewItem): string | null {
  switch (item.kind) {
    case "message":
      return item.roomSlug ? `/community/${item.roomSlug}?message=${item.id}` : null;
    case "question":
      return item.questionId ? `/community/questions/${item.questionId}` : null;
    case "answer":
      return item.questionId ? `/community/questions/${item.questionId}#answer-${item.id}` : null;
    case "room":
      return item.roomSlug ? `/community/${item.roomSlug}` : null;
    case "user":
      // Profile pages land in a later phase — the row is informational.
      return null;
  }
}

function buildUrl(params: {
  q: string;
  kind: SearchTab;
  roomSlug: string;
  date: SearchDate;
  cursor: { createdAt: string; id: string } | null;
}): string {
  const url = new URL("/api/community/search", window.location.origin);
  url.searchParams.set("q", params.q);
  if (params.kind !== "all") url.searchParams.set("kind", params.kind);
  if (params.roomSlug) url.searchParams.set("room", params.roomSlug);
  if (params.date !== "all") url.searchParams.set("date", params.date);
  if (params.cursor) {
    url.searchParams.set("before_at", params.cursor.createdAt);
    url.searchParams.set("before_id", params.cursor.id);
  }
  return url.toString();
}

export function SearchView({
  rooms,
  initialQuery,
  initialKind,
  initialRoomSlug,
  initialDate,
  initialItems,
  initialCursor,
  unavailable,
}: SearchViewProps) {
  const { t, lang } = useI18n();
  const locale =
    lang === "de" ? "de-DE" : lang === "fr" ? "fr-FR" : lang === "ar" ? "ar" : "en-US";
  const [query, setQuery] = useState(initialQuery);
  const [kind, setKind] = useState<SearchTab>(initialKind);
  const [roomSlug, setRoomSlug] = useState(initialRoomSlug);
  const [date, setDate] = useState<SearchDate>(initialDate);
  const [items, setItems] = useState<SearchViewItem[]>(initialItems);
  const [cursor, setCursor] = useState<{ createdAt: string; id: string } | null>(initialCursor);
  const [hasSearched, setHasSearched] = useState(initialQuery.trim().length >= 2);
  const [searching, setSearching] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  const requestSeq = useRef(0);

  const runSearch = useCallback(
    async (next: { q: string; kind: SearchTab; roomSlug: string; date: SearchDate }, append = false) => {
      const seq = ++requestSeq.current;
      if (append) setLoadingMore(true);
      else setSearching(true);
      setError(false);
      try {
        const res = await fetch(
          buildUrl({ ...next, cursor: append ? cursor : null }),
          { cache: "no-store" },
        );
        if (seq !== requestSeq.current) return; // a newer request won
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as {
          items: SearchViewItem[];
          cursor: { createdAt: string; id: string } | null;
          more: boolean;
        };
        setItems((prev) => (append ? [...prev, ...data.items] : data.items));
        setCursor(data.cursor);
        setHasSearched(true);
      } catch {
        if (seq !== requestSeq.current) return;
        setError(true);
        if (!append) setItems([]);
      } finally {
        if (seq === requestSeq.current) {
          setSearching(false);
          setLoadingMore(false);
        }
      }
    },
    [cursor],
  );

  const submit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (query.trim().length < 2) return;
      void runSearch({ q: query.trim(), kind, roomSlug, date });
    },
    [query, kind, roomSlug, date, runSearch],
  );

  // Changing a FILTER keeps the current query (the required behavior).
  const onKind = (k: SearchTab) => {
    setKind(k);
    if (query.trim().length >= 2) void runSearch({ q: query.trim(), kind: k, roomSlug, date });
  };
  const onRoom = (slug: string) => {
    setRoomSlug(slug);
    if (query.trim().length >= 2) void runSearch({ q: query.trim(), kind, roomSlug: slug, date });
  };
  const onDate = (d: SearchDate) => {
    setDate(d);
    if (query.trim().length >= 2) void runSearch({ q: query.trim(), kind, roomSlug, date: d });
  };

  const tabs: Array<{ id: SearchTab; label: string }> = [
    { id: "all", label: t("community.searchKindAll") },
    { id: "message", label: t("community.searchKindMessage") },
    { id: "question", label: t("community.searchKindQuestion") },
    { id: "answer", label: t("community.searchKindAnswer") },
  ];

  const kindLabel: Record<SearchViewItem["kind"], string> = {
    message: t("community.searchKindMessage"),
    question: t("community.searchKindQuestion"),
    answer: t("community.searchKindAnswer"),
    user: t("community.searchKindUser"),
    room: t("community.searchKindRoom"),
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 p-4 sm:p-6">
      <header>
        <h1 className="text-lg font-bold text-ink sm:text-xl">{t("community.searchTitle")}</h1>
        <p className="mt-0.5 text-sm text-muted">{t("community.searchHint")}</p>
      </header>

      {/* Search form — the query is preserved across filter changes */}
      <form onSubmit={submit} className="flex flex-col gap-3" role="search">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Icon
              name="search"
              size={16}
              className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint"
            />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("community.searchPlaceholder")}
              aria-label={t("community.searchTitle")}
              className="w-full rounded-2xl border border-line bg-surface py-2.5 pr-3 ps-9 text-sm text-ink placeholder:text-faint focus:border-accent focus:ring-2 focus:ring-accent/20 focus:outline-none"
            />
          </div>
          <Button type="submit" disabled={searching || query.trim().length < 2}>
            {searching ? t("community.searching") : t("community.searchSubmit")}
          </Button>
        </div>

        {/* Kind tabs */}
        <div className="flex flex-wrap gap-1.5" role="tablist" aria-label={t("community.searchTitle")}>
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={kind === tab.id}
              onClick={() => onKind(tab.id)}
              className={`rounded-full px-3 py-1.5 text-xs font-bold transition-colors ${
                kind === tab.id
                  ? "bg-accent-soft text-accent"
                  : "bg-surface text-muted hover:bg-surface-2 hover:text-ink"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Filters: room + date (preserving the query) */}
        <div className="flex flex-wrap gap-2">
          <label className="flex items-center gap-2 text-xs font-semibold text-muted">
            {t("community.searchFilterRoom")}
            <select
              value={roomSlug}
              onChange={(e) => onRoom(e.target.value)}
              className="rounded-xl border border-line bg-surface px-2.5 py-1.5 text-xs font-semibold text-ink focus:border-accent focus:outline-none"
            >
              <option value="">{t("community.searchFilterAllRooms")}</option>
              {rooms.map((room) => (
                <option key={room.id} value={room.slug}>
                  #{room.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-xs font-semibold text-muted">
            {t("community.searchFilterDate")}
            <select
              value={date}
              onChange={(e) => onDate(e.target.value as SearchDate)}
              className="rounded-xl border border-line bg-surface px-2.5 py-1.5 text-xs font-semibold text-ink focus:border-accent focus:outline-none"
            >
              <option value="all">{t("community.searchDateAll")}</option>
              <option value="week">{t("community.searchDateWeek")}</option>
              <option value="month">{t("community.searchDateMonth")}</option>
              <option value="year">{t("community.searchDateYear")}</option>
            </select>
          </label>
          {(roomSlug || date !== "all") && (
            <button
              type="button"
              onClick={() => {
                const q = query.trim();
                setRoomSlug("");
                setDate("all");
                if (q.length >= 2) void runSearch({ q, kind, roomSlug: "", date: "all" });
              }}
              className="text-xs font-bold text-accent hover:underline"
            >
              {t("community.searchClearFilters")}
            </button>
          )}
        </div>
      </form>

      {/* Results */}
      {unavailable && <ErrorState title={t("community.searchError")} />}
      {!unavailable && searching && <LoadingState label={t("community.searching")} />}
      {!unavailable && !searching && error && (
        <ErrorState
          title={t("community.searchError")}
          onRetry={() => void runSearch({ q: query.trim(), kind, roomSlug, date })}
          retryLabel={t("community.retry")}
        />
      )}
      {!unavailable &&
        !searching &&
        !error &&
        hasSearched &&
        (items.length === 0 ? (
          <EmptyState title={t("community.searchEmpty")} body={t("community.searchHint")} />
        ) : (
          <>
            <p className="text-xs font-semibold text-faint" aria-live="polite">
              {t("community.searchResultsFor", { query: query.trim() })} · {items.length}
            </p>
            <ul className="flex flex-col gap-2">
              {items.map((item) => {
                const href = itemHref(item);
                const inner = (
                  <>
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
                      <Icon name={KIND_ICON[item.kind]} size={16} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-baseline gap-x-1.5 text-[13px]">
                        <span className="rounded-full bg-surface-2 px-1.5 py-px text-[10px] font-bold text-muted">
                          {kindLabel[item.kind]}
                        </span>
                        {item.roomName && (
                          <span className="text-[11px] font-semibold text-accent">#{item.roomName}</span>
                        )}
                        {item.authorName && (
                          <span className="flex items-center gap-1 text-[11px] text-faint">
                            {item.authorName}
                            {item.authorIsAdmin === true && (
                              <AdminBadge size={11} label={t("community.adminBadge")} />
                            )}
                          </span>
                        )}
                        <span className="text-[10px] text-faint">
                          {new Date(item.createdAt).toLocaleString(locale)}
                        </span>
                      </span>
                      <span className="mt-0.5 block truncate text-sm text-ink">
                        {item.kind === "user"
                          ? `@${item.content || (item.authorName ?? "")}`
                          : item.content}
                      </span>
                    </span>
                    <Icon name="chevronRight" size={14} className="shrink-0 text-faint rtl:-scale-x-100" />
                  </>
                );
                return (
                  <li key={`${item.kind}-${item.id}`}>
                    {href ? (
                      <Link
                        href={href}
                        className="flex items-center gap-3 rounded-2xl border border-line bg-surface p-3 transition-colors hover:border-accent/50 hover:bg-accent-soft/30"
                      >
                        {inner}
                      </Link>
                    ) : (
                      <div className="flex items-center gap-3 rounded-2xl border border-line bg-surface p-3">
                        {inner}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
            <div className="flex justify-center">
              <Button
                type="button"
                variant="secondary"
                disabled={loadingMore || !cursor}
                onClick={() => void runSearch({ q: query.trim(), kind, roomSlug, date }, true)}
              >
                {cursor
                  ? loadingMore
                    ? t("community.searching")
                    : t("community.searchLoadMore")
                  : t("community.searchNoMore")}
              </Button>
            </div>
          </>
        ))}
    </div>
  );
}
