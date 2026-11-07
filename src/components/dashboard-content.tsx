import Link from "next/link";
import { Button } from "@/components/ui";
import { Icon, type IconName } from "@/components/icon";
import { EmptyState } from "@/components/empty-state";
import { GlassCard } from "@/components/ui/surfaces";
import type {
  ActivityLog,
  DashboardData,
  DashboardRecommendations,
  DashboardSubscription,
  MatchingSummary,
  RecentApplication,
  RecommendationItem,
  SavedPreviewItem,
} from "@/lib/dashboard";
import { getProfileCompletion } from "@/lib/dashboard";
import type {
  NextAction,
  ProfileCompleteness,
} from "@/lib/dashboard-intelligence";
import { EmailAccountCard } from "@/components/email-account-card";
import {
  QuotaIndicator,
  makeQuotaLabels,
  quotaDataFromEntitlement,
} from "@/components/quota-indicator";
import type { UsageSnapshot } from "@/lib/email-campaigns";
import { SaveOpportunityButton } from "@/components/opportunity-save-button";
import { getServerT, getRequestLang } from "@/lib/i18n/server";
import {
  localeForLang,
  type Language,
  type TranslateVars,
} from "@/lib/i18n/core";

type T = (path: string, vars?: TranslateVars) => string;

// ---------------------------------------------------------------------------
// Campaign status presentation (email_campaigns CampaignStatus values).
// Unknown/future values render their raw string with a neutral tone —
// never an invented label, never a colored claim.
// ---------------------------------------------------------------------------

const APP_STATUS_TONES: Record<string, string> = {
  draft: "bg-line/60 text-muted",
  queued: "bg-accent-soft text-accent",
  sending: "bg-accent-soft text-accent",
  completed: "bg-success-soft text-success",
  partially_failed: "bg-warning-soft text-warning",
  failed: "bg-danger/10 text-danger",
  cancelled: "bg-line/60 text-muted",
};

function appStatus(
  item: RecentApplication,
  t: T,
): { label: string; tone: string } {
  const raw = item.campaign_status;
  if (raw && raw in APP_STATUS_TONES) {
    return { label: t(`dash.appStatus.${raw}`), tone: APP_STATUS_TONES[raw] };
  }
  if (!raw) {
    return {
      label: t(item.has_content ? "dash.apps.prepared" : "dash.appStatus.draft"),
      tone: "bg-line/60 text-muted",
    };
  }
  return { label: raw, tone: "bg-line/60 text-muted" };
}

const ACTIVITY_ICONS: Array<{ prefix: string; icon: IconName }> = [
  { prefix: "opportunity_", icon: "bookmark" },
  { prefix: "campaign_", icon: "mail" },
  { prefix: "bewerbung_scan", icon: "scan" },
  { prefix: "quota_", icon: "chart" },
  { prefix: "provider_", icon: "mail" },
];

function activityIcon(type: string): IconName {
  const hit = ACTIVITY_ICONS.find((entry) => type.startsWith(entry.prefix));
  return hit ? hit.icon : "activity";
}

// ---------------------------------------------------------------------------
// Dashboard — reorganized premium layout (Phase 2).
//
//   1. welcome header      (date + greeting + goal + profile chip)
//   2. quick actions       (the five real workflow entry points)
//   3. statistics cards    (e-mails today / saved / AI usage / profile)
//   4. next action banner  (server-derived rule chain)
//   5. main column         (application statuses, recommendations, saved)
//   6. sidebar column      (profile, activity, matching, e-mail, account,
//                            subscription)
//
// Every value comes from getDashboardData — no synthetic data.
// ---------------------------------------------------------------------------

export async function DashboardContent({ data }: { data: DashboardData }) {
  const t = await getServerT();
  const lang = (await getRequestLang()) as Language;
  const locale = localeForLang(lang);
  const {
    profile,
    usage,
    usageSnapshot,
    aiEntitlement,
    subscription,
    emailAccount,
    hasCompletedScan,
    matching,
    candidateProfile,
    completeness,
    nextAction,
    savedPreview,
    recentApplications,
    activities,
    recommendations,
  } = data;
  const isAusbildung = profile.selected_goal === "ausbildung";
  const goalLabel = t(isAusbildung ? "dash.goalAusbildung" : "dash.goalArbeit");
  const completion = getProfileCompletion(profile);
  const firstName = profile.full_name.trim().split(" ")[0] || "";
  const hasProfile = Boolean(candidateProfile);

  // Shared green quota indicator (P0 quota audit): labels via the ONE
  // helper so wording parity holds across all quota surfaces.
  const quotaLabels = makeQuotaLabels(t);
  const aiData = quotaDataFromEntitlement(aiEntitlement);
  const hour = new Date().getHours();
  const greetingKey =
    hour >= 5 && hour < 11
      ? "dash.greeting.morning"
      : hour >= 11 && hour < 18
        ? "dash.greeting.afternoon"
        : "dash.greeting.evening";
  const dateLabel = new Intl.DateTimeFormat(locale, {
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date());

  const quickItems: Array<{
    key: string;
    icon: IconName;
    href: string;
    label: string;
  }> = [
    {
      key: "find",
      icon: "search",
      href: "/opportunities",
      label: t("workflow.find.label", { goal: goalLabel }),
    },
    {
      key: "scan",
      icon: "scan",
      href: "/bewerbung-scanner",
      label: t("workflow.scan.label"),
    },
    {
      key: "assistant",
      icon: "spark",
      href: "/ai",
      label: t("workflow.assistant.label"),
    },
    {
      key: "saved",
      icon: "bookmark",
      href: "/opportunities/saved",
      label: t("workflow.saved.label"),
    },
    {
      key: "email",
      icon: "mail",
      href: "/settings/email",
      label: t("workflow.email.label"),
    },
  ];

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-10 lg:px-10">
      {/* ----------------------------------------------------------------- */}
      {/* 1 · Welcome header                                                 */}
      {/* ----------------------------------------------------------------- */}
      <section className="anim-fade-up">
        <GlassCard
          variant="surface-elevated"
          className="relative overflow-hidden p-6 sm:p-8"
        >
          <div className="hero-orb pointer-events-none absolute -end-24 -top-28 h-72 w-72 rounded-full opacity-70" />
          <div className="grid-fade pointer-events-none absolute inset-x-0 bottom-0 h-28 opacity-30 [mask-image:linear-gradient(to_bottom,transparent,black)]" />
          <div className="relative flex flex-wrap items-center justify-between gap-x-6 gap-y-4">
            <div className="min-w-0">
              <p className="text-xs font-bold uppercase tracking-[0.14em] text-faint">
                {dateLabel}
              </p>
              <h1 className="display-title mt-2 text-3xl text-ink sm:text-4xl">
                {t(greetingKey, { name: firstName })}
              </h1>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-accent/20 bg-accent-soft px-3.5 py-1.5 text-xs font-bold text-accent">
                {t("dash.goalLabel", { goal: goalLabel })}
              </span>
              {hasProfile && completeness && (
                <span className="flex items-center gap-2.5 rounded-full border border-line-strong bg-surface px-3.5 py-1.5 text-xs font-bold text-ink-soft">
                  <span className="h-1.5 w-14 overflow-hidden rounded-full bg-surface-2">
                    <span
                      className="block h-full rounded-full bg-success"
                      style={{ width: `${completeness.percentage}%` }}
                    />
                  </span>
                  {t("dash.header.profileChip", {
                    percent: completeness.percentage,
                  })}
                </span>
              )}
            </div>
          </div>
        </GlassCard>
      </section>

      {/* ----------------------------------------------------------------- */}
      {/* 2 · Quick actions — the five real workflow entry points.           */}
      {/* ----------------------------------------------------------------- */}
      <section className="mt-4 anim-fade-up" aria-label={t("dash.quick.title")}>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {quickItems.map((item) => (
            <Link
              key={item.key}
              href={item.href}
              className="group flex items-center gap-3 rounded-2xl border border-line bg-surface p-3.5 shadow-[var(--shadow-card)] transition-[transform,box-shadow,border-color] duration-300 hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-[var(--shadow-float)]"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent transition-colors duration-300 group-hover:bg-accent group-hover:text-white">
                <Icon name={item.icon} size={17} />
              </span>
              <span className="min-w-0 flex-1 text-sm font-bold leading-tight text-ink transition-colors group-hover:text-accent">
                {item.label}
              </span>
              <Icon
                name="arrowRight"
                size={14}
                className="shrink-0 text-faint transition-colors group-hover:text-accent rtl:-scale-x-100"
              />
            </Link>
          ))}
        </div>
      </section>

      {/* ----------------------------------------------------------------- */}
      {/* 3 · Statistics cards (real backend values only).                   */}
      {/* ----------------------------------------------------------------- */}
      <section className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          icon="mail"
          tone="accent"
          badge={t("badges.today")}
          value={usageSnapshot ? String(usageSnapshot.emails_sent) : "—"}
          suffix={
            usageSnapshot ? ` / ${usageSnapshot.daily_limit}` : undefined
          }
          label={t("dash.metrics.emailsSent")}
          footer={
            <QuotaIndicator
              data={
                usageSnapshot
                  ? {
                      used: usageSnapshot.emails_sent,
                      limit: usageSnapshot.daily_limit,
                      remaining: usageSnapshot.remaining,
                    }
                  : { used: null, limit: null, remaining: null }
              }
              unit={t("account.emailsUnit")}
              resetLabel={t("quota.resetsDaily")}
              labels={quotaLabels}
              upgradeHint={t("quota.upgrade")}
              variant="bar"
            />
          }
        />
        <StatCard
          icon="bookmark"
          tone="accent"
          badge={t("badges.you")}
          value={String(matching.savedTotal)}
          label={t("dash.metrics.saved")}
          detail={
            matching.savedTotal > 0
              ? t("dash.metrics.savedDetail", {
                  count: matching.completeCount,
                })
              : t("dash.metrics.savedDetailEmpty")
          }
          href="/opportunities/saved"
          hrefLabel={t("dash.metrics.savedCta")}
        />
        <StatCard
          icon="spark"
          tone="ai"
          badge={t("badges.you")}
          value={String(usage.ai_requests)}
          label={t("dash.metrics.aiUsage")}
          detail={
            aiData.used !== null &&
            aiData.limit !== null &&
            aiData.remaining !== null
              ? t("dash.metrics.aiUsageDetail", {
                  remaining: aiData.remaining,
                  limit: aiData.limit,
                })
              : aiData.limit === null
                ? t("quota.unlimited")
                : aiData.limit === 0
                  ? t("quota.unavailable")
                  : t("quota.unknown")
          }
          href="/ai"
          hrefLabel={t("dash.metrics.aiCta")}
          footer={
            <QuotaIndicator
              data={aiData}
              unit={t("quota.unitAi")}
              resetLabel={t("quota.resetsDaily")}
              labels={quotaLabels}
              upgradeHint={t("quota.upgrade")}
              variant="bar"
            />
          }
        />
        <StatCard
          icon="user"
          tone={
            hasProfile && completeness && completeness.missing.length === 0
              ? "success"
              : "warning"
          }
          badge={t("badges.profile")}
          value={hasProfile && completeness ? `${completeness.percentage}%` : "—"}
          label={
            hasProfile && completeness
              ? t("dash.metrics.profile")
              : t("dash.metrics.profileMissing")
          }
          footer={
            hasProfile && completeness ? (
              <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
                <div
                  className="h-full rounded-full bg-success transition-[width] duration-300"
                  style={{ width: `${completeness.percentage}%` }}
                />
              </div>
            ) : undefined
          }
          href={
            hasProfile && completeness ? undefined : "/bewerbung-scanner"
          }
          hrefLabel={
            hasProfile && completeness ? undefined : t("completeness.scanNow")
          }
        />
      </section>

      {/* ----------------------------------------------------------------- */}
      {/* 4 · Next action (server-derived rule chain).                       */}
      {/* ----------------------------------------------------------------- */}
      <NextActionCard action={nextAction} t={t} />

      {/* ----------------------------------------------------------------- */}
      {/* 5+6 · Main column | Sidebar (real server data throughout).         */}
      {/* ----------------------------------------------------------------- */}
      <section className="mt-6 grid items-start gap-5 xl:grid-cols-[1.35fr_0.65fr]">
        <div className="min-w-0 space-y-5">
          <ApplicationsCard
            items={recentApplications}
            t={t}
            locale={locale}
          />
          <RecommendationsCard
            recommendations={recommendations}
            t={t}
            locale={locale}
          />
          <SavedPreviewCard items={savedPreview} t={t} />
        </div>
        <div className="min-w-0 space-y-5">
          <CompletenessCard
            completeness={completeness}
            hasProfile={hasProfile}
            t={t}
          />
          <ActivityCard items={activities} t={t} locale={locale} />
          <MatchingCard matching={matching} t={t} locale={locale} />
          <EmailAccountCard account={emailAccount} />
          <AccountCard
            profile={profile}
            goalLabel={goalLabel}
            completion={completion}
            usageSnapshot={usageSnapshot}
            t={t}
          />
          {subscription && (
            <SubscriptionCard subscription={subscription} t={t} locale={locale} />
          )}
        </div>
      </section>

      {!emailAccount && hasCompletedScan && (
        <p className="mt-2 text-xs text-faint">{t("dash.connectEmailHint")}</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Quick-action + statistic card primitives
// ---------------------------------------------------------------------------

const toneStyles: Record<string, string> = {
  accent: "bg-accent-soft text-accent",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  ai: "bg-ai-soft text-ai",
};

function StatCard({
  icon,
  tone,
  badge,
  value,
  suffix,
  label,
  detail,
  href,
  hrefLabel,
  footer,
}: {
  icon: IconName;
  tone: keyof typeof toneStyles;
  badge: string;
  value: string;
  suffix?: string;
  label: string;
  detail?: string;
  href?: string;
  hrefLabel?: string;
  /** Optional node under the label (quota bar / progress). The wrapper is
   *  min-w-0 and lets the shared QuotaIndicator's nowrap text wrap on
   *  narrow screens so the grid track can never be pushed wider. */
  footer?: React.ReactNode;
}) {
  return (
    <div className="surface-elevated min-w-0 rounded-3xl p-5 transition-shadow duration-300 hover:shadow-[var(--shadow-float)]">
      <div className="flex items-start justify-between gap-3">
        <span
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${toneStyles[tone]}`}
        >
          <Icon name={icon} size={17} />
        </span>
        <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-faint">
          {badge}
        </span>
      </div>
      <p className="num mt-4 text-3xl font-extrabold text-ink">
        {value}
        {suffix ? (
          <span className="text-base font-semibold text-muted"> {suffix}</span>
        ) : null}
      </p>
      <p className="mt-1 text-sm font-semibold text-ink-soft">{label}</p>
      {detail ? (
        <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted">
          {detail}
        </p>
      ) : null}
      {footer ? (
        <div className="mt-3 min-w-0 [&_.whitespace-nowrap]:whitespace-normal">
          {footer}
        </div>
      ) : null}
      {href && hrefLabel ? (
        <Link
          href={href}
          className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-accent transition-colors hover:text-accent-deep"
        >
          {hrefLabel}
          <Icon name="arrowRight" size={12} className="rtl:-scale-x-100" />
        </Link>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Next action (server-derived rule chain — label/reason/CTA are data text)
// ---------------------------------------------------------------------------

function NextActionCard({ action, t }: { action: NextAction; t: T }) {
  return (
    <section className="mt-4">
      <GlassCard
        variant="surface-elevated"
        className="relative flex flex-col gap-4 overflow-hidden p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6"
      >
        <div
          className="pointer-events-none absolute inset-y-0 start-0 w-1.5"
          style={{ backgroundImage: "var(--gradient-neon)" }}
        />
        <div className="flex min-w-0 items-start gap-4 ps-2">
          <span className="hidden h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-accent-soft text-accent sm:flex">
            <Icon name="arrowRight" size={21} className="rtl:-scale-x-100" />
          </span>
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-accent">
              {t("dash.nextAction")}
            </p>
            <h2 className="mt-1 text-lg font-bold tracking-tight text-ink sm:text-xl">
              {action.label}
            </h2>
            <p className="mt-1 max-w-2xl text-xs leading-5 text-muted">
              {action.reason}
            </p>
          </div>
        </div>
        <Link href={action.href} className="shrink-0">
          <Button className="rounded-2xl">
            {action.ctaLabel}
            <Icon name="arrowRight" size={16} className="rtl:-scale-x-100" />
          </Button>
        </Link>
      </GlassCard>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Application status cards (the user's own campaigns — real rows only)
// ---------------------------------------------------------------------------

function ApplicationsCard({
  items,
  t,
  locale,
}: {
  items: RecentApplication[];
  t: T;
  locale: string;
}) {
  return (
    <GlassCard variant="surface" className="overflow-hidden" as="section">
      <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-5 sm:px-6">
        <div className="min-w-0">
          <h2 className="font-bold tracking-tight text-ink">
            {t("dash.sections.applications.title")}
          </h2>
          <p className="mt-1 text-xs text-muted">
            {t("dash.sections.applications.hint")}
          </p>
        </div>
        <Link
          href="/bewerbung-automation"
          className="shrink-0 rounded-xl border border-line-strong bg-surface px-3 py-2 text-xs font-bold text-accent transition-colors hover:bg-accent-soft"
        >
          {t("dash.sections.applications.cta")}
        </Link>
      </div>
      {items.length === 0 ? (
        <EmptyState
          icon="send"
          title={t("dash.empty.noApplications.title")}
          body={t("dash.empty.noApplications.body")}
        />
      ) : (
        <div className="divide-y divide-line">
          {items.map((item) => (
            <ApplicationRow key={item.id} item={item} t={t} locale={locale} />
          ))}
        </div>
      )}
    </GlassCard>
  );
}

function ApplicationRow({
  item,
  t,
  locale,
}: {
  item: RecentApplication;
  t: T;
  locale: string;
}) {
  const status = appStatus(item, t);
  const goal =
    item.goal === "ausbildung"
      ? t("dash.goalAusbildung")
      : item.goal === "arbeit"
        ? t("dash.goalArbeit")
        : null;
  const context = [
    item.company ?? item.opportunity_title ?? null,
    goal,
    formatDate(item.updated_at, locale),
  ]
    .filter(Boolean)
    .join(" · ");
  const showSent =
    item.campaign_status !== null &&
    item.total_recipients !== null &&
    item.total_recipients > 0 &&
    item.sent_count !== null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 transition-colors hover:bg-surface-2/40 sm:px-6">
      <div className="min-w-0 flex-1 basis-52">
        <Link
          href="/bewerbung-automation"
          className="block truncate text-sm font-bold text-ink transition-colors hover:text-accent"
        >
          {item.subject || t("dash.apps.untitled")}
        </Link>
        <p className="mt-0.5 truncate text-xs text-muted">
          {context || t("common.notDocumented")}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2.5">
        {showSent ? (
          <span className="num text-xs font-semibold text-muted">
            {t("dash.apps.sentOf", {
              sent: item.sent_count as number,
              total: item.total_recipients as number,
            })}
          </span>
        ) : null}
        <span
          className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${status.tone}`}
        >
          {status.label}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Recommendations (server-resolved + matcher v2 — never fabricated)
// ---------------------------------------------------------------------------

function RecommendationsCard({
  recommendations,
  t,
  locale,
}: {
  recommendations: DashboardRecommendations;
  t: T;
  locale: string;
}) {
  return (
    <GlassCard variant="surface" className="overflow-hidden" as="section">
      <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-5 sm:px-6">
        <div>
          <h2 className="font-bold tracking-tight text-ink">
            {t("dash.sections.recommended.title")}
          </h2>
          <p className="mt-1 text-xs text-muted">
            {t("dash.sections.recommended.hint")}
          </p>
        </div>
        <Link
          href="/opportunities"
          className="shrink-0 rounded-xl border border-line-strong bg-surface px-3 py-2 text-xs font-bold text-accent transition-colors hover:bg-accent-soft"
        >
          {t("dash.buttons.searchAll")}
        </Link>
      </div>
      {recommendations.available ? (
        recommendations.items.length > 0 ? (
          <div className="divide-y divide-line">
            {recommendations.items.map((item) => (
              <RecommendationRow
                key={item.opportunity.id}
                item={item}
                t={t}
                locale={locale}
              />
            ))}
          </div>
        ) : (
          <EmptyState
            icon="search"
            title={t("dash.empty.noMatches.title")}
            body={t("dash.empty.noMatches.body")}
          />
        )
      ) : (
        <EmptyState
          icon="search"
          title={t("dash.empty.recsUnavailable.title")}
          body={
            recommendations.blockedReason === "no_profile"
              ? t("dash.empty.recsUnavailable.bodyNoProfile")
              : recommendations.blockedReason === "no_keyword"
                ? t("dash.empty.recsUnavailable.bodyNoKeyword")
                : t("dash.empty.recsUnavailable.bodySource")
          }
        />
      )}
    </GlassCard>
  );
}

function RecommendationRow({
  item,
  t,
  locale,
}: {
  item: RecommendationItem;
  t: T;
  locale: string;
}) {
  const { opportunity, match, saved } = item;
  const isComplete = match?.status === "complete";
  const isIncomplete = match?.status === "incomplete";
  const reason = isComplete
    ? (match?.reasons[0] ?? null)
    : isIncomplete
      ? `Match incomplete: ${match?.missing_information[0] ?? "required profile data missing"}`
      : null;
  const initial = (opportunity.company_name || "?").trim().charAt(0) || "?";
  return (
    <div className="flex flex-wrap items-center gap-3 px-5 py-4 transition-colors hover:bg-surface-2/40 sm:px-6">
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-accent-soft text-base font-extrabold text-accent">
        {initial}
      </span>
      <div className="min-w-0 flex-1 basis-48">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={`/opportunities/${encodeURIComponent(opportunity.id)}`}
            className="text-sm font-bold text-ink transition-colors hover:text-accent"
          >
            {opportunity.title || t("dash.untitled")}
          </Link>
          <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.06em] text-muted">
            {opportunity.goal === "ausbildung"
              ? t("dash.goalAusbildung")
              : t("dash.goalArbeit")}
          </span>
        </div>
        <p className="mt-1 text-xs text-muted">
          {[
            opportunity.company_name,
            opportunity.location,
            opportunity.posted_at
              ? t("dash.posted", {
                  date: formatDate(opportunity.posted_at, locale),
                })
              : null,
            opportunity.salary?.label ?? null,
          ]
            .filter(Boolean)
            .join(" · ") || t("common.notDocumented")}
        </p>
        {reason && <p className="mt-1.5 text-xs leading-5 text-muted">{reason}</p>}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {isComplete && match?.score !== null && (
          <span className="rounded-full bg-success-soft px-2.5 py-1 text-xs font-bold text-success">
            {t("dash.status.match")}: {match.score} %
          </span>
        )}
        {isIncomplete && (
          <span className="rounded-full bg-warning-soft px-2.5 py-1 text-xs font-bold text-warning">
            {t("dash.status.incomplete")}
          </span>
        )}
        <Link
          href={`/opportunities/${encodeURIComponent(opportunity.id)}`}
          className="rounded-xl border border-line-strong bg-surface px-3 py-1.5 text-xs font-bold text-accent transition-colors hover:bg-accent-soft"
        >
          {t("dash.buttons.view")}
        </Link>
        <SaveOpportunityButton
          opportunityKey={opportunity.id}
          initialSaved={saved}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Saved preview (Phase 7 snapshot/staleness semantics)
// ---------------------------------------------------------------------------

function SavedPreviewCard({ items, t }: { items: SavedPreviewItem[]; t: T }) {
  return (
    <GlassCard variant="surface" className="overflow-hidden" as="section">
      <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-5 sm:px-6">
        <div>
          <h2 className="font-bold tracking-tight text-ink">
            {t("dash.sections.saved.title")}
          </h2>
          <p className="mt-1 text-xs text-muted">
            {t("dash.sections.saved.hint")}
          </p>
        </div>
        <Link
          href="/opportunities/saved"
          className="shrink-0 rounded-xl border border-line-strong bg-surface px-3 py-2 text-xs font-bold text-accent transition-colors hover:bg-accent-soft"
        >
          {t("dash.buttons.allSaved")}
        </Link>
      </div>
      {items.length > 0 ? (
        <div className="divide-y divide-line">
          {items.map((item) => (
            <div
              key={item.id}
              className="flex flex-wrap items-center justify-between gap-2 px-5 py-3.5 transition-colors hover:bg-surface-2/40 sm:px-6"
            >
              <div className="min-w-0 basis-48 flex-1">
                <Link
                  href={`/opportunities/${encodeURIComponent(item.opportunity_key)}`}
                  className="block truncate text-sm font-semibold text-ink transition-colors hover:text-accent"
                >
                  {item.title || t("dash.untitled")}
                </Link>
                <p className="mt-0.5 truncate text-xs text-muted">
                  {item.company_name || t("dash.noCompany")}
                  {item.location ? ` · ${item.location}` : ""} ·{" "}
                  {t("dash.savedOn", {
                    date: item.savedAtLabel ?? "—",
                  })}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                {item.match_score !== null && (
                  <span
                    className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${
                      item.stale
                        ? "bg-surface-2 text-faint"
                        : "bg-accent-soft text-accent"
                    }`}
                    title={
                      item.stale
                        ? item.staleReasons.join(" ")
                        : t("dash.status.snapshot")
                    }
                  >
                    {item.match_score} %
                    {item.stale ? ` · ${t("dash.status.stale")}` : ""}
                  </span>
                )}
                {item.match_score === null &&
                  item.match_status === "incomplete" && (
                    <span className="rounded-full bg-warning-soft px-2.5 py-1 text-[11px] font-bold text-warning">
                      {t("dash.status.incomplete")}
                    </span>
                  )}
                <Link
                  href={`/opportunities/${encodeURIComponent(item.opportunity_key)}`}
                  className="rounded-xl border border-line-strong bg-surface px-3 py-1.5 text-xs font-bold text-accent transition-colors hover:bg-accent-soft"
                >
                  {t("dash.buttons.view")}
                </Link>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState
          icon="bookmark"
          title={t("dash.empty.nothingSaved.title")}
          body={t("dash.empty.nothingSaved.body")}
        />
      )}
    </GlassCard>
  );
}

// ---------------------------------------------------------------------------
// Completeness (deterministic 12-section check, server-derived)
// ---------------------------------------------------------------------------

function CompletenessCard({
  completeness,
  hasProfile,
  t,
}: {
  completeness: ProfileCompleteness | null;
  hasProfile: boolean;
  t: T;
}) {
  return (
    <GlassCard variant="surface" className="p-5 sm:p-6" as="section">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="font-bold tracking-tight text-ink">
            {t("completeness.title")}
          </h2>
          <p className="mt-1 text-xs text-muted">{t("completeness.hint")}</p>
        </div>
        {hasProfile && completeness && (
          <span className="num text-3xl font-extrabold text-ink">
            {completeness.percentage}%
          </span>
        )}
      </div>
      {!hasProfile || !completeness ? (
        <div className="mt-4">
          <EmptyState
            icon="user"
            title={t("completeness.noProfile")}
            body={t("completeness.noProfileBody")}
            cta={{
              label: t("completeness.scanNow"),
              href: "/bewerbung-scanner",
            }}
          />
        </div>
      ) : (
        <>
          <div className="mt-4 h-2 overflow-hidden rounded-full bg-surface-2">
            <div
              className="h-full rounded-full bg-success transition-[width] duration-300"
              style={{ width: `${completeness.percentage}%` }}
            />
          </div>
          {completeness.missing.length === 0 ? (
            <p className="mt-4 rounded-2xl bg-success-soft p-3.5 text-xs font-semibold text-success">
              {t("completeness.allDocumented")}
            </p>
          ) : (
            <>
              <p className="mt-4 text-[10px] font-bold uppercase tracking-[0.1em] text-faint">
                {t("completeness.missing", {
                  count: completeness.missing.length,
                })}
              </p>
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {completeness.missing.map((section) => (
                  <li
                    key={section}
                    className="rounded-lg bg-warning-soft px-2.5 py-1 text-[11px] font-semibold text-warning"
                  >
                    {section}
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-[10px] font-bold uppercase tracking-[0.1em] text-faint">
                {t("completeness.documented", {
                  count: completeness.completed.length,
                })}
              </p>
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {completeness.completed.map((section) => (
                  <li
                    key={section}
                    className="rounded-lg bg-success-soft px-2.5 py-1 text-[11px] font-semibold text-success"
                  >
                    {section}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </GlassCard>
  );
}

// ---------------------------------------------------------------------------
// Recent activity (activity_logs — the user's own rows, newest first)
// ---------------------------------------------------------------------------

function ActivityCard({
  items,
  t,
  locale,
}: {
  items: ActivityLog[];
  t: T;
  locale: string;
}) {
  return (
    <GlassCard variant="surface" className="overflow-hidden" as="section">
      <div className="border-b border-line px-5 py-5 sm:px-6">
        <h2 className="font-bold tracking-tight text-ink">
          {t("dash.sections.activity.title")}
        </h2>
        <p className="mt-1 text-xs text-muted">
          {t("dash.sections.activity.hint")}
        </p>
      </div>
      {items.length === 0 ? (
        <EmptyState
          icon="activity"
          title={t("dash.empty.noActivity.title")}
          body={t("dash.empty.noActivity.body")}
        />
      ) : (
        <ol className="px-5 py-4 sm:px-6">
          {items.map((item, index) => (
            <li key={item.id} className="relative flex gap-3.5 pb-5 last:pb-0">
              {index < items.length - 1 && (
                <span
                  aria-hidden="true"
                  className="absolute bottom-0 top-10 start-[17px] w-px bg-line"
                />
              )}
              <span className="relative z-10 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-line bg-surface text-accent">
                <Icon name={activityIcon(item.activity_type)} size={15} />
              </span>
              <div className="min-w-0 flex-1 pt-1">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                  <p className="text-sm font-semibold leading-snug text-ink">
                    {item.title}
                  </p>
                  <time className="shrink-0 text-[11px] font-semibold text-faint">
                    {formatDate(item.created_at, locale)}
                  </time>
                </div>
                {item.description ? (
                  <p className="mt-0.5 text-xs leading-5 text-muted">
                    {item.description}
                  </p>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      )}
    </GlassCard>
  );
}

// ---------------------------------------------------------------------------
// Matching (Phase 7 snapshots — never a fabricated ranking)
// ---------------------------------------------------------------------------

function MatchingCard({
  matching,
  t,
  locale,
}: {
  matching: MatchingSummary;
  t: T;
  locale: string;
}) {
  if (!matching.hasCandidateProfile) {
    return (
      <GlassCard variant="surface" className="p-5 sm:p-6" as="section">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0">
            <h2 className="font-bold tracking-tight text-ink">
              {t("matching.title")}
            </h2>
            <p className="mt-1 text-xs text-muted">{t("matching.noProfile")}</p>
          </div>
          <Link
            href="/bewerbung-scanner"
            className="shrink-0 rounded-xl bg-accent-soft px-4 py-2 text-xs font-bold text-accent transition-colors hover:bg-accent hover:text-white"
          >
            {t("matching.scanCta")}
          </Link>
        </div>
      </GlassCard>
    );
  }
  return (
    <GlassCard variant="surface" className="p-5 sm:p-6" as="section">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="font-bold tracking-tight text-ink">
            {t("matching.title")}
          </h2>
          <p className="mt-1 max-w-md text-xs leading-5 text-muted">
            {t("matching.hint")}
          </p>
        </div>
        <Link
          href="/opportunities/saved"
          className="shrink-0 rounded-xl bg-accent-soft px-4 py-2 text-xs font-bold text-accent transition-colors hover:bg-accent hover:text-white"
        >
          {t("dash.buttons.allSaved")}
        </Link>
      </div>
      <div className="mt-4 grid grid-cols-3 gap-2 sm:gap-3">
        <div className="rounded-2xl bg-surface-2 p-3 sm:p-3.5">
          <p className="text-[11px] font-semibold text-muted sm:text-xs">
            {t("matching.evaluated")}
          </p>
          <p className="num mt-1 text-xl font-extrabold text-ink sm:text-2xl">
            {matching.savedTotal}
          </p>
        </div>
        <div className="rounded-2xl bg-success-soft p-3 sm:p-3.5">
          <p className="text-[11px] font-semibold text-success sm:text-xs">
            {t("matching.complete")}
          </p>
          <p className="num mt-1 text-xl font-extrabold text-ink sm:text-2xl">
            {matching.completeCount}
          </p>
        </div>
        <div className="rounded-2xl bg-warning-soft p-3 sm:p-3.5">
          <p className="text-[11px] font-semibold text-warning sm:text-xs">
            {t("matching.incomplete")}
          </p>
          <p className="num mt-1 text-xl font-extrabold text-ink sm:text-2xl">
            {matching.incompleteCount}
          </p>
        </div>
      </div>
      {matching.top.length > 0 && (
        <>
          <p className="mt-4 text-[10px] font-bold uppercase tracking-[0.1em] text-faint">
            {t("matching.recentlyMatched")}
          </p>
          <ul className="mt-1 divide-y divide-line">
            {matching.top.map((item) => (
              <li key={item.opportunity_key} className="py-2.5">
                <Link
                  href={`/opportunities/${encodeURIComponent(item.opportunity_key)}`}
                  className="text-sm font-semibold text-ink transition-colors hover:text-accent"
                >
                  {item.title || t("matching.untitled")}
                </Link>
                <span className="ms-2 text-xs text-muted">
                  {item.location || t("matching.locationNotListed")} ·{" "}
                  {t("matching.snapshot")} {item.match_score} % ·{" "}
                  {formatDate(item.saved_at, locale)}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </GlassCard>
  );
}

// ---------------------------------------------------------------------------
// Account summary (the user's own profile fields)
// ---------------------------------------------------------------------------

function AccountCard({
  profile,
  goalLabel,
  completion,
  usageSnapshot,
  t,
}: {
  profile: { full_name: string; email: string; account_status: string };
  goalLabel: string;
  completion: number;
  usageSnapshot: UsageSnapshot | null;
  t: T;
}) {
  return (
    <GlassCard variant="surface" className="p-5 sm:p-6" as="section">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="font-bold text-ink">
            {t("dash.sections.account.title")}
          </h2>
          <p className="mt-1 text-xs text-muted">
            {t("dash.sections.account.hint")}
          </p>
        </div>
        <span className="rounded-full bg-success-soft px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.08em] text-success">
          {profile.account_status}
        </span>
      </div>
      <dl className="mt-6 space-y-3.5 text-sm">
        <Detail label={t("dash.detail.fullName")} value={profile.full_name} />
        <Detail label={t("dash.detail.email")} value={profile.email} />
        <Detail label={t("dash.detail.goal")} value={goalLabel} />
        <Detail
          label={t("dash.detail.onboarding")}
          value={`${completion}%`}
        />
        <Detail
          label={t("dash.detail.emailLimit")}
          value={
            usageSnapshot
              ? t("dash.detail.emails", { count: usageSnapshot.daily_limit })
              : t("quota.unknown")
          }
        />
      </dl>
    </GlassCard>
  );
}

// ---------------------------------------------------------------------------
// Subscription card — display-only summary of the user's own subscription.
// Never grants anything: plan identity comes from the server-resolved
// BillingStatus row (historical plans keep their label), entitlements are
// decided exclusively by the entitlement service elsewhere.
// ---------------------------------------------------------------------------

/** Exported for behavioral tests: the card is display-only — it renders
 *  the server-resolved summary and nothing else (no entitlement logic). */
export function SubscriptionCard({
  subscription,
  t,
  locale,
}: {
  subscription: DashboardSubscription;
  t: T;
  locale: string;
}) {
  const statusKey =
    subscription.status === "active"
      ? "statusActive"
      : subscription.status === "canceled"
        ? "statusCanceled"
        : subscription.status === "expired"
          ? "statusExpired"
          : "statusNone";
  const tone =
    subscription.status === "active"
      ? "bg-success-soft text-success"
      : subscription.status === "none"
        ? "bg-line/60 text-muted"
        : "bg-warning-soft text-warning";
  return (
    <GlassCard variant="surface" className="p-5 sm:p-6" as="section">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-bold text-ink">{t("dash.subscription.title")}</h2>
        <Link
          href="/settings/billing"
          className="text-xs font-semibold text-accent hover:underline"
        >
          {t("dash.subscription.manage")}
        </Link>
      </div>
      {subscription.lookupFailed ? (
        <p className="mt-3 text-xs leading-5 text-muted">
          {t("billing.currentPlan.lookupFailed")}
        </p>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-2.5">
            <span className="text-base font-bold text-ink">
              {subscription.planLabel}
            </span>
            <span
              className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.08em] ${tone}`}
            >
              {t(`billing.currentPlan.${statusKey}`)}
            </span>
          </div>
          {subscription.status === "none" && (
            <p className="mt-2.5 text-xs text-muted">
              {t("dash.subscription.none")}
            </p>
          )}
          {(subscription.status === "canceled" ||
            subscription.status === "expired") && (
            <p className="mt-2.5 text-xs text-muted">
              {t("dash.subscription.lapsed")}
            </p>
          )}
          {(subscription.periodStartMs !== null ||
            subscription.periodEndMs !== null ||
            subscription.provider !== null) && (
            <dl className="mt-5 space-y-3.5 text-sm">
              {subscription.periodStartMs !== null && (
                <Detail
                  label={t("billing.currentPlan.periodStart")}
                  value={formatDate(
                    new Date(subscription.periodStartMs).toISOString(),
                    locale,
                  )}
                />
              )}
              {subscription.periodEndMs !== null && (
                <Detail
                  label={t("billing.currentPlan.periodEnd")}
                  value={formatDate(
                    new Date(subscription.periodEndMs).toISOString(),
                    locale,
                  )}
                />
              )}
              {subscription.provider !== null && (
                <Detail
                  label={t("billing.currentPlan.provider")}
                  value={
                    subscription.provider === "mock"
                      ? t("billing.currentPlan.providerMock")
                      : subscription.provider
                  }
                />
              )}
            </dl>
          )}
        </>
      )}
    </GlassCard>
  );
}

// ---------------------------------------------------------------------------
// Small shared pieces
// ---------------------------------------------------------------------------

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-line pb-3">
      <dt className="shrink-0 text-xs text-muted">{label}</dt>
      <dd className="max-w-[62%] break-words text-end text-xs font-semibold text-ink-soft">
        {value}
      </dd>
    </div>
  );
}

/** Locale-aware short date (de-DE / en-US / fr-FR / ar). */
function formatDate(value: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
  }).format(date);
}
