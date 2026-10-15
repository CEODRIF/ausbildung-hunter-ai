"use client";

import {
  useRef,
  useState,
  useTransition,
  type FormEvent,
} from "react";
import { updateProfileIdentity } from "@/app/settings/profile/actions";
import { Icon } from "@/components/icon";
import { UserAvatar } from "@/components/user-avatar";
import { useI18n } from "@/lib/i18n";
import {
  DISPLAY_NAME_MAX_LENGTH,
  PROFILE_AVATAR_IDS,
  avatarAssetPath,
  validateDisplayName,
  type ProfileAvatarId,
} from "@/lib/profile-avatars";

/**
 * Edit-profile form (display name + avatar gallery).
 *
 *  - The PERSISTED identity is `initialName`/`initialAvatar`; the form
 *    state is a working copy that only reaches the database on a
 *    successful server action ("preserve the existing avatar until
 *    changes are saved").
 *  - The server is the source of truth for validation (same
 *    validateDisplayName / isProfileAvatarId rules run there); the
 *    client check only prevents a known-bad round trip.
 *  - Double submission is blocked by an in-flight ref AND useTransition
 *    pending state (button disabled while saving).
 *  - States: idle → saving (pending) → success | validation error |
 *    server error, all rendered inline.
 */
export function ProfileIdentityForm({
  initialName,
  initialAvatar,
  avatarEnabled,
}: {
  initialName: string;
  initialAvatar: ProfileAvatarId | null;
  /** False while the profiles.avatar migration is pending: the picker is
   *  hidden and only the display name is editable/saved. */
  avatarEnabled: boolean;
}) {
  const { t } = useI18n();

  // Base = last PERSISTED values (updated only after a successful save).
  const [base, setBase] = useState<{
    name: string;
    avatar: ProfileAvatarId | null;
  }>({ name: initialName, avatar: initialAvatar });

  const [name, setName] = useState(initialName);
  const [avatar, setAvatar] = useState<ProfileAvatarId | null>(initialAvatar);
  const [status, setStatus] = useState<
    | { kind: "success" }
    | { kind: "error"; code: "invalid_name" | "invalid_avatar" | "unauthorized" | "failed" }
    | null
  >(null);
  const [isPending, startTransition] = useTransition();
  const inFlight = useRef(false);

  const trimmed = name.trim();
  const dirty =
    trimmed !== base.name.trim() || (avatarEnabled && avatar !== base.avatar);

  const nameTooLong = trimmed.length > DISPLAY_NAME_MAX_LENGTH;

  const resetToBase = () => {
    setName(base.name);
    setAvatar(base.avatar);
    setStatus(null);
  };

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (inFlight.current || isPending) return;

    // Client-side pre-check (the server re-validates independently).
    const check = validateDisplayName(name);
    if (!check.ok) {
      setStatus({ kind: "error", code: "invalid_name" });
      return;
    }
    const nextAvatar = avatarEnabled ? avatar : null;

    inFlight.current = true;
    setStatus(null);
    startTransition(async () => {
      try {
        const fd = new FormData(e.currentTarget);
        fd.set("fullName", check.value);
        fd.set("avatar", nextAvatar ?? "");
        const result = await updateProfileIdentity(fd);
        if (result.ok) {
          // Adopt the persisted values as the new base.
          setBase({ name: check.value, avatar: nextAvatar });
          setName(check.value);
          setAvatar(nextAvatar);
          setStatus({ kind: "success" });
        } else {
          setStatus({ kind: "error", code: result.error });
        }
      } catch {
        setStatus({ kind: "error", code: "failed" });
      } finally {
        inFlight.current = false;
      }
    });
  };

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-5">
      {/* ---------------- live preview (updates on every keystroke/choice) */}
      <div className="flex items-center gap-4">
        <div
          className="rounded-full p-[2.5px]"
          style={{ backgroundImage: "var(--gradient-neon)" }}
        >
          <UserAvatar
            avatar={avatarEnabled ? avatar : null}
            fullName={trimmed}
            className="h-16 w-16 bg-surface-2 ring-[3px] ring-[var(--background)] sm:h-20 sm:w-20"
            imgClassName="h-16 w-16 object-cover sm:h-20 sm:w-20"
            initialsClassName="text-xl font-extrabold text-accent sm:text-2xl"
            label={trimmed || t("profile.page.edit.displayName")}
          />
        </div>
        <div className="min-w-0 text-start">
          <p className="truncate text-sm font-bold text-ink">
            {trimmed || t("profile.page.edit.displayName")}
          </p>
          <p className="mt-0.5 text-xs text-muted">
            {t("profile.page.edit.previewHint")}
          </p>
        </div>
      </div>

      {/* ---------------- display name */}
      <div>
        <label
          htmlFor="profile-full-name"
          className="mb-1 block text-[11px] font-bold uppercase tracking-[0.08em] text-faint"
        >
          {t("profile.page.edit.displayName")}
        </label>
        <input
          id="profile-full-name"
          name="fullName"
          type="text"
          value={name}
          maxLength={DISPLAY_NAME_MAX_LENGTH + 10}
          onChange={(e) => {
            setName(e.target.value);
            setStatus(null);
          }}
          aria-invalid={nameTooLong || !validateDisplayName(name).ok}
          aria-describedby={
            nameTooLong
              ? "profile-full-name-error"
              : undefined
          }
          className="w-full min-h-[38px] rounded-xl border border-line-strong bg-surface px-3 py-2 text-sm font-semibold text-ink outline-none transition-colors focus:border-accent focus-visible:ring-2 focus-visible:ring-accent/60"
          placeholder={t("profile.page.edit.displayNamePlaceholder")}
        />
        {nameTooLong && (
          <p
            id="profile-full-name-error"
            role="alert"
            className="mt-1.5 text-xs font-semibold text-danger"
          >
            {t("profile.page.edit.invalidName")}
          </p>
        )}
      </div>

      {/* ---------------- avatar gallery (hidden while migration pending) */}
      {avatarEnabled && (
        <div>
          <p className="mb-2 block text-[11px] font-bold uppercase tracking-[0.08em] text-faint">
            {t("profile.page.edit.chooseAvatar")}
          </p>
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-5">
            {PROFILE_AVATAR_IDS.map((id) => {
              const selected = avatar === id;
              return (
                <button
                  key={id}
                  type="button"
                  aria-pressed={selected}
                  aria-label={t(`profile.page.edit.avatars.${id}`)}
                  title={t(`profile.page.edit.avatars.${id}`)}
                  disabled={isPending}
                  onClick={() => {
                    // Clicking the active avatar again removes it (back to
                    // the initials fallback) — "keep current" is implicit.
                    setAvatar(selected ? null : id);
                    setStatus(null);
                  }}
                  className={`group relative rounded-2xl border-2 p-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 disabled:opacity-60 ${
                    selected
                      ? "border-accent bg-accent-soft"
                      : "border-line-strong bg-surface hover:border-accent/50"
                  }`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- bundled local SVG, intrinsic 256×256 */}
                  <img
                    src={avatarAssetPath(id)}
                    width={256}
                    height={256}
                    alt=""
                    className="h-14 w-14 rounded-xl sm:h-16 sm:w-16"
                  />
                  {selected && (
                    <span
                      aria-hidden="true"
                      className="absolute -end-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-accent text-white ring-2 ring-[var(--surface)]"
                    >
                      <Icon name="check" size={11} />
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* ---------------- status feedback */}
      {status?.kind === "success" && (
        <p
          role="status"
          className="flex items-center gap-2 rounded-xl bg-success-soft px-3 py-2.5 text-sm font-semibold text-success"
        >
          <Icon name="check" size={14} />
          {t("profile.page.edit.success")}
        </p>
      )}
      {status?.kind === "error" && (
        <p
          role="alert"
          className="flex items-center gap-2 rounded-xl bg-danger-soft px-3 py-2.5 text-sm font-semibold text-danger"
        >
          <Icon name="x" size={14} />
          {status.code === "invalid_name" || status.code === "invalid_avatar"
            ? t("profile.page.edit.invalidName")
            : t("profile.page.edit.error")}
        </p>
      )}

      {/* ---------------- actions */}
      <div className="flex flex-wrap items-center gap-2.5 border-t border-line pt-4">
        <button
          type="submit"
          disabled={isPending || !dirty}
          className="inline-flex h-10 items-center gap-2 rounded-xl bg-accent px-5 text-sm font-bold text-white shadow-sm transition-colors hover:bg-accent-deep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isPending && (
            <span
              aria-hidden="true"
              className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white"
            />
          )}
          {isPending
            ? t("profile.page.edit.saving")
            : t("profile.page.edit.save")}
        </button>
        <button
          type="button"
          onClick={resetToBase}
          disabled={isPending || !dirty}
          className="inline-flex h-10 items-center rounded-xl border border-line-strong bg-surface px-5 text-sm font-bold text-ink-soft transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {t("profile.page.edit.cancel")}
        </button>
      </div>
    </form>
  );
}
