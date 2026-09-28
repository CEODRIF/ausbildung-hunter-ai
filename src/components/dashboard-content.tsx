import Link from "next/link";
import { Card } from "@/components/ui";
import { Icon } from "@/components/app-shell";
import type {
  DashboardData,
  DashboardRecommendations,
  MatchingSummary,
  RecommendationItem,
  RecentApplication,
  SavedPreviewItem,
} from "@/lib/dashboard";
import { getProfileCompletion } from "@/lib/dashboard";
import type {
  NextAction,
  ProfileCompleteness,
} from "@/lib/dashboard-intelligence";
import { EmailAccountCard } from "@/components/email-account-card";
import { SaveOpportunityButton } from "@/components/opportunity-save-button";

export function DashboardContent({ data }: { data: DashboardData }) {
  const {
    profile,
    usage,
    usageSnapshot,
    aiLimit,
    applicationsCount,
    activities,
    emailAccount,
    hasCompletedScan,
    matching,
    candidateProfile,
    completeness,
    nextAction,
    savedPreview,
    recentApplications,
    recommendations,
  } = data;
  const isAusbildung = profile.selected_goal === "ausbildung";
  const goalLabel = isAusbildung ? "Ausbildung" : "Arbeit";
  const completion = getProfileCompletion(profile);
  const firstName = profile.full_name.trim().split(" ")[0] || "there";
  const remaining = Math.max(usageSnapshot.remaining, 0);
  const aiRemaining = Math.max(aiLimit - usage.ai_requests, 0);

  return (
    <div className="mx-auto max-w-7xl px-5 py-8 sm:px-8 lg:px-10 lg:py-10">
      <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
        <div>
          <p className="text-sm font-semibold text-[#2f6fed]">
            Your {goalLabel.toLowerCase()} workspace
          </p>
          <h1 className="mt-2 text-3xl font-bold tracking-[-0.04em] text-[#10203b] sm:text-4xl">
            Good morning, {firstName}.
          </h1>
          <p className="mt-2 text-sm text-[#71819a]">
            Stay focused on your next step toward {goalLabel}.
          </p>
        </div>
        <div className="rounded-xl border border-[#dce8ff] bg-[#f3f7ff] px-3.5 py-2 text-xs font-bold text-[#2f6fed]">
          Goal: {goalLabel}
        </div>
      </div>

      <NextActionCard action={nextAction} />

      <section className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <UsageCard
          sent={usageSnapshot.emails_sent}
          limit={usageSnapshot.daily_limit}
          remaining={remaining}
        />
        <MetricCard
          label="Applications prepared"
          value={applicationsCount}
          detail="Drafts in your workspace"
          icon="file"
          tone="green"
          href="/applications/new"
          hrefLabel="New application"
        />
        <MetricCard
          label="Saved opportunities"
          value={matching.savedTotal}
          detail={
            matching.savedTotal > 0
              ? `${matching.completeCount} complete match snapshot${matching.completeCount === 1 ? "" : "s"}`
              : "Save matches you want to apply to"
          }
          icon="bookmark"
          tone="blue"
          href="/opportunities/saved"
          hrefLabel="View saved"
        />
        <MetricCard
          label="AI usage"
          value={usage.ai_requests}
          detail={`${aiRemaining} of ${aiLimit} requests left today`}
          icon="spark"
          tone="purple"
          href="/ai"
          hrefLabel="Open assistant"
        />
        <ProfileMetricCard
          completeness={completeness}
          hasProfile={Boolean(candidateProfile)}
        />
      </section>

      <section className="mt-5 grid gap-5 xl:grid-cols-[1.3fr_0.7fr]">
        <div className="min-w-0">
          <RecommendationsCard recommendations={recommendations} />
          <SavedPreviewCard items={savedPreview} />
          <MatchingCard matching={matching} />
          <RecentApplicationsCard items={recentApplications} />
        </div>
        <div className="min-w-0">
          <CompletenessCard
            completeness={completeness}
            hasProfile={Boolean(candidateProfile)}
          />
          <WorkflowNav goalLabel={goalLabel} />
          <Card className="p-5 sm:p-6" as="section">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="font-bold text-[#1d3458]">Account overview</h2>
                <p className="mt-1 text-xs text-[#8b9ab0]">
                  Your current profile data
                </p>
              </div>
              <span className="rounded-lg bg-[#eaf8f3] px-2 py-1 text-[10px] font-bold uppercase tracking-[0.08em] text-[#1b9b70]">
                {profile.account_status}
              </span>
            </div>
            <dl className="mt-7 space-y-4 text-sm">
              <Detail label="Full name" value={profile.full_name} />
              <Detail label="Email" value={profile.email} />
              <Detail label="Goal" value={goalLabel} />
              <Detail label="Onboarding completion" value={`${completion}%`} />
              <Detail
                label="Daily email limit"
                value={`${usageSnapshot.daily_limit} emails`}
              />
            </dl>
          </Card>
          <section className="mt-5">
            <Card className="overflow-hidden" as="section">
              <div className="flex items-center justify-between border-b border-[#edf0f4] px-5 py-5 sm:px-6">
                <div>
                  <h2 className="font-bold text-[#1d3458]">Recent activity</h2>
                  <p className="mt-1 text-xs text-[#8b9ab0]">
                    The latest changes in your workspace
                  </p>
                </div>
                <span className="rounded-lg bg-[#f4f7fc] px-2 py-1 text-[10px] font-bold text-[#8492a7]">
                  Live data
                </span>
              </div>
              {activities.length ? (
                <div className="divide-y divide-[#edf0f4]">
                  {activities.map((activity) => (
                    <ActivityRow key={activity.id} {...activity} />
                  ))}
                </div>
              ) : (
                <EmptyBlock
                  icon="activity"
                  title="No activity yet"
                  body="Your account activity will appear here as you use your workspace."
                />
              )}
            </Card>
          </section>
        </div>
      </section>

      <EmailAccountCard account={emailAccount} />
      {!emailAccount && hasCompletedScan && (
        <p className="mt-2 text-xs text-[#8290a4]">
          Connect Gmail or Outlook before sending applications.
        </p>
      )}
    </div>
  );
}

/** Deterministic next-step recommendation (server-derived rule chain). */
function NextActionCard({ action }: { action: NextAction }) {
  return (
    <section className="mt-6">
      <Card className="flex flex-col gap-4 border-[#b9d4ff] bg-gradient-to-br from-[#f3f7ff] to-[#f8faff] p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
        <div className="min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#2f6fed]">
            Recommended next action
          </p>
          <h2 className="mt-1 text-xl font-bold tracking-[-0.02em] text-[#10203b]">
            {action.label}
          </h2>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-[#546783]">
            {action.reason}
          </p>
        </div>
        <Link
          href={action.href}
          className="shrink-0 rounded-xl bg-[#2f6fed] px-5 py-3 text-sm font-bold text-white shadow-sm hover:bg-[#2559c9]"
        >
          {action.ctaLabel} →
        </Link>
      </Card>
    </section>
  );
}

/** Recommended opportunities: resolved server-side from the authoritative
 *  source and ranked by the existing matcher v2. Never fabricated. */
function RecommendationsCard({
  recommendations,
}: {
  recommendations: DashboardRecommendations;
}) {
  return (
    <section className="mt-5">
      <Card className="overflow-hidden" as="section">
        <div className="flex items-center justify-between border-b border-[#edf0f4] px-5 py-5 sm:px-6">
          <div>
            <h2 className="font-bold text-[#1d3458]">
              Recommended opportunities
            </h2>
            <p className="mt-1 text-xs text-[#8b9ab0]">
              Resolved from the official source and matched against your profile
            </p>
          </div>
          <Link
            href="/opportunities"
            className="rounded-xl border border-[#dbe3ef] px-3 py-2 text-xs font-bold text-[#2f6fed]"
          >
            Search all →
          </Link>
        </div>
        {recommendations.available ? (
          recommendations.items.length > 0 ? (
            <div className="divide-y divide-[#edf0f4]">
              {recommendations.items.map((item) => (
                <RecommendationRow key={item.opportunity.id} item={item} />
              ))}
            </div>
          ) : (
            <EmptyBlock
              icon="search"
              title="No matching opportunities right now"
              body="The source returned no results for your documented target. Try a broader search."
            />
          )
        ) : (
          <EmptyBlock
            icon="search"
            title="Recommendations unavailable"
            body={
              recommendations.blockedReason === "no_profile"
                ? "Scan your Bewerbung to build your candidate profile — recommendations compare real vacancies against it."
                : recommendations.blockedReason === "no_keyword"
                  ? "Add a target role to your profile first — recommendations are searched with documented keywords only (nothing is invented)."
                  : "The opportunity source is unavailable right now. Nothing is shown instead of real results."
            }
          />
        )}
      </Card>
    </section>
  );
}

function RecommendationRow({ item }: { item: RecommendationItem }) {
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
              className="text-sm font-bold text-[#1d3458] hover:text-[#2f6fed]"
            >
              {opportunity.title || "Untitled opportunity"}
            </Link>
            <span className="rounded-md bg-[#f4f7fc] px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.06em] text-[#546783]">
              {opportunity.goal === "ausbildung" ? "Ausbildung" : "Arbeit"}
            </span>
          </div>
          <p className="mt-1 text-xs text-[#8290a4]">
            {[
              opportunity.company_name,
              opportunity.location,
              opportunity.posted_at
                ? `Posted ${formatActivityDate(opportunity.posted_at)}`
                : null,
              opportunity.salary?.label ?? null,
            ]
              .filter(Boolean)
              .join(" · ") || "No further details documented"}
          </p>
          {reason && (
            <p className="mt-1.5 text-xs leading-5 text-[#546783]">{reason}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {isComplete && match?.score !== null && (
            <span className="rounded-lg bg-[#eaf8f3] px-2 py-1 text-xs font-bold text-[#1b9b70]">
              Match: {match.score} %
            </span>
          )}
          {isIncomplete && (
            <span className="rounded-lg bg-[#fff4e5] px-2 py-1 text-xs font-bold text-[#a3611c]">
              Match incomplete
            </span>
          )}
          <div className="flex items-center gap-2">
            <Link
              href={`/opportunities/${encodeURIComponent(opportunity.id)}`}
              className="rounded-lg border border-[#dbe3ef] px-2.5 py-1.5 text-xs font-bold text-[#2f6fed]"
            >
              View
            </Link>
            <SaveOpportunityButton
              opportunityKey={opportunity.id}
              initialSaved={saved}
            />
            <Link
              href={`/applications/new?opp=${encodeURIComponent(opportunity.id)}`}
              className="rounded-lg bg-[#edf3ff] px-2.5 py-1.5 text-xs font-bold text-[#2f6fed]"
            >
              Prepare application
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Saved-opportunity preview with Phase 7 snapshot/staleness semantics. */
function SavedPreviewCard({ items }: { items: SavedPreviewItem[] }) {
  return (
    <section className="mt-5">
      <Card className="overflow-hidden" as="section">
        <div className="flex items-center justify-between border-b border-[#edf0f4] px-5 py-5 sm:px-6">
          <div>
            <h2 className="font-bold text-[#1d3458]">Saved opportunities</h2>
            <p className="mt-1 text-xs text-[#8b9ab0]">
              Snapshots are historical — the live match is on the detail page
            </p>
          </div>
          <Link
            href="/opportunities/saved"
            className="rounded-xl border border-[#dbe3ef] px-3 py-2 text-xs font-bold text-[#2f6fed]"
          >
            All saved →
          </Link>
        </div>
        {items.length > 0 ? (
          <div className="divide-y divide-[#edf0f4]">
            {items.map((item) => (
              <div
                key={item.id}
                className="flex flex-wrap items-center justify-between gap-2 px-5 py-3.5 sm:px-6"
              >
                <div className="min-w-0">
                  <Link
                    href={`/opportunities/${encodeURIComponent(item.opportunity_key)}`}
                    className="text-sm font-semibold text-[#1d3458] hover:text-[#2f6fed]"
                  >
                    {item.title || "Untitled opportunity"}
                  </Link>
                  <p className="mt-0.5 text-xs text-[#8290a4]">
                    {item.company_name || "Company not listed"}
                    {item.location ? ` · ${item.location}` : ""} · saved{" "}
                    {item.savedAtLabel ?? "—"}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {item.match_score !== null && (
                    <span
                      className={`rounded-lg px-2 py-1 text-[11px] font-bold ${
                        item.stale
                          ? "bg-[#f0f2f6] text-[#8290a4]"
                          : "bg-[#f7faff] text-[#2f6fed]"
                      }`}
                      title={
                        item.stale
                          ? item.staleReasons.join(" ")
                          : "Snapshot at save time"
                      }
                    >
                      {item.match_score} %{item.stale ? " · stale" : ""}
                    </span>
                  )}
                  {item.match_score === null &&
                    item.match_status === "incomplete" && (
                      <span className="rounded-lg bg-[#fff4e5] px-2 py-1 text-[11px] font-bold text-[#a3611c]">
                        Incomplete
                      </span>
                    )}
                  <Link
                    href={`/opportunities/${encodeURIComponent(item.opportunity_key)}`}
                    className="rounded-lg border border-[#dbe3ef] px-2.5 py-1.5 text-xs font-bold text-[#2f6fed]"
                  >
                    View
                  </Link>
                  <Link
                    href={`/applications/new?opp=${encodeURIComponent(item.opportunity_key)}`}
                    className="rounded-lg bg-[#edf3ff] px-2.5 py-1.5 text-xs font-bold text-[#2f6fed]"
                  >
                    Prepare
                  </Link>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyBlock
            icon="bookmark"
            title="Nothing saved yet"
            body="Save opportunities you want to apply to — they keep a server-computed match snapshot."
          />
        )}
      </Card>
    </section>
  );
}

/** Recent applications: real drafts joined with persisted campaign state. */
function RecentApplicationsCard({ items }: { items: RecentApplication[] }) {
  const campaignLabel: Record<string, string> = {
    draft: "Campaign ready",
    queued: "Sending queued",
    sending: "Sending",
    completed: "Sent",
    partially_failed: "Partially sent",
    failed: "Sending failed",
    cancelled: "Cancelled",
  };
  return (
    <section className="mt-5">
      <Card className="overflow-hidden" as="section">
        <div className="flex items-center justify-between border-b border-[#edf0f4] px-5 py-5 sm:px-6">
          <div>
            <h2 className="font-bold text-[#1d3458]">Recent applications</h2>
            <p className="mt-1 text-xs text-[#8b9ab0]">
              Your prepared drafts and their sending status
            </p>
          </div>
          <Link
            href="/applications/new"
            className="rounded-xl border border-[#dbe3ef] px-3 py-2 text-xs font-bold text-[#2f6fed]"
          >
            New application →
          </Link>
        </div>
        {items.length > 0 ? (
          <div className="divide-y divide-[#edf0f4]">
            {items.map((item) => (
              <div
                key={item.id}
                className="flex flex-wrap items-center justify-between gap-2 px-5 py-3.5 sm:px-6"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-[#1d3458]">
                    {item.subject || "Untitled application"}
                  </p>
                  <p className="mt-0.5 text-xs text-[#8290a4]">
                    {[
                      item.company,
                      item.opportunity_title
                        ? `for ${item.opportunity_title}`
                        : null,
                      `created ${formatActivityDate(item.created_at)}`,
                      item.sent_at
                        ? `sent ${formatActivityDate(item.sent_at)}`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ") || "No details documented"}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {item.campaign_status && (
                    <span
                      className={`rounded-lg px-2 py-1 text-[11px] font-bold ${
                        item.campaign_status === "completed"
                          ? "bg-[#eaf8f3] text-[#1b9b70]"
                          : item.campaign_status === "failed" ||
                              item.campaign_status === "partially_failed"
                            ? "bg-[#fdecec] text-[#c0392b]"
                            : "bg-[#f4f7fc] text-[#546783]"
                      }`}
                    >
                      {campaignLabel[item.campaign_status] ??
                        item.campaign_status}
                    </span>
                  )}
                  {!item.campaign_status && !item.has_content && (
                    <span className="rounded-lg bg-[#f4f7fc] px-2 py-1 text-[11px] font-bold text-[#8492a7]">
                      Empty draft
                    </span>
                  )}
                  <Link
                    href="/applications/new"
                    className="rounded-lg border border-[#dbe3ef] px-2.5 py-1.5 text-xs font-bold text-[#2f6fed]"
                  >
                    Open draft
                  </Link>
                  {item.campaign_id && (
                    <Link
                      href={`/applications/campaign/${item.campaign_id}`}
                      className="rounded-lg bg-[#edf3ff] px-2.5 py-1.5 text-xs font-bold text-[#2f6fed]"
                    >
                      Campaign
                    </Link>
                  )}
                  {item.opportunity_key && (
                    <Link
                      href={`/opportunities/${encodeURIComponent(item.opportunity_key)}`}
                      className="rounded-lg border border-[#dbe3ef] px-2.5 py-1.5 text-xs font-bold text-[#2f6fed]"
                    >
                      Opportunity
                    </Link>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyBlock
            icon="file"
            title="No applications yet"
            body="Prepare your first application — it can be prefilled from any saved opportunity."
          />
        )}
      </Card>
    </section>
  );
}

/** Deterministic 12-section candidate-profile completeness (server-derived). */
function CompletenessCard({
  completeness,
  hasProfile,
}: {
  completeness: ProfileCompleteness | null;
  hasProfile: boolean;
}) {
  return (
    <Card className="p-5 sm:p-6" as="section">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-bold text-[#1d3458]">Candidate profile</h2>
          <p className="mt-1 text-xs text-[#8b9ab0]">
            Documented sections used by the matcher
          </p>
        </div>
        {hasProfile && completeness && (
          <span className="text-2xl font-bold text-[#1d3458]">
            {completeness.percentage}%
          </span>
        )}
      </div>
      {!hasProfile || !completeness ? (
        <div className="mt-5">
          <EmptyBlock
            icon="user"
            title="No candidate profile"
            body="Scan your Bewerbung to build your candidate profile."
          />
          <Link
            href="/bewerbung-scanner"
            className="mt-2 inline-block rounded-xl bg-[#edf3ff] px-4 py-2 text-xs font-bold text-[#2f6fed]"
          >
            Scan now →
          </Link>
        </div>
      ) : (
        <>
          <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-[#edf1f6]">
            <div
              className="h-full rounded-full bg-[#1b9b70]"
              style={{ width: `${completeness.percentage}%` }}
            />
          </div>
          {completeness.missing.length === 0 ? (
            <p className="mt-4 rounded-xl bg-[#eaf8f3] p-3 text-xs font-semibold text-[#1b9b70]">
              All sections documented — the matcher has everything it can use.
            </p>
          ) : (
            <>
              <p className="mt-4 text-[10px] font-bold uppercase tracking-[0.1em] text-[#8b9ab0]">
                Missing ({completeness.missing.length})
              </p>
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {completeness.missing.map((section) => (
                  <li
                    key={section}
                    className="rounded-lg bg-[#fff4e5] px-2 py-1 text-[11px] font-semibold text-[#a3611c]"
                  >
                    {section}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[10px] font-bold uppercase tracking-[0.1em] text-[#8b9ab0]">
                Documented ({completeness.completed.length})
              </p>
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {completeness.completed.map((section) => (
                  <li
                    key={section}
                    className="rounded-lg bg-[#eaf8f3] px-2 py-1 text-[11px] font-semibold text-[#1b9b70]"
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

/** Real workflow navigation (Phase 8) — replaces the disabled placeholders. */
function WorkflowNav({ goalLabel }: { goalLabel: string }) {
  const items = [
    {
      label: `Scan Bewerbung`,
      description: "Build or update your candidate profile",
      icon: "scan" as const,
      href: "/bewerbung-scanner",
    },
    {
      label: `Find ${goalLabel}`,
      description: "Search the official BA source",
      icon: "search" as const,
      href: "/opportunities",
    },
    {
      label: "AI Assistant",
      description: "Ask about your applications",
      icon: "spark" as const,
      href: "/ai",
    },
    {
      label: "Saved opportunities",
      description: "Your saved matches & snapshots",
      icon: "bookmark" as const,
      href: "/opportunities/saved",
    },
    {
      label: "New application",
      description: "Composer with opportunity prefill",
      icon: "edit" as const,
      href: "/applications/new",
    },
    {
      label: "Email settings",
      description: "Connect Gmail or Outlook",
      icon: "mail" as const,
      href: "/settings/email",
    },
    {
      label: "Usage & limits",
      description: "Daily email and AI quotas",
      icon: "settings" as const,
      href: "/settings/usage",
    },
  ];
  return (
    <Card className="mt-5 overflow-hidden" as="section">
      <div className="border-b border-[#edf0f4] px-5 py-5 sm:px-6">
        <h2 className="font-bold text-[#1d3458]">Workflow</h2>
        <p className="mt-1 text-xs text-[#8b9ab0]">
          Everything in your {goalLabel.toLowerCase()} journey
        </p>
      </div>
      <div className="grid gap-1 p-3">
        {items.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="group flex items-center gap-3 rounded-xl p-3 hover:bg-[#f5f8ff]"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#edf3ff] text-[#2f6fed]">
              <Icon name={item.icon} size={17} />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-bold text-[#1d3458] group-hover:text-[#2f6fed]">
                {item.label}
              </span>
              <span className="mt-0.5 block truncate text-xs text-[#8290a4]">
                {item.description}
              </span>
            </span>
            <span className="ml-auto text-[#c6d0de] group-hover:text-[#2f6fed]">
              <Icon name="arrow" size={14} />
            </span>
          </Link>
        ))}
      </div>
    </Card>
  );
}

function UsageCard({
  sent,
  limit,
  remaining,
}: {
  sent: number;
  limit: number;
  remaining: number;
}) {
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#edf3ff] text-[#2f6fed]">
          <Icon name="mail" size={17} />
        </span>
        <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-[#a0adbd]">
          Today
        </span>
      </div>
      <p className="mt-5 text-3xl font-bold tracking-[-0.04em] text-[#10203b]">
        {sent}{" "}
        <span className="text-base font-semibold text-[#8492a7]">
          / {limit}
        </span>
      </p>
      <p className="mt-1 text-sm font-semibold text-[#1d3458]">
        Emails sent today
      </p>
      <Link
        href="/settings/usage"
        className="mt-2 inline-block text-xs font-semibold text-[#1b9b70] hover:text-[#157a56]"
      >
        {remaining} remaining →
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
}: {
  label: string;
  value: number;
  detail: string;
  icon: "file" | "spark" | "bookmark";
  tone: "green" | "purple" | "blue";
  href: string;
  hrefLabel: string;
}) {
  const tones = {
    green: "bg-[#eaf8f3] text-[#1b9b70]",
    purple: "bg-[#f2edff] text-[#805ad5]",
    blue: "bg-[#edf3ff] text-[#2f6fed]",
  };
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between">
        <span
          className={`flex h-9 w-9 items-center justify-center rounded-xl ${tones[tone]}`}
        >
          <Icon name={icon} size={17} />
        </span>
        <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-[#a0adbd]">
          You
        </span>
      </div>
      <p className="mt-5 text-3xl font-bold tracking-[-0.04em] text-[#10203b]">
        {value}
      </p>
      <p className="mt-1 text-sm font-semibold text-[#1d3458]">{label}</p>
      <p className="mt-1 line-clamp-2 text-xs leading-5 text-[#8290a4]">
        {detail}
      </p>
      <Link
        href={href}
        className="mt-2 inline-block text-xs font-semibold text-[#2f6fed] hover:text-[#2559c9]"
      >
        {hrefLabel} →
      </Link>
    </Card>
  );
}

/** Candidate-profile metric (Phase 8 completeness), not the onboarding form. */
function ProfileMetricCard({
  completeness,
  hasProfile,
}: {
  completeness: ProfileCompleteness | null;
  hasProfile: boolean;
}) {
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#fff3e5] text-[#d78b3b]">
          <Icon name="user" size={17} />
        </span>
        <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-[#a0adbd]">
          Profile
        </span>
      </div>
      {hasProfile && completeness ? (
        <>
          <p className="mt-5 text-3xl font-bold tracking-[-0.04em] text-[#10203b]">
            {completeness.percentage}%
          </p>
          <p className="mt-1 text-sm font-semibold text-[#1d3458]">
            Profile completeness
          </p>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[#edf1f6]">
            <div
              className="h-full rounded-full bg-[#d78b3b]"
              style={{ width: `${completeness.percentage}%` }}
            />
          </div>
        </>
      ) : (
        <>
          <p className="mt-5 text-3xl font-bold tracking-[-0.04em] text-[#c6d0de]">
            —
          </p>
          <p className="mt-1 text-sm font-semibold text-[#1d3458]">
            No candidate profile
          </p>
          <Link
            href="/bewerbung-scanner"
            className="mt-2 inline-block text-xs font-semibold text-[#2f6fed] hover:text-[#2559c9]"
          >
            Scan now →
          </Link>
        </>
      )}
    </Card>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-[#f0f3f7] pb-3">
      <dt className="text-xs text-[#8492a7]">{label}</dt>
      <dd className="max-w-[62%] text-right text-xs font-semibold text-[#1d3458]">
        {value}
      </dd>
    </div>
  );
}

function ActivityRow({
  activity_type,
  title,
  description,
  created_at,
}: {
  activity_type: string;
  title: string;
  description: string | null;
  created_at: string;
}) {
  const icon =
    activity_type === "bewerbung_scan_completed"
      ? "scan"
      : activity_type === "opportunity_saved" ||
          activity_type === "opportunity_removed"
        ? "bookmark"
        : activity_type.startsWith("campaign")
          ? "send"
          : activity_type === "quota_upgrade_activated"
            ? "settings"
            : "file";
  return (
    <div className="flex items-start gap-3 px-5 py-4 sm:px-6">
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#edf3ff] text-[#2f6fed]">
        <Icon name={icon} size={15} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-[#1d3458]">{title}</p>
        {description && (
          <p className="mt-1 text-xs leading-5 text-[#8290a4]">{description}</p>
        )}
      </div>
      <time
        className="shrink-0 text-[10px] text-[#a0adbd]"
        dateTime={created_at}
      >
        {formatActivityDate(created_at)}
      </time>
    </div>
  );
}

function EmptyBlock({
  icon,
  title,
  body,
}: {
  icon: "activity" | "search" | "bookmark" | "file" | "user";
  title: string;
  body: string;
}) {
  return (
    <div className="px-5 py-10 text-center sm:px-6">
      <span className="mx-auto flex h-10 w-10 items-center justify-center rounded-xl bg-[#f2f5f9] text-[#8b9ab0]">
        <Icon name={icon} size={18} />
      </span>
      <h3 className="mt-4 text-sm font-bold text-[#1d3458]">{title}</h3>
      <p className="mx-auto mt-1 max-w-sm text-xs leading-5 text-[#8290a4]">
        {body}
      </p>
    </div>
  );
}

function formatActivityDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
  }).format(date);
}

/** Safe matching summary (Phase 7): only the user's own saved-opportunity
 *  snapshots are shown — counts plus the top complete snapshots. An
 *  incomplete profile produces a warning, never a fake ranking. */
function MatchingCard({ matching }: { matching: MatchingSummary }) {
  if (!matching.hasCandidateProfile) {
    return (
      <section className="mt-5">
        <Card className="p-5 sm:p-6" as="section">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="min-w-0">
              <h2 className="font-bold text-[#1d3458]">Opportunity matching</h2>
              <p className="mt-1 text-xs text-[#8b9ab0]">
                No candidate profile yet — match scores are unavailable until
                you scan a document.
              </p>
            </div>
            <Link
              href="/bewerbung-scanner"
              className="rounded-xl bg-[#edf3ff] px-4 py-2 text-xs font-semibold text-[#2f6fed]"
            >
              Scan your profile →
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
            <h2 className="font-bold text-[#1d3458]">Opportunity matching</h2>
            <p className="mt-1 text-xs leading-5 text-[#8b9ab0]">
              Server-computed snapshots of your saved opportunities. The current
              match is always calculated live on the detail page — after profile
              changes a snapshot may be stale.
            </p>
          </div>
          <Link
            href="/opportunities/saved"
            className="rounded-xl bg-[#edf3ff] px-4 py-2 text-xs font-semibold text-[#2f6fed]"
          >
            All saved →
          </Link>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <div className="rounded-xl bg-[#f7f9fc] p-3">
            <p className="text-xs font-semibold text-[#71819a]">Evaluated</p>
            <p className="mt-1 text-2xl font-bold text-[#10203b]">
              {matching.savedTotal}
            </p>
          </div>
          <div className="rounded-xl bg-[#eaf8f3] p-3">
            <p className="text-xs font-semibold text-[#1b9b70]">
              Complete matches
            </p>
            <p className="mt-1 text-2xl font-bold text-[#10203b]">
              {matching.completeCount}
            </p>
          </div>
          <div className="rounded-xl bg-[#fff4e5] p-3">
            <p className="text-xs font-semibold text-[#a3611c]">
              Incomplete matches
            </p>
            <p className="mt-1 text-2xl font-bold text-[#10203b]">
              {matching.incompleteCount}
            </p>
          </div>
        </div>
        {matching.top.length > 0 && (
          <>
            <p className="mt-4 text-[10px] font-bold uppercase tracking-[0.1em] text-[#8b9ab0]">
              Recently matched
            </p>
            <ul className="mt-1 divide-y divide-[#edf0f4]">
              {matching.top.map((item) => (
                <li key={item.opportunity_key} className="py-2.5">
                  <Link
                    href={`/opportunities/${encodeURIComponent(item.opportunity_key)}`}
                    className="text-sm font-semibold text-[#1d3458] hover:text-[#2f6fed]"
                  >
                    {item.title || "Untitled opportunity"}
                  </Link>
                  <span className="ml-2 text-xs text-[#8b9ab0]">
                    {item.location || "Location not listed"} · snapshot{" "}
                    {item.match_score} % · saved{" "}
                    {formatActivityDate(item.saved_at)}
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
