"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Card } from "@/components/ui";
import { Icon } from "@/components/icon";
import { useI18n } from "@/lib/i18n";
import {
  COMMUNITY_AVATAR_IDS,
  communityAvatarUrl,
} from "@/lib/community";
import {
  completeOnboarding,
  generateCommunityUsernameAction,
} from "@/app/community/actions";

/**
 * First-visit "Choose your Community identity" screen.
 *
 *  - The username is GENERATED (adjective + creature, e.g. "BlueFalcon"):
 *    never a real first name, never free-form at this step. The server
 *    verifies uniqueness (case-insensitive unique index); on a race the
 *    flow regenerates.
 *  - "[Generate another]" rerolls. The identity is PERSISTED on join and
 *    only regenerated explicitly — never on every page load.
 *  - Exactly four built-in avatars (two feminine, two masculine) — an id is
 *    stored, never image data; no runtime image generation.
 *
 * Everything is re-validated server-side (schema + RLS + unique index) in
 * the action.
 */
export function CommunityOnboarding() {
  const { t } = useI18n();
  const router = useRouter();
  const [username, setUsername] = useState<string | null>(null);
  const [generating, setGenerating] = useState(true);
  const [avatarId, setAvatarId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  /**
   * Fetch one UNIQUE candidate (the server re-checks at claim time too).
   * NOTE: no synchronous setState here — the mount effect calls this, and a
   * synchronous set inside an effect is a cascading-render smell (the
   * "generating" state is owned by the caller: initial value + handlers).
   */
  const fetchUsername = useCallback(async (signal?: { cancelled: boolean }) => {
    const result = await generateCommunityUsernameAction();
    if (signal?.cancelled) return;
    setGenerating(false);
    if (result.ok && result.username) {
      setUsername(result.username);
      setError(null);
    } else {
      // The action failed (DB hiccup) — surface a retryable error.
      setError("generic");
    }
  }, []);

  // Initial candidate: async work is defined INSIDE the effect (the
  // react-hooks rule only inlines effect-local functions through awaits —
  // calling an outer helper from the effect body is flagged as a
  // synchronous setState risk).
  useEffect(() => {
    let cancelled = false;
    const loadInitial = async () => {
      const result = await generateCommunityUsernameAction();
      if (cancelled) return;
      setGenerating(false);
      if (result.ok && result.username) {
        setUsername(result.username);
        setError(null);
      } else {
        // The action failed (DB hiccup) — surface a retryable error.
        setError("generic");
      }
    };
    void loadInitial();
    return () => {
      cancelled = true;
    };
  }, []);

  const valid = username !== null && avatarId !== null;

  const submit = () => {
    if (!valid || pending || !username) return;
    setError(null);
    startTransition(async () => {
      try {
        const result = await completeOnboarding({
          displayName: username,
          avatarId: avatarId as string,
        });
        if (result.ok) {
          // Re-render the server page: the community now appears (same URL).
          router.refresh();
          return;
        }
          if (result.code === "username_taken") {
            // Lost a race: regenerate and try again — the user's avatar
            // choice is kept, only the name changes.
            setUsername(null);
            setError("username_taken");
            setGenerating(true);
            void fetchUsername();
            return;
          }
        setError(result.code);
      } catch (error) {
        // A rejected server action (DB/network outage) must surface as an
        // inline error — never as an unhandled transition error.
        console.error("[community] onboarding request failed:", error);
        setError("generic");
      }
    });
  };

  const errorText =
    error === "username_taken"
      ? t("community.usernameTaken")
      : error === "username_invalid"
        ? t("community.usernameInvalid")
        : error === "avatar_invalid"
          ? t("community.avatarInvalid")
          : error === "rate_limited"
            ? t("community.rateLimited")
            : error
              ? t("community.onboardingFailed")
              : null;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-center justify-center px-4 py-10 sm:px-6">
      <Card className="w-full">
        <div className="flex flex-col gap-6 p-6 sm:p-8">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-accent-soft text-accent">
              <Icon name="users" size={20} />
            </span>
            <div>
              <h2 className="text-lg font-bold text-ink">
                {t("community.identityTitle")}
              </h2>
              <p className="mt-0.5 text-sm leading-6 text-muted">
                {t("community.identitySubtitle")}
              </p>
            </div>
          </div>

          {/* Generated username */}
          <div>
            <span className="mb-2 block text-sm font-semibold text-ink-soft">
              {t("community.nameLabel")}
            </span>
            <div className="flex items-center gap-2">
              <div className="flex h-12 min-w-0 flex-1 items-center rounded-2xl border border-line-strong bg-surface px-3.5">
                {generating ? (
                  <span className="flex items-center gap-2 text-sm text-muted">
                    <span className="typing-dots" aria-hidden="true">
                      <span className="typing-dot" />
                      <span className="typing-dot" />
                      <span className="typing-dot" />
                    </span>
                    {t("community.usernameRegenerating")}
                  </span>
                ) : (
                  <span className="truncate text-sm font-bold text-ink">
                    @{username ?? "…"}
                  </span>
                )}
              </div>
              <Button
                type="button"
                variant="secondary"
                size="md"
                onClick={() => {
                  setError(null);
                  setGenerating(true);
                  void fetchUsername();
                }}
                disabled={generating || pending}
                aria-label={t("community.generateAnother")}
                title={t("community.generateAnother")}
                className="shrink-0"
              >
                <Icon name="spark" size={16} />
                <span className="hidden sm:inline">{t("community.generateAnother")}</span>
              </Button>
            </div>
            <p className="mt-1.5 text-xs text-muted">{t("community.nameHelp")}</p>
          </div>

          {/* Avatars: exactly four (2 feminine, 2 masculine) */}
          <div>
            <span className="mb-2 block text-sm font-semibold text-ink-soft">
              {t("community.chooseAvatar")}
            </span>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {COMMUNITY_AVATAR_IDS.map((id, index) => {
                const selected = avatarId === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => {
                      setAvatarId(id);
                      setError(null);
                    }}
                    aria-pressed={selected}
                    aria-label={`${t("community.avatarAlt")} ${index + 1}`}
                    className={`relative mx-auto flex aspect-square w-full max-w-20 items-center justify-center rounded-2xl transition ${
                      selected
                        ? "ring-2 ring-accent ring-offset-2 ring-offset-surface"
                        : "hover:opacity-90"
                    }`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element -- avatar: fixed 80px, static public asset */}
                    <img
                      src={communityAvatarUrl(id)}
                      alt={`${t("community.avatarAlt")} ${index + 1}`}
                      width={80}
                      height={80}
                      className="h-full w-full rounded-2xl object-cover"
                      loading="lazy"
                    />
                    {selected && (
                      <span className="absolute -bottom-0.5 -end-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-accent text-white ring-2 ring-surface">
                        <Icon name="check" size={11} />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {errorText && (
            <p role="alert" className="text-sm font-medium text-danger">
              {errorText}
            </p>
          )}

          <Button onClick={submit} disabled={!valid || pending} className="w-full sm:w-auto">
            {pending ? t("common.loading") : t("community.complete")}
          </Button>
        </div>
      </Card>
    </div>
  );
}
