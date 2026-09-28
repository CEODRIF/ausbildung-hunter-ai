import Link from "next/link";
import { Card } from "@/components/ui";
import { Icon } from "@/components/app-shell";
import type { DashboardData, MatchingSummary } from "@/lib/dashboard";
import { getProfileCompletion } from "@/lib/dashboard";
import { EmailAccountCard } from "@/components/email-account-card";

export function DashboardContent({ data }: { data: DashboardData }) {
  const {
    profile,
    usage,
    applicationsCount,
    activities,
    emailAccount,
    hasCompletedScan,
    matching,
  } = data;
  const isAusbildung = profile.selected_goal === "ausbildung";
  const goalLabel = isAusbildung ? "Ausbildung" : "Arbeit";
  const remaining = Math.max(profile.daily_email_limit - usage.emails_sent, 0);
  const completion = getProfileCompletion(profile);
  const firstName = profile.full_name.trim().split(" ")[0] || "there";
  const actions = [
    {
      label: "Find Ausbildung",
      description: isAusbildung
        ? "Your selected goal · Coming soon"
        : "Coming soon",
      icon: "search" as const,
    },
    {
      label: "Find Arbeit",
      description: !isAusbildung
        ? "Your selected goal · Coming soon"
        : "Coming soon",
      icon: "search" as const,
    },
    {
      label: "Analyze Bewerbung",
      description: "Coming soon",
      icon: "scan" as const,
    },
    {
      label: "Write Bewerbung",
      description: "Coming soon",
      icon: "edit" as const,
    },
    {
      label: "Send Applications",
      description: "Coming soon",
      icon: "send" as const,
    },
  ];

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

      <section className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <UsageCard
          sent={usage.emails_sent}
          limit={profile.daily_email_limit}
          remaining={remaining}
        />
        <MetricCard
          label="Applications"
          value={applicationsCount}
          detail="Real applications in your workspace"
          icon="file"
          tone="green"
        />
        <MetricCard
          label="AI usage"
          value={usage.ai_requests}
          detail="Requests today · AI is not connected yet"
          icon="spark"
          tone="purple"
        />
        <ProfileCard completion={completion} />
      </section>

      <MatchingCard matching={matching} />

      <section className="mt-8 grid gap-5 xl:grid-cols-[1.3fr_0.7fr]">
        <Card className="overflow-hidden" as="section">
          <div className="border-b border-[#edf0f4] px-5 py-5 sm:px-6">
            <h2 className="font-bold text-[#1d3458]">Quick actions</h2>
            <p className="mt-1 text-xs text-[#8b9ab0]">
              Shortcuts for your {goalLabel.toLowerCase()} journey
            </p>
          </div>
          <div className="grid gap-3 p-5 sm:grid-cols-2 sm:p-6">
            {actions.map((action) => (
              <DisabledAction key={action.label} {...action} />
            ))}
          </div>
        </Card>
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
            <Detail
              label="Daily email limit"
              value={`${profile.daily_email_limit} emails`}
            />
          </dl>
        </Card>
      </section>

      <EmailAccountCard account={emailAccount} />

      <Card className="mt-5 p-5 sm:p-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="font-bold text-[#1d3458]">
              Recommended opportunities
            </h2>
            <p className="mt-1 text-xs leading-5 text-[#8290a4]">
              {hasCompletedScan
                ? "Search real Germany vacancies using your candidate profile."
                : "Scan your Bewerbung first to get personalized opportunities."}
            </p>
          </div>
          <a
            href={hasCompletedScan ? "/opportunities" : "/bewerbung-scanner"}
            className="shrink-0 rounded-xl border border-[#dbe3ef] px-3 py-2 text-xs font-bold text-[#2f6fed]"
          >
            {hasCompletedScan ? "Find opportunities" : "Scan Bewerbung"}
          </a>
        </div>
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
            <EmptyActivity />
          )}
        </Card>
      </section>
    </div>
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
        Daily email usage
      </p>
      <p className="mt-2 text-xs font-semibold text-[#1b9b70]">
        {remaining} remaining
      </p>
    </Card>
  );
}

function MetricCard({
  label,
  value,
  detail,
  icon,
  tone,
}: {
  label: string;
  value: number;
  detail: string;
  icon: "file" | "spark";
  tone: "green" | "purple";
}) {
  const tones = {
    green: "bg-[#eaf8f3] text-[#1b9b70]",
    purple: "bg-[#f2edff] text-[#805ad5]",
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
          Today
        </span>
      </div>
      <p className="mt-5 text-3xl font-bold tracking-[-0.04em] text-[#10203b]">
        {value}
      </p>
      <p className="mt-1 text-sm font-semibold text-[#1d3458]">{label}</p>
      <p className="mt-2 line-clamp-2 text-xs leading-5 text-[#8290a4]">
        {detail}
      </p>
    </Card>
  );
}

function ProfileCard({ completion }: { completion: number }) {
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
      <p className="mt-5 text-3xl font-bold tracking-[-0.04em] text-[#10203b]">
        {completion}%
      </p>
      <p className="mt-1 text-sm font-semibold text-[#1d3458]">
        Profile completion
      </p>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[#edf1f6]">
        <div
          className="h-full rounded-full bg-[#d78b3b]"
          style={{ width: `${completion}%` }}
        />
      </div>
    </Card>
  );
}

function DisabledAction({
  label,
  description,
  icon,
}: {
  label: string;
  description: string;
  icon: "search" | "scan" | "edit" | "send";
}) {
  return (
    <button
      type="button"
      disabled
      className="group flex cursor-not-allowed items-center gap-3 rounded-xl border border-[#e7ecf3] bg-[#fbfcfe] p-4 text-left opacity-80"
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#f0f4fa] text-[#8290a4]">
        <Icon name={icon} size={17} />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-bold text-[#546783]">{label}</span>
        <span className="mt-1 block text-xs font-medium text-[#a0adbd]">
          {description}
        </span>
      </span>
    </button>
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
  return (
    <div className="flex items-start gap-3 px-5 py-4 sm:px-6">
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#edf3ff] text-[#2f6fed]">
        <Icon
          name={activity_type === "application" ? "file" : "arrow"}
          size={15}
        />
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

function EmptyActivity() {
  return (
    <div className="px-5 py-10 text-center sm:px-6">
      <span className="mx-auto flex h-10 w-10 items-center justify-center rounded-xl bg-[#f2f5f9] text-[#8b9ab0]">
        <Icon name="activity" size={18} />
      </span>
      <h3 className="mt-4 text-sm font-bold text-[#1d3458]">No activity yet</h3>
      <p className="mx-auto mt-1 max-w-sm text-xs leading-5 text-[#8290a4]">
        Your account activity will appear here as you use your workspace.
      </p>
    </div>
  );
}

function formatActivityDate(value: string) {
  const date = new Date(value);
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
      <section className="mt-8">
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
    <section className="mt-8">
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
            <p className="text-xs font-semibold text-[#71819a]">Saved</p>
            <p className="mt-1 text-2xl font-bold text-[#10203b]">
              {matching.savedTotal}
            </p>
          </div>
          <div className="rounded-xl bg-[#eaf8f3] p-3">
            <p className="text-xs font-semibold text-[#1b9b70]">
              Matched (snapshot)
            </p>
            <p className="mt-1 text-2xl font-bold text-[#10203b]">
              {matching.completeCount}
            </p>
          </div>
          <div className="rounded-xl bg-[#fff4e5] p-3">
            <p className="text-xs font-semibold text-[#a3611c]">
              Incomplete profile data
            </p>
            <p className="mt-1 text-2xl font-bold text-[#10203b]">
              {matching.incompleteCount}
            </p>
          </div>
        </div>
        {matching.top.length > 0 && (
          <ul className="mt-4 divide-y divide-[#edf0f4]">
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
        )}
      </Card>
    </section>
  );
}
