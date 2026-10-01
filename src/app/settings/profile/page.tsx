import { redirect } from "next/navigation";
import { saveProfileName, uploadAvatar } from "@/app/settings/profile/actions";
import { AuthFeedback } from "@/components/auth-feedback";
import { ProfileIdentities } from "@/components/profile-identities";
import { Button, Card, Input } from "@/components/ui";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { getServerT } from "@/lib/i18n/server";
import { linkedProviders, splitFullName } from "@/lib/profile-settings";

export const dynamic = "force-dynamic";

const ERROR_KEYS: Record<string, string> = {
  name_required: "profileSettings.errorNameRequired",
  name_too_long: "profileSettings.errorNameTooLong",
  save_failed: "profileSettings.errorSaveFailed",
  avatar_type: "profileSettings.errorAvatarType",
  avatar_size: "profileSettings.errorAvatarSize",
  avatar_failed: "profileSettings.errorAvatarFailed",
  no_file: "profileSettings.errorNoFile",
};

function initialsOf(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

export default async function ProfileSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{
    saved?: string;
    avatar?: string;
    linked?: string;
    error?: string;
  }>;
}) {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active")
    redirect("/login");
  const params = await searchParams;
  const t = await getServerT();

  // first/last are authoritative once set; older accounts only have full_name.
  const name =
    profile.first_name || profile.last_name
      ? {
          firstName: profile.first_name ?? "",
          lastName: profile.last_name ?? "",
        }
      : splitFullName(profile.full_name);
  const displayName =
    [name.firstName, name.lastName].filter(Boolean).join(" ") ||
    profile.full_name;
  const linked = linkedProviders(user.identities);

  const success = params.avatar
    ? t("profileSettings.avatarSaved")
    : params.linked
      ? t("profileSettings.linkSuccess")
      : params.saved
        ? t("profileSettings.nameSaved")
        : undefined;
  const error = params.error
    ? t(ERROR_KEYS[params.error] ?? "profileSettings.errorGeneric")
    : undefined;

  return (
    <div className="px-4 py-6 sm:px-6 lg:px-10">
      <div className="mx-auto max-w-3xl space-y-4">
        <AuthFeedback state={{ error, success }} />

        <Card className="p-6">
          <h2 className="text-lg font-bold text-ink-soft">
            {t("profileSettings.personalTitle")}
          </h2>
          <p className="mt-1 text-sm leading-6 text-muted">
            {t("profileSettings.personalNote")}
          </p>
          <form
            action={saveProfileName}
            className="mt-5 grid gap-4 sm:grid-cols-2"
          >
            <Input
              id="firstName"
              name="firstName"
              label={t("profileSettings.firstName")}
              defaultValue={name.firstName}
              maxLength={60}
              autoComplete="given-name"
              required
            />
            <Input
              id="lastName"
              name="lastName"
              label={t("profileSettings.lastName")}
              defaultValue={name.lastName}
              maxLength={60}
              autoComplete="family-name"
              required
            />
            <div className="sm:col-span-2">
              <p className="mb-4 text-xs text-muted">
                {t("profileSettings.emailNote")}
              </p>
              <Button type="submit">{t("profileSettings.save")}</Button>
            </div>
          </form>
        </Card>

        <Card className="p-6">
          <h2 className="text-lg font-bold text-ink-soft">
            {t("profileSettings.photoTitle")}
          </h2>
          <p className="mt-1 text-sm leading-6 text-muted">
            {t("profileSettings.photoNote")}
          </p>
          <div className="mt-5 flex flex-wrap items-center gap-5">
            {profile.avatar_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={profile.avatar_url}
                alt={displayName}
                className="h-16 w-16 shrink-0 rounded-full border border-line object-cover"
              />
            ) : (
              <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-accent-soft text-lg font-bold text-accent">
                {initialsOf(displayName)}
              </span>
            )}
            <form
              action={uploadAvatar}
              className="flex flex-wrap items-center gap-3"
            >
              <input
                type="file"
                name="avatar"
                accept="image/jpeg,image/png,image/webp"
                required
                className="max-w-full text-sm text-muted file:me-3 file:cursor-pointer file:rounded-lg file:border-0 file:bg-accent-soft file:px-3 file:py-2 file:text-sm file:font-semibold file:text-accent"
              />
              <Button type="submit" variant="secondary">
                {t("profileSettings.uploadPhoto")}
              </Button>
            </form>
          </div>
          <p className="mt-3 text-xs text-muted">
            {t("profileSettings.photoHint")}
          </p>
        </Card>

        <Card className="p-6">
          <h2 className="text-lg font-bold text-ink-soft">
            {t("profileSettings.accountsTitle")}
          </h2>
          <p className="mt-1 text-sm leading-6 text-muted">
            {t("profileSettings.accountsNote")}
          </p>
          <div className="mt-4">
            <ProfileIdentities linked={linked} />
          </div>
        </Card>
      </div>
    </div>
  );
}
