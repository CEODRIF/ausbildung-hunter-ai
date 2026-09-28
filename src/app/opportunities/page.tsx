import Link from "next/link";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { OpportunitySearch } from "@/components/opportunity-search";
import { sanitizeSearchUrlState } from "@/lib/opportunities/types";

export const dynamic = "force-dynamic";
export default async function OpportunitiesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { profile } = await getCurrentUserAndProfile();
  if (!profile) return null;
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
    <main className="min-h-screen bg-[#f6f8fb] px-5 py-8 sm:px-8 lg:px-10">
      <div className="mx-auto max-w-6xl">
        <div className="flex items-end justify-between">
          <div>
            <Link
              href="/dashboard"
              className="text-sm font-semibold text-[#2f6fed]"
            >
              ← Dashboard
            </Link>
            <h1 className="mt-6 text-3xl font-bold tracking-[-0.04em] text-[#10203b]">
              Germany opportunities
            </h1>
            <p className="mt-2 text-sm text-[#71819a]">
              Real vacancies from the Bundesagentur für Arbeit Jobsuche.
            </p>
          </div>
          <Link
            href="/opportunities/saved"
            className="text-sm font-semibold text-[#2f6fed]"
          >
            Saved opportunities
          </Link>
        </div>
        <div className="mt-8">
          <OpportunitySearch
            defaultGoal={defaultGoal}
            initialUrlState={initialUrlState}
          />
        </div>
      </div>
    </main>
  );
}
