import Link from "next/link";
import { redirect } from "next/navigation";
import { Card } from "@/components/ui";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  recoverStaleCampaigns, getCampaign, getSenderSlotWaitMs } from "@/lib/email-campaigns";
import { formatScheduledLocal, utcToLocalParts } from "@/lib/schedule-time";
import { getRequestLang, getServerT } from "@/lib/i18n/server";
import { localeForLang } from "@/lib/i18n/core";
import {
  cancelCampaignAction,
  processCampaign,
  rescheduleCampaignAction,
} from "@/app/applications/campaign/[id]/actions";
import { ScheduleForm } from "@/components/schedule-form";
import { CampaignMonitor } from "@/app/applications/campaign/[id]/campaign-monitor";

export const dynamic = "force-dynamic";

/** Request-scoped schedule status, kept OUTSIDE the component so the
 *  `Date.now()` comparison lives in a plain helper (server render is
 *  one-shot per request; this satisfies the render-purity rule). */
function scheduleStatus(scheduledAt: string | null): {
  scheduledMs: number | null;
  future: boolean;
} {
  const parsed = scheduledAt ? Date.parse(scheduledAt) : null;
  const valid = parsed !== null && Number.isFinite(parsed);
  return {
    scheduledMs: valid ? parsed : null,
    // future = the due-gate still holds; past+queued = the scheduler is
    // late (honest "waiting" state, the monitor keeps draining).
    future: valid && parsed > Date.now(),
  };
}

export default async function CampaignPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active")
    redirect("/login");
  const { id } = await params;
  const data = await getCampaign(user.id, id);
  // Deterministic recovery on every visit: a stalled `sending` message is
  // finalized (never left hanging) and a never-started campaign past its TTL
  // is cancelled — which is also what keeps "active campaigns" honest.
  const recovery = await recoverStaleCampaigns(user.id, id).catch(() => null);
  const campaignState = recovery
    ? { ...data.campaign, status: recovery.status }
    : data.campaign;
  const t = await getServerT();
  const locale = localeForLang(await getRequestLang());
  const search = await searchParams;
  // One-time notices for the just-finished actions (the page state itself
  // already reflects them after the redirect).
  const notice =
    search.scheduled === "1"
      ? t("account.scheduledNotice")
      : search.rescheduled === "1"
        ? t("account.rescheduledNotice")
        : null;
  const { scheduledMs, future: scheduleFuture } = scheduleStatus(
    campaignState.scheduled_at,
  );
  // Reschedule form prefill: the campaign's CURRENT scheduled time as local
  // wall-clock parts in its own zone (so the form shows what it will change).
  const rescheduleDefaults = (() => {
    if (!campaignState.scheduled_at || !campaignState.timezone) return undefined;
    const parts = utcToLocalParts(
      campaignState.scheduled_at,
      campaignState.timezone,
    );
    return parts
      ? { ...parts, timeZone: campaignState.timezone }
      : undefined;
  })();
  const terminal = [
    "completed",
    "partially_failed",
    "failed",
    "cancelled",
  ].includes(campaignState.status);
  // Read-only display context for THIS campaign (address + subject only —
  // nothing is written, the sending engine is untouched).
  const admin = createAdminClient();
  const [accountResult, draftResult] = await Promise.all([
    data.campaign.email_account_id
      ? admin
          .from("email_accounts")
          .select("email_address")
          .eq("id", data.campaign.email_account_id)
          .maybeSingle<{ email_address: string }>()
      : Promise.resolve({ data: null as { email_address: string } | null }),
    admin
      .from("application_drafts")
      .select("subject, opportunity_title")
      .eq("id", data.campaign.draft_id)
      .maybeSingle<{ subject: string; opportunity_title: string | null }>(),
  ]);
  const senderEmail = accountResult.data?.email_address ?? null;
  const title =
    draftResult.data?.subject?.trim() || draftResult.data?.opportunity_title ||
    null;
  // Smart Sending — the REAL sender-slot state for this campaign, read from
  // Postgres (never a faked progress number): busy slot = waiting, free
  // slot while `sending` = a send is in flight.
  const senderSlotWaitMs = terminal
    ? 0
    : await getSenderSlotWaitMs(user.id, id).catch(() => 0);
  const sendingState = terminal
    ? null
    : senderSlotWaitMs > 0
      ? "Waiting for sending slot…"
      : campaignState.status === "sending"
        ? "Sending…"
        : null;
  return (
    <div className="px-4 py-6 sm:px-6 lg:px-10">
      <div className="mx-auto max-w-6xl">
        <Link
          href="/applications"
          className="mt-2 text-xs font-semibold text-muted hover:text-ink-soft"
        >
          ← Applications
        </Link>
        {notice && (
          <div className="mt-3 rounded-2xl border border-success/25 bg-success-soft px-4 py-3 text-sm font-semibold text-success">
            {notice}
          </div>
        )}
        {scheduledMs !== null && Number.isFinite(scheduledMs) && (
          <div
            className={`mt-3 rounded-2xl border px-4 py-3 text-sm font-semibold ${
              scheduleFuture
                ? "border-accent/25 bg-accent-soft text-accent-deep"
                : !terminal
                  ? "border-warning/25 bg-warning-soft text-warning"
                  : ""
            }`}
          >
            {scheduleFuture
              ? t("account.scheduledBanner", {
                  time: formatScheduledLocal(
                    campaignState.scheduled_at!,
                    campaignState.timezone ?? "UTC",
                    locale,
                  ),
                  timezone: campaignState.timezone ?? "UTC",
                })
              : t("account.dueBanner")}
          </div>
        )}
        <div className="mt-2 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
          <div>
            <h1 className="text-2xl font-bold text-ink">
              {title ?? "Application campaign"}
            </h1>
            <p className="mt-1 text-sm text-muted">
              {t("account.monitorNote")}
              {senderEmail ? ` · Sending from: ${senderEmail}` : ""}
            </p>
            {sendingState && (
              <p className="mt-1 text-xs font-semibold text-accent-deep">
                {sendingState}
              </p>
            )}
            <CampaignMonitor campaignId={id} />
          </div>
          <div className="flex gap-2">
            {/* Manual processing is hidden while the schedule is still in
                the future — the claim gate cannot see due messages, so the
                button would do nothing and only mislead. Once the instant
                has passed it comes back (it then also serves as a
                recovery trigger if the scheduler was down). */}
            {!scheduleFuture && (
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
            )}
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
        {/* Reschedule — only while the campaign is queued AND the instant
            is still in the future. The RPC itself is the authority: once
            any message has been claimed it refuses atomically. */}
        {campaignState.status === "queued" && scheduleFuture && (
          <Card className="mt-6 p-5 sm:p-6">
            <h2 className="font-bold text-ink-soft">
              {t("account.rescheduleTitle")}
            </h2>
            <p className="mt-1 text-xs text-muted">
              {t("account.rescheduleHint")}
            </p>
            <div className="mt-4">
              <ScheduleForm
                action={rescheduleCampaignAction}
                extraHidden={[{ name: "campaignId", value: id }]}
                defaults={rescheduleDefaults}
                submitLabel={t("account.rescheduleSubmit")}
                pendingLabel={t("account.rescheduling")}
              />
            </div>
          </Card>
        )}
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
