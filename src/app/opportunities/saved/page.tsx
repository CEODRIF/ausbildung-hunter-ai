import Link from "next/link";
import { redirect } from "next/navigation";
import { SaveOpportunityButton } from "@/components/opportunity-save-button";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { MATCHER_VERSION } from "@/lib/opportunities/matching";
import { getServerT, getRequestLang } from "@/lib/i18n/server";
import { localeForLang } from "@/lib/i18n/core";
import {
  evaluateSnapshotStaleness,
  formatSnapshotDate,
  getProfileRevision,
  listSavedOpportunities,
  type SavedOpportunityRow,
  type SnapshotStaleness,
} from "@/lib/opportunities/saved";

export const dynamic = "force-dynamic";

type T = (path: string, vars?: Record<string, string | number>) => string;

function formatDay(
  iso: string | null,
  locale: string,
): string | null {
  if (!iso) return null;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime())
    ? null
    : parsed.toLocaleDateString(locale, {
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
  // Best-effort current profile revision (server-side) so each saved
  // snapshot can be labeled fresh or stale — never silently current.
  const profileRevision = await getProfileRevision(user.id);
  const stalenessByRow = new Map(
    saved.map((row) => [
      row.id,
      evaluateSnapshotStaleness(row, {
        profileUpdatedAt: profileRevision,
        matcherVersion: MATCHER_VERSION,
      }),
    ]),
  );
  const [t, lang] = await Promise.all([getServerT(), getRequestLang()]);
  const locale = localeForLang(lang);

  return (
    <div className="px-4 py-6 sm:px-6 lg:px-10">
      <div className="mx-auto max-w-5xl">
        <div className="mt-2 space-y-3">
          {saved.length ? (
            saved.map((item: SavedOpportunityRow) => (
              <SavedCard
                key={item.id}
                t={t}
                locale={locale}
                item={item}
                staleness={stalenessByRow.get(item.id) ?? null}
              />
            ))
          ) : (
            <div className="rounded-2xl border border-dashed border-line-strong bg-surface p-10 text-center text-sm text-muted">
              <p className="font-semibold text-ink-soft">
                {t("account.emptySavedTitle")}
              </p>
              <p className="mt-1">{t("account.emptySavedBody")}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SavedCard({
  t,
  locale,
  item,
  staleness,
}: {
  t: T;
  locale: string;
  item: SavedOpportunityRow;
  staleness: SnapshotStaleness | null;
}) {
  const snapshotStand = formatSnapshotDate(item.saved_at, locale);
  return (
    <article className="rounded-2xl border border-line bg-surface p-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-lg bg-accent-soft px-2 py-1 text-[10px] font-bold uppercase text-accent">
              {t(
                item.goal === "ausbildung"
                  ? "dash.goalAusbildung"
                  : "dash.goalArbeit",
              )}
            </span>
            {item.salary_label && (
              <span className="rounded-lg bg-success-soft px-2 py-1 text-[10px] font-bold text-success">
                {item.salary_label}
              </span>
            )}
            {item.match_score !== null && (
              <span
                className={`rounded-lg px-2 py-1 text-[10px] font-bold ${
                  staleness?.stale
                    ? "bg-surface-2 text-muted"
                    : "bg-surface-2 text-accent"
                }`}
                title={t("account.snapshotSince", {
                  date: snapshotStand ?? t("account.unknownDate"),
                  version: item.matcher_version ?? t("account.unknownVersion"),
                })}
              >
                {t("account.matchAtSave", { score: item.match_score })}
                {snapshotStand ? ` · ${snapshotStand}` : ""}
              </span>
            )}
            {item.match_score === null &&
              item.match_status === "incomplete" && (
                <span
                  className="rounded-lg bg-warning-soft px-2 py-1 text-[10px] font-bold text-warning"
                  title={t("account.missingProfileAtSave")}
                >
                  {t("account.matchAtSaveIncomplete")}
                </span>
              )}
            {staleness?.stale && (
              <span
                className="rounded-lg bg-warning-soft px-2 py-1 text-[10px] font-bold text-warning"
                title={staleness.reasons.join(" ")}
              >
                {t("account.staleSnapshot")}
              </span>
            )}
          </div>
          <h2 className="mt-3 text-lg font-bold text-ink-soft">
            {item.title || t("search.untitled")}
          </h2>
          <p className="mt-1 text-sm text-muted">
            {item.company_name || t("search.companyNotListed")} ·{" "}
            {item.location || t("search.locationNotListed")}
          </p>
          <p className="mt-1 text-xs text-muted">
            {[
              item.source_name ?? t("account.savedFromSearch"),
              item.posted_at
                ? t("account.postedOn", {
                    date: formatDay(item.posted_at, locale) ?? "",
                  })
                : null,
              item.saved_at
                ? t("account.savedOn", {
                    date: formatDay(item.saved_at, locale) ?? "",
                  })
                : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
          {item.notes && (
            <p className="mt-2 rounded-xl bg-surface-2 p-3 text-xs text-muted">
              {item.notes}
            </p>
          )}
          <p className="mt-2 text-[11px] text-muted">
            {t("account.liveMatchNote")}
          </p>
          {staleness?.stale && (
            <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-[11px] text-warning">
              {staleness.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-start gap-2 sm:items-end">
          <Link
            href={`/opportunities/${encodeURIComponent(item.opportunity_key)}`}
            className="rounded-xl bg-navy px-4 py-2 text-xs font-semibold text-white"
          >
            {t("account.viewDetails")}
          </Link>
          <Link
            href={`/applications/new?opp=${encodeURIComponent(item.opportunity_key)}`}
            className="rounded-xl bg-accent-soft px-4 py-2 text-xs font-semibold text-accent"
          >
            {t("account.prepareApplication")}
          </Link>
          {item.source_url && (
            <a
              href={item.source_url}
              target="_blank"
              rel="noreferrer"
              className="text-xs font-bold text-accent"
            >
              {t("account.openSource")} →
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
