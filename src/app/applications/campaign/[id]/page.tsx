import { redirect } from "next/navigation";
import { Card } from "@/components/ui";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { getCampaign } from "@/lib/email-campaigns";
import { getServerT } from "@/lib/i18n/server";
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
  const t = await getServerT();
  const terminal = [
    "completed",
    "partially_failed",
    "failed",
    "cancelled",
  ].includes(data.campaign.status);
  return (
    <div className="px-4 py-6 sm:px-6 lg:px-10">
      <div className="mx-auto max-w-6xl">
        <div className="mt-2 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
          <div>
            <p className="text-sm text-muted">{t("account.monitorNote")}</p>
            <CampaignMonitor />
          </div>
          <div className="flex gap-2">
            <form action={processCampaign}>
              <input type="hidden" name="campaignId" value={id} />
              <button
                disabled={terminal}
                className="h-10 rounded-xl bg-accent px-4 text-xs font-semibold text-white disabled:opacity-50"
                type="submit"
              >
                {t("account.processBatch")}
              </button>
            </form>
            {!terminal && (
              <form action={cancelCampaignAction}>
                <input type="hidden" name="campaignId" value={id} />
                <button
                  className="h-10 rounded-xl border border-danger/25 px-4 text-xs font-semibold text-danger"
                  type="submit"
                >
                  {t("account.cancelQueued")}
                </button>
              </form>
            )}
          </div>
        </div>
        <section className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Metric
            label={t("account.status")}
            value={data.campaign.status.replace("_", " ")}
          />
          <Metric label={t("account.total")} value={String(data.messages.length)} />
          <Metric
            label={t("account.sent")}
            value={String(
              data.messages.filter((message) => message.status === "sent")
                .length,
            )}
          />
          <Metric
            label={t("account.remainingQuota")}
            value={String(data.usage.remaining)}
          />
        </section>
        <Card className="mt-6 overflow-hidden">
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(100px,0.5fr)_90px_minmax(100px,0.8fr)] gap-3 border-b border-line bg-surface-2 px-5 py-3 text-[10px] font-bold uppercase tracking-[0.08em] text-faint">
            <span>{t("account.recipient")}</span>
            <span>{t("account.company")}</span>
            <span>{t("account.status")}</span>
            <span>{t("account.error")}</span>
          </div>
          <div className="divide-y divide-line">
            {data.messages.map((message) => (
              <div
                key={message.id}
                className="grid grid-cols-[minmax(0,1fr)_minmax(100px,0.5fr)_90px_minmax(100px,0.8fr)] items-center gap-3 px-5 py-4 text-xs"
              >
                <span className="truncate font-semibold text-ink-soft">
                  {message.recipient_email}
                </span>
                <span className="truncate text-muted">
                  {message.company_name || "—"}
                </span>
                <span
                  className={`font-semibold ${message.status === "sent" ? "text-success" : message.status === "failed" ? "text-danger" : message.status === "cancelled" ? "text-muted" : "text-warning"}`}
                >
                  {message.status}
                </span>
                <span className="truncate text-muted">
                  {message.error_message || "—"}
                </span>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
function Metric({ label, value }: { label: string; value: string }) {
  return (
    <Card className="p-4">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-2 text-xl font-bold capitalize text-ink">
        {value}
      </p>
    </Card>
  );
}
