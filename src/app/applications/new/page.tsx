import Link from "next/link";
import { getApplicationComposerData } from "@/lib/application-drafts";
import { ApplicationComposer } from "@/components/application-composer";
import { Card } from "@/components/ui";
import { applyOpportunityPrefill } from "@/lib/opportunity-prefill";
import { getServerT } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

export default async function NewApplicationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const data = await getApplicationComposerData();
  if (!data) return null;
  const t = await getServerT();
  if (!data.accounts.length)
    return (
      <div className="px-4 py-6 sm:px-6 lg:px-10">
        <div className="mx-auto max-w-xl">
          <Card className="mt-2 p-8 text-center sm:p-12">
            <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-soft text-2xl text-accent">
              @
            </span>
            <h2 className="mt-6 text-2xl font-bold tracking-[-0.04em] text-ink">
              {t("empty.noEmail.title")}
            </h2>
            <p className="mx-auto mt-3 max-w-sm text-sm leading-6 text-muted">
              {t("empty.noEmail.body")}
            </p>
            <Link
              href="/settings/email"
              className="mt-7 inline-flex h-11 items-center rounded-xl bg-accent px-5 text-sm font-semibold text-white hover:bg-accent-deep"
            >
              {t("empty.noEmail.cta")} <span className="ms-2">→</span>
            </Link>
          </Card>
        </div>
      </div>
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
          ? t("account.prefillInvalid")
          : t("account.prefillUnavailable");
    }
  }

  return (
    <div className="px-4 py-6 sm:px-6 lg:px-10">
      <div className="mx-auto max-w-7xl">
        <div className="mt-2">
          <ApplicationComposer
            draft={activeDraft}
            accounts={data.accounts}
            prefillNotice={prefillNotice}
            prefillError={prefillError}
          />
        </div>
      </div>
    </div>
  );
}
