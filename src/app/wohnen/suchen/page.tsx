"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useI18n } from "@/lib/i18n";
import { Icon } from "@/components/icon";
import { Button } from "@/components/ui";
import { formatEur } from "@/lib/housing/affordability";
import type { SavedHousingSearch } from "@/lib/housing/types";

type Phase = "loading" | "done" | "error";

const TYPE_KEY: Record<string, string> = {
  apartment: "typeApartment",
  wg_room: "typeWg",
  furnished: "typeFurnished",
  studio: "typeStudio",
};

function formatDay(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString();
}

function runHref(query: SavedHousingSearch["query"]): string {
  return `/wohnen?q=${encodeURIComponent(JSON.stringify(query))}`;
}

/**
 * Meine Suchen — the user's saved searches. "Suchen" re-applies the saved
 * filter set on the main search page via a `?q=` deep link.
 */
export default function SavedSearchesPage() {
  const { t } = useI18n();
  const [phase, setPhase] = useState<Phase>("loading");
  const [rows, setRows] = useState<SavedHousingSearch[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/housing/save");
        if (!res.ok) throw new Error();
        const data = (await res.json()) as { searches: SavedHousingSearch[] };
        if (!cancelled) {
          setRows(data.searches ?? []);
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

  async function removeRow(id: string) {
    setRows((prev) => prev.filter((r) => r.id !== id));
    await fetch("/api/housing/save", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "search", id }),
    });
  }

  return (
    <div className="px-4 py-6 sm:px-6 lg:px-10">
      <div className="mx-auto max-w-3xl space-y-4">
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
            <Icon name="search" size={34} strokeWidth={1.4} className="text-faint" />
            <p className="mt-3 text-sm font-semibold text-ink">{t("housing.searchesEmpty")}</p>
            <Link href="/wohnen">
              <Button className="mt-4" variant="secondary" size="sm">
                {t("housing.searchesEmptyCta")}
              </Button>
            </Link>
          </div>
        )}

        {phase === "done" &&
          rows.map((row) => {
            const q = row.query;
            const bits: string[] = [];
            if (q.city) bits.push(q.city);
            if (q.accommodation_type && q.accommodation_type !== "all" && TYPE_KEY[q.accommodation_type])
              bits.push(t(`housing.${TYPE_KEY[q.accommodation_type]}`));
            if (q.max_warm_rent != null) bits.push(`≤ ${formatEur(q.max_warm_rent)}`);
            if (q.rooms !== "all") bits.push(`${q.rooms} ${t("housing.searchRooms")}`);

            return (
              <div
                key={row.id}
                className="flex flex-col gap-3 rounded-3xl border border-line bg-surface p-4 shadow-[var(--shadow-card)] sm:flex-row sm:items-center"
              >
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-accent-soft text-accent">
                  <Icon name="search" size={20} strokeWidth={1.7} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-bold text-ink">
                    {row.name || t("housing.searchesRun")}
                  </p>
                  <p className="truncate text-xs text-muted">
                    {bits.length ? bits.join(" · ") : t("housing.typeAll")}
                  </p>
                  <p className="mt-0.5 text-[11px] text-faint">
                    {row.last_run_at && (
                      <>
                        {t("housing.searchesLastRun")}: {formatDay(row.last_run_at)} ·{" "}
                      </>
                    )}
                    {t("housing.searchesCount", { n: row.last_count })}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Link href={runHref(q)}>
                    <Button variant="secondary" size="sm">
                      {t("housing.searchesRun")}
                    </Button>
                  </Link>
                  <button
                    type="button"
                    onClick={() => void removeRow(row.id)}
                    aria-label={t("housing.searchesRemove")}
                    className="flex h-9 w-9 items-center justify-center rounded-xl text-muted transition-colors hover:bg-danger-soft hover:text-danger"
                  >
                    <Icon name="trash" size={16} strokeWidth={1.8} />
                  </button>
                </div>
              </div>
            );
          })}
      </div>
    </div>
  );
}
