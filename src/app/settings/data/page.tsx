import Link from "next/link";
import { redirect } from "next/navigation";
import { Card } from "@/components/ui";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { DeleteAccountForm } from "@/app/settings/data/delete-account-form";

export const dynamic = "force-dynamic";

/** Phase 11 — GDPR data controls: export (portability) + deletion
 *  (erasure). Both actions run server-side against the session user only. */
export default async function DataSettingsPage() {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user || !profile || profile.account_status !== "active")
    redirect("/login");

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
            Data &amp; privacy
          </h1>
          <p className="mt-2 text-sm text-[#71819a]">
            Export the data we store for you, or permanently delete your
            account. Both actions are verified server-side against your session.
          </p>
        </div>

        <Card className="mt-8 p-6">
          <h2 className="font-bold text-[#1d3458]">Export your data</h2>
          <p className="mt-2 text-sm leading-6 text-[#8290a4]">
            Download a JSON file containing your profile, candidate profile,
            saved opportunities, application drafts, campaigns and messages, AI
            conversations, document scans, billing state and usage. OAuth
            tokens, encrypted email credentials, and API keys are never
            included.
          </p>
          <a
            href="/api/account/export"
            className="mt-5 inline-flex h-11 items-center rounded-xl bg-[#2f6fed] px-5 text-sm font-semibold text-white hover:bg-[#255dcc]"
          >
            Download data export (JSON)
          </a>
        </Card>

        <Card className="mt-5 border-[#f0d9da] p-6">
          <h2 className="font-bold text-[#b3444e]">Delete your account</h2>
          <p className="mt-2 text-sm leading-6 text-[#8290a4]">
            Permanently removes your account, profile, applications, campaigns,
            AI conversations, stored files, and every related record. This
            cannot be undone.
          </p>
          <DeleteAccountForm email={String(profile.email ?? "")} />
        </Card>
      </div>
    </main>
  );
}
