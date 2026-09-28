import Link from "next/link";
import { redirect } from "next/navigation";
import { SaveOpportunityButton } from "@/components/opportunity-save-button";
import { getCurrentUserAndProfile } from "@/lib/auth";
import {
  listSavedOpportunities,
  type SavedOpportunityRow,
} from "@/lib/opportunities/saved";

export const dynamic = "force-dynamic";

function formatDay(iso: string | null): string | null {
  if (!iso) return null;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime())
    ? null
    : parsed.toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      });
}

export default async function SavedOpportunitiesPage() {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active")
    redirect("/login");
  const saved = await listSavedOpportunities(user.id);

  return (
    <main className="min-h-screen bg-[#f6f8fb] px-5 py-8 sm:px-8 lg:px-10">
      <div className="mx-auto max-w-5xl">
        <Link
          href="/opportunities"
          className="text-sm font-semibold text-[#2f6fed]"
        >
          ← Opportunities
        </Link>
        <h1 className="mt-7 text-3xl font-bold tracking-[-0.04em] text-[#10203b]">
          Saved opportunities
        </h1>
        <div className="mt-8 space-y-3">
          {saved.length ? (
            saved.map((item: SavedOpportunityRow) => (
              <SavedCard key={item.id} item={item} />
            ))
          ) : (
            <div className="rounded-2xl border border-dashed border-[#dfe6f0] bg-white p-10 text-center text-sm text-[#8290a4]">
              No saved opportunities yet. Search and save the ones worth
              applying to.
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

function SavedCard({ item }: { item: SavedOpportunityRow }) {
  return (
    <article className="rounded-2xl border border-[#e7ecf3] bg-white p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-lg bg-[#edf3ff] px-2 py-1 text-[10px] font-bold uppercase text-[#2f6fed]">
              {item.goal === "ausbildung" ? "Ausbildung" : "Arbeit"}
            </span>
            {item.salary_label && (
              <span className="rounded-lg bg-[#e8f5ee] px-2 py-1 text-[10px] font-bold text-[#177a55]">
                {item.salary_label}
              </span>
            )}
            {item.match_score !== null && (
              <span
                className="rounded-lg bg-[#f7faff] px-2 py-1 text-[10px] font-bold text-[#2f6fed]"
                title="Match-Snapshot zum Zeitpunkt des Speicherns"
              >
                Match bei Speicherung: {item.match_score} %
              </span>
            )}
            {item.match_score === null &&
              item.match_status === "incomplete" && (
                <span
                  className="rounded-lg bg-[#fff4e5] px-2 py-1 text-[10px] font-bold text-[#a3611c]"
                  title="Zum Speichern fehlten essentielle Profilangaben"
                >
                  Match bei Speicherung: unvollständig
                </span>
              )}
          </div>
          <h2 className="mt-3 text-lg font-bold text-[#1d3458]">
            {item.title || "Untitled opportunity"}
          </h2>
          <p className="mt-1 text-sm text-[#71819a]">
            {item.company_name || "Company not listed"} ·{" "}
            {item.location || "Location not listed"}
          </p>
          <p className="mt-1 text-xs text-[#8290a4]">
            {[
              item.source_name ?? "Saved from search",
              item.posted_at ? `Posted ${formatDay(item.posted_at)}` : null,
              item.saved_at ? `Saved ${formatDay(item.saved_at)}` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
          {item.notes && (
            <p className="mt-2 rounded-xl bg-[#f7f9fc] p-3 text-xs text-[#546783]">
              {item.notes}
            </p>
          )}
          <p className="mt-2 text-[11px] text-[#8290a4]">
            Aktueller Match wird auf der Detailseite live berechnet — nach
            Profiländerungen kann er vom Snapshot abweichen.
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <Link
            href={`/opportunities/${encodeURIComponent(item.opportunity_key)}`}
            className="rounded-xl bg-[#10203b] px-4 py-2 text-xs font-semibold text-white"
          >
            View details
          </Link>
          <Link
            href={`/applications/new?opp=${encodeURIComponent(item.opportunity_key)}`}
            className="rounded-xl bg-[#edf3ff] px-4 py-2 text-xs font-semibold text-[#2f6fed]"
          >
            Prepare application
          </Link>
          {item.source_url && (
            <a
              href={item.source_url}
              target="_blank"
              rel="noreferrer"
              className="text-xs font-bold text-[#2f6fed]"
            >
              Open source →
            </a>
          )}
          <SaveOpportunityButton
            opportunityKey={item.opportunity_key}
            initialSaved
          />
        </div>
      </div>
    </article>
  );
}
