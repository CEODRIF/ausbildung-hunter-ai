"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { ArrowUpDown, Search } from "lucide-react";
import {
  deleteCampaignAction,
  deleteCampaignsAction,
} from "@/app/applications/actions";
import { discardDraft } from "@/app/applications/new/actions";
import {
  bulkDeleteSummary,
  campaignIds,
  pruneSelection,
  selectAllVisible,
  toggleSelection,
} from "@/lib/bulk-selection";

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

const STATUS_DOTS: Record<string, string> = {
  draft: "bg-faint",
  queued: "bg-ink-soft",
  sending: "bg-accent",
  completed: "bg-success",
  partially_failed: "bg-warning",
  failed: "bg-warning",
  cancelled: "bg-faint",
};

function SearchIcon({ className = "" }: { className?: string }) {
  return <Search size={16} strokeWidth={1.8} className={className} aria-hidden="true" />;
}

function ArrowUpDownIcon() {
  return <ArrowUpDown size={15} strokeWidth={1.8} aria-hidden="true" />;
}

/** Subtle stage pill — the color always follows the REAL engine status. */
function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold whitespace-nowrap ${
        STATUS_TONES[status] ?? "bg-surface-2 text-ink-soft"
      }`}
    >
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 rounded-full ${
          STATUS_DOTS[status] ?? "bg-faint"
        } ${status === "sending" ? "animate-pulse" : ""}`}
      />
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

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
 * Delete (single, with an explicit confirmation) plus bulk selection and
 * bulk delete for CAMPAIGNS only (drafts keep their own single-row Delete).
 * Every value rendered here comes from the database; the component only
 * filters, sorts and selects what it is given.
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
  // Bulk selection — campaign ids only (draft rows are never selectable).
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
  const [pendingBulk, setPendingBulk] = useState(false);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);
  const [bulkResult, setBulkResult] = useState<{
    text: string;
    warning: boolean;
  } | null>(null);

  // Derived, always-current views: ids that no longer exist in the server
  // data (deleted + revalidated) are pruned at render time — no effect, no
  // stale state; a deleted id can never survive in the selection or in the
  // hidden set.
  const effectiveHidden = useMemo(
    () => pruneSelection(hiddenIds, items),
    [hiddenIds, items],
  );
  const effectiveSelected = useMemo(
    () => pruneSelection(selected, items),
    [selected, items],
  );
  // Rows removed locally after a bulk delete, until the server data
  // revalidates (no full page reload needed for the list itself).
  const visibleItems = useMemo(
    () => items.filter((row) => !effectiveHidden.has(row.id)),
    [items, effectiveHidden],
  );

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return visibleItems
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
  }, [visibleItems, query, status, newestFirst]);

  const statusesPresent = useMemo(
    () => [...new Set(items.map((row) => row.status))].sort(),
    [items],
  );

  // The bulk UI only exists when there are campaign rows at all.
  const viewCampaignIds = useMemo(() => campaignIds(rows), [rows]);
  const selectedInView = viewCampaignIds.filter(
    (id) => effectiveSelected.has(id),
  ).length;
  const allVisibleSelected =
    viewCampaignIds.length > 0 && selectedInView === viewCampaignIds.length;
  const someVisibleSelected = selectedInView > 0;
  // Client-side hint (the engine is authoritative): how many selected
  // campaigns currently read `sending` — they will be skipped, not forced.
  const selectedSending = useMemo(
    () =>
      items.filter(
        (row) =>
          row.kind === "campaign" &&
          effectiveSelected.has(row.id) &&
          row.status === "sending",
      ).length,
    [items, effectiveSelected],
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

  async function confirmBulkDelete() {
    // Double-click / double-confirm guard: one bulk operation at a time.
    if (isBulkDeleting || effectiveSelected.size === 0) return;
    setIsBulkDeleting(true);
    setBulkResult(null);
    try {
      const result = await deleteCampaignsAction([...effectiveSelected]);
      // Only the ids the engine actually deleted leave the list.
      if (result.deleted.length > 0) {
        setHiddenIds((prev) => new Set([...prev, ...result.deleted]));
      }
      setSelected((prev) => {
        const next = new Set(prev);
        for (const id of result.deleted) next.delete(id);
        return next;
      });
      if (result.deleted.length === 0 && result.blocked.length > 0) {
        setBulkResult({
          warning: true,
          text: "All selected campaigns are currently being sent. Please wait until sending finishes before deleting them.",
        });
      } else {
        const summary = bulkDeleteSummary(
          result.deleted,
          result.blocked,
          result.failed,
        );
        if (summary)
          setBulkResult({
            warning: result.blocked.length > 0 || result.failed.length > 0,
            text: summary,
          });
      }
      setPendingBulk(false);
      router.refresh();
    } catch {
      setBulkResult({ warning: true, text: "Unable to delete campaigns." });
    } finally {
      setIsBulkDeleting(false);
    }
  }

  return (
    <div>
      {/* Toolbar */}
      <div className="flex flex-col gap-3 border-b border-line px-4 py-3.5 sm:flex-row sm:items-center sm:px-5">
        <div className="relative flex-1">
          <SearchIcon className="pointer-events-none absolute start-3.5 top-1/2 -translate-y-1/2 text-faint" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search campaigns"
            className="h-11 w-full rounded-2xl border border-line bg-surface ps-10 pe-3.5 text-sm text-ink shadow-sm outline-none transition-[border-color,box-shadow] focus:border-accent focus:ring-4 focus:ring-accent/10"
          />
        </div>
        <select
          value={status}
          onChange={(event) => setStatus(event.target.value)}
          className="h-11 rounded-2xl border border-line bg-surface px-3 text-sm font-semibold text-ink-soft shadow-sm outline-none focus:border-accent"
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
          className="inline-flex h-11 items-center gap-2 rounded-2xl border border-line bg-surface px-4 text-sm font-bold text-muted shadow-sm transition hover:bg-surface-2 hover:text-ink"
        >
          <ArrowUpDownIcon />
          {newestFirst ? "Newest first" : "Oldest first"}
        </button>
      </div>

      {/* Bulk actions bar — only while something is selected */}
      {effectiveSelected.size > 0 && (
        <div className="flex flex-col gap-3 border-b border-line bg-warning-soft/60 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm font-semibold text-ink-soft">
            {effectiveSelected.size} campaign
            {effectiveSelected.size === 1 ? "" : "s"} selected
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              disabled={isBulkDeleting}
              className="h-9 rounded-xl border border-line-strong px-3 text-sm font-semibold text-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              Clear selection
            </button>
            <button
              type="button"
              onClick={() => setPendingBulk(true)}
              disabled={isBulkDeleting}
              className="h-9 rounded-xl bg-warning px-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-70"
            >
              Delete selected
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="border-b border-line px-4 py-3 text-xs font-semibold text-warning">
          {error}
        </p>
      )}

      {bulkResult && (
        <p
          className={`border-b border-line px-4 py-3 text-xs font-semibold ${
            bulkResult.warning ? "text-warning" : "text-success"
          }`}
        >
          {bulkResult.text}
        </p>
      )}

      {rows.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted">No campaigns match.</p>
      ) : (
        <>
          {/* Desktop */}
          <div className="hidden overflow-x-auto lg:block">
              <table className="w-full text-left text-sm">
                <thead className="text-[11px] uppercase tracking-wide text-faint">
                  <tr className="border-b border-line">
                  <th className="w-10 px-4 py-3">
                    {viewCampaignIds.length > 0 && (
                      <input
                        type="checkbox"
                        aria-label="Select all visible campaigns"
                        checked={allVisibleSelected}
                        ref={(element) => {
                          if (element)
                            element.indeterminate =
                              someVisibleSelected && !allVisibleSelected;
                        }}
                        onChange={() =>
                          setSelected(selectAllVisible(effectiveSelected, rows))
                        }
                        className="h-4 w-4 cursor-pointer accent-accent-deep"
                      />
                    )}
                  </th>
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
                      className="border-b border-line transition-colors last:border-0 hover:bg-surface-2/40"
                    >
                      <td className="w-10 px-4 py-3.5">
                        {row.kind === "campaign" ? (
                          <input
                            type="checkbox"
                            aria-label={`Select ${row.title}`}
                            checked={effectiveSelected.has(row.id)}
                            onChange={() =>
                              setSelected(toggleSelection(selected, row.id))
                            }
                            className="h-4 w-4 cursor-pointer accent-accent-deep"
                          />
                        ) : null}
                      </td>
                      <td className="px-4 py-3.5">
                        <p className="font-bold text-ink">{row.title}</p>
                        {row.company && (
                          <p className="text-xs text-muted">{row.company}</p>
                        )}
                      </td>
                      <td className="px-4 py-3.5 text-muted">
                        {typeLabel(row.goal)}
                      </td>
                      <td className="px-4 py-3.5 text-muted">
                        {row.sender_email ?? "—"}
                      </td>
                      <td className="num px-4 py-3.5 text-muted">
                        {row.total_recipients ?? "—"}
                      </td>
                      <td className="px-4 py-3.5">
                        <StatusPill status={row.status} />
                      </td>
                      <td className="num px-4 py-3.5 text-muted">
                        {row.sent_count ?? "—"}
                      </td>
                      <td className="num px-4 py-3.5 text-muted">
                        {row.failed_count ?? "—"}
                      </td>
                      <td className="px-4 py-3.5 text-muted">
                        {formatDate(row.created_at, locale)}
                      </td>
                    <td className="px-4 py-3.5">
                      <div className="flex items-center gap-4">
                        <Link
                          href={
                            row.campaign_id
                              ? `/applications/campaign/${row.campaign_id}`
                              : `/applications/new?draft=${row.id}`
                          }
                          className="font-bold text-accent transition hover:text-accent-deep hover:underline"
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
                          className="font-bold text-danger/70 transition hover:text-danger hover:underline"
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
                  <div className="flex min-w-0 items-start gap-3">
                    {row.kind === "campaign" && (
                      <input
                        type="checkbox"
                        aria-label={`Select ${row.title}`}
                        checked={selected.has(row.id)}
                        onChange={() =>
                          setSelected(toggleSelection(selected, row.id))
                        }
                        className="mt-1 h-4 w-4 shrink-0 cursor-pointer accent-accent-deep"
                      />
                    )}
                    <div className="min-w-0">
                      <p className="truncate font-bold text-ink">{row.title}</p>
                      {row.company && (
                        <p className="text-xs text-muted">{row.company}</p>
                      )}
                    </div>
                  </div>
                  <span className="shrink-0">
                    <StatusPill status={row.status} />
                  </span>
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs text-muted">
                  <div>Type: {typeLabel(row.goal)}</div>
                  <div>Sender: {row.sender_email ?? "—"}</div>
                  <div>Recipients: {row.total_recipients ?? "—"}</div>
                  <div>Sent: {row.sent_count ?? "—"}</div>
                  <div>Failed: {row.failed_count ?? "—"}</div>
                  <div>Created: {formatDate(row.created_at, locale)}</div>
                </dl>
                <div className="mt-3 flex items-center gap-5">
                  <Link
                    href={
                      row.campaign_id
                        ? `/applications/campaign/${row.campaign_id}`
                        : `/applications/new?draft=${row.id}`
                    }
                    className="text-sm font-bold text-accent hover:underline"
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

      {/* Bulk confirmation — a bulk deletion is never one click */}
      {pendingBulk && effectiveSelected.size > 0 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 px-4">
          <div className="w-full max-w-md rounded-3xl border border-line bg-surface p-6 shadow-[var(--shadow-float)]">
            <h2 className="text-base font-bold text-ink">
              Delete selected campaigns?
            </h2>
            <p className="mt-2 text-sm text-muted">
              You are about to permanently delete {effectiveSelected.size}{" "}
              campaign{effectiveSelected.size === 1 ? "" : "s"}.
            </p>
            <p className="mt-1 text-sm text-muted">
              This action cannot be undone.
            </p>
            {selectedSending > 0 && (
              <p className="mt-3 rounded-xl bg-warning-soft px-3 py-2 text-xs font-semibold text-warning">
                {selectedSending} selected campaign
                {selectedSending === 1 ? " is" : "s are"} currently being sent
                {selectedSending === effectiveSelected.size
                  ? "."
                  : " and will be skipped."}
              </p>
            )}
            {selectedSending === effectiveSelected.size && (
              <p className="mt-2 text-sm text-muted">
                Please wait until sending finishes before deleting them.
              </p>
            )}
            <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={() => setPendingBulk(false)}
                disabled={isBulkDeleting}
                className="h-10 rounded-xl border border-line-strong px-4 text-sm font-semibold text-muted disabled:cursor-not-allowed disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmBulkDelete}
                disabled={
                  isBulkDeleting ||
                  effectiveSelected.size === 0 ||
                  selectedSending === effectiveSelected.size
                }
                aria-busy={isBulkDeleting}
                className="flex h-10 items-center gap-2 rounded-xl bg-warning px-4 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-70"
              >
                {isBulkDeleting && (
                  <span
                    aria-hidden="true"
                    className="inline-block h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-white/40 border-t-white"
                  />
                )}
                {isBulkDeleting
                  ? "Deleting…"
                  : `Delete ${effectiveSelected.size} campaign${
                      effectiveSelected.size === 1 ? "" : "s"
                    }`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirmation — a single deletion is never one click */}
      {pendingDelete?.kind === "campaign" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 px-4">
          <div className="w-full max-w-md rounded-3xl border border-line bg-surface p-6 shadow-[var(--shadow-float)]">
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
          <div className="w-full max-w-md rounded-3xl border border-line bg-surface p-6 shadow-[var(--shadow-float)]">
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
