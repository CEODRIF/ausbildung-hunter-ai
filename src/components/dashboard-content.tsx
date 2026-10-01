import Link from "next/link";
import { Button, Card } from "@/components/ui";
import { Icon, type IconName } from "@/components/icon";
import { FeatureCard } from "@/components/feature-card";
import { EmptyState } from "@/components/empty-state";
import type {
  DashboardData,
  DashboardRecommendations,
  MatchingSummary,
  RecommendationItem,
  SavedPreviewItem,
} from "@/lib/dashboard";
import { getProfileCompletion } from "@/lib/dashboard";
import type {
  NextAction,
  ProfileCompleteness,
} from "@/lib/dashboard-intelligence";
import { EmailAccountCard } from "@/components/email-account-card";
import { SaveOpportunityButton } from "@/components/opportunity-save-button";
import { getServerT, getRequestLang } from "@/lib/i18n/server";
import { localeForLang, type Language, type TranslateVars } from "@/lib/i18n/core";

type T = (path: string, vars?: TranslateVars) => string;

export async function DashboardContent({ data }: { data: DashboardData }) {
  const t = await getServerT();
  const lang = (await getRequestLang()) as Language;
  const locale = localeForLang(lang);
  const {
    profile,
    usage,
    usageSnapshot,
    aiLimit,
    applicationsCount,
    emailAccount,
    hasCompletedScan,
    matching,
    candidateProfile,
    completeness,
    nextAction,
    savedPreview,
    recommendations,
  } = data;
  const isAusbildung = profile.selected_goal === "ausbildung";
  const goalLabel = t(
    isAusbildung ? "dash.goalAusbildung" : "dash.goalArbeit",
  );
  const completion = getProfileCompletion(profile);
  const firstName = profile.full_name.trim().split(" ")[0] || "";
  const remaining = Math.max(usageSnapshot.remaining, 0);
  const aiRemaining = Math.max(aiLimit - usage.ai_requests, 0);
  const hour = new Date().getHours();
  const greetingKey =
    hour >= 5 && hour < 11
      ? "dash.greeting.morning"
      : hour >= 11 && hour < 18
        ? "dash.greeting.afternoon"
        : "dash.greeting.evening";

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8 lg:px-10">
      {/* ----------------------------------------------------------------- */}
      {/* Hero — what the product is, and the two primary actions.           */}
      {/* ----------------------------------------------------------------- */}
      <section className="relative overflow-hidden rounded-3xl border border-line bg-surface p-6 sm:p-8">
        <div className="hero-orb pointer-events-none absolute -end-24 -top-24 h-80 w-80 rounded-full" />
        <div className="grid-fade pointer-events-none absolute inset-x-0 bottom-0 h-40 opacity-40 [mask-image:linear-gradient(to_bottom,transparent,black)]" />
        <div className="relative">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm font-semibold text-accent">
              {t(greetingKey, { name: firstName })}
            </p>
            <span className="rounded-lg border border-accent/20 bg-accent-soft px-2.5 py-1 text-xs font-bold text-accent">
              {t("dash.goalLabel", { goal: goalLabel })}
            </span>
          </div>
          <h1 className="mt-3 max-w-2xl text-3xl font-bold leading-[1.08] tracking-[-0.04em] text-ink sm:text-4xl">
            {t("dash.hero.title")}
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-muted sm:text-[15px]">
            {t("dash.hero.subtitle")}
          </p>
          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            <Link href="/opportunities/ai-search">
              <Button size="lg">
                <Icon name="spark" size={17} />
                {t("dash.hero.ctaFind")}
              </Button>
            </Link>
            <Link href="/bewerbung-scanner">
              <Button size="lg" variant="secondary">
                <Icon name="scan" size={17} />
                {t("dash.hero.ctaAnalyze")}
              </Button>
            </Link>
          </div>
        </div>
      </section>

      {/* ----------------------------------------------------------------- */}
      {/* Feature cards — the five ways in, each with a real action.         */}
      {/* ----------------------------------------------------------------- */}
      <section className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <FeatureCard
          icon="search"
          title={t("dash.features.search.title")}
          text={t("dash.features.search.text")}
          action={{ label: t("dash.features.search.action"), href: "/opportunities/ai-search" }}
        />
        <FeatureCard
          icon="spark"
          title={t("dash.features.assistant.title")}
          text={t("dash.features.assistant.text")}
          action={{ label: t("dash.features.assistant.action"), href: "/ai" }}
        />
        <FeatureCard
          icon="scan"
          title={t("dash.features.scanner.title")}
          text={t("dash.features.scanner.text")}
          action={{ label: t("dash.features.scanner.action"), href: "/bewerbung-scanner" }}
        />
        <FeatureCard
          icon="target"
          title={t("dash.features.opportunities.title")}
          text={t("dash.features.opportunities.text")}
          action={{ label: t("dash.features.opportunities.action"), href: "/opportunities" }}
        />
        <FeatureCard
          icon="briefcase"
          title={t("dash.features.applications.title")}
          text={t("dash.features.applications.text")}
          action={{ label: t("dash.features.applications.action"), href: "/applications" }}
        />
      </section>

      <NextActionCard action={nextAction} t={t} />

      {/* ----------------------------------------------------------------- */}
      {/* User progress — real backend values only.                          */}
      {/* ----------------------------------------------------------------- */}
      <section className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <UsageCard
          sent={usageSnapshot.emails_sent}
          limit={usageSnapshot.daily_limit}
          remaining={remaining}
          t={t}
        />
        <MetricCard
          label={t("dash.metrics.applications")}
          value={applicationsCount}
          detail={t("dash.metrics.applicationsDetail")}
          icon="file"
          tone="success"
          href="/applications/new"
          hrefLabel={t("dash.metrics.applicationsCta")}
          badge={t("badges.you")}
        />
        <MetricCard
          label={t("dash.metrics.saved")}
          value={matching.savedTotal}
          detail={
            matching.savedTotal > 0
              ? t("dash.metrics.savedDetail", { count: matching.completeCount })
              : t("dash.metrics.savedDetailEmpty")
          }
          icon="bookmark"
          tone="accent"
          href="/opportunities/saved"
          hrefLabel={t("dash.metrics.savedCta")}
          badge={t("badges.you")}
        />
        <MetricCard
          label={t("dash.metrics.aiUsage")}
          value={usage.ai_requests}
          detail={t("dash.metrics.aiUsageDetail", {
            remaining: aiRemaining,
            limit: aiLimit,
          })}
          icon="spark"
          tone="ai"
          href="/ai"
          hrefLabel={t("dash.metrics.aiCta")}
          badge={t("badges.you")}
        />
        <ProfileMetricCard
          completeness={completeness}
          hasProfile={Boolean(candidateProfile)}
          t={t}
        />
      </section>

      {/* ----------------------------------------------------------------- */}
      {/* Data areas (real server data; professional empty states).          */}
      {/* ----------------------------------------------------------------- */}
      <section className="mt-6 grid gap-5 xl:grid-cols-[1.3fr_0.7fr]">
        <div className="min-w-0">
          <RecommendationsCard recommendations={recommendations} t={t} locale={locale} />
          <SavedPreviewCard items={savedPreview} t={t} />
          <MatchingCard matching={matching} t={t} locale={locale} />
        </div>
        <div className="min-w-0">
          <CompletenessCard
            completeness={completeness}
            hasProfile={Boolean(candidateProfile)}
            t={t}
          />
          <WorkflowNav goalLabel={goalLabel} t={t} />
          <Card className="mt-5 p-5 sm:p-6" as="section">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="font-bold text-ink">{t("dash.sections.account.title")}</h2>
                <p className="mt-1 text-xs text-muted">
                  {t("dash.sections.account.hint")}
                </p>
              </div>
              <span className="rounded-lg bg-success-soft px-2 py-1 text-[10px] font-bold uppercase tracking-[0.08em] text-success">
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
                value={t("dash.detail.emails", {
                  count: usageSnapshot.daily_limit,
                })}
              />
            </dl>
          </Card>
        </div>
      </section>

      <EmailAccountCard account={emailAccount} />
      {!emailAccount && hasCompletedScan && (
        <p className="mt-2 text-xs text-faint">
          {t("dash.connectEmailHint")}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Next action (server-derived rule chain — label/reason/CTA are data text)
// ---------------------------------------------------------------------------

function NextActionCard({ action, t }: { action: NextAction; t: T }) {
  return (
    <section className="mt-6">
      <Card className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
        <div className="flex min-w-0 items-start gap-4">
          <span className="hidden h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-accent-soft text-accent sm:flex">
            <Icon name="arrowRight" size={20} className="rtl:-scale-x-100" />
          </span>
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-accent">
              {t("dash.nextAction")}
            </p>
            <h2 className="mt-1 text-lg font-bold tracking-[-0.02em] text-ink sm:text-xl">
              {action.label}
            </h2>
            <p className="mt-1 max-w-2xl text-xs leading-5 text-muted">
              {action.reason}
            </p>
          </div>
        </div>
        <Link href={action.href} className="shrink-0">
          <Button>
            {action.ctaLabel}
            <Icon name="arrowRight" size={16} className="rtl:-scale-x-100" />
          </Button>
        </Link>
      </Card>
    </section>
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
    <section className="mt-6">
      <Card className="overflow-hidden" as="section">
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-5 sm:px-6">
          <div>
            <h2 className="font-bold text-ink">{t("dash.sections.recommended.title")}</h2>
            <p className="mt-1 text-xs text-muted">
              {t("dash.sections.recommended.hint")}
            </p>
          </div>
          <Link
            href="/opportunities"
            className="shrink-0 rounded-xl border border-line-strong px-3 py-2 text-xs font-bold text-accent transition-colors hover:bg-accent-soft"
          >
            {t("dash.buttons.searchAll")}
          </Link>
        </div>
        {recommendations.available ? (
          recommendations.items.length > 0 ? (
            <div className="divide-y divide-line">
              {recommendations.items.map((item) => (
                <RecommendationRow key={item.opportunity.id} item={item} t={t} locale={locale} />
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
      </Card>
    </section>
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
  return (
    <div className="px-5 py-4 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href={`/opportunities/${encodeURIComponent(opportunity.id)}`}
              className="text-sm font-bold text-ink transition-colors hover:text-accent"
            >
              {opportunity.title || t("dash.untitled")}
            </Link>
            <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.06em] text-muted">
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
                ? t("dash.posted", { date: formatDate(opportunity.posted_at, locale) })
                : null,
              opportunity.salary?.label ?? null,
            ]
              .filter(Boolean)
              .join(" · ") || t("common.notDocumented")}
          </p>
          {reason && (
            <p className="mt-1.5 text-xs leading-5 text-muted">{reason}</p>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {isComplete && match?.score !== null && (
            <span className="rounded-lg bg-success-soft px-2 py-1 text-xs font-bold text-success">
              {t("dash.status.match")}: {match.score} %
            </span>
          )}
          {isIncomplete && (
            <span className="rounded-lg bg-warning-soft px-2 py-1 text-xs font-bold text-warning">
              {t("dash.status.incomplete")}
            </span>
          )}
          <Link
            href={`/opportunities/${encodeURIComponent(opportunity.id)}`}
            className="rounded-lg border border-line-strong px-2.5 py-1.5 text-xs font-bold text-accent transition-colors hover:bg-accent-soft"
          >
            {t("dash.buttons.view")}
          </Link>
          <SaveOpportunityButton
            opportunityKey={opportunity.id}
            initialSaved={saved}
          />
          <Link
            href={`/applications/new?opp=${encodeURIComponent(opportunity.id)}`}
            className="rounded-lg bg-accent-soft px-2.5 py-1.5 text-xs font-bold text-accent transition-colors hover:bg-accent hover:text-white"
          >
            {t("dash.buttons.prepare")}
          </Link>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Saved preview (Phase 7 snapshot/staleness semantics)
// ---------------------------------------------------------------------------

function SavedPreviewCard({
  items,
  t,
}: {
  items: SavedPreviewItem[];
  t: T;
}) {
  return (
    <section className="mt-5">
      <Card className="overflow-hidden" as="section">
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-5 sm:px-6">
          <div>
            <h2 className="font-bold text-ink">{t("dash.sections.saved.title")}</h2>
            <p className="mt-1 text-xs text-muted">
              {t("dash.sections.saved.hint")}
            </p>
          </div>
          <Link
            href="/opportunities/saved"
            className="shrink-0 rounded-xl border border-line-strong px-3 py-2 text-xs font-bold text-accent transition-colors hover:bg-accent-soft"
          >
            {t("dash.buttons.allSaved")}
          </Link>
        </div>
        {items.length > 0 ? (
          <div className="divide-y divide-line">
            {items.map((item) => (
              <div
                key={item.id}
                className="flex flex-wrap items-center justify-between gap-2 px-5 py-3.5 sm:px-6"
              >
                <div className="min-w-0">
                  <Link
                    href={`/opportunities/${encodeURIComponent(item.opportunity_key)}`}
                    className="text-sm font-semibold text-ink transition-colors hover:text-accent"
                  >
                    {item.title || t("dash.untitled")}
                  </Link>
                  <p className="mt-0.5 text-xs text-muted">
                    {item.company_name || t("dash.noCompany")}
                    {item.location ? ` · ${item.location}` : ""} ·{" "}
                    {t("dash.savedOn", {
                      date: item.savedAtLabel ?? "—",
                    })}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {item.match_score !== null && (
                    <span
                      className={`rounded-lg px-2 py-1 text-[11px] font-bold ${
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
                      <span className="rounded-lg bg-warning-soft px-2 py-1 text-[11px] font-bold text-warning">
                        {t("dash.status.incomplete")}
                      </span>
                    )}
                  <Link
                    href={`/opportunities/${encodeURIComponent(item.opportunity_key)}`}
                    className="rounded-lg border border-line-strong px-2.5 py-1.5 text-xs font-bold text-accent transition-colors hover:bg-accent-soft"
                  >
                    {t("dash.buttons.view")}
                  </Link>
                  <Link
                    href={`/applications/new?opp=${encodeURIComponent(item.opportunity_key)}`}
                    className="rounded-lg bg-accent-soft px-2.5 py-1.5 text-xs font-bold text-accent transition-colors hover:bg-accent hover:text-white"
                  >
                    {t("apps.openDraft")}
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
      </Card>
    </section>
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
    <Card className="p-5 sm:p-6" as="section">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="font-bold text-ink">{t("completeness.title")}</h2>
          <p className="mt-1 text-xs text-muted">{t("completeness.hint")}</p>
        </div>
        {hasProfile && completeness && (
          <span className="text-2xl font-bold text-ink">
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
            cta={{ label: t("completeness.scanNow"), href: "/bewerbung-scanner" }}
          />
        </div>
      ) : (
        <>
          <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-surface-2">
            <div
              className="h-full rounded-full bg-success transition-[width] duration-300"
              style={{ width: `${completeness.percentage}%` }}
            />
          </div>
          {completeness.missing.length === 0 ? (
            <p className="mt-4 rounded-xl bg-success-soft p-3 text-xs font-semibold text-success">
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
                    className="rounded-lg bg-warning-soft px-2 py-1 text-[11px] font-semibold text-warning"
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
                    className="rounded-lg bg-success-soft px-2 py-1 text-[11px] font-semibold text-success"
                  >
                    {section}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Workflow nav
// ---------------------------------------------------------------------------

function WorkflowNav({ goalLabel, t }: { goalLabel: string; t: T }) {
  const items: Array<{ key: string; icon: IconName; href: string; label: string; desc: string }> = [
    { key: "scan", icon: "scan", href: "/bewerbung-scanner", label: t("workflow.scan.label"), desc: t("workflow.scan.desc") },
    { key: "find", icon: "search", href: "/opportunities", label: t("workflow.find.label", { goal: goalLabel }), desc: t("workflow.find.desc") },
    { key: "assistant", icon: "spark", href: "/ai", label: t("workflow.assistant.label"), desc: t("workflow.assistant.desc") },
    { key: "saved", icon: "bookmark", href: "/opportunities/saved", label: t("workflow.saved.label"), desc: t("workflow.saved.desc") },
    { key: "newApplication", icon: "edit", href: "/applications/new", label: t("workflow.newApplication.label"), desc: t("workflow.newApplication.desc") },
    { key: "email", icon: "mail", href: "/settings/email", label: t("workflow.email.label"), desc: t("workflow.email.desc") },
    { key: "usage", icon: "settings", href: "/settings/usage", label: t("workflow.usage.label"), desc: t("workflow.usage.desc") },
  ];
  return (
    <Card className="mt-5 overflow-hidden" as="section">
      <div className="border-b border-line px-5 py-5 sm:px-6">
        <h2 className="font-bold text-ink">{t("workflow.title")}</h2>
        <p className="mt-1 text-xs text-muted">
          {t("workflow.hint", { goal: goalLabel.toLowerCase() })}
        </p>
      </div>
      <div className="grid gap-1 p-3">
        {items.map((item) => (
          <Link
            key={item.key}
            href={item.href}
            className="group flex items-center gap-3 rounded-xl p-3 transition-colors hover:bg-accent-soft"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
              <Icon name={item.icon} size={17} />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-bold text-ink transition-colors group-hover:text-accent">
                {item.label}
              </span>
              <span className="mt-0.5 block truncate text-xs text-muted">
                {item.desc}
              </span>
            </span>
            <span className="ms-auto text-faint transition-colors group-hover:text-accent">
              <Icon name="arrowRight" size={14} className="rtl:-scale-x-100" />
            </span>
          </Link>
        ))}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Metric cards
// ---------------------------------------------------------------------------

const toneStyles: Record<string, string> = {
  accent: "bg-accent-soft text-accent",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  ai: "bg-ai-soft text-ai",
};

function UsageCard({
  sent,
  limit,
  remaining,
  t,
}: {
  sent: number;
  limit: number;
  remaining: number;
  t: T;
}) {
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent-soft text-accent">
          <Icon name="mail" size={17} />
        </span>
        <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-faint">
          {t("badges.today")}
        </span>
      </div>
      <p className="mt-5 text-3xl font-bold tracking-[-0.04em] text-ink">
        {sent}
        <span className="text-base font-semibold text-muted"> / {limit}</span>
      </p>
      <p className="mt-1 text-sm font-semibold text-ink-soft">
        {t("dash.metrics.emailsSent")}
      </p>
      <Link
        href="/settings/usage"
        className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-success transition-colors hover:text-success/80"
      >
        {t("dash.metrics.emailsDetail", { remaining, limit })}
        <Icon name="arrowRight" size={12} className="rtl:-scale-x-100" />
      </Link>
    </Card>
  );
}

function MetricCard({
  label,
  value,
  detail,
  icon,
  tone,
  href,
  hrefLabel,
  badge,
}: {
  label: string;
  value: number;
  detail: string;
  icon: IconName;
  tone: keyof typeof toneStyles;
  href: string;
  hrefLabel: string;
  badge: string;
}) {
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between">
        <span className={`flex h-9 w-9 items-center justify-center rounded-xl ${toneStyles[tone]}`}>
          <Icon name={icon} size={17} />
        </span>
        <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-faint">
          {badge}
        </span>
      </div>
      <p className="mt-5 text-3xl font-bold tracking-[-0.04em] text-ink">
        {value}
      </p>
      <p className="mt-1 text-sm font-semibold text-ink-soft">{label}</p>
      <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted">{detail}</p>
      <Link
        href={href}
        className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-accent transition-colors hover:text-accent-deep"
      >
        {hrefLabel}
        <Icon name="arrowRight" size={12} className="rtl:-scale-x-100" />
      </Link>
    </Card>
  );
}

/** Candidate-profile metric (completeness), not the onboarding form. */
function ProfileMetricCard({
  completeness,
  hasProfile,
  t,
}: {
  completeness: ProfileCompleteness | null;
  hasProfile: boolean;
  t: T;
}) {
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-warning-soft text-warning">
          <Icon name="user" size={17} />
        </span>
        <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-faint">
          {t("badges.profile")}
        </span>
      </div>
      {hasProfile && completeness ? (
        <>
          <p className="mt-5 text-3xl font-bold tracking-[-0.04em] text-ink">
            {completeness.percentage}%
          </p>
          <p className="mt-1 text-sm font-semibold text-ink-soft">
            {t("dash.metrics.profile")}
          </p>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-2">
            <div
              className="h-full rounded-full bg-warning transition-[width] duration-300"
              style={{ width: `${completeness.percentage}%` }}
            />
          </div>
        </>
      ) : (
        <>
          <p className="mt-5 text-3xl font-bold tracking-[-0.04em] text-faint">
            —
          </p>
          <p className="mt-1 text-sm font-semibold text-ink-soft">
            {t("dash.metrics.profileMissing")}
          </p>
          <Link
            href="/bewerbung-scanner"
            className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-accent transition-colors hover:text-accent-deep"
          >
            {t("completeness.scanNow")}
            <Icon name="arrowRight" size={12} className="rtl:-scale-x-100" />
          </Link>
        </>
      )}
    </Card>
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
      <section className="mt-5">
        <Card className="p-5 sm:p-6" as="section">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="min-w-0">
              <h2 className="font-bold text-ink">{t("matching.title")}</h2>
              <p className="mt-1 text-xs text-muted">{t("matching.noProfile")}</p>
            </div>
            <Link
              href="/bewerbung-scanner"
              className="shrink-0 rounded-xl bg-accent-soft px-4 py-2 text-xs font-bold text-accent transition-colors hover:bg-accent hover:text-white"
            >
              {t("matching.scanCta")}
            </Link>
          </div>
        </Card>
      </section>
    );
  }
  return (
    <section className="mt-5">
      <Card className="p-5 sm:p-6" as="section">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="font-bold text-ink">{t("matching.title")}</h2>
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
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <div className="rounded-xl bg-surface-2 p-3">
            <p className="text-xs font-semibold text-muted">{t("matching.evaluated")}</p>
            <p className="mt-1 text-2xl font-bold text-ink">{matching.savedTotal}</p>
          </div>
          <div className="rounded-xl bg-success-soft p-3">
            <p className="text-xs font-semibold text-success">{t("matching.complete")}</p>
            <p className="mt-1 text-2xl font-bold text-ink">{matching.completeCount}</p>
          </div>
          <div className="rounded-xl bg-warning-soft p-3">
            <p className="text-xs font-semibold text-warning">{t("matching.incomplete")}</p>
            <p className="mt-1 text-2xl font-bold text-ink">{matching.incompleteCount}</p>
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
      </Card>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Small shared pieces
// ---------------------------------------------------------------------------

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-line pb-3">
      <dt className="shrink-0 text-xs text-muted">{label}</dt>
      <dd className="max-w-[62%] text-end text-xs font-semibold text-ink-soft">
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
