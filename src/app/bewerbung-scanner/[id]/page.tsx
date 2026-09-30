import Link from "next/link";
import { getScan } from "@/lib/bewerbung-scanner";
import { BewerbungResults } from "@/components/bewerbung-results";
import { Card } from "@/components/ui";
import { getServerT } from "@/lib/i18n/server";
import { deleteScanAction } from "@/app/bewerbung-scanner/[id]/actions";
import { DeleteScanButton } from "@/app/bewerbung-scanner/[id]/delete-scan-button";

export const dynamic = "force-dynamic";
export default async function BewerbungScannerResultsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ bulk_deleted?: string; error?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const [data, t] = await Promise.all([getScan(id), getServerT()]);
  return (
    <div className="px-4 py-6 sm:px-6 lg:px-10">
      <div className="mx-auto max-w-4xl">
        {query.bulk_deleted && (
          <p className="mb-4 rounded-2xl border border-success/25 bg-success-soft px-4 py-3 text-sm text-success">
            {t("account.bulkDeleted", { count: query.bulk_deleted })}
          </p>
        )}
        {query.error === "bulk_failed" && (
          <p className="mb-4 rounded-2xl border border-danger/25 bg-danger-soft px-4 py-3 text-sm text-danger">
            {t("account.bulkFailed")}
          </p>
        )}
        {data.profile ? (
          <BewerbungResults
            scanId={id}
            profile={data.profile.profile_json}
            history={data.history}
          />
        ) : (
          <div className="rounded-2xl border border-danger/25 bg-surface p-8 text-center text-sm text-danger">
            {data.scan.error_message === "PDF_PARSE_FAILED"
              ? t("account.scanPdfFailed")
              : data.scan.error_message === "SCAN_UNEXPECTED_FAILED"
                ? t("account.scanUnexpectedFailed")
                : data.scan.error_message || t("account.scanNotReady")}
          </div>
        )}
        {data.profile && (
          <Card className="mt-5 border-accent/25 bg-surface-2 p-5">
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-ink-soft">
              {t("account.nextStep")}
            </p>
            <p className="mt-2 text-sm leading-6 text-ink-soft">
              {t("account.nextStepBody", {
                goal:
                  data.profile.profile_json.goal === "arbeit"
                    ? t("dash.goalArbeit")
                    : t("dash.goalAusbildung"),
              })}
            </p>
            <Link
              href="/opportunities/ai-search"
              className="mt-4 inline-flex h-11 items-center justify-center rounded-xl bg-accent px-5 text-sm font-semibold text-white shadow-[0_8px_18px_rgba(47,111,237,0.22)] transition-colors hover:bg-accent-deep"
            >
              ✦ {t("account.startAiSearch")}
            </Link>
          </Card>
        )}
        {/* Phase 16 — item-level erasure for the scan's personal data
            (uploaded CVs + extracted candidate profile). */}
        <Card className="mt-5 border-danger/25 p-5">
          <p className="text-xs font-bold uppercase tracking-[0.12em] text-danger">
            {t("account.deletePersonalTitle")}
          </p>
          <p className="mt-2 text-sm leading-6 text-muted">
            {t("account.deletePersonalBody")}
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
    </div>
  );
}
