import Link from "next/link";
import { Button } from "@/components/ui";
import { Icon, type IconName } from "@/components/icon";
import { FeatureCard } from "@/components/feature-card";
import { EmptyState } from "@/components/empty-state";
import { GlassCard } from "@/components/ui/surfaces";
import { SearchOrb } from "@/components/ui/search-orb";
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
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-10 lg:px-10">
      {/* ----------------------------------------------------------------- */}
      {/* Hero + discovery launcher — the two primary actions.               */}
      {/* ----------------------------------------------------------------- */}
      <section className="grid gap-5 xl:grid-cols-[1.25fr_0.75fr]">
        <GlassCard variant="surface-elevated" className="relative overflow-hidden p-6 anim-fade-up sm:p-10">
          <div className="hero-orb pointer-events-none absolute -end-24 -top-24 h-80 w-80 rounded-full" />
          <div className="grid-fade pointer-events-none absolute inset-x-0 bottom-0 h-40 opacity-40 [mask-image:linear-gradient(to_bottom,transparent,black)]" />
          <div className="relative">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm font-semibold text-accent">
                {t(greetingKey, { name: firstName })}
              </p>
              <span className="rounded-full border border-accent/20 bg-accent-soft px-3 py-1 text-xs font-bold text-accent">
                {t("dash.goalLabel", { goal: goalLabel })}
              </span>
            </div>
            <h1 className="display-title mt-4 max-w-2xl text-4xl text-ink sm:text-5xl">
              {t("dash.hero.title")}
            </h1>
            <p className="mt-4 max-w-2xl text-sm leading-7 text-muted sm:text-base">
              {t("premium.hero.subtitle")}
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
              <Link href="/company-discovery">
                <Button size="lg" className="h-13 rounded-2xl px-7">
                  <Icon name="search" size={17} />
                  {t("premium.hero.ctaStart")}
                </Button>
              </Link>
              <Link href="/bewerbung-scanner">
                <Button
                  size="lg"
                  variant="secondary"
                  className="h-13 rounded-2xl border-transparent bg-surface px-6"
                >
                  <Icon name="scan" size={17} />
                  {t("dash.hero.ctaAnalyze")}
                </Button>
              </Link>
              <Link
                href="/company-discovery"
                className="inline-flex h-13 items-center gap-1.5 px-2 text-sm font-semibold text-muted transition-colors hover:text-accent"
              >
                {t("premium.hero.ctaPrevious")}
                <Icon name="arrowRight" size={15} className="rtl:-scale-x-100" />
              </Link>
            </div>
          </div>
        </GlassCard>

        {/* Discovery launcher — the product's signature action. */}
        <GlassCard
          variant="surface-floating"
          className="relative flex flex-col items-center justify-center overflow-hidden p-8 text-center anim-fade-up"
        >
          <div className="hero-orb pointer-events-none absolute inset-0 rounded-full opacity-70" />
          <div className="relative">
            <SearchOrb active={false} size={150} />
            <h2 className="mt-6 text-lg font-bold tracking-tight text-ink">
              {t("premium.hero.searchTitle")}
            </h2>
            <p className="mx-auto mt-2 max-w-60 text-xs leading-5 text-muted">
              {t("dash.hero.subtitle")}
            </p>
            <Link href="/company-discovery" className="mt-6 inline-block">
              <Button size="md" className="rounded-2xl">
                {t("premium.hero.ctaStart")}
                <Icon name="arrowRight" size={15} className="rtl:-scale-x-100" />
              </Button>
            </Link>
          </div>
        </GlassCard>
      </section>

      {/* ----------------------------------------------------------------- */}
      {/* Feature cards — the four ways in, each with a real action.         */}
      {/* ----------------------------------------------------------------- */}
      <section className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
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
      <section className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
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
          <GlassCard className="mt-5 p-5 sm:p-6" as="section">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="font-bold text-ink">{t("dash.sections.account.title")}</h2>
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
                value={t("dash.detail.emails", {
                  count: usageSnapshot.daily_limit,
                })}
              />
            </dl>
          </GlassCard>
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
    <section className="mt-5">
      <GlassCard variant="surface-elevated" className="flex flex-col gap-4 overflow-hidden p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
        <div className="pointer-events-none absolute inset-y-0 start-0 w-1.5" style={{ backgroundImage: "var(--gradient-neon)" }} />
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
    <section className="mt-6 first:mt-0">
      <GlassCard variant="surface" className="overflow-hidden" as="section">
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-5 sm:px-6">
          <div>
            <h2 className="font-bold tracking-tight text-ink">{t("dash.sections.recommended.title")}</h2>
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
      </GlassCard>
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
    <div className="px-5 py-4 transition-colors hover:bg-surface-2/40 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
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
          <Link
            href={`/applications/new?opp=${encodeURIComponent(opportunity.id)}`}
            className="rounded-xl bg-accent-soft px-3 py-1.5 text-xs font-bold text-accent transition-colors hover:bg-accent hover:text-white"
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
      <GlassCard variant="surface" className="overflow-hidden" as="section">
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-5 sm:px-6">
          <div>
            <h2 className="font-bold tracking-tight text-ink">{t("dash.sections.saved.title")}</h2>
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
                  <Link
                    href={`/applications/new?opp=${encodeURIComponent(item.opportunity_key)}`}
                    className="rounded-xl bg-accent-soft px-3 py-1.5 text-xs font-bold text-accent transition-colors hover:bg-accent hover:text-white"
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
      </GlassCard>
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
    <GlassCard variant="surface" className="p-5 sm:p-6" as="section">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="font-bold tracking-tight text-ink">{t("completeness.title")}</h2>
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
            cta={{ label: t("completeness.scanNow"), href: "/bewerbung-scanner" }}
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
    <GlassCard variant="surface" className="mt-5 overflow-hidden" as="section">
      <div className="border-b border-line px-5 py-5 sm:px-6">
        <h2 className="font-bold tracking-tight text-ink">{t("workflow.title")}</h2>
        <p className="mt-1 text-xs text-muted">
          {t("workflow.hint", { goal: goalLabel.toLowerCase() })}
        </p>
      </div>
      <div className="grid gap-1 p-3">
        {items.map((item) => (
          <Link
            key={item.key}
            href={item.href}
            className="group flex items-center gap-3 rounded-2xl p-3 transition-colors hover:bg-accent-soft/60"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent transition-colors duration-300 group-hover:bg-accent group-hover:text-white">
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
    </GlassCard>
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
    <div className="surface-elevated rounded-3xl p-5 transition-shadow duration-300 hover:shadow-[var(--shadow-float)]">
      <div className="flex items-start justify-between">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-soft text-accent">
          <Icon name="mail" size={17} />
        </span>
        <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-faint">
          {t("badges.today")}
        </span>
      </div>
      <p className="num mt-5 text-4xl font-extrabold text-ink">
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
    </div>
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
    <div className="surface-elevated rounded-3xl p-5 transition-shadow duration-300 hover:shadow-[var(--shadow-float)]">
      <div className="flex items-start justify-between">
        <span className={`flex h-10 w-10 items-center justify-center rounded-xl ${toneStyles[tone]}`}>
          <Icon name={icon} size={17} />
        </span>
        <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-faint">
          {badge}
        </span>
      </div>
      <p className="num mt-5 text-4xl font-extrabold text-ink">{value}</p>
      <p className="mt-1 text-sm font-semibold text-ink-soft">{label}</p>
      <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted">{detail}</p>
      <Link
        href={href}
        className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-accent transition-colors hover:text-accent-deep"
      >
        {hrefLabel}
        <Icon name="arrowRight" size={12} className="rtl:-scale-x-100" />
      </Link>
    </div>
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
    <div className="surface-elevated rounded-3xl p-5 transition-shadow duration-300 hover:shadow-[var(--shadow-float)]">
      <div className="flex items-start justify-between">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-warning-soft text-warning">
          <Icon name="user" size={17} />
        </span>
        <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-faint">
          {t("badges.profile")}
        </span>
      </div>
      {hasProfile && completeness ? (
        <>
          <p className="num mt-5 text-4xl font-extrabold text-ink">
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
          <p className="num mt-5 text-4xl font-extrabold text-faint">
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
    </div>
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
        <GlassCard variant="surface" className="p-5 sm:p-6" as="section">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="min-w-0">
              <h2 className="font-bold tracking-tight text-ink">{t("matching.title")}</h2>
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
      </section>
    );
  }
  return (
    <section className="mt-5">
      <GlassCard variant="surface" className="p-5 sm:p-6" as="section">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="font-bold tracking-tight text-ink">{t("matching.title")}</h2>
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
          <div className="rounded-2xl bg-surface-2 p-3.5">
            <p className="text-xs font-semibold text-muted">{t("matching.evaluated")}</p>
            <p className="num mt-1 text-2xl font-extrabold text-ink">{matching.savedTotal}</p>
          </div>
          <div className="rounded-2xl bg-success-soft p-3.5">
            <p className="text-xs font-semibold text-success">{t("matching.complete")}</p>
            <p className="num mt-1 text-2xl font-extrabold text-ink">{matching.completeCount}</p>
          </div>
          <div className="rounded-2xl bg-warning-soft p-3.5">
            <p className="text-xs font-semibold text-warning">{t("matching.incomplete")}</p>
            <p className="num mt-1 text-2xl font-extrabold text-ink">{matching.incompleteCount}</p>
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
