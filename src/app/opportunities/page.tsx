import Link from "next/link";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { OpportunitySearch } from "@/components/opportunity-search";
import { sanitizeSearchUrlState } from "@/lib/opportunities/types";
import { getServerT } from "@/lib/i18n/server";
import { checkFeature } from "@/lib/billing/entitlement-service";

export const dynamic = "force-dynamic";
export default async function OpportunitiesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile) return null;
  const t = await getServerT();
  // Canonical search entitlement for the shared quota indicator (P0 quota
  // audit): server-derived; a failed read surfaces as the indicator's
  // honest unknown state.
  const searchEntitlement = await checkFeature(user.id, "opportunity_search");
  const raw = await searchParams;
  const entries = Object.entries(raw)
    .filter(([, value]) => value !== undefined)
    .map(
      ([key, value]) =>
        `${key}=${Array.isArray(value) ? (value[0] ?? "") : value}`,
    )
    .join("&");
  // Only validated, whitelisted filter values reach the client; anything else
  // is dropped server-side.
  const initialUrlState = sanitizeSearchUrlState(entries);
  const defaultGoal = profile.selected_goal ?? "arbeit";
  return (
    <div className="bg-background px-4 py-6 sm:px-6 lg:px-10">
      <div className="mx-auto max-w-6xl">
        <div className="flex items-center justify-between gap-3">
          <p className="hidden text-sm font-semibold text-muted sm:block">
            {t("pages.opportunities.subtitle")}
          </p>
          <div className="flex items-center gap-4">
            <Link
              href="/opportunities/saved"
              className="text-sm font-semibold text-accent transition-colors hover:text-accent-deep"
            >
              {t("pages.opportunitiesSaved.title")}
            </Link>
          </div>
        </div>
        <div className="mt-6">
          <OpportunitySearch
            defaultGoal={defaultGoal}
            initialUrlState={initialUrlState}
            searchEntitlement={searchEntitlement}
          />
        </div>
      </div>
    </div>
  );
}
