import Link from "next/link";
import { redirect } from "next/navigation";
import { Card } from "@/components/ui";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { getUsageSnapshot } from "@/lib/email-campaigns";
import { activateQuota } from "@/app/settings/usage/actions";

export const dynamic = "force-dynamic";
export default async function UsageSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ activated?: string; error?: string }>;
}) {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active")
    redirect("/login");
  const usage = await getUsageSnapshot(user.id);
  const params = await searchParams;
  return (
    <main className="min-h-screen bg-[#f6f8fb] px-5 py-8 sm:px-8 lg:px-10">
      <div className="mx-auto max-w-3xl">
        <Link
          href="/dashboard"
          className="text-sm font-semibold text-[#2f6fed]"
        >
          ← Back to dashboard
        </Link>
        <div className="mt-8">
          <p className="text-sm font-semibold text-[#2f6fed]">Settings</p>
          <h1 className="mt-2 text-3xl font-bold tracking-[-0.04em] text-[#10203b]">
            Usage & limits
          </h1>
          <p className="mt-2 text-sm text-[#71819a]">
            Daily sending capacity is calculated server-side using UTC calendar
            days.
          </p>
        </div>
        {params.activated && <Notice>100 emails/day activated.</Notice>}
        {params.error && <ErrorNotice message={params.error} />}
        <Card className="mt-8 p-6">
          <div className="grid gap-5 sm:grid-cols-3">
            <Stat
              label="Current daily limit"
              value={String(usage.daily_limit)}
              suffix="emails"
            />
            <Stat
              label="Emails sent today"
              value={String(usage.emails_sent)}
              suffix="emails"
            />
            <Stat
              label="Remaining"
              value={String(usage.remaining)}
              suffix="emails"
            />
          </div>
        </Card>
        {usage.daily_limit < 100 && (
          <Card className="mt-5 p-6">
            <h2 className="font-bold text-[#1d3458]">
              Unlock 100 daily application emails
            </h2>
            <p className="mt-2 text-sm leading-6 text-[#8290a4]">
              Activate your quota upgrade code to increase your daily capacity.
              The server validates and records the activation.
            </p>
            <form
              action={activateQuota}
              className="mt-5 flex flex-col gap-3 sm:flex-row"
            >
              <input
                name="code"
                className="h-11 flex-1 rounded-xl border border-[#dfe6f0] bg-white px-3.5 text-sm uppercase tracking-[0.12em] outline-none focus:border-[#2f6fed]"
                placeholder="DRIF089"
                required
              />
              <button
                className="h-11 rounded-xl bg-[#2f6fed] px-5 text-sm font-semibold text-white hover:bg-[#255dcc]"
                type="submit"
              >
                Activate
              </button>
            </form>
          </Card>
        )}
      </div>
    </main>
  );
}
function Stat({
  label,
  value,
  suffix,
}: {
  label: string;
  value: string;
  suffix: string;
}) {
  return (
    <div className="rounded-xl bg-[#f7f9fc] p-4">
      <p className="text-xs text-[#8290a4]">{label}</p>
      <p className="mt-2 text-2xl font-bold text-[#10203b]">
        {value}{" "}
        <span className="text-xs font-semibold text-[#8290a4]">{suffix}</span>
      </p>
    </div>
  );
}
function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-6 rounded-xl border border-[#ccefe1] bg-[#f3fcf8] px-4 py-3 text-sm font-medium text-[#187e5b]">
      {children}
    </div>
  );
}
function ErrorNotice({ message }: { message: string }) {
  return (
    <div className="mt-6 rounded-xl border border-[#f5d7da] bg-[#fff8f8] px-4 py-3 text-sm font-medium text-[#a3404b]">
      {message}
    </div>
  );
}
