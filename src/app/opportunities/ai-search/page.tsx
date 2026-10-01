import { getCurrentUserAndProfile } from "@/lib/auth";
import { summarizeProfile } from "@/lib/opportunities/ai-search";
import { getCandidateProfile } from "@/lib/opportunities/search";
import { getSearchCreditStatus } from "@/lib/search-credits";
import { getServerT } from "@/lib/i18n/server";
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
  // Search credits (read-only here; the balance is charged server-side by the
  // search endpoint — this page only displays it).
  const credits = await getSearchCreditStatus(user.id).catch(() => ({
    creditsRemaining: 0,
    creditLimit: 0,
    resetHours: 0,
    resetsAt: null,
    premium: false,
  }));
  const t = await getServerT();

  return (
    <div className="px-4 py-6 sm:px-6 lg:px-10">
      <div className="mx-auto max-w-6xl">
        <div>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">
            {t("account.aiSearchIntro1")}
            <span className="font-semibold text-ink-soft">
              {t("account.aiSearchSource")}
            </span>
            {t("account.aiSearchIntro2")}
          </p>
        </div>
        <div className="mt-6">
          <AISearchClient
            hasProfile={candidateProfile !== null}
            profileSummary={
              candidateProfile ? summarizeProfile(candidateProfile) : null
            }
            defaultGoal={
              candidateProfile?.goal ?? profile.selected_goal ?? "ausbildung"
            }
            // Server-resolved balance (the page is a server component, so the
            // client never computes its own credits).
            initialCredits={{
              creditsRemaining: credits.creditsRemaining,
              creditLimit: credits.creditLimit,
              resetHours: credits.resetHours,
              premium: credits.premium,
            }}
          />
        </div>
      </div>
    </div>
  );
}
