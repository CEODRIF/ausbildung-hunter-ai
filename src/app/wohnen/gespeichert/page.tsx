"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useI18n } from "@/lib/i18n";
import { Icon } from "@/components/icon";
import { Button } from "@/components/ui";
import { DemoBanner } from "@/components/housing/demo-banner";
import { formatEur } from "@/lib/housing/affordability";
import type {
  SavedHousingListing,
  SavedListingStatus,
} from "@/lib/housing/types";

const STATUSES: SavedListingStatus[] = ["saved", "applied", "viewing", "rejected", "closed"];

type Phase = "loading" | "done" | "error";

/**
 * Gespeicherte Angebote — the user's saved listings, with notes, a status
 * workflow, and removal. Data is the server-stored snapshot, so a card stays
 * correct even if the source listing changes or disappears.
 */
export default function SavedListingsPage() {
  const { t } = useI18n();
  const [phase, setPhase] = useState<Phase>("loading");
  const [rows, setRows] = useState<SavedHousingListing[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/housing/save");
        if (!res.ok) throw new Error();
        const data = (await res.json()) as { listings: SavedHousingListing[] };
        if (!cancelled) {
          setRows(data.listings ?? []);
          setPhase("done");
        }
      } catch {
        if (!cancelled) setPhase("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function patchRow(row: SavedHousingListing, body: Record<string, unknown>) {
    await fetch("/api/housing/save", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "listing", provider: row.provider, sourceId: row.source_listing_id, ...body }),
    });
  }

  async function removeRow(row: SavedHousingListing) {
    setRows((prev) => prev.filter((r) => r.id !== row.id));
    await fetch("/api/housing/save", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "listing", provider: row.provider, sourceId: row.source_listing_id }),
    });
  }

  return (
    <div className="px-4 py-6 sm:px-6 lg:px-10">
      <div className="mx-auto max-w-3xl space-y-4">
        {/* Snapshots today are demo data (no live providers registered) —
            keep the saved list from looking like live offers. */}
        {phase === "done" &&
          rows.length > 0 &&
          rows.every((r) => r.snapshot.data_status === "demo") && <DemoBanner />}
        {phase === "loading" && (
          <div className="flex items-center gap-3 rounded-3xl border border-line bg-surface p-6 text-sm text-muted">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-line-strong border-t-accent" />
            {t("common.loading")}
          </div>
        )}

        {phase === "error" && (
          <div className="rounded-3xl border border-danger/30 bg-danger-soft p-6 text-sm text-danger">
            {t("housing.error")}
          </div>
        )}

        {phase === "done" && rows.length === 0 && (
          <div className="flex flex-col items-center justify-center rounded-3xl border border-dashed border-line-strong bg-surface p-12 text-center">
            <Icon name="bookmark" size={34} strokeWidth={1.4} className="text-faint" />
            <p className="mt-3 text-sm font-semibold text-ink">{t("housing.savedEmpty")}</p>
            <Link href="/wohnen">
              <Button className="mt-4" variant="secondary" size="sm">
                {t("housing.savedEmptyCta")}
              </Button>
            </Link>
          </div>
        )}

        {phase === "done" &&
          rows.map((row) => {
            const l = row.snapshot;
            return (
              <div
                key={row.id}
                className="space-y-3 rounded-3xl border border-line bg-surface p-4 shadow-[var(--shadow-card)]"
              >
                <div className="flex items-start gap-3">
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-accent-soft text-accent">
                    <Icon name="home" size={22} strokeWidth={1.6} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate text-sm font-bold text-ink">{l.title}</h3>
                    <p className="truncate text-xs text-muted">
                      {[l.city, l.address, l.postal_code].filter(Boolean).join(", ")}
                    </p>
                    <p className="mt-1 text-sm font-extrabold text-accent">
                      {l.rent_warm_eur != null ? formatEur(l.rent_warm_eur) : "—"}
                      {l.rent_warm_eur != null && (
                        <span className="ms-1 text-xs font-semibold text-muted">
                          {t("housing.warm")}
                        </span>
                      )}
                    </p>
                  </div>
                  <a
                    href={l.listing_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs font-semibold text-accent hover:underline"
                  >
                    {t("housing.externalLink")}
                    <Icon name="external" size={12} strokeWidth={2} />
                  </a>
                </div>

                {/* status */}
                <div className="flex flex-wrap items-center gap-2">
                  <label className="flex items-center gap-1.5 text-xs font-semibold text-muted">
                    {t("housing.savedStatusLabel")}
                    <select
                      className="h-8 rounded-lg border border-line-strong bg-surface px-2 text-xs text-ink outline-none focus:border-accent"
                      value={row.status}
                      onChange={(e) => {
                        const status = e.target.value as SavedListingStatus;
                        setRows((prev) =>
                          prev.map((r) => (r.id === row.id ? { ...r, status } : r)),
                        );
                        void patchRow(row, { status });
                      }}
                    >
                      {STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {t(`housing.savedStatus.${s}`)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    onClick={() => void removeRow(row)}
                    className="ms-auto inline-flex items-center gap-1 text-xs font-semibold text-danger hover:underline"
                  >
                    <Icon name="trash" size={13} strokeWidth={2} />
                    {t("housing.savedRemove")}
                  </button>
                </div>

                {/* notes */}
                <NotesEditor
                  key={row.id}
                  initial={row.notes ?? ""}
                  placeholder={t("housing.savedAddNote")}
                  onSave={(notes) => {
                    setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, notes } : r)));
                    void patchRow(row, { notes });
                  }}
                />
              </div>
            );
          })}
      </div>
    </div>
  );
}

function NotesEditor({
  initial,
  placeholder,
  onSave,
}: {
  initial: string;
  placeholder: string;
  onSave: (notes: string) => void;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState(initial);
  const [editing, setEditing] = useState(false);
  const dirty = value !== initial;

  return (
    <div>
      {editing ? (
        <div className="space-y-2">
          <textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={placeholder}
            className="min-h-16 w-full resize-y rounded-2xl border border-line-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-accent focus:ring-4 focus:ring-accent/10"
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={!dirty}
              onClick={() => {
                onSave(value.trim());
                setEditing(false);
              }}
            >
              <Icon name="check" size={14} strokeWidth={2} />
              OK
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setValue(initial);
                setEditing(false);
              }}
            >
              {t("common.close")}
            </Button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="w-full rounded-2xl border border-dashed border-line-strong bg-surface-2/50 px-3 py-2 text-start text-xs text-muted transition-colors hover:border-accent"
        >
          {value ? <span className="text-ink-soft">{value}</span> : placeholder}
        </button>
      )}
    </div>
  );
}
