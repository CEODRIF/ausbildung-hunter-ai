import { getScan } from "@/lib/bewerbung-scanner";
import { BewerbungResults } from "@/components/bewerbung-results";

export const dynamic = "force-dynamic";
export default async function BewerbungScannerResultsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const data = await getScan(id);
  if (!data.profile)
    return (
      <main className="min-h-screen bg-[#f6f8fb] p-8 text-center text-sm text-[#a3404b]">
        {data.scan.error_message || "This scan is not ready yet."}
      </main>
    );
  return (
    <BewerbungResults
      scanId={id}
      profile={data.profile.profile_json}
      history={data.history}
    />
  );
}
