import Link from "next/link";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { OpportunitySearch } from "@/components/opportunity-search";
import { sanitizeSearchUrlState } from "@/lib/opportunities/types";
import { getServerT } from "@/lib/i18n/server";
import { Icon } from "@/components/icon";

export const dynamic = "force-dynamic";
export default async function OpportunitiesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { profile } = await getCurrentUserAndProfile();
  if (!profile) return null;
  const t = await getServerT();
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
            <Link
              href="/opportunities/ai-search"
              className="inline-flex items-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-white shadow-[0_8px_18px_rgba(200,60,255,0.22)] transition-colors hover:bg-accent-deep"
            >
              <Icon name="spark" size={15} />
              {t("nav.ausbildungSearch")}
            </Link>
          </div>
        </div>
        <div className="mt-6">
          <OpportunitySearch
            defaultGoal={defaultGoal}
            initialUrlState={initialUrlState}
          />
        </div>
      </div>
    </div>
  );
}
