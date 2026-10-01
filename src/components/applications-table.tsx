"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { deleteCampaignAction } from "@/app/applications/actions";
import { discardDraft } from "@/app/applications/new/actions";

/** One row of the Applications list. `kind: "campaign"` = an
 *  email_campaigns row (one row PER campaign, fully independent);
 *  `kind: "draft"` = a composer draft that has not been sent yet.
 *  Every value is computed server-side from the database. */
export interface ApplicationRow {
  kind: "campaign" | "draft";
  id: string;
  title: string;
  company: string | null;
  goal: string;
  created_at: string;
  /** Engine status for campaigns; "draft" for unsent drafts. */
  status: string;
  campaign_id: string | null;
  total_recipients: number | null;
  sent_count: number | null;
  failed_count: number | null;
  sender_email: string | null;
}

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
  draft: "bg-surface-2 text-muted",
  queued: "bg-surface-2 text-ink-soft",
  sending: "bg-accent-soft text-accent-deep",
  completed: "bg-success-soft text-success",
  partially_failed: "bg-warning-soft text-warning",
  failed: "bg-warning-soft text-warning",
  cancelled: "bg-surface-2 text-muted",
};

function formatDate(value: string, locale: string) {
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

function typeLabel(goal: string) {
  return goal === "arbeit" ? "Arbeit" : "Ausbildung";
}

/** What the confirmation modal is about. The destructive call only ever
 *  happens after the user confirms here. */
type PendingDelete =
  | {
      kind: "campaign";
      campaign_id: string;
      title: string;
      sender_email: string | null;
    }
  | {
      kind: "draft";
      draft_id: string;
      title: string;
      sender_email: string | null;
    };

/**
 * Applications list: search, status filter, newest/oldest sort, Open and
 * Delete (with an explicit confirmation). Every value rendered here comes
 * from the database; the component only filters and sorts what it is given.
 */
export function ApplicationsTable({
  items,
  locale,
}: {
  items: ApplicationRow[];
  locale: string;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [newestFirst, setNewestFirst] = useState(true);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(
    null,
  );
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState("");

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return items
      .filter((row) => {
        if (status !== "all" && row.status !== status) return false;
        if (!needle) return true;
        return [row.title, row.company ?? "", row.sender_email ?? "", row.goal]
          .join(" ")
          .toLowerCase()
          .includes(needle);
      })
      .sort((a, b) =>
        newestFirst
          ? b.created_at.localeCompare(a.created_at)
          : a.created_at.localeCompare(b.created_at),
      );
  }, [items, query, status, newestFirst]);

  const statusesPresent = useMemo(
    () => [...new Set(items.map((row) => row.status))].sort(),
    [items],
  );

  async function confirmDelete() {
    if (!pendingDelete || isDeleting) return;
    if (pendingDelete.kind === "draft") {
      setIsDeleting(true);
      setError("");
      try {
        const formData = new FormData();
        formData.set("draftId", pendingDelete.draft_id);
        await discardDraft(formData);
        setPendingDelete(null);
        router.refresh();
      } catch {
        setError("Unable to delete draft.");
      } finally {
        setIsDeleting(false);
      }
      return;
    }
    setIsDeleting(true);
    setError("");
    try {
      const result = await deleteCampaignAction(pendingDelete.campaign_id);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setPendingDelete(null);
      router.refresh();
    } catch {
      setError("Unable to delete campaign.");
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <div>
      {/* Toolbar */}
      <div className="flex flex-col gap-3 border-b border-line px-4 py-3 sm:flex-row sm:items-center">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search campaigns"
          className="h-10 flex-1 rounded-xl border border-line-strong bg-surface px-3.5 text-sm outline-none focus:border-accent"
        />
        <select
          value={status}
          onChange={(event) => setStatus(event.target.value)}
          className="h-10 rounded-xl border border-line-strong bg-surface px-3 text-sm outline-none focus:border-accent"
        >
          <option value="all">All statuses</option>
          {statusesPresent.map((value) => (
            <option key={value} value={value}>
              {STATUS_LABELS[value] ?? value}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => setNewestFirst((current) => !current)}
          className="h-10 rounded-xl border border-line-strong px-3 text-sm font-semibold text-muted"
        >
          {newestFirst ? "Newest first" : "Oldest first"}
        </button>
      </div>

      {error && (
        <p className="border-b border-line px-4 py-3 text-xs font-semibold text-warning">
          {error}
        </p>
      )}

      {rows.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted">No campaigns match.</p>
      ) : (
        <>
          {/* Desktop */}
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
                {rows.map((row) => (
                  <tr
                    key={row.id}
                    className="border-b border-line last:border-0"
                  >
                    <td className="px-4 py-3">
                      <p className="font-semibold text-ink-soft">{row.title}</p>
                      {row.company && (
                        <p className="text-xs text-muted">{row.company}</p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted">
                      {typeLabel(row.goal)}
                    </td>
                    <td className="px-4 py-3 text-muted">
                      {row.sender_email ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-muted">
                      {row.total_recipients ?? "—"}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded-lg px-2 py-1 text-xs font-semibold ${
                          STATUS_TONES[row.status] ?? "bg-surface-2 text-ink-soft"
                        }`}
                      >
                        {STATUS_LABELS[row.status] ?? row.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-muted">
                      {row.sent_count ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-muted">
                      {row.failed_count ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-muted">
                      {formatDate(row.created_at, locale)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <Link
                          href={
                            row.campaign_id
                              ? `/applications/campaign/${row.campaign_id}`
                              : `/applications/new?draft=${row.id}`
                          }
                          className="font-semibold text-accent-deep hover:underline"
                        >
                          Open
                        </Link>
                        <button
                          type="button"
                          onClick={() => {
                            setError("");
                            if (row.campaign_id) {
                              setPendingDelete({
                                kind: "campaign",
                                campaign_id: row.campaign_id,
                                title: row.title,
                                sender_email: row.sender_email,
                              });
                            } else {
                              setPendingDelete({
                                kind: "draft",
                                draft_id: row.id,
                                title: row.title,
                                sender_email: row.sender_email,
                              });
                            }
                          }}
                          className="font-semibold text-warning hover:underline"
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile */}
          <div className="divide-y divide-line lg:hidden">
            {rows.map((row) => (
              <div key={row.id} className="px-4 py-4">
                <div className="flex items-start justify-between gap-3">
                  <p className="font-semibold text-ink-soft">{row.title}</p>
                  <span
                    className={`shrink-0 rounded-lg px-2 py-1 text-xs font-semibold ${
                      STATUS_TONES[row.status] ?? "bg-surface-2 text-ink-soft"
                    }`}
                  >
                    {STATUS_LABELS[row.status] ?? row.status}
                  </span>
                </div>
                <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted">
                  <div>Type: {typeLabel(row.goal)}</div>
                  <div>Sender: {row.sender_email ?? "—"}</div>
                  <div>Recipients: {row.total_recipients ?? "—"}</div>
                  <div>Sent: {row.sent_count ?? "—"}</div>
                  <div>Failed: {row.failed_count ?? "—"}</div>
                  <div>Created: {formatDate(row.created_at, locale)}</div>
                </dl>
                <div className="mt-2 flex items-center gap-4">
                  <Link
                    href={
                      row.campaign_id
                        ? `/applications/campaign/${row.campaign_id}`
                        : `/applications/new?draft=${row.id}`
                    }
                    className="text-sm font-semibold text-accent-deep hover:underline"
                  >
                    Open
                  </Link>
                  <button
                    type="button"
                    onClick={() => {
                      setError("");
                      if (row.campaign_id) {
                        setPendingDelete({
                          kind: "campaign",
                          campaign_id: row.campaign_id,
                          title: row.title,
                          sender_email: row.sender_email,
                        });
                      } else {
                        setPendingDelete({
                          kind: "draft",
                          draft_id: row.id,
                          title: row.title,
                          sender_email: row.sender_email,
                        });
                      }
                    }}
                    className="text-sm font-semibold text-warning hover:underline"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Confirmation — a deletion is never one click */}
      {pendingDelete?.kind === "campaign" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 px-4">
          <div className="w-full max-w-md rounded-2xl border border-line bg-surface p-5">
            <h2 className="text-base font-bold text-ink">Delete campaign?</h2>
            <p className="mt-2 text-sm text-muted">
              Are you sure you want to delete this campaign?
            </p>
            <p className="mt-1 text-sm text-muted">
              This will permanently remove this campaign and its associated
              application data. Sent emails already delivered are not affected.
            </p>
            <p className="mt-3 rounded-xl bg-surface-2 px-3 py-2 text-xs font-semibold text-ink-soft">
              {pendingDelete.title}
              {pendingDelete.sender_email
                ? ` · Sending from: ${pendingDelete.sender_email}`
                : ""}
            </p>
            <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={() => setPendingDelete(null)}
                disabled={isDeleting}
                className="h-10 rounded-xl border border-line-strong px-4 text-sm font-semibold text-muted disabled:cursor-not-allowed disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmDelete}
                disabled={isDeleting}
                aria-busy={isDeleting}
                className="flex h-10 items-center gap-2 rounded-xl bg-warning px-4 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-70"
              >
                {isDeleting && (
                  <span
                    aria-hidden="true"
                    className="inline-block h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-white/40 border-t-white"
                  />
                )}
                {isDeleting ? "Deleting…" : "Delete campaign"}
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingDelete?.kind === "draft" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 px-4">
          <div className="w-full max-w-md rounded-2xl border border-line bg-surface p-5">
            <h2 className="text-base font-bold text-ink">Delete draft?</h2>
            <p className="mt-2 text-sm text-muted">
              Are you sure you want to delete this draft?
            </p>
            <p className="mt-1 text-sm text-muted">
              This will permanently remove this draft, its recipients and its
              attachments. This cannot be undone.
            </p>
            <p className="mt-3 rounded-xl bg-surface-2 px-3 py-2 text-xs font-semibold text-ink-soft">
              {pendingDelete.title}
              {pendingDelete.sender_email
                ? ` · Sending from: ${pendingDelete.sender_email}`
                : ""}
            </p>
            <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={() => setPendingDelete(null)}
                disabled={isDeleting}
                className="h-10 rounded-xl border border-line-strong px-4 text-sm font-semibold text-muted disabled:cursor-not-allowed disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmDelete}
                disabled={isDeleting}
                aria-busy={isDeleting}
                className="flex h-10 items-center gap-2 rounded-xl bg-warning px-4 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-70"
              >
                {isDeleting && (
                  <span
                    aria-hidden="true"
                    className="inline-block h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-white/40 border-t-white"
                  />
                )}
                {isDeleting ? "Deleting…" : "Delete draft"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
