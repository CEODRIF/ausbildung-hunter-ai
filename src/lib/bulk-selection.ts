/**
 * Pure selection helpers for the Applications bulk-delete UI.
 *
 * Framework-free (no React/Next imports) so the selection logic can be
 * unit-tested directly. The selection only ever contains CAMPAIGN ids —
 * draft rows are never selectable: bulk delete is campaigns only, and a
 * draft keeps its own single-row Delete flow.
 */

export function isCampaignRow(row: { kind: string }): boolean {
  return row.kind === "campaign";
}

/** Ids of the campaign rows among the given rows (drafts excluded). */
export function campaignIds(
  rows: Array<{ kind: string; id: string }>,
): string[] {
  return rows.filter(isCampaignRow).map((row) => row.id);
}

/** Toggle one campaign id in the selection (returns a new Set). */
export function toggleSelection(selected: Set<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/**
 * "Select all" header checkbox: selects every VISIBLE campaign row (the
 * current filtered/sorted view — campaigns hidden by the search never join
 * the selection, and drafts are never selectable). When every visible
 * campaign is already selected, it clears the selection instead.
 */
export function selectAllVisible(
  selected: Set<string>,
  visibleRows: Array<{ kind: string; id: string }>,
): Set<string> {
  const visibleIds = campaignIds(visibleRows);
  if (visibleIds.length === 0) return new Set();
  const allSelected = visibleIds.every((id) => selected.has(id));
  return allSelected ? new Set() : new Set(visibleIds);
}

/**
 * Drop ids that no longer exist in the list (deleted rows disappear from
 * the server data after revalidation; a deleted id must never survive in
 * the selection or in the local "hidden" set). Returns the same Set when
 * nothing changed so React can skip a re-render.
 */
export function pruneSelection(
  selected: Set<string>,
  rows: Array<{ kind: string; id: string }>,
): Set<string> {
  const ids = new Set(rows.map((row) => row.id));
  let changed = false;
  const next = new Set<string>();
  for (const id of selected) {
    if (ids.has(id)) next.add(id);
    else changed = true;
  }
  return changed ? next : selected;
}

/** Human summary of a bulk-delete result (the UI shows it verbatim). */
export function bulkDeleteSummary(
  deleted: string[],
  blocked: string[],
  failed: string[],
): string {
  const parts: string[] = [];
  if (deleted.length > 0)
    parts.push(
      `${deleted.length} campaign${
        deleted.length === 1 ? "" : "s"
      } deleted successfully.`,
    );
  if (blocked.length > 0)
    parts.push(
      `${blocked.length} campaign${
        blocked.length === 1 ? "" : "s"
      } could not be deleted because ${
        blocked.length === 1 ? "it is" : "they are"
      } currently being sent.`,
    );
  if (failed.length > 0)
    parts.push(
      `${failed.length} campaign${
        failed.length === 1 ? "" : "s"
      } could not be deleted.`,
    );
  return parts.join(" ");
}
