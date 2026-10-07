"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icon";
import { useI18n } from "@/lib/i18n";
import { Button, Input, Textarea } from "@/components/ui";

/**
 * Community Phase 5 — the "new question" form.
 *
 * The form mirrors the server's validation (same limits) for FAST feedback,
 * but the SERVER is authoritative: POST /api/community/questions re-checks
 * session auth, the write gate, the room (exists + enabled + qna_enabled),
 * every field, and the image bytes before the RLS insert policy applies.
 * The client NEVER sends its own user id.
 */

export interface QuestionCreateRoomOption {
  id: string;
  slug: string;
  name: string;
}

const TITLE_MIN = 10;
const TITLE_MAX = 120;
const BODY_MIN = 30;
const BODY_MAX = 4000;
const MAX_TAGS = 5;
const TAG_MAX = 24;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // 2 MB — the storage limit
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

interface QuestionCreateProps {
  rooms: QuestionCreateRoomOption[];
  defaultRoomSlug: string;
}

export function QuestionCreate({ rooms, defaultRoomSlug }: QuestionCreateProps) {
  const { t } = useI18n();
  const router = useRouter();
  const [roomSlug, setRoomSlug] = useState(
    rooms.some((r) => r.slug === defaultRoomSlug) ? defaultRoomSlug : rooms[0]?.slug ?? "",
  );
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [tags, setTags] = useState("");
  const [image, setImage] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const validate = (): boolean => {
    const tt = title.trim();
    const bb = body.trim();
    if (tt.length < TITLE_MIN || tt.length > TITLE_MAX) {
      setError(t("community.questionCreateInvalid"));
      return false;
    }
    if (bb.length < BODY_MIN || bb.length > BODY_MAX) {
      setError(t("community.questionCreateInvalid"));
      return false;
    }
    const parsed = tags
      .split(",")
      .map((x) => x.trim().toLowerCase().replace(/\s+/g, "-"))
      .filter((x) => x.length > 0);
    if (parsed.length > MAX_TAGS || parsed.some((x) => x.length < 1 || x.length > TAG_MAX)) {
      setError(t("community.questionCreateInvalid"));
      return false;
    }
    if (image && (image.size > MAX_IMAGE_BYTES || !IMAGE_TYPES.has(image.type))) {
      setError(t("community.questionCreateInvalid"));
      return false;
    }
    return true;
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    if (!validate()) return;
    setSubmitting(true);
    try {
      const form = new FormData();
      form.set("room", roomSlug);
      form.set("title", title.trim());
      form.set("body", body.trim());
      form.set("tags", tags.trim());
      if (image) form.set("image", image);
      const res = await fetch("/api/community/questions", {
        method: "POST",
        body: form,
      });
      if (res.status === 201) {
        const data = (await res.json()) as { question: { id: string } };
        router.push(`/community/questions/${data.question.id}`);
        router.refresh();
        return; // the navigation takes over — no double state
      }
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      const code = data?.error ?? "question_failed";
      setError(
        code === "qna_disabled"
          ? t("community.questionQnaDisabled")
          : code === "suspended" || code === "muted"
            ? t("community.questionActionError")
            : t("community.questionCreateError"),
      );
    } catch {
      setError(t("community.questionCreateError"));
    } finally {
      // Harmless if the navigation already unmounted the form.
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 p-4 sm:p-6">
      <header>
        <h1 className="text-lg font-bold text-ink sm:text-xl">{t("community.newQuestionTitle")}</h1>
        <p className="mt-0.5 text-sm text-muted">{t("community.newQuestionSubtitle")}</p>
      </header>

      {rooms.length === 0 ? (
        <p className="rounded-2xl border border-line bg-surface p-4 text-sm text-muted">
          {t("community.questionsEmpty")}
        </p>
      ) : (
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4" noValidate>
          {/* Room — only Q&A-enabled rooms reach this list (server-side). */}
          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-muted">
              {t("community.searchFilterRoom")}
            </span>
            <select
              value={roomSlug}
              onChange={(e) => setRoomSlug(e.target.value)}
              required
              className="w-full rounded-2xl border border-line bg-surface px-3 py-2.5 text-sm text-ink focus:border-accent focus:outline-none"
            >
              {rooms.map((room) => (
                <option key={room.id} value={room.slug}>
                  #{room.name}
                </option>
              ))}
            </select>
          </label>

          <Input
            label={t("community.questionTitleLabel")}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t("community.questionTitlePlaceholder")}
            maxLength={TITLE_MAX}
            required
            minLength={TITLE_MIN}
            error={
              title.length > 0 && (title.trim().length < TITLE_MIN || title.trim().length > TITLE_MAX)
                ? t("community.questionCreateInvalid")
                : undefined
            }
          />

          <Textarea
            label={t("community.questionBodyLabel")}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={t("community.questionBodyPlaceholder")}
            hint={t("community.questionBodyMinHint")}
            maxLength={BODY_MAX}
            rows={7}
            required
          />

          <Input
            label={t("community.questionTagsLabel")}
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder={t("community.questionTagsPlaceholder")}
            maxLength={160}
          />

          {/* Optional image — client check mirrors the server's byte check. */}
          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-muted">
              {t("community.questionImageLabel")}
            </span>
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={(e) => {
                const file = e.target.files?.[0] ?? null;
                setImage(file);
                if (file && (file.size > MAX_IMAGE_BYTES || !IMAGE_TYPES.has(file.type))) {
                  setError(t("community.questionCreateInvalid"));
                }
              }}
              className="block w-full text-sm text-muted file:mr-3 file:rounded-xl file:border-0 file:bg-accent-soft file:px-3 file:py-2 file:text-xs file:font-bold file:text-accent hover:file:bg-accent-soft/70"
            />
          </label>

          {error && (
            <p role="alert" className="rounded-xl bg-danger-soft/60 px-3 py-2 text-xs font-semibold text-danger">
              {error}
            </p>
          )}

          <Button type="submit" disabled={submitting} size="lg" className="w-full sm:w-auto">
            <Icon name="send" size={16} />
            {submitting ? t("community.questionCreating") : t("community.questionCreateCta")}
          </Button>
        </form>
      )}
    </div>
  );
}
