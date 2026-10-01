import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { listUserCampaigns } from "@/lib/email-campaigns";
import { ApplicationsTable } from "@/components/applications-table";
import { getRequestLang } from "@/lib/i18n/server";
import { localeForLang } from "@/lib/i18n/core";

export const dynamic = "force-dynamic";

/**
 * Applications — the user's multi-campaign list. Every campaign is its own
 * row (independent id, recipients, counters and errors), plus each unsent
 * draft. Every number comes from the database; nothing is synthesised.
 * Account management (connect / reconnect / disconnect) deliberately lives
 * in Email settings, not here — this page only shows sender info.
 */
export default async function ApplicationsPage() {
  const { user } = await getCurrentUserAndProfile();
  if (!user) redirect("/login");
  const locale = localeForLang(await getRequestLang());
  const items = await listUserCampaigns(user.id);

  const stats = {
    total: items.length,
    drafts: items.filter((item) => !item.campaign_id).length,
    sending: items.filter(
      (item) => item.status === "queued" || item.status === "sending",
    ).length,
    sent: items.filter((item) => item.status === "completed").length,
    failed: items.filter(
      (item) => item.status === "failed" || item.status === "partially_failed",
    ).length,
  };

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-10">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <h1 className="text-2xl font-bold text-ink">Applications</h1>
          <p className="mt-1 text-sm text-muted">
            Create and manage your application campaigns
          </p>
        </div>
        <Link
          href="/applications/new?new=1"
          className="inline-flex h-11 items-center justify-center rounded-xl bg-accent px-5 text-sm font-semibold text-white hover:bg-accent-deep"
        >
          New application
        </Link>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {(
          [
            ["Total", stats.total],
            ["Drafts", stats.drafts],
            ["Sending", stats.sending],
            ["Sent", stats.sent],
            ["Failed", stats.failed],
          ] as const
        ).map(([label, value]) => (
          <div
            key={label}
            className="rounded-2xl border border-line bg-surface p-4"
          >
            <p className="text-xs font-semibold text-muted">{label}</p>
            <p className="mt-1 text-xl font-bold text-ink">{value}</p>
          </div>
        ))}
      </div>

      <div className="mt-6 rounded-2xl border border-line bg-surface">
        <div className="border-b border-line px-4 py-3">
          <h2 className="text-sm font-bold text-ink-soft">
            All applications &amp; campaigns
          </h2>
        </div>

        {items.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <p className="text-sm font-semibold text-ink-soft">
              No applications yet.
            </p>
            <p className="mt-1 text-xs text-muted">
              Create your first application campaign to get started.
            </p>
            <Link
              href="/applications/new?new=1"
              className="mt-4 inline-flex h-10 items-center justify-center rounded-xl bg-accent px-4 text-sm font-semibold text-white hover:bg-accent-deep"
            >
              New application
            </Link>
          </div>
        ) : (
          <>
            <ApplicationsTable items={items} locale={locale} />
          </>
        )}
      </div>
    </div>
  );
}
