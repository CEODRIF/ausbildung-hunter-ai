import Link from "next/link";
import { redirect } from "next/navigation";
import { Card } from "@/components/ui";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { getCampaign } from "@/lib/email-campaigns";
import {
  cancelCampaignAction,
  processCampaign,
} from "@/app/applications/campaign/[id]/actions";
import { CampaignMonitor } from "@/app/applications/campaign/[id]/campaign-monitor";

export const dynamic = "force-dynamic";
export default async function CampaignPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active")
    redirect("/login");
  const { id } = await params;
  const data = await getCampaign(user.id, id);
  const terminal = [
    "completed",
    "partially_failed",
    "failed",
    "cancelled",
  ].includes(data.campaign.status);
  return (
    <main className="min-h-screen bg-[#f6f8fb] px-5 py-8 sm:px-8 lg:px-10">
      <div className="mx-auto max-w-6xl">
        <Link
          href="/applications/new"
          className="text-sm font-semibold text-[#2f6fed]"
        >
          ← Back to application composer
        </Link>
        <div className="mt-8 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
          <div>
            <p className="text-sm font-semibold text-[#2f6fed]">
              Campaign monitor
            </p>
            <h1 className="mt-2 text-3xl font-bold tracking-[-0.04em] text-[#10203b]">
              Application campaign
            </h1>
            <p className="mt-2 text-sm text-[#71819a]">
              Sending is server-controlled and continues independently of this
              page.
            </p>
            <CampaignMonitor />
          </div>
          <div className="flex gap-2">
            <form action={processCampaign}>
              <input type="hidden" name="campaignId" value={id} />
              <button
                disabled={terminal}
                className="h-10 rounded-xl bg-[#2f6fed] px-4 text-xs font-semibold text-white disabled:opacity-50"
                type="submit"
              >
                Process next batch
              </button>
            </form>
            {!terminal && (
              <form action={cancelCampaignAction}>
                <input type="hidden" name="campaignId" value={id} />
                <button
                  className="h-10 rounded-xl border border-[#f0d9da] px-4 text-xs font-semibold text-[#b3444e]"
                  type="submit"
                >
                  Cancel queued
                </button>
              </form>
            )}
          </div>
        </div>
        <section className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Metric
            label="Status"
            value={data.campaign.status.replace("_", " ")}
          />
          <Metric label="Total" value={String(data.messages.length)} />
          <Metric
            label="Sent"
            value={String(
              data.messages.filter((message) => message.status === "sent")
                .length,
            )}
          />
          <Metric
            label="Remaining quota"
            value={String(data.usage.remaining)}
          />
        </section>
        <Card className="mt-6 overflow-hidden">
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(100px,0.5fr)_90px_minmax(100px,0.8fr)] gap-3 border-b border-[#edf0f4] bg-[#fbfcfe] px-5 py-3 text-[10px] font-bold uppercase tracking-[0.08em] text-[#9aa7b8]">
            <span>Recipient</span>
            <span>Company</span>
            <span>Status</span>
            <span>Error</span>
          </div>
          <div className="divide-y divide-[#edf0f4]">
            {data.messages.map((message) => (
              <div
                key={message.id}
                className="grid grid-cols-[minmax(0,1fr)_minmax(100px,0.5fr)_90px_minmax(100px,0.8fr)] items-center gap-3 px-5 py-4 text-xs"
              >
                <span className="truncate font-semibold text-[#1d3458]">
                  {message.recipient_email}
                </span>
                <span className="truncate text-[#8290a4]">
                  {message.company_name || "—"}
                </span>
                <span
                  className={`font-semibold ${message.status === "sent" ? "text-[#1b9b70]" : message.status === "failed" ? "text-[#b3444e]" : message.status === "cancelled" ? "text-[#8290a4]" : "text-[#a56a1e]"}`}
                >
                  {message.status}
                </span>
                <span className="truncate text-[#8290a4]">
                  {message.error_message || "—"}
                </span>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </main>
  );
}
function Metric({ label, value }: { label: string; value: string }) {
  return (
    <Card className="p-4">
      <p className="text-xs text-[#8290a4]">{label}</p>
      <p className="mt-2 text-xl font-bold capitalize text-[#10203b]">
        {value}
      </p>
    </Card>
  );
}
