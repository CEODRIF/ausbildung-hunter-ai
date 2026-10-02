import Link from "next/link";
import { redirect } from "next/navigation";
import { Mail, Plus } from "lucide-react";
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

  const STAT_TONES: Record<string, string> = {
    Total: "bg-accent-soft text-accent",
    Drafts: "bg-surface-2 text-muted",
    Sending: "bg-cyan-soft text-cyan",
    Sent: "bg-success-soft text-success",
    Failed: "bg-danger-soft text-danger",
  };
  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-10">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <h1 className="display-title text-3xl text-ink sm:text-4xl">
            Applications
          </h1>
          <p className="mt-1.5 text-sm text-muted">
            Create and manage your application campaigns
          </p>
        </div>
        <Link
          href="/applications/new?new=1"
          className="btn-neon inline-flex h-12 items-center justify-center gap-2 rounded-2xl px-6 text-sm font-bold text-white"
        >
          <Plus size={16} strokeWidth={2.2} />
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
            className="surface-elevated rounded-3xl p-4 transition-shadow duration-300 hover:shadow-[var(--shadow-float)] sm:p-5"
          >
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] font-bold tracking-wide text-muted uppercase">
                {label}
              </p>
              <span
                className={`h-2 w-2 rounded-full ${STAT_TONES[label] ?? "bg-line"}`}
              />
            </div>
            <p className="num mt-2 text-3xl font-extrabold text-ink">
              {value}
            </p>
          </div>
        ))}
      </div>

      <div className="surface-elevated mt-6 overflow-hidden rounded-3xl">
        <div className="border-b border-line px-5 py-4">
          <h2 className="text-base font-bold tracking-tight text-ink">
            All applications &amp; campaigns
          </h2>
        </div>

        {items.length === 0 ? (
          <div className="flex flex-col items-center px-4 py-14 text-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-soft text-accent">
              <Mail size={24} strokeWidth={1.8} />
            </span>
            <p className="mt-4 text-sm font-bold text-ink">
              No applications yet.
            </p>
            <p className="mt-1 max-w-xs text-xs leading-5 text-muted">
              Create your first application campaign to get started.
            </p>
            <Link
              href="/applications/new?new=1"
              className="btn-neon mt-5 inline-flex h-10 items-center justify-center gap-2 rounded-2xl px-4 text-sm font-bold text-white"
            >
              <Plus size={15} strokeWidth={2.2} />
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
