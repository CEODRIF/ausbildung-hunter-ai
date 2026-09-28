import Link from "next/link";
import { Card } from "@/components/ui";
import type { SafeEmailAccount } from "@/lib/email-oauth";

export function EmailAccountCard({
  account,
}: {
  account: SafeEmailAccount | null;
}) {
  const label = account
    ? `${account.provider === "gmail" ? "Gmail" : "Outlook"} connected`
    : "Not connected";
  return (
    <Card className="mt-5 flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
      <div>
        <p className="text-xs font-bold uppercase tracking-[0.12em] text-[#8b9ab0]">
          Email account
        </p>
        <div className="mt-2 flex items-center gap-2">
          <span
            className={`h-2 w-2 rounded-full ${account ? "bg-[#1b9b70]" : "bg-[#a0adbd]"}`}
          />
          <h2 className="font-bold text-[#1d3458]">{label}</h2>
        </div>
        {account && (
          <p className="mt-1 text-xs text-[#8290a4]">{account.email}</p>
        )}
      </div>
      <Link
        href="/settings/email"
        className="inline-flex h-10 items-center justify-center rounded-xl border border-[#dbe3ef] px-4 text-xs font-bold text-[#2f6fed] hover:bg-[#f5f8ff]"
      >
        {account ? "Manage account" : "Connect email"}{" "}
        <span className="ml-2">→</span>
      </Link>
    </Card>
  );
}
