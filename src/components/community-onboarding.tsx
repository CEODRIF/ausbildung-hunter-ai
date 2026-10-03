"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, Input } from "@/components/ui";
import { Icon } from "@/components/icon";
import { useI18n } from "@/lib/i18n";
import {
  COMMUNITY_AVATAR_IDS,
  COMMUNITY_MAX_NAME_LENGTH,
  communityAvatarUrl,
} from "@/lib/community";
import { completeOnboarding } from "@/app/community/actions";

/**
 * First-visit community onboarding: display name + one of exactly five
 * predefined project avatars. No user-uploaded pictures — by design.
 * The button stays disabled until both inputs are valid; everything is
 * re-validated server-side (schema + RLS) in the action.
 */
export function CommunityOnboarding() {
  const { t } = useI18n();
  const router = useRouter();
  const [name, setName] = useState("");
  const [avatarId, setAvatarId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const trimmed = name.trim();
  const valid = trimmed.length >= 1 && trimmed.length <= COMMUNITY_MAX_NAME_LENGTH && avatarId !== null;

  const submit = () => {
    if (!valid || pending) return;
    setError(null);
    startTransition(async () => {
      const result = await completeOnboarding({
        displayName: trimmed,
        avatarId: avatarId as string,
      });
      if (result.ok) {
        // Re-render the server page: the chat now appears (same URL).
        router.refresh();
        return;
      }
      setError(result.code);
    });
  };

  const errorText =
    error === "name_required"
      ? t("community.nameRequired")
      : error === "name_too_long"
        ? t("community.nameTooLong")
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
          <div>
            <h2 className="text-lg font-bold text-ink">
              {t("community.onboardingTitle")}
            </h2>
            <p className="mt-1 text-sm leading-6 text-muted">
              {t("community.onboardingHint")}
            </p>
          </div>

          <Input
            id="community-name"
            label={t("community.nameLabel")}
            hint={t("community.nameHelp")}
            placeholder={t("community.namePlaceholder")}
            value={name}
            maxLength={COMMUNITY_MAX_NAME_LENGTH + 20}
            autoComplete="name"
            onChange={(event) => {
              setName(event.target.value);
              setError(null);
            }}
          />

          <div>
            <span className="mb-2 block text-sm font-semibold text-ink-soft">
              {t("community.chooseAvatar")}
            </span>
            <div className="grid grid-cols-5 gap-2 sm:gap-3">
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
                    className={`relative mx-auto flex aspect-square w-full max-w-16 items-center justify-center rounded-full transition ${
                      selected
                        ? "ring-2 ring-accent ring-offset-2 ring-offset-surface"
                        : "hover:opacity-90"
                    }`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element -- avatar: fixed 96px, static public asset */}
                    <img
                      src={communityAvatarUrl(id)}
                      alt={`${t("community.avatarAlt")} ${index + 1}`}
                      width={96}
                      height={96}
                      className="h-full w-full rounded-full object-cover"
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

          <Button
            onClick={submit}
            disabled={!valid || pending}
            className="w-full sm:w-auto"
          >
            {pending ? t("common.loading") : t("community.complete")}
          </Button>
        </div>
      </Card>
    </div>
  );
}