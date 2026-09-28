import Link from "next/link";
import { getOpportunityDetails } from "@/lib/opportunities/search";
export const dynamic = "force-dynamic";
export default async function OpportunityDetailsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ goal?: "ausbildung" | "arbeit" }>;
}) {
  const opportunity = await getOpportunityDetails(
    decodeURIComponent((await params).id),
    (await searchParams).goal || "arbeit",
  );
  return (
    <main className="min-h-screen bg-[#f6f8fb] px-5 py-8 sm:px-8 lg:px-10">
      <div className="mx-auto max-w-4xl">
        <Link
          href="/opportunities"
          className="text-sm font-semibold text-[#2f6fed]"
        >
          ← Back to opportunities
        </Link>
        <article className="mt-8 rounded-2xl border border-[#e7ecf3] bg-white p-6 sm:p-8">
          <span className="rounded-lg bg-[#edf3ff] px-2 py-1 text-[10px] font-bold uppercase text-[#2f6fed]">
            {opportunity.goal}
          </span>
          <h1 className="mt-4 text-3xl font-bold tracking-[-0.04em] text-[#10203b]">
            {opportunity.title}
          </h1>
          <p className="mt-2 text-sm text-[#71819a]">
            {opportunity.company_name || "Company not listed"} ·{" "}
            {opportunity.location || "Location not listed"}
          </p>
          <div className="mt-6 grid gap-3 sm:grid-cols-3">
            <Info label="Source" value={opportunity.source_name} />
            <Info
              label="Posted"
              value={opportunity.posted_at || "Not provided"}
            />
            <Info
              label="Start date"
              value={opportunity.start_date || "Not provided"}
            />
          </div>
          {opportunity.description && (
            <div className="mt-8 whitespace-pre-wrap text-sm leading-7 text-[#546783]">
              {opportunity.description}
            </div>
          )}
          <p className="mt-8 text-xs text-[#8290a4]">
            Retrieved:{" "}
            {new Date(opportunity.retrieved_at).toLocaleString("en-GB")}
          </p>
          <a
            href={opportunity.source_url}
            target="_blank"
            rel="noreferrer"
            className="mt-6 inline-flex rounded-xl bg-[#10203b] px-5 py-3 text-sm font-semibold text-white"
          >
            Apply on original website →
          </a>
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
