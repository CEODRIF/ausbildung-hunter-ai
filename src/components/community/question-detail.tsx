"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n";
import { Icon } from "@/components/icon";
import { Button, Textarea } from "@/components/ui";
import {
  acceptAnswerAction,
  setQuestionClosedAction,
  unsolveQuestionAction,
} from "@/app/community/advanced-actions";
import { ReportDialog, type ReportTargetType } from "./report-dialog";

/**
 * Community Phase 5 — the question detail view.
 *
 * AUTHORIZATION: the page (server) decides ONCE which capabilities the
 * viewer has — `isAuthor` / `isModerator` — from the session + the
 * database. The buttons rendered here are merely affordances; EVERY action
 * re-runs its own server-side check (role re-read on every call), so a
 * stale UI or a forged click cannot escalate anything.
 *
 * REALTIME: one channel on the EXISTING realtime socket (no second system,
 * no polling, no timers). Answer inserts/updates and question state changes
 * trigger a server re-render (router.refresh) — the server stays the source
 * of truth; the client only mirrors what the server sent it.
 *
 * DEEP LINK: `#answer-{id}` scrolls + focuses that answer on mount (the
 * notification target and the search results use this exact shape).
 */

export type QuestionStatus = "open" | "solved" | "closed";

export interface AnswerView {
  id: string;
  body: string;
  accepted: boolean;
  createdAt: string;
  authorName: string | null;
  authorId: string;
}

export interface QuestionDetailProps {
  questionId: string;
  title: string;
  body: string;
  tags: string[];
  status: QuestionStatus;
  acceptedAnswerId: string | null;
  createdAt: string;
  authorName: string | null;
  authorId: string;
  room: { slug: string; name: string } | null;
  imagePath: string | null;
  answers: AnswerView[];
  me: { userId: string; displayName: string };
  /** SERVER-computed capabilities (never a client claim). */
  isAuthor: boolean;
  isModerator: boolean;
}

const ANSWER_MIN = 10;
const ANSWER_MAX = 4000;

type CommunityClient = NonNullable<Awaited<ReturnType<typeof createClient>>>;

const STATUS_KEY: Record<QuestionStatus, "community.questionStatusOpen" | "community.questionStatusSolved" | "community.questionStatusClosed"> = {
  open: "community.questionStatusOpen",
  solved: "community.questionStatusSolved",
  closed: "community.questionStatusClosed",
};

const STATUS_STYLE: Record<QuestionStatus, string> = {
  open: "bg-accent-soft text-accent",
  solved: "bg-success/10 text-success",
  closed: "bg-surface-2 text-faint",
};

export function QuestionDetail({
  questionId,
  title,
  body,
  tags,
  status: initialStatus,
  // `acceptedAnswerId` intentionally not destructured — no client mirror
  // needed (the accepted flag lives on each answer row; see below).
  createdAt,
  authorName,
  authorId,
  room,
  imagePath,
  answers: initialAnswers,
  me,
  isAuthor,
  isModerator,
}: QuestionDetailProps) {
  const { t, lang } = useI18n();
  const router = useRouter();
  const locale =
    lang === "de" ? "de-DE" : lang === "fr" ? "fr-FR" : lang === "ar" ? "ar" : "en-US";

  const [answers, setAnswers] = useState(initialAnswers);
  const [status, setStatus] = useState<QuestionStatus>(initialStatus);
  // NOTE: no local accepted-answer state — the accepted flag lives on each
  // answer row (server data) and accept/unsolve re-render via
  // router.refresh(); the `acceptedAnswerId` prop is still part of the
  // server→component contract (used by the detail loader) but needs no
  // client mirror.
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [answerError, setAnswerError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [reportTarget, setReportTarget] = useState<{ type: ReportTargetType; id: string } | null>(null);

  const knownAnswerIds = useRef<Set<string>>(new Set(answers.map((a) => a.id)));
  const toastTimer = useRef<number | null>(null);

  const flashToast = useCallback((text: string) => {
    setToast(text);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 4000);
  }, []);
  useEffect(() => () => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
  }, []);

  // The ONE question channel (existing realtime infrastructure).
  const clientRef = useRef<CommunityClient | null>(null);
  const getClient = useCallback((): CommunityClient | null => {
    if (!clientRef.current) {
      try {
        clientRef.current = createClient();
      } catch (error) {
        console.error("[community] realtime client unavailable:", error);
        return null;
      }
    }
    return clientRef.current;
  }, []);

  useEffect(() => {
    let disposed = false;
    let channel: ReturnType<CommunityClient["channel"]> | null = null;
    const client = getClient();
    if (!client) return;

    const subscribe = () => {
      if (disposed || channel) return;
      try {
        const answerFilter = `question_id=eq.${questionId}`;
        const questionFilter = `id=eq.${questionId}`;
        // Event-driven re-render: the server re-reads everything (no polling).
        const resync = () => router.refresh();
        channel = client
          .channel(`community-question:${questionId}`)
          .on(
            "postgres_changes",
            { event: "INSERT", schema: "public", table: "community_answers", filter: answerFilter },
            (payload) => {
              const id = (payload.new as { id?: string } | undefined)?.id;
              if (id && knownAnswerIds.current.has(id)) return; // our own echo
              resync();
            },
          )
          .on(
            "postgres_changes",
            { event: "UPDATE", schema: "public", table: "community_answers", filter: answerFilter },
            () => resync(),
          )
          .on(
            "postgres_changes",
            { event: "DELETE", schema: "public", table: "community_answers", filter: answerFilter },
            () => resync(),
          )
          .on(
            "postgres_changes",
            { event: "UPDATE", schema: "public", table: "community_questions", filter: questionFilter },
            () => resync(),
          )
          .subscribe();
      } catch (error) {
        console.error("[community] question realtime failed:", error);
      }
    };

    void (async () => {
      try {
        await client.auth.initialize();
      } catch (error) {
        console.error("[community] realtime init failed:", error);
      }
      if (disposed) return;
      const {
        data: { session },
      } = await client.auth.getSession();
      if (disposed) return;
      if (session?.access_token) {
        // Awaited on purpose: a token-less join streams zero RLS rows.
        await client.realtime
          .setAuth(session.access_token)
          .catch((error) => console.error("[community] realtime setAuth failed:", error));
        if (!disposed) subscribe();
      }
    })();

    const sub = client.auth.onAuthStateChange((event, session) => {
      if (session?.access_token) {
        void client.realtime
          .setAuth(session.access_token)
          .then(() => {
            if (event === "INITIAL_SESSION" || event === "SIGNED_IN") subscribe();
          })
          .catch((error) => console.error("[community] realtime setAuth failed:", error));
      } else if (event === "SIGNED_OUT") client.realtime.setAuth();
    });

    return () => {
      disposed = true;
      sub.data.subscription.unsubscribe();
      if (channel) void client.removeChannel(channel);
    };
  }, [questionId, getClient, router]);

  // Sign the question image (private bucket — same helper as the room chat).
  useEffect(() => {
    if (!imagePath) return;
    const client = getClient();
    if (!client) return;
    let cancelled = false;
    void (async () => {
      try {
        const { data } = await client.storage
          .from("community-images")
          .createSignedUrl(imagePath, 3600);
        if (data?.signedUrl && !cancelled) setImageSrc(data.signedUrl);
      } catch (error) {
        console.error("[community] question image signing failed:", error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [imagePath, getClient]);

  // Deep link: #answer-{id} → scroll + focus (keyboard accessible).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const match = window.location.hash.match(/^#answer-([0-9a-f-]{36})$/i);
    if (!match) return;
    const el = document.getElementById(`answer-${match[1]}`);
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    el.focus({ preventScroll: true });
  }, [answers]);

  const sendAnswer = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (text.length < ANSWER_MIN || text.length > ANSWER_MAX || sending) return;
    setSending(true);
    setAnswerError(null);
    try {
      const res = await fetch(`/api/community/questions/${questionId}/answers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: text }),
      });
      if (res.status === 201) {
        const data = (await res.json()) as {
          answer: { id: string; body: string; created_at: string };
        };
        const incoming: AnswerView = {
          id: data.answer.id,
          body: data.answer.body,
          accepted: false,
          createdAt: data.answer.created_at,
          authorName: me.displayName,
          authorId: me.userId,
        };
        knownAnswerIds.current.add(incoming.id);
        setAnswers((prev) => [...prev, incoming]);
        setDraft("");
        return;
      }
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      const code = data?.error ?? "";
      setAnswerError(
        code === "question_closed"
          ? t("community.answerClosed")
          : code === "suspended" || code === "muted"
            ? t("community.questionActionError")
            : t("community.answerError"),
      );
    } catch {
      setAnswerError(t("community.answerError"));
    } finally {
      setSending(false);
    }
  };

  const onAccept = async (answerId: string) => {
    const res = await acceptAnswerAction(questionId, answerId);
    if (res.ok) {
      setStatus("solved");
      router.refresh();
    } else {
      flashToast(t("community.questionActionError"));
    }
  };

  const onUnsolved = async () => {
    const res = await unsolveQuestionAction(questionId);
    if (res.ok) {
      setStatus("open");
      router.refresh();
    } else {
      flashToast(t("community.questionActionError"));
    }
  };

  const onToggleClose = async () => {
    const closed = status !== "closed";
    const res = await setQuestionClosedAction(questionId, closed);
    if (res.ok) {
      setStatus(closed ? "closed" : "open");
      router.refresh();
    } else {
      flashToast(t("community.questionActionError"));
    }
  };

  const canAccept = status === "open" && (isAuthor || isModerator);
  const canUnsolved = status === "solved" && (isAuthor || isModerator);
  const canClose = isModerator;

  return (
    <article className="mx-auto flex w-full max-w-3xl flex-col gap-5 p-4 sm:p-6">
      {/* Header */}
      <header>
        <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-faint">
          {room ? (
            <Link
              href={`/community/${room.slug}`}
              className="flex items-center gap-1 font-bold text-accent hover:underline"
            >
              <Icon name="hash" size={12} />
              {room.name}
            </Link>
          ) : null}
          <span>
            {t("community.questionAskedOn")} {new Date(createdAt).toLocaleDateString(locale)}
          </span>
          {authorName && <span>· {authorName}</span>}
        </div>
        <div className="flex items-start justify-between gap-3">
          <h1 className="text-xl font-bold leading-tight text-ink sm:text-2xl">{title}</h1>
          <span
            className={`mt-1 shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold ${STATUS_STYLE[status]}`}
          >
            {t(STATUS_KEY[status])}
          </span>
        </div>
        {tags.length > 0 && (
          <ul className="mt-2 flex flex-wrap gap-1.5" aria-label={t("community.questionTagsLabel")}>
            {tags.map((tag) => (
              <li
                key={tag}
                className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-semibold text-muted"
              >
                #{tag}
              </li>
            ))}
          </ul>
        )}
      </header>

      {/* Question body (rendered as TEXT — never HTML) */}
      <div className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4">
        <p className="whitespace-pre-line text-sm leading-6 text-ink-soft">{body}</p>
        {imageSrc && (
          // eslint-disable-next-line @next/next/no-img-element -- user-uploaded Supabase storage URL (same category as the other user-image disables)
          <img
            src={imageSrc}
            alt={t("community.imageAlt")}
            className="max-h-96 w-auto rounded-xl border border-line object-contain"
          />
        )}
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => setReportTarget({ type: "question", id: questionId })}
            disabled={authorId === me.userId}
            className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] font-bold text-faint transition-colors hover:bg-surface-2 hover:text-danger disabled:cursor-not-allowed disabled:opacity-40"
            aria-label={t("community.report")}
          >
            <Icon name="flag" size={12} />
            {t("community.report")}
          </button>
        </div>
      </div>

      {/* Moderation row (capability-driven; server re-checks everything) */}
      {(canClose || canUnsolved) && (
        <div className="flex flex-wrap gap-2">
          {canUnsolved && (
            <Button variant="secondary" size="sm" onClick={() => void onUnsolved()}>
              {t("community.unsolveCta")}
            </Button>
          )}
          {canClose &&
            (status === "closed" ? (
              <Button variant="secondary" size="sm" onClick={() => void onToggleClose()}>
                {t("community.reopenQuestion")}
              </Button>
            ) : (
              <Button variant="secondary" size="sm" onClick={() => void onToggleClose()}>
                {t("community.closeQuestion")}
              </Button>
            ))}
        </div>
      )}

      {/* Answers */}
      <section aria-labelledby="answers-title" className="flex flex-col gap-3">
        <h2 id="answers-title" className="text-sm font-bold text-ink">
          {answers.length === 1
            ? t("community.questionOneAnswer")
            : t("community.questionAnswers", { count: answers.length })}
        </h2>
        {answers.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-line bg-surface/60 p-6 text-center text-sm text-muted">
            {t("community.noAnswers")}
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {answers.map((answer) => (
              <li
                key={answer.id}
                id={`answer-${answer.id}`}
                tabIndex={-1}
                className={`flex flex-col gap-2 rounded-2xl border p-4 outline-none focus:ring-2 focus:ring-accent/40 ${
                  answer.accepted ? "border-success/50 bg-success/5" : "border-line bg-surface"
                }`}
              >
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-bold text-ink">
                    {answer.authorName ?? t("community.questionAnswers")}
                  </span>
                  <span className="text-faint">
                    {new Date(answer.createdAt).toLocaleString(locale)}
                  </span>
                  {answer.accepted && (
                    <span className="flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 font-bold text-success">
                      <Icon name="check" size={12} />
                      {t("community.acceptedAnswerNote")}
                    </span>
                  )}
                </div>
                <p className="whitespace-pre-line text-sm leading-6 text-ink-soft">{answer.body}</p>
                <div className="flex justify-end gap-2">
                  {canAccept && !answer.accepted && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => void onAccept(answer.id)}
                      aria-label={t("community.acceptAnswer")}
                    >
                      <Icon name="check" size={14} />
                      {t("community.acceptAnswer")}
                    </Button>
                  )}
                  <button
                    type="button"
                    onClick={() => setReportTarget({ type: "answer", id: answer.id })}
                    disabled={answer.authorId === me.userId}
                    className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] font-bold text-faint transition-colors hover:bg-surface-2 hover:text-danger disabled:cursor-not-allowed disabled:opacity-40"
                    aria-label={t("community.report")}
                  >
                    <Icon name="flag" size={12} />
                    {t("community.report")}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Answer composer (hidden once the question is closed) */}
      {status !== "closed" ? (
        <form
          onSubmit={(e) => void sendAnswer(e)}
          className="flex flex-col gap-2 rounded-2xl border border-line bg-surface p-4"
        >
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t("community.answerPlaceholder")}
            maxLength={ANSWER_MAX}
            rows={3}
            aria-label={t("community.answerPlaceholder")}
            error={
              draft.length > 0 &&
              (draft.trim().length < ANSWER_MIN || draft.trim().length > ANSWER_MAX)
                ? t("community.answerError")
                : undefined
            }
          />
          {answerError && (
            <p role="alert" className="text-xs font-semibold text-danger">
              {answerError}
            </p>
          )}
          <div className="flex justify-end">
            <Button
              type="submit"
              disabled={sending || draft.trim().length < ANSWER_MIN}
              size="sm"
            >
              <Icon name="send" size={14} />
              {sending ? t("community.answerSending") : t("community.answerSend")}
            </Button>
          </div>
        </form>
      ) : (
        <p className="rounded-2xl border border-line bg-surface-2/60 p-4 text-center text-sm font-semibold text-muted">
          {t("community.answerClosed")}
        </p>
      )}

      {/* Action feedback (transient, aria-live) */}
      {toast && (
        <p
          role="status"
          aria-live="polite"
          className="rounded-xl bg-danger-soft/60 px-3 py-2 text-center text-xs font-semibold text-danger"
        >
          {toast}
        </p>
      )}

      <ReportDialog
        open={reportTarget !== null}
        target={reportTarget ?? { type: "question", id: questionId }}
        onClose={() => setReportTarget(null)}
      />
    </article>
  );
}
