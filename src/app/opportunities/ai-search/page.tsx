import Link from "next/link";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { summarizeProfile } from "@/lib/opportunities/ai-search";
import { getCandidateProfile } from "@/lib/opportunities/search";
import { AISearchClient } from "@/components/ai-search";

export const dynamic = "force-dynamic";

/**
 * AI Ausbildung Search — entry page (server component).
 *
 * Reuses the existing pieces end-to-end: the candidate profile comes from
 * the Bewerbung Scanner (latest validated `candidate_profiles` row, same
 * lookup the matching engine uses), the shell/layout/auth are the existing
 * opportunities layout, and the search itself runs through the shared
 * provider + cache. This page only resolves the profile and hands a safe
 * summary to the client component.
 */
export default async function AISearchPage() {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active") return null;
  const candidateProfile = await getCandidateProfile(user.id);

  return (
    <main className="min-h-screen bg-[#f6f8fb] px-5 py-8 sm:px-8 lg:px-10">
      <div className="mx-auto max-w-6xl">
        <div>
          <Link
            href="/opportunities"
            className="text-sm font-semibold text-[#2f6fed]"
          >
            ← Opportunities
          </Link>
          <h1 className="mt-6 text-3xl font-bold tracking-[-0.04em] text-[#10203b]">
            AI Ausbildung Search
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-[#71819a]">
            Upload your CV, and the AI reads your profile to build focused
            searches across the public{" "}
            <span className="font-semibold text-[#1d3458]">
              Bundesagentur für Arbeit Jobsuche
            </span>
            . You get real, currently published postings — nothing invented —
            with live progress and an Excel export.
          </p>
        </div>
        <div className="mt-8">
          <AISearchClient
            hasProfile={candidateProfile !== null}
            profileSummary={
              candidateProfile ? summarizeProfile(candidateProfile) : null
            }
            defaultGoal={
              candidateProfile?.goal ?? profile.selected_goal ?? "ausbildung"
            }
          />
        </div>
      </div>
    </main>
  );
}
