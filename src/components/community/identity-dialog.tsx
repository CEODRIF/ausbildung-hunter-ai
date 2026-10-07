"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, Input } from "@/components/ui";
import { Icon } from "@/components/icon";
import { useI18n } from "@/lib/i18n";
import {
  COMMUNITY_AVATAR_IDS,
  COMMUNITY_ADMIN_MAX_NAME_LENGTH,
  COMMUNITY_MAX_USERNAME_LENGTH,
  communityAvatarUrl,
  isValidAdminCommunityName,
  isValidCommunityUsername,
} from "@/lib/community";
import { updateCommunityIdentity } from "@/app/community/actions";

/**
 * "Choose your Community identity" — LATER edition: rename the alias and/or
 * change the avatar (spec §5: editable after onboarding).
 *
 * Accessible dialog: role=dialog + aria-modal, Escape / scrim close, initial
 * focus into the input, and no focus trap acrobatics needed — the dialog is
 * short and the Escape path always works.
 */

export interface IdentityDialogProps {
  me: { displayName: string; avatarId: string; platformAdmin?: boolean };
  onClose: () => void;
}

export function IdentityDialog({ me, onClose }: IdentityDialogProps) {
  const { t } = useI18n();
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(me.displayName);
  const [avatarId, setAvatarId] = useState(me.avatarId);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Phase 10: the designated platform admin (server-stamped flag — the same
  // value the server action re-validates) may use a custom name (1–40 chars,
  // no control characters). Normal users keep the exact username rules.
  const isAdmin = me.platformAdmin === true;
  const trimmed = name.trim();
  const nameChanged = trimmed !== me.displayName;
  const avatarChanged = avatarId !== me.avatarId;
  const dirty = nameChanged || avatarChanged;
  const nameValid =
    trimmed.length === 0 ||
    (isAdmin ? isValidAdminCommunityName(trimmed) : isValidCommunityUsername(trimmed));

  const submit = () => {
    if (!dirty || pending || !nameValid) return;
    setError(null);
    startTransition(async () => {
      const result = await updateCommunityIdentity({
        displayName: nameChanged ? trimmed : undefined,
        avatarId: avatarChanged ? avatarId : undefined,
      });
      if (result.ok) {
        // Re-render the server page so the new identity shows everywhere.
        router.refresh();
        return;
      }
      setError(result.code);
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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="community-identity-title"
    >
      <button
        type="button"
        aria-label={t("common.close")}
        onClick={onClose}
        className="absolute inset-0 bg-navy/50 backdrop-blur-sm"
      />
      <Card className="relative w-full max-w-md">
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h2 id="community-identity-title" className="text-sm font-bold text-ink">
            {t("community.editIdentity")}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close")}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-surface-2"
          >
            <Icon name="x" size={15} />
          </button>
        </div>
        <div className="flex flex-col gap-5 p-5">
          <div className="flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element -- avatar: fixed 56px, static public asset */}
            <img
              src={communityAvatarUrl(avatarId)}
              alt={t("community.avatarAlt")}
              width={56}
              height={56}
              className="h-14 w-14 rounded-2xl object-cover"
            />
            <div className="min-w-0">
              <p className="truncate text-sm font-bold text-ink">@{name || me.displayName}</p>
              <p className="truncate text-xs text-muted">{t("community.nameHelp")}</p>
            </div>
          </div>

          <Input
            ref={inputRef}
            id="community-identity-name"
            label={t("community.nameLabel")}
            hint={t("community.nameHelp")}
            value={name}
            maxLength={isAdmin ? COMMUNITY_ADMIN_MAX_NAME_LENGTH : COMMUNITY_MAX_USERNAME_LENGTH}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              setName(event.target.value);
              setError(null);
            }}
          />

          <div>
            <span className="mb-2 block text-sm font-semibold text-ink-soft">
              {t("community.chooseAvatar")}
            </span>
            <div className="grid grid-cols-4 gap-2">
              {COMMUNITY_AVATAR_IDS.map((id) => {
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
                    aria-label={t("community.avatarAlt")}
                    className={`relative flex aspect-square items-center justify-center rounded-2xl transition ${
                      selected
                        ? "ring-2 ring-accent ring-offset-2 ring-offset-surface"
                        : "hover:opacity-90"
                    }`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element -- avatar: fixed 64px, static public asset */}
                    <img
                      src={communityAvatarUrl(id)}
                      alt={t("community.avatarAlt")}
                      width={64}
                      height={64}
                      loading="lazy"
                      className="h-full w-full rounded-2xl object-cover"
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

          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={onClose}>
              {t("common.close")}
            </Button>
            <Button size="sm" onClick={submit} disabled={!dirty || pending || !nameValid}>
              {pending ? t("common.loading") : t("community.saveEdit")}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
