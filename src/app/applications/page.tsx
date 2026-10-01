import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadRecentApplications } from "@/lib/dashboard";
import { getRequestLang, getServerT } from "@/lib/i18n/server";
import { localeForLang } from "@/lib/i18n/core";

export const dynamic = "force-dynamic";

/** Campaign status → label + tone (the engine's own vocabulary). */
const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  queued: "Queued",
  sending: "Sending",
  completed: "Sent",
  partially_failed: "Partly failed",
  failed: "Failed",
  cancelled: "Cancelled",
};

const STATUS_TONES: Record<string, string> = {
  queued: "bg-surface-2 text-ink-soft",
  sending: "bg-accent-soft text-accent-deep",
  completed: "bg-success-soft text-success",
  partially_failed: "bg-warning-soft text-warning",
  failed: "bg-warning-soft text-warning",
  cancelled: "bg-surface-2 text-muted",
};

function formatDate(value: string | null, locale: string) {
  if (!value) return "—";
  try {
    return new Intl.DateTimeFormat(locale, {
      year: "numeric",
      month: "short",
      day: "numeric",
    }).format(new Date(value));
  } catch {
    return "—";
  }
}

/**
 * Applications — the user's real drafts joined with the persisted campaign
 * and message counters maintained by the sending engine. Every number comes
 * from the database; nothing is synthesised. Account management (connect /
 * reconnect / disconnect) deliberately lives in Email settings, not here.
 */
export default async function ApplicationsPage() {
  const { user } = await getCurrentUserAndProfile();
  if (!user) redirect("/login");
  const t = await getServerT();
  const locale = localeForLang(await getRequestLang());
  const admin = createAdminClient();
  const items = await loadRecentApplications(admin, user.id, 50);

  const stats = {
    total: items.length,
    drafts: items.filter((item) => !item.campaign_id).length,
    sending: items.filter(
      (item) =>
        item.campaign_status === "queued" || item.campaign_status === "sending",
    ).length,
    sent: items.filter((item) => item.campaign_status === "completed").length,
    failed: items.filter(
      (item) =>
        item.campaign_status === "failed" ||
        item.campaign_status === "partially_failed",
    ).length,
  };

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-10">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <h1 className="text-2xl font-bold text-ink">Applications</h1>
          <p className="mt-1 text-sm text-muted">
            Create and manage your applications
          </p>
        </div>
        <Link
          href="/applications/new"
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
            {t("dash.sections.recentApplications.title")}
          </h2>
        </div>

        {items.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted">
            No applications yet — create your first one.
          </p>
        ) : (
          <>
            {/* Desktop table */}
            <div className="hidden overflow-x-auto lg:block">
              <table className="w-full text-left text-sm">
                <thead className="text-[11px] uppercase tracking-wide text-muted">
                  <tr className="border-b border-line">
                    <th className="px-4 py-3 font-semibold">Application</th>
                    <th className="px-4 py-3 font-semibold">Type</th>
                    <th className="px-4 py-3 font-semibold">Sender</th>
                    <th className="px-4 py-3 font-semibold">Recipients</th>
                    <th className="px-4 py-3 font-semibold">Status</th>
                    <th className="px-4 py-3 font-semibold">Sent</th>
                    <th className="px-4 py-3 font-semibold">Failed</th>
                    <th className="px-4 py-3 font-semibold">Created</th>
                    <th className="px-4 py-3 font-semibold">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => {
                    const status = item.campaign_status ?? "draft";
                    return (
                      <tr
                        key={item.id}
                        className="border-b border-line last:border-0"
                      >
                        <td className="px-4 py-3">
                          <p className="font-semibold text-ink-soft">
                            {item.subject.trim() ||
                              item.opportunity_title ||
                              t("apps.untitled")}
                          </p>
                          {item.company && (
                            <p className="text-xs text-muted">{item.company}</p>
                          )}
                        </td>
                        <td className="px-4 py-3 text-muted">
                          {item.goal === "arbeit" ? "Arbeit" : "Ausbildung"}
                        </td>
                        <td className="px-4 py-3 text-muted">
                          {item.sender_email ?? "—"}
                        </td>
                        <td className="px-4 py-3 text-muted">
                          {item.total_recipients ?? "—"}
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`rounded-lg px-2 py-1 text-xs font-semibold ${
                              STATUS_TONES[status] ?? "bg-surface-2 text-ink-soft"
                            }`}
                          >
                            {STATUS_LABELS[status] ?? status}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-muted">
                          {item.sent_count ?? "—"}
                        </td>
                        <td className="px-4 py-3 text-muted">
                          {item.failed_count ?? "—"}
                        </td>
                        <td className="px-4 py-3 text-muted">
                          {formatDate(item.created_at, locale)}
                        </td>
                        <td className="px-4 py-3">
                          {item.campaign_id ? (
                            <Link
                              href={`/applications/campaign/${item.campaign_id}`}
                              className="font-semibold text-accent-deep hover:underline"
                            >
                              Open campaign
                            </Link>
                          ) : (
                            <Link
                              href={`/applications/new?draft=${item.id}`}
                              className="font-semibold text-accent-deep hover:underline"
                            >
                              {t("apps.openDraft")}
                            </Link>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile cards */}
            <div className="divide-y divide-line lg:hidden">
              {items.map((item) => {
                const status = item.campaign_status ?? "draft";
                return (
                  <div key={item.id} className="px-4 py-4">
                    <div className="flex items-start justify-between gap-3">
                      <p className="font-semibold text-ink-soft">
                        {item.subject.trim() ||
                          item.opportunity_title ||
                          t("apps.untitled")}
                      </p>
                      <span
                        className={`shrink-0 rounded-lg px-2 py-1 text-xs font-semibold ${
                          STATUS_TONES[status] ?? "bg-surface-2 text-ink-soft"
                        }`}
                      >
                        {STATUS_LABELS[status] ?? status}
                      </span>
                    </div>
                    <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted">
                      <div>
                        Type: {item.goal === "arbeit" ? "Arbeit" : "Ausbildung"}
                      </div>
                      <div>Sender: {item.sender_email ?? "—"}</div>
                      <div>Recipients: {item.total_recipients ?? "—"}</div>
                      <div>Sent: {item.sent_count ?? "—"}</div>
                      <div>Failed: {item.failed_count ?? "—"}</div>
                      <div>Created: {formatDate(item.created_at, locale)}</div>
                    </dl>
                    <div className="mt-2">
                      {item.campaign_id ? (
                        <Link
                          href={`/applications/campaign/${item.campaign_id}`}
                          className="text-sm font-semibold text-accent-deep hover:underline"
                        >
                          Open campaign
                        </Link>
                      ) : (
                        <Link
                          href={`/applications/new?draft=${item.id}`}
                          className="text-sm font-semibold text-accent-deep hover:underline"
                        >
                          {t("apps.openDraft")}
                        </Link>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
