import Link from "next/link";
import { getApplicationComposerData } from "@/lib/application-drafts";
import { ApplicationComposer } from "@/components/application-composer";
import { Card } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function NewApplicationPage() {
  const data = await getApplicationComposerData();
  if (!data) return null;
  if (!data.accounts.length)
    return (
      <main className="min-h-screen bg-[#f6f8fb] px-5 py-12 sm:px-8">
        <div className="mx-auto max-w-xl">
          <Link
            href="/dashboard"
            className="text-sm font-semibold text-[#2f6fed]"
          >
            ← Back to dashboard
          </Link>
          <Card className="mt-8 p-8 text-center sm:p-12">
            <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-[#edf3ff] text-2xl text-[#2f6fed]">
              @
            </span>
            <h1 className="mt-6 text-2xl font-bold tracking-[-0.04em] text-[#10203b]">
              No email account connected
            </h1>
            <p className="mx-auto mt-3 max-w-sm text-sm leading-6 text-[#71819a]">
              Connect Gmail or Outlook before preparing an application email.
            </p>
            <Link
              href="/settings/email"
              className="mt-7 inline-flex h-11 items-center rounded-xl bg-[#2f6fed] px-5 text-sm font-semibold text-white hover:bg-[#255dcc]"
            >
              Connect email account <span className="ml-2">→</span>
            </Link>
          </Card>
        </div>
      </main>
    );
  return (
    <main className="min-h-screen bg-[#f6f8fb] px-5 py-8 sm:px-8 lg:px-10">
      <div className="mx-auto max-w-7xl">
        <Link
          href="/dashboard"
          className="text-sm font-semibold text-[#2f6fed]"
        >
          ← Back to dashboard
        </Link>
        <div className="mt-7">
          <ApplicationComposer draft={data.draft!} accounts={data.accounts} />
        </div>
      </div>
    </main>
  );
}
