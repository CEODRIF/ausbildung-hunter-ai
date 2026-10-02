import Link from "next/link";
import type { SafeEmailAccount } from "@/lib/email-oauth";
import { getServerT } from "@/lib/i18n/server";

export async function EmailAccountCard({
  account,
}: {
  account: SafeEmailAccount | null;
}) {
  const t = await getServerT();
  const label = account
    ? t(
        account.provider === "gmail"
          ? "account.connectedGmail"
          : "account.connectedOutlook",
      )
    : t("account.notConnected");
  return (
    <div className="glass mt-5 flex flex-col gap-4 rounded-3xl p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
      <div>
        <p className="text-xs font-bold uppercase tracking-[0.12em] text-faint">
          {t("pages.settingsEmail.title")}
        </p>
        <div className="mt-2 flex items-center gap-2">
          <span
            className={`h-2.5 w-2.5 rounded-full ${
              account ? "bg-success" : "bg-faint"
            }`}
          />
          <h2 className="font-bold text-ink-soft">{label}</h2>
        </div>
        {account && (
          <p className="mt-1 text-xs text-muted" dir="ltr">
            {account.email}
          </p>
        )}
      </div>
      <Link
        href="/settings/email"
        className="inline-flex h-11 items-center justify-center rounded-2xl border border-line-strong bg-surface px-5 text-xs font-bold text-accent transition-colors hover:bg-surface-2"
      >
        {account ? t("account.manageAccount") : t("empty.noEmail.cta")}
        <span className="ms-2">→</span>
      </Link>
    </div>
  );
}
