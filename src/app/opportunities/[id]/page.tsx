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
import {
  sanitizeSearchUrlState,
  type Opportunity,
} from "@/lib/opportunities/types";

export const dynamic = "force-dynamic";

const GOAL_LABELS: Record<Opportunity["goal"], string> = {
  ausbildung: "Ausbildung",
  arbeit: "Arbeit",
};

const EDUCATION_LABELS: Record<string, string> = {
  basic: "Basic secondary education (Hauptschulabschluss)",
  intermediate: "Intermediate secondary education (Mittlerer Schulabschluss)",
  advanced: "Advanced secondary education (Fachabitur)",
  university: "University entrance qualification (Abitur)",
  unknown: "See source (not classified)",
};

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
  let details: Awaited<ReturnType<typeof getOpportunityDetails>> | null = null;
  let stateError: string | null = null;
  try {
    details = await getOpportunityDetails(id, { userId: user.id });
  } catch (error) {
    if (error instanceof OpportunityNotFoundError) {
      stateError = error.message;
    } else {
      stateError =
        "The opportunity source could not be reached right now. Please try again in a moment.";
    }
  }
  const savedRows = stateError ? [] : await listSavedOpportunities(user.id);
  const savedKeys = new Set(savedRows.map((row) => row.opportunity_key));

  if (stateError || !details) {
    return (
      <main className="min-h-screen bg-[#f6f8fb] px-5 py-8 sm:px-8 lg:px-10">
        <div className="mx-auto max-w-3xl">
          <Link
            href={backHref}
            className="text-sm font-semibold text-[#2f6fed]"
          >
            ← Back to opportunities
          </Link>
          <div className="mt-8 rounded-2xl border border-[#e7ecf3] bg-white p-10 text-center">
            <h1 className="text-xl font-bold text-[#10203b]">
              Opportunity unavailable
            </h1>
            <p className="mt-3 text-sm leading-6 text-[#71819a]">
              {stateError}
            </p>
          </div>
        </div>
      </main>
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
      const stand = formatSnapshotDate(savedRow.saved_at);
      const scoreLabel =
        savedRow.match_score !== null
          ? `${savedRow.match_score} %`
          : "unvollständig";
      snapshotLines = [
        `Gespeicherter Snapshot: ${scoreLabel} · Stand ${stand ?? "unbekannt"} (Matcher v${savedRow.matcher_version ?? "?"}) — historischer Wert, kein aktueller Match.`,
        ...staleness.reasons,
      ];
    }
  }

  const applyHref = opportunity.application_url ?? opportunity.source_url;
  const applyLabel = opportunity.application_url
    ? "Apply at the company →"
    : "Open in the Jobbörse →";

  return (
    <main className="min-h-screen bg-[#f6f8fb] px-5 py-8 sm:px-8 lg:px-10">
      <div className="mx-auto max-w-4xl">
        <Link href={backHref} className="text-sm font-semibold text-[#2f6fed]">
          ← Back to opportunities
        </Link>
        <article className="mt-8 rounded-2xl border border-[#e7ecf3] bg-white p-6 sm:p-8">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-lg bg-[#edf3ff] px-2 py-1 text-[10px] font-bold uppercase text-[#2f6fed]">
              {GOAL_LABELS[opportunity.goal]}
            </span>
            {opportunity.training_type && (
              <span className="rounded-lg bg-[#f0e9fb] px-2 py-1 text-[10px] font-bold uppercase text-[#6b46c1]">
                {opportunity.training_type.toLowerCase().replaceAll("_", " ")}
              </span>
            )}
            {opportunity.salary?.label && (
              <span className="rounded-lg bg-[#e8f5ee] px-2 py-1 text-[10px] font-bold text-[#177a55]">
                {opportunity.salary.label}
              </span>
            )}
            {opportunity.home_office === true && (
              <span className="rounded-lg bg-[#f2f4f8] px-2 py-1 text-[10px] font-bold text-[#546783]">
                Home office possible
              </span>
            )}
          </div>
          <h1 className="mt-4 text-3xl font-bold tracking-[-0.04em] text-[#10203b]">
            {opportunity.title}
          </h1>
          <p className="mt-2 text-sm text-[#71819a]">
            {opportunity.company_name || "Company not listed"} ·{" "}
            {opportunity.location || "Location not listed"}
            {opportunity.distance_km !== null &&
              opportunity.distance_km !== undefined && (
                <span> · {opportunity.distance_km} km from your search</span>
              )}
          </p>

          <div className="mt-6 grid gap-3 sm:grid-cols-3">
            <Info label="Source" value={opportunity.source_name} />
            <Info
              label="Posted"
              value={formatDay(opportunity.posted_at) || "Not provided"}
            />
            <Info
              label="Updated"
              value={formatDay(opportunity.updated_at) || "Not provided"}
            />
            <Info
              label="Planned start"
              value={formatDay(opportunity.valid_from) || "Not provided"}
            />
            <Info
              label="Working time"
              value={opportunity.employment_type || "Not specified"}
            />
            <Info
              label="Occupation (source)"
              value={opportunity.profession || "Not specified"}
            />
            {opportunity.goal === "ausbildung" && (
              <Info
                label="Required education"
                value={
                  opportunity.education_requirement
                    ? (EDUCATION_LABELS[
                        opportunity.education_requirement.level
                      ] ?? opportunity.education_requirement.raw)
                    : "No requirement documented"
                }
              />
            )}
            {opportunity.career_change_friendly === true && (
              <Info label="Career changer" value="Explicitly suitable" />
            )}
          </div>

          {details.match_available && match && (
            <MatchSection match={match} snapshotLines={snapshotLines} />
          )}

          {opportunity.description && (
            <div className="mt-8 whitespace-pre-wrap text-sm leading-7 text-[#546783]">
              {opportunity.description}
            </div>
          )}

          {(opportunity.tasks.length > 0 ||
            opportunity.requirements.length > 0) && (
            <div className="mt-8 grid gap-6 sm:grid-cols-2">
              {opportunity.tasks.length > 0 && (
                <section>
                  <h3 className="text-xs font-bold uppercase tracking-[0.08em] text-[#10203b]">
                    Tasks (from source)
                  </h3>
                  <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-[#546783]">
                    {opportunity.tasks.map((task) => (
                      <li key={task}>{task}</li>
                    ))}
                  </ul>
                </section>
              )}
              {opportunity.requirements.length > 0 && (
                <section>
                  <h3 className="text-xs font-bold uppercase tracking-[0.08em] text-[#10203b]">
                    Requirements (from source)
                  </h3>
                  <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-[#546783]">
                    {opportunity.requirements.map((requirement) => (
                      <li key={requirement}>{requirement}</li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          )}

          {opportunity.contact && (
            <div className="mt-8 rounded-2xl bg-[#f7f9fc] p-5">
              <h3 className="text-xs font-bold uppercase tracking-[0.08em] text-[#10203b]">
                Contact (from source)
              </h3>
              <p className="mt-2 text-sm text-[#546783]">
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

          <p className="mt-8 text-xs text-[#8290a4]">
            Retrieved from source:{" "}
            {new Date(opportunity.retrieved_at).toLocaleString("en-GB")}
          </p>

          <div className="mt-6 flex flex-wrap items-center gap-3">
            <a
              href={applyHref}
              target="_blank"
              rel="noreferrer"
              className="inline-flex rounded-xl bg-[#10203b] px-5 py-3 text-sm font-semibold text-white"
            >
              {applyLabel}
            </a>
            <Link
              href={`/applications/new?opp=${encodeURIComponent(opportunity.id)}`}
              className="inline-flex rounded-xl bg-[#edf3ff] px-5 py-3 text-sm font-semibold text-[#2f6fed]"
            >
              Prepare application
            </Link>
            <SaveOpportunityButton
              opportunityKey={opportunity.id}
              initialSaved={savedKeys.has(opportunity.id)}
            />
          </div>
        </article>
      </div>
    </main>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-[#f7f9fc] p-3">
      <p className="text-[10px] font-bold uppercase tracking-[0.08em] text-[#9aa7b8]">
        {label}
      </p>
      <p className="mt-1 text-xs font-semibold text-[#1d3458]">{value}</p>
    </div>
  );
}

const STATUS_ICONS: Record<
  MatchResult["dimensions"][number]["status"],
  { icon: string; className: string }
> = {
  match: { icon: "✓", className: "text-[#177a55]" },
  partial: { icon: "△", className: "text-[#a3611c]" },
  mismatch: { icon: "✕", className: "text-[#b4543c]" },
  unknown: { icon: "?", className: "text-[#8290a4]" },
  not_applicable: { icon: "–", className: "text-[#9aa7b8]" },
};

/** Dedicated, fully data-backed match explanation (German). No percentage is
 *  shown unless the match is complete — an incomplete match is labeled as
 *  such and explains exactly what is missing. A saved-snapshot note (when
 *  present) is explicitly labeled as historical. */
function MatchSection({
  match,
  snapshotLines,
}: {
  match: MatchResult;
  snapshotLines: string[] | null;
}) {
  const isComplete = match.status === "complete";
  return (
    <div className="mt-8 rounded-2xl border border-[#dce9ff] bg-[#f7faff] p-5">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-sm font-bold uppercase tracking-[0.08em] text-[#10203b]">
          {MATCH_STATUS_LABELS[match.status]}
        </h2>
        {isComplete && match.score !== null && (
          <span className="text-2xl font-bold text-[#2f6fed]">
            {formatMatchScore(match.score)}
          </span>
        )}
      </div>
      {snapshotLines && snapshotLines.length > 0 && (
        <ul className="mt-2 space-y-1 rounded-xl bg-[#f0f4fb] p-3 text-xs leading-5 text-[#546783]">
          {snapshotLines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      {!isComplete && (
        <p className="mt-2 text-sm text-[#546783]">
          Für eine Prozentangabe fehlen essentielle Angaben – es wird daher
          bewusst kein Score berechnet. Unten steht, was noch fehlt.
        </p>
      )}
      {isComplete && match.cap && (
        <p className="mt-2 rounded-xl bg-[#fdeee8] p-3 text-xs font-medium text-[#b4543c]">
          {match.cap.reason} (Score auf {match.cap.max_score} % begrenzt.)
        </p>
      )}
      <h3 className="mt-4 text-xs font-bold uppercase tracking-[0.08em] text-[#10203b]">
        Warum dieses Ergebnis?
      </h3>
      <ul className="mt-2 space-y-2.5">
        {match.dimensions.map((dimension) => {
          const style = STATUS_ICONS[dimension.status];
          return (
            <li key={dimension.id} className="text-sm text-[#546783]">
              <span
                className={`mr-2 inline-block w-4 text-center font-bold ${style.className}`}
                aria-hidden
              >
                {style.icon}
              </span>
              <span className="font-semibold text-[#1d3458]">
                {DIMENSION_LABELS[dimension.id]}:
              </span>{" "}
              {STATUS_LABELS[dimension.status]}
              {dimension.evidence.length > 0 && (
                <span className="mt-0.5 block pl-6 text-xs leading-5 text-[#71819a]">
                  {dimension.evidence.slice(0, 2).join(" ")}
                </span>
              )}
              {(dimension.candidate || dimension.opportunity) && (
                <span className="mt-0.5 block pl-6 text-[11px] leading-4 text-[#8290a4]">
                  {dimension.candidate && `Profil: ${dimension.candidate}`}
                  {dimension.candidate && dimension.opportunity && " · "}
                  {dimension.opportunity && `Angebot: ${dimension.opportunity}`}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {match.missing_information.length > 0 && (
        <>
          <h3 className="mt-4 text-xs font-bold uppercase tracking-[0.08em] text-[#10203b]">
            Fehlende Informationen
          </h3>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-[#546783]">
            {match.missing_information.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
