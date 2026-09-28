import { getScan } from "@/lib/bewerbung-scanner";
import { BewerbungResults } from "@/components/bewerbung-results";
import { Card } from "@/components/ui";
import { deleteScanAction } from "@/app/bewerbung-scanner/[id]/actions";
import { DeleteScanButton } from "@/app/bewerbung-scanner/[id]/delete-scan-button";

export const dynamic = "force-dynamic";
export default async function BewerbungScannerResultsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const data = await getScan(id);
  return (
    <main className="min-h-screen bg-[#f6f8fb] p-5 sm:p-8">
      <div className="mx-auto max-w-4xl">
        {data.profile ? (
          <BewerbungResults
            scanId={id}
            profile={data.profile.profile_json}
            history={data.history}
          />
        ) : (
          <div className="rounded-2xl border border-[#f0d9da] bg-white p-8 text-center text-sm text-[#a3404b]">
            {data.scan.error_message || "This scan is not ready yet."}
          </div>
        )}
        {/* Phase 16 — item-level erasure for the scan's personal data
            (uploaded CVs + extracted candidate profile). */}
        <Card className="mt-5 border-[#f0d9da] p-5">
          <p className="text-xs font-bold uppercase tracking-[0.12em] text-[#b3444e]">
            Delete personal data
          </p>
          <p className="mt-2 text-sm leading-6 text-[#8290a4]">
            Removes this scan, its extracted candidate profile, and the uploaded
            documents that are not used by another scan. This cannot be undone.
          </p>
          <form
            action={deleteScanAction}
            id="delete-scan-form"
            className="mt-4"
          >
            <input type="hidden" name="scanId" value={id} />
            <DeleteScanButton />
          </form>
        </Card>
      </div>
    </main>
  );
}
