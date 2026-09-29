import Link from "next/link";
import { redirect } from "next/navigation";
import { SaveOpportunityButton } from "@/components/opportunity-save-button";
import { getCurrentUserAndProfile } from "@/lib/auth";
import {
  getOpportunityDetails,
  OpportunityNotFoundError,
} from "@/lib/opportunities/search";
import {
  DIMENSION_LABELS,
  MATCH_STATUS_LABELS,
  MATCHER_VERSION,
  STATUS_LABELS,
  formatMatchScore,
  type MatchResult,
} from "@/lib/opportunities/matching";
import {
  evaluateSnapshotStaleness,
  formatSnapshotDate,
  getProfileRevision,
  listSavedOpportunities,
} from "@/lib/opportunities/saved";
import { sanitizeSearchUrlState } from "@/lib/opportunities/types";
import { getServerT, getRequestLang } from "@/lib/i18n/server";
import { localeForLang } from "@/lib/i18n/core";

export const dynamic = "force-dynamic";

type T = (path: string, vars?: Record<string, string | number>) => string;

const EDUCATION_KEYS: Record<string, string> = {
  basic: "account.eduBasic",
  intermediate: "account.eduIntermediate",
  advanced: "account.eduAdvanced",
  university: "account.eduUniversity",
  unknown: "account.eduUnknown",
};

function formatDay(iso: string | null, locale: string): string | null {
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

export default async function OpportunityDetailsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active")
    redirect("/login");

  const id = decodeURIComponent((await params).id);
  // `from` carries the previous search state for the back link. It is
  // re-sanitized server-side (whitelist + validation) — never trusted raw.
  const rawFrom = (await searchParams).from;
  const backQuery = sanitizeSearchUrlState(
    typeof rawFrom === "string" ? decodeURIComponent(rawFrom) : "",
  );
  const backHref = backQuery ? `/opportunities?${backQuery}` : "/opportunities";
  const [t, lang] = await Promise.all([getServerT(), getRequestLang()]);
  const locale = localeForLang(lang);
  let details: Awaited<ReturnType<typeof getOpportunityDetails>> | null = null;
  let stateError: string | null = null;
  try {
    details = await getOpportunityDetails(id, { userId: user.id });
  } catch (error) {
    if (error instanceof OpportunityNotFoundError) {
      stateError = error.message;
    } else {
      stateError = t("account.unavailableTitle");
    }
  }
  const savedRows = stateError ? [] : await listSavedOpportunities(user.id);
  const savedKeys = new Set(savedRows.map((row) => row.opportunity_key));

  if (stateError || !details) {
    return (
      <div className="px-4 py-6 sm:px-6 lg:px-10">
        <div className="mx-auto max-w-3xl">
          <Link
            href={backHref}
            className="text-sm font-semibold text-accent"
          >
            ← {t("account.backToOpportunities")}
          </Link>
          <div className="mt-8 rounded-2xl border border-line bg-surface p-10 text-center">
            <h2 className="text-xl font-bold text-ink">
              {t("account.unavailableTitle")}
            </h2>
            <p className="mt-3 text-sm leading-6 text-muted">{stateError}</p>
          </div>
        </div>
      </div>
    );
  }

  const opportunity = details.opportunity;
  const match = opportunity.match;

  // Saved-snapshot provenance (server-side): labels the stored snapshot as
  // historical and states explicitly when the profile/engine changed since.
  let snapshotLines: string[] | null = null;
  const savedRow = savedRows.find(
    (row) => row.opportunity_key === opportunity.id,
  );
  if (savedRow && match) {
    const profileRevision = await getProfileRevision(user.id);
    const staleness = evaluateSnapshotStaleness(savedRow, {
      profileUpdatedAt: profileRevision,
      matcherVersion: MATCHER_VERSION,
    });
    if (staleness.hasSnapshot) {
      const stand = formatSnapshotDate(savedRow.saved_at, locale);
      const scoreLabel =
        savedRow.match_score !== null
          ? `${savedRow.match_score} %`
          : t("account.scoreIncomplete");
      snapshotLines = [
        t("account.savedSnapshotNote", {
          score: scoreLabel,
          date: stand ?? t("account.unknownDate"),
          version: savedRow.matcher_version ?? t("account.unknownVersion"),
        }),
        ...staleness.reasons,
      ];
    }
  }

  const applyHref = opportunity.application_url ?? opportunity.source_url;
  const applyLabel = opportunity.application_url
    ? `${t("account.applyAtCompany")} →`
    : `${t("account.openInJobbörse")} →`;

  return (
    <div className="px-4 py-6 sm:px-6 lg:px-10">
      <div className="mx-auto max-w-4xl">
        <Link href={backHref} className="text-sm font-semibold text-accent">
          ← {t("account.backToOpportunities")}
        </Link>
        <article className="mt-8 rounded-2xl border border-line bg-surface p-6 sm:p-8">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-lg bg-accent-soft px-2 py-1 text-[10px] font-bold uppercase text-accent">
              {t(
                opportunity.goal === "ausbildung"
                  ? "dash.goalAusbildung"
                  : "dash.goalArbeit",
              )}
            </span>
            {opportunity.training_type && (
              <span className="rounded-lg bg-ai-soft px-2 py-1 text-[10px] font-bold uppercase text-ai">
                {opportunity.training_type.toLowerCase().replaceAll("_", " ")}
              </span>
            )}
            {opportunity.salary?.label && (
              <span className="rounded-lg bg-success-soft px-2 py-1 text-[10px] font-bold text-success">
                {opportunity.salary.label}
              </span>
            )}
            {opportunity.home_office === true && (
              <span className="rounded-lg bg-surface-2 px-2 py-1 text-[10px] font-bold text-muted">
                {t("account.homeOfficePossible")}
              </span>
            )}
          </div>
          <h1 className="mt-4 text-3xl font-bold tracking-[-0.04em] text-ink">
            {opportunity.title}
          </h1>
          <p className="mt-2 text-sm text-muted">
            {opportunity.company_name || t("search.companyNotListed")} ·{" "}
            {opportunity.location || t("search.locationNotListed")}
            {opportunity.distance_km !== null &&
              opportunity.distance_km !== undefined && (
                <span>
                  {" · "}
                  {t("account.kmFromSearch", {
                    km: opportunity.distance_km,
                  })}
                </span>
              )}
          </p>

          <div className="mt-6 grid gap-3 sm:grid-cols-3">
            <Info label={t("account.source")} value={opportunity.source_name} />
            <Info
              label={t("account.posted")}
              value={formatDay(opportunity.posted_at, locale) || t("account.notProvided")}
            />
            <Info
              label={t("account.updated")}
              value={formatDay(opportunity.updated_at, locale) || t("account.notProvided")}
            />
            <Info
              label={t("account.plannedStart")}
              value={formatDay(opportunity.valid_from, locale) || t("account.notProvided")}
            />
            <Info
              label={t("account.workingTime")}
              value={opportunity.employment_type || t("account.notSpecified")}
            />
            <Info
              label={t("account.occupation")}
              value={opportunity.profession || t("account.notSpecified")}
            />
            {opportunity.goal === "ausbildung" && (
              <Info
                label={t("account.requiredEducation")}
                value={
                  opportunity.education_requirement
                    ? (EDUCATION_KEYS[opportunity.education_requirement.level]
                        ? t(
                            EDUCATION_KEYS[
                              opportunity.education_requirement.level
                            ],
                          )
                        : opportunity.education_requirement.raw)
                    : t("account.noRequirement")
                }
              />
            )}
            {opportunity.career_change_friendly === true && (
              <Info
                label={t("account.careerChangerLabel")}
                value={t("account.careerChangerValue")}
              />
            )}
          </div>

          {details.match_available && match && (
            <MatchSection t={t} match={match} snapshotLines={snapshotLines} />
          )}

          {opportunity.description && (
            <div className="mt-8 whitespace-pre-wrap text-sm leading-7 text-muted">
              {opportunity.description}
            </div>
          )}

          {(opportunity.tasks.length > 0 ||
            opportunity.requirements.length > 0) && (
            <div className="mt-8 grid gap-6 sm:grid-cols-2">
              {opportunity.tasks.length > 0 && (
                <section>
                  <h3 className="text-xs font-bold uppercase tracking-[0.08em] text-ink">
                    {t("account.tasks")}
                  </h3>
                  <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-muted">
                    {opportunity.tasks.map((task) => (
                      <li key={task}>{task}</li>
                    ))}
                  </ul>
                </section>
              )}
              {opportunity.requirements.length > 0 && (
                <section>
                  <h3 className="text-xs font-bold uppercase tracking-[0.08em] text-ink">
                    {t("account.requirements")}
                  </h3>
                  <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-muted">
                    {opportunity.requirements.map((requirement) => (
                      <li key={requirement}>{requirement}</li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          )}

          {opportunity.contact && (
            <div className="mt-8 rounded-2xl bg-surface-2 p-5">
              <h3 className="text-xs font-bold uppercase tracking-[0.08em] text-ink">
                {t("account.contact")}
              </h3>
              <p className="mt-2 text-sm text-muted">
                {[
                  opportunity.contact.person,
                  opportunity.contact.phone,
                  opportunity.contact.email,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </div>
          )}

          <p className="mt-8 text-xs text-muted">
            {t("account.retrievedFrom", {
              date: new Date(opportunity.retrieved_at).toLocaleString(locale),
            })}
          </p>

          <div className="mt-6 flex flex-wrap items-center gap-3">
            <a
              href={applyHref}
              target="_blank"
              rel="noreferrer"
              className="inline-flex rounded-xl bg-navy px-5 py-3 text-sm font-semibold text-white"
            >
              {applyLabel}
            </a>
            <Link
              href={`/applications/new?opp=${encodeURIComponent(opportunity.id)}`}
              className="inline-flex rounded-xl bg-accent-soft px-5 py-3 text-sm font-semibold text-accent"
            >
              {t("account.prepareApplication")}
            </Link>
            <SaveOpportunityButton
              opportunityKey={opportunity.id}
              initialSaved={savedKeys.has(opportunity.id)}
            />
          </div>
        </article>
      </div>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-surface-2 p-3">
      <p className="text-[10px] font-bold uppercase tracking-[0.08em] text-faint">
        {label}
      </p>
      <p className="mt-1 text-xs font-semibold text-ink-soft">{value}</p>
    </div>
  );
}

const STATUS_ICONS: Record<
  MatchResult["dimensions"][number]["status"],
  { icon: string; className: string }
> = {
  match: { icon: "✓", className: "text-success" },
  partial: { icon: "△", className: "text-warning" },
  mismatch: { icon: "✕", className: "text-danger" },
  unknown: { icon: "?", className: "text-muted" },
  not_applicable: { icon: "–", className: "text-faint" },
};

/** Dedicated, fully data-backed match explanation. Engine-generated labels
 *  (dimensions, statuses, evidence, cap reasons) come from the matcher in
 *  its source language and are rendered verbatim — like AI output; only the
 *  surrounding chrome is translated. */
function MatchSection({
  t,
  match,
  snapshotLines,
}: {
  t: T;
  match: MatchResult;
  snapshotLines: string[] | null;
}) {
  const isComplete = match.status === "complete";
  return (
    <div className="mt-8 rounded-2xl border border-accent/25 bg-surface-2 p-5">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-sm font-bold uppercase tracking-[0.08em] text-ink">
          {MATCH_STATUS_LABELS[match.status]}
        </h2>
        {isComplete && match.score !== null && (
          <span className="text-2xl font-bold text-accent">
            {formatMatchScore(match.score)}
          </span>
        )}
      </div>
      {snapshotLines && snapshotLines.length > 0 && (
        <ul className="mt-2 space-y-1 rounded-xl bg-surface p-3 text-xs leading-5 text-muted">
          {snapshotLines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      {!isComplete && (
        <p className="mt-2 text-sm text-muted">
          {t("account.matchIncompleteNote")}
        </p>
      )}
      {isComplete && match.cap && (
        <p className="mt-2 rounded-xl bg-warning-soft p-3 text-xs font-medium text-danger">
          {match.cap.reason} (Score auf {match.cap.max_score} % begrenzt.)
        </p>
      )}
      <h3 className="mt-4 text-xs font-bold uppercase tracking-[0.08em] text-ink">
        {t("account.matchWhy")}
      </h3>
      <ul className="mt-2 space-y-2.5">
        {match.dimensions.map((dimension) => {
          const style = STATUS_ICONS[dimension.status];
          return (
            <li key={dimension.id} className="text-sm text-muted">
              <span
                className={`me-2 inline-block w-4 text-center font-bold ${style.className}`}
                aria-hidden
              >
                {style.icon}
              </span>
              <span className="font-semibold text-ink-soft">
                {DIMENSION_LABELS[dimension.id]}:
              </span>{" "}
              {STATUS_LABELS[dimension.status]}
              {dimension.evidence.length > 0 && (
                <span className="mt-0.5 block ps-6 text-xs leading-5 text-muted">
                  {dimension.evidence.slice(0, 2).join(" ")}
                </span>
              )}
              {(dimension.candidate || dimension.opportunity) && (
                <span className="mt-0.5 block ps-6 text-[11px] leading-4 text-muted">
                  {dimension.candidate && `${t("account.matchProfil")}: ${dimension.candidate}`}
                  {dimension.candidate && dimension.opportunity && " · "}
                  {dimension.opportunity && `${t("account.matchAngebot")}: ${dimension.opportunity}`}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {match.missing_information.length > 0 && (
        <>
          <h3 className="mt-4 text-xs font-bold uppercase tracking-[0.08em] text-ink">
            {t("account.matchMissing")}
          </h3>
          <ul className="mt-2 list-disc space-y-1 ps-5 text-sm text-muted">
            {match.missing_information.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
