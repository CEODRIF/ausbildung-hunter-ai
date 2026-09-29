import Link from "next/link";
import { redirect } from "next/navigation";
import { Card } from "@/components/ui";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { getUsageSnapshot } from "@/lib/email-campaigns";
import { getServerT } from "@/lib/i18n/server";
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
  const t = await getServerT();
  return (
    <div className="px-4 py-6 sm:px-6 lg:px-10">
      <div className="mx-auto max-w-3xl">
        <p className="text-sm leading-6 text-muted">
          {t("account.usageNote1")}
          <Link href="/settings/billing" className="font-semibold text-accent">
            {t("account.usageNoteLinkBilling")}
          </Link>
          {t("account.usageNote2")}
          <Link href="/settings/data" className="font-semibold text-accent">
            {t("account.usageNoteLinkData")}
          </Link>
          .
        </p>
        {params.activated && (
          <Notice>{t("account.activatedNotice")}</Notice>
        )}
        {params.error && <ErrorNotice message={params.error} />}
        <Card className="mt-4 p-6">
          <div className="grid gap-5 sm:grid-cols-3">
            <Stat
              label={t("account.dailyLimit")}
              value={String(usage.daily_limit)}
              suffix={t("account.emailsUnit")}
            />
            <Stat
              label={t("account.sentToday")}
              value={String(usage.emails_sent)}
              suffix={t("account.emailsUnit")}
            />
            <Stat
              label={t("account.remaining")}
              value={String(usage.remaining)}
              suffix={t("account.emailsUnit")}
            />
          </div>
        </Card>
        {usage.daily_limit < 100 && (
          <Card className="mt-5 p-6">
            <h2 className="font-bold text-ink-soft">
              {t("account.unlockTitle")}
            </h2>
            <p className="mt-2 text-sm leading-6 text-muted">
              {t("account.unlockBody")}
            </p>
            <form
              action={activateQuota}
              className="mt-5 flex flex-col gap-3 sm:flex-row"
            >
              <input
                name="code"
                className="h-11 flex-1 rounded-xl border border-line-strong bg-surface px-3.5 text-sm uppercase tracking-[0.12em] outline-none focus:border-accent"
                placeholder={t("account.codePlaceholder")}
                required
              />
              <button
                className="h-11 rounded-xl bg-accent px-5 text-sm font-semibold text-white hover:bg-accent-deep"
                type="submit"
              >
                {t("account.activate")}
              </button>
            </form>
          </Card>
        )}
      </div>
    </div>
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
    <div className="rounded-xl bg-surface-2 p-4">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-2 text-2xl font-bold text-ink">
        {value}{" "}
        <span className="text-xs font-semibold text-muted">{suffix}</span>
      </p>
    </div>
  );
}
function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-6 rounded-xl border border-success/25 bg-success-soft px-4 py-3 text-sm font-medium text-success">
      {children}
    </div>
  );
}
function ErrorNotice({ message }: { message: string }) {
  return (
    <div className="mt-6 rounded-xl border border-danger/25 bg-danger-soft px-4 py-3 text-sm font-medium text-danger">
      {message}
    </div>
  );
}
