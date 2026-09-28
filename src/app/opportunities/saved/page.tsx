import Link from "next/link";
import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentUserAndProfile } from "@/lib/auth";
export const dynamic = "force-dynamic";
export default async function SavedOpportunitiesPage() {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active")
    redirect("/login");
  const admin = createAdminClient();
  const { data } = await admin
    .from("saved_opportunities")
    .select(
      "opportunity_key, provider, source_url, title, company_name, location, goal, saved_at, notes",
    )
    .eq("user_id", user.id)
    .order("saved_at", { ascending: false });
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
          {data?.length ? (
            data.map((item) => (
              <article
                key={item.opportunity_key}
                className="rounded-2xl border border-[#e7ecf3] bg-white p-5"
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <span className="rounded-lg bg-[#edf3ff] px-2 py-1 text-[10px] font-bold uppercase text-[#2f6fed]">
                      {item.goal}
                    </span>
                    <h2 className="mt-3 text-lg font-bold text-[#1d3458]">
                      {item.title}
                    </h2>
                    <p className="mt-1 text-sm text-[#71819a]">
                      {item.company_name || "Company not listed"} ·{" "}
                      {item.location || "Location not listed"}
                    </p>
                  </div>
                  <a
                    href={item.source_url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs font-bold text-[#2f6fed]"
                  >
                    Open source →
                  </a>
                </div>
              </article>
            ))
          ) : (
            <div className="rounded-2xl border border-dashed border-[#dfe6f0] bg-white p-10 text-center text-sm text-[#8290a4]">
              No saved opportunities yet.
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
