import Link from "next/link";
import { getApplicationComposerData } from "@/lib/application-drafts";
import { ApplicationComposer } from "@/components/application-composer";
import { Card } from "@/components/ui";
import { applyOpportunityPrefill } from "@/lib/opportunity-prefill";

export const dynamic = "force-dynamic";

export default async function NewApplicationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
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

  // Optional server-derived prefill from an opportunity (?opp=<key>).
  // The key is validated and the opportunity re-resolved from the
  // authoritative source — nothing is trusted from the URL beyond the key.
  const params = await searchParams;
  const rawOpp = typeof params.opp === "string" ? params.opp : "";
  let activeDraft = data.draft!;
  let prefillNotice: string | null = null;
  let prefillError: string | null = null;
  if (rawOpp) {
    const outcome = await applyOpportunityPrefill(
      { userId: data.userId, accounts: data.accounts, draft: data.draft! },
      rawOpp,
    );
    if (outcome.ok) {
      activeDraft = outcome.draft;
      prefillNotice = outcome.notice;
    } else {
      prefillError =
        outcome.error === "invalid_key"
          ? "Der übergebene Stellenangebots-Link ist ungültig. Es wurde kein Entwurf vorbereitet."
          : "Das Stellenangebot konnte nicht mehr geladen werden. Es wurde kein Entwurf vorbereitet.";
    }
  }

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
          <ApplicationComposer
            draft={activeDraft}
            accounts={data.accounts}
            prefillNotice={prefillNotice}
            prefillError={prefillError}
          />
        </div>
      </div>
    </main>
  );
}
