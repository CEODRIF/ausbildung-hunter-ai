import { getCurrentUserAndProfile } from "@/lib/auth";
import { CompanyDiscovery } from "@/components/company-discovery";
import { listRecentDiscoveryCampaigns } from "@/lib/company-discovery/campaigns";
import {
  getLatestDiscoveryRun,
  listRunCompaniesWithEmails,
  type RunCompanyResult,
} from "@/lib/company-discovery/runs";
import type { DiscoveryRun } from "@/lib/company-discovery/types";

export const dynamic = "force-dynamic";

/**
 * /company-discovery — Company & Email Discovery.
 *
 * Collects UNIQUE German companies (1 company = 1 result) with a publicly
 * published contact email for the user's field/role, across several public
 * sources, until the requested target count is reached or safe limits hit.
 *
 * The page renders the LAST PERSISTED result (run + companies + their public
 * addresses) plus the campaign history, all read from the database on the
 * server: a refresh or a re-login always shows the same data — results are
 * never kept in client state only. A database that is not fully migrated must
 * not take the page down, so a read failure degrades to "no saved run" and is
 * logged for operators.
 */
export default async function CompanyDiscoveryPage() {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile) return null;

  let initialRun: DiscoveryRun | null = null;
  let initialCompanies: RunCompanyResult[] = [];
  let campaigns: Awaited<ReturnType<typeof listRecentDiscoveryCampaigns>> = [];
  try {
    initialRun = await getLatestDiscoveryRun(user.id);
    if (initialRun) {
      initialCompanies = await listRunCompaniesWithEmails(initialRun.runId, user.id);
    }
    campaigns = await listRecentDiscoveryCampaigns(user.id, 5);
  } catch (error) {
    console.error(
      `[company-discovery] page preload failed user="${user.id}"`,
      error,
    );
    initialRun = null;
    initialCompanies = [];
    campaigns = [];
  }

  return (
    <div className="bg-background px-4 py-6 sm:px-6 lg:px-10">
      <div className="mx-auto max-w-4xl">
        <CompanyDiscovery
          initialRun={initialRun}
          initialCompanies={initialCompanies}
          campaigns={campaigns}
        />
      </div>
    </div>
  );
}
