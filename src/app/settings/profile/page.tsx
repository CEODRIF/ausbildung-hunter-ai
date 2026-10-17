import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { getServerT, getRequestLang } from "@/lib/i18n/server";
import {
  localeForLang,
  type Language,
  type TranslateVars,
} from "@/lib/i18n/core";
import { GlassCard } from "@/components/ui/surfaces";
import { Icon, type IconName } from "@/components/icon";
import { ApplicantProfileForm } from "@/components/applicant-profile-form";
import { ProfileIdentityForm } from "@/components/profile-identity-form";
import { UserAvatar } from "@/components/user-avatar";
import {
  hasApplicantProfileColumns,
  hasProfileAvatarColumn,
} from "@/lib/contact-name-support";
import { isProfileAvatarId } from "@/lib/profile-avatars";

export const dynamic = "force-dynamic";

type T = (path: string, vars?: TranslateVars) => string;

/**
 * Social / contact links — the three requested channels only. Brand tints
 * are the official brand colors (hover state only); at rest everything is
 * drawn from the design tokens, so light and dark stay consistent.
 */
const SOCIALS = [
  {
    icon: "whatsapp",
    label: "WhatsApp",
    href: "https://wa.me/4915210523155",
    tileHover: "hover:border-[#25D366]/40",
    iconHover:
      "group-hover:text-[#25D366] group-hover:drop-shadow-[0_0_10px_rgba(37,211,102,0.35)]",
  },
  {
    icon: "facebook",
    label: "Facebook",
    href: "https://www.facebook.com/ceodrif?mibextid=wwXIfr",
    tileHover: "hover:border-[#1877F2]/40",
    iconHover:
      "group-hover:text-[#1877F2] group-hover:drop-shadow-[0_0_10px_rgba(24,119,242,0.35)]",
  },
  {
    icon: "tiktok",
    label: "TikTok",
    href: "https://www.tiktok.com/@ceodrif",
    tileHover: "hover:border-[#FE2C55]/40",
    iconHover:
      "group-hover:text-[#FE2C55] group-hover:drop-shadow-[0_0_10px_rgba(254,44,85,0.3)]",
  },
] as const;

/**
 * Settings — Profile. A premium identity dashboard over the EXISTING
 * profile data (no new backend, no new fields, no new endpoints):
 *
 *   1. Hero identity card — avatar (gallery avatar → uploaded `avatar_url`
 *      → initials, resolved by UserAvatar), name, email, status / goal /
 *      member-since pills.
 *   2. Identity editor — display name + 10-avatar gallery (the avatar
 *      picker is gated on the hasProfileAvatarColumn() probe; display
 *      name works on every schema).
 *   3. Personal information — read-only rows from `profiles`.
 *   4. Connected accounts — links to the existing settings pages
 *      (email / usage / billing / data), reusing their own titles.
 *
 * All visuals come from the design tokens in globals.css, so light and
 * dark themes work from this one markup; layout is mobile-first with a
 * two-column card grid on xl screens. Logical (start/end) utilities keep
 * the Arabic (RTL) layout correct.
 */
export default async function ProfileSettingsPage() {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active")
    redirect("/login");
  const t = await getServerT();
  const lang = (await getRequestLang()) as Language;
  const locale = localeForLang(lang);

  // Avatar gallery: only offered once the MANUAL migration
  // (20261111000000_profile_avatar_gallery) has been applied — code may
  // deploy first. The display name works on every schema (full_name has
  // existed since the auth foundation).
  const avatarSupported = await hasProfileAvatarColumn();
  // Applicant details (the seven mandatory Anschreiber-header fields):
  // editable only once the 20261114000000 migration is applied (manual
  // migrations — code may deploy first, like the avatar picker above).
  const applicantSupported = await hasApplicantProfileColumns();
  const avatarId =
    avatarSupported && isProfileAvatarId(profile.avatar)
      ? profile.avatar
      : null;

  const created = new Date(profile.created_at);
  const memberSinceLabel = Number.isNaN(created.getTime())
    ? ""
    : new Intl.DateTimeFormat(locale, {
        month: "long",
        year: "numeric",
      }).format(created);

  const goalLabel =
    profile.selected_goal === "ausbildung"
      ? t("dash.goalAusbildung")
      : profile.selected_goal === "arbeit"
        ? t("dash.goalArbeit")
        : null;

  const accounts: Array<{
    icon: IconName;
    href: string;
    title: string;
    desc: string;
  }> = [
    {
      icon: "mail",
      href: "/settings/email",
      title: t("pages.settingsEmail.title"),
      desc: t("pages.settingsEmail.subtitle"),
    },
    {
      icon: "chart",
      href: "/settings/usage",
      title: t("pages.settingsUsage.title"),
      desc: t("pages.settingsUsage.subtitle"),
    },
    {
      icon: "idCard",
      href: "/settings/billing",
      title: t("pages.settingsBilling.title"),
      desc: t("pages.settingsBilling.subtitle"),
    },
    {
      icon: "lock",
      href: "/settings/data",
      title: t("pages.settingsData.title"),
      desc: t("pages.settingsData.subtitle"),
    },
  ];

  return (
    <div className="px-4 py-6 sm:px-6 lg:px-10">
      <div className="mx-auto max-w-5xl">
        {/* Back — comfortable 44px touch target, glass container */}
        <Link
          href="/dashboard"
          className="mb-4 inline-flex h-11 items-center gap-2 rounded-2xl border border-line-strong bg-surface px-4 text-sm font-semibold text-ink-soft shadow-[var(--shadow-card)] transition-colors hover:bg-surface-2 hover:text-ink"
        >
          <Icon name="arrowLeft" size={15} className="rtl:-scale-x-100" />
          {t("common.back")}
        </Link>

        {/* ------------------------------------------------ hero identity */}
        <div className="mx-auto max-w-3xl">
          <GlassCard
            variant="surface-elevated"
            as="section"
            aria-label={t("pages.settingsProfile.title")}
            className="relative overflow-hidden p-6 sm:p-10"
          >
            <div className="hero-orb pointer-events-none absolute -end-20 -top-24 h-72 w-72 rounded-full" />
            <div className="hero-orb pointer-events-none absolute -bottom-28 -start-24 h-72 w-72 rounded-full opacity-70" />
            <div className="relative flex flex-col items-center text-center">
              {/* Avatar — gradient ring; gallery avatar / uploaded URL /
                  initials resolved in ONE place (UserAvatar) */}
              <div
                className="rounded-full p-[3px]"
                style={{ backgroundImage: "var(--gradient-neon)" }}
              >
                <UserAvatar
                  avatar={avatarId}
                  avatarUrl={profile.avatar_url}
                  fullName={profile.full_name}
                  className="h-26 w-26 bg-surface-2 ring-4 ring-[var(--background)] sm:h-32 sm:w-32"
                  imgClassName="h-full w-full object-cover"
                  initialsClassName="text-4xl font-extrabold text-accent"
                  label={profile.full_name}
                />
              </div>

              <p className="mt-5 max-w-full break-words text-2xl font-extrabold tracking-tight text-ink sm:text-3xl">
                {profile.full_name}
              </p>
              <p className="mt-1.5 max-w-full break-all text-sm text-muted">
                {profile.email}
              </p>

              {/* Metadata pills — existing data only */}
              <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
                <StatusPill status={profile.account_status} t={t} />
                {goalLabel && (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-3 py-1 text-xs font-bold text-accent">
                    <Icon name="target" size={12} />
                    {goalLabel}
                  </span>
                )}
                {memberSinceLabel && (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-3 py-1 text-xs font-semibold text-muted">
                    <Icon name="clock" size={12} />
                    {t("profile.page.memberSince")} {memberSinceLabel}
                  </span>
                )}
              </div>
            </div>
          </GlassCard>

          {/* ------------------------------------------------ identity editor */}
          <GlassCard
            variant="surface"
            as="section"
            className="mt-5 overflow-hidden"
            aria-label={t("profile.page.edit.title")}
          >
            <div className="flex items-center gap-3.5 border-b border-line px-5 py-5 sm:px-6">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-accent-soft text-accent">
                <Icon name="edit" size={19} />
              </span>
              <div className="min-w-0">
                <h2 className="font-bold tracking-tight text-ink">
                  {t("profile.page.edit.title")}
                </h2>
                <p className="mt-0.5 text-xs text-muted">
                  {t("profile.page.edit.hint")}
                </p>
              </div>
            </div>
            <div className="px-5 py-5 sm:px-6">
              <ProfileIdentityForm
                initialName={profile.full_name}
                initialAvatar={avatarId}
                avatarEnabled={avatarSupported}
              />
            </div>
          </GlassCard>
        </div>

        {/* ----------------------------------------- section cards (2 col) */}
        <div className="mx-auto mt-5 grid max-w-3xl gap-5 xl:max-w-none xl:grid-cols-2">
          {/* Personal information */}
          <GlassCard
            variant="surface"
            as="section"
            className="overflow-hidden"
            aria-label={t("profile.page.personal.title")}
          >
            <div className="flex items-center gap-3.5 border-b border-line px-5 py-5 sm:px-6">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-accent-soft text-accent">
                <Icon name="idCard" size={19} />
              </span>
              <div className="min-w-0">
                <h2 className="font-bold tracking-tight text-ink">
                  {t("profile.page.personal.title")}
                </h2>
                <p className="mt-0.5 text-xs text-muted">
                  {t("profile.page.personal.hint")}
                </p>
              </div>
            </div>
            <dl className="px-5 py-5 sm:px-6">
              <ProfileDetail
                label={t("dash.detail.fullName")}
                value={profile.full_name}
              />
              <ProfileDetail
                label={t("dash.detail.email")}
                value={profile.email}
              />
              {goalLabel && (
                <ProfileDetail
                  label={t("dash.detail.goal")}
                  value={goalLabel}
                />
              )}
              <ProfileDetail
                label={t("dash.detail.emailLimit")}
                value={t("dash.detail.emails", {
                  count: profile.daily_email_limit,
                })}
                last
              />
            </dl>
          </GlassCard>

          {/* Applicant details — the seven mandatory cover-letter fields */}
          <GlassCard
            variant="surface"
            as="section"
            className="overflow-hidden xl:col-span-2"
            aria-label={t("profile.page.applicant.title")}
          >
            <div className="flex items-center gap-3.5 border-b border-line px-5 py-5 sm:px-6">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-accent-soft text-accent">
                <Icon name="user" size={19} />
              </span>
              <div className="min-w-0">
                <h2 className="font-bold tracking-tight text-ink">
                  {t("profile.page.applicant.title")}
                </h2>
                <p className="mt-0.5 text-xs text-muted">
                  {t("profile.page.applicant.hint")}
                </p>
              </div>
            </div>
            <div className="px-5 py-5 sm:px-6">
              <ApplicantProfileForm
                supported={applicantSupported}
                initial={{
                  fullName: profile.full_name ?? "",
                  street: profile.street ?? "",
                  postalCode: profile.postal_code ?? "",
                  city: profile.city ?? "",
                  country: profile.country ?? "",
                  email: profile.email ?? "",
                  phone: profile.phone ?? "",
                }}
              />
            </div>
          </GlassCard>

          {/* Connected accounts / settings */}
          <GlassCard
            variant="surface"
            as="section"
            className="overflow-hidden"
            aria-label={t("profile.page.accounts.title")}
          >
            <div className="flex items-center gap-3.5 border-b border-line px-5 py-5 sm:px-6">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-ai-soft text-ai">
                <Icon name="globe" size={19} />
              </span>
              <div className="min-w-0">
                <h2 className="font-bold tracking-tight text-ink">
                  {t("profile.page.accounts.title")}
                </h2>
                <p className="mt-0.5 text-xs text-muted">
                  {t("profile.page.accounts.hint")}
                </p>
              </div>
            </div>
            <div className="grid gap-1 p-3">
              {accounts.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="group flex items-center gap-3 rounded-2xl p-3 transition-colors hover:bg-accent-soft/60"
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-muted transition-colors duration-300 group-hover:bg-accent group-hover:text-white">
                    <Icon name={item.icon} size={17} />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-bold text-ink transition-colors group-hover:text-accent">
                      {item.title}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-muted">
                      {item.desc}
                    </span>
                  </span>
                  <span className="ms-auto shrink-0 text-faint transition-colors group-hover:text-accent">
                    <Icon
                      name="chevronRight"
                      size={14}
                      className="rtl:-scale-x-100"
                    />
                  </span>
                </Link>
              ))}
            </div>
          </GlassCard>
        </div>

        {/* ----------------------------------------------- social media */}
        <section
          aria-label={t("profile.page.social.title")}
          className="mx-auto mt-10 flex max-w-3xl flex-col items-center"
        >
          <h2 className="mb-4 text-xs font-bold uppercase tracking-[0.14em] text-faint">
            {t("profile.page.social.title")}
          </h2>
          <div className="flex items-center justify-center gap-3 sm:gap-4">
            {SOCIALS.map((s) => (
              <Link
                key={s.label}
                href={s.href}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={s.label}
                className={`group flex h-16 w-16 items-center justify-center rounded-[22px] border border-line-strong bg-surface shadow-[var(--shadow-card)] transition-all duration-200 hover:-translate-y-0.5 hover:scale-[1.05] hover:shadow-[var(--shadow-float)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 sm:h-24 sm:w-24 sm:rounded-3xl motion-reduce:transition-none motion-reduce:hover:translate-y-0 motion-reduce:hover:scale-100 ${s.tileHover}`}
              >
                <Icon
                  name={s.icon}
                  size={32}
                  className={`text-muted transition-[color,filter] duration-200 ${s.iconHover}`}
                />
              </Link>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

/** Account-status pill (existing `account_status` values only). */
function StatusPill({
  status,
  t,
}: {
  status: "pending" | "active" | "suspended";
  t: T;
}) {
  const styles = {
    active: "bg-success-soft text-success",
    pending: "bg-warning-soft text-warning",
    suspended: "bg-danger-soft text-danger",
  } as const;
  const icons: Record<typeof status, IconName> = {
    active: "check",
    pending: "clock",
    suspended: "lock",
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold ${styles[status]}`}
    >
      <Icon name={icons[status]} size={12} />
      {t(`profile.page.status.${status}`)}
    </span>
  );
}

/** Label/value row — long values wrap instead of overflowing. */
function ProfileDetail({
  label,
  value,
  last = false,
}: {
  label: string;
  value: string;
  last?: boolean;
}) {
  return (
    <div
      className={`flex items-start justify-between gap-4 pt-3 ${
        last ? "pb-0" : "border-b border-line pb-3.5"
      } first:pt-0`}
    >
      <dt className="shrink-0 pt-px text-xs font-medium text-muted">
        {label}
      </dt>
      <dd className="max-w-[62%] break-words text-end text-xs font-semibold text-ink-soft">
        {value}
      </dd>
    </div>
  );
}
