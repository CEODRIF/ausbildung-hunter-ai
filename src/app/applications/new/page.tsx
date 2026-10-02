import Link from "next/link";
import {
  createBlankDraft,
  getApplicationComposerData,
  loadOwnedDraft,
} from "@/lib/application-drafts";
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

  const params = await searchParams;
  const rawOpp = typeof params.opp === "string" ? params.opp : "";
  const rawDraft = typeof params.draft === "string" ? params.draft : "";
  const wantsNew = params.new === "1" || params.new === "true";
  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // Draft resolution (multi-campaign management):
  //  - ?draft=<id> opens THAT specific draft (linked from the Applications
  //    list); ownership is enforced server-side — a stale or foreign id
  //    falls back to the default draft instead of erroring.
  //  - ?new=1 (the "New application" button) opens a fresh, independent
  //    draft; an already-blank draft is reused so empty drafts never pile
  //    up, and non-blank work is never overwritten.
  //  - otherwise the most recent draft is resumed (previous behaviour).
  let activeDraft = data.draft!;
  if (rawDraft && uuidPattern.test(rawDraft)) {
    const specific = await loadOwnedDraft(data.userId, rawDraft);
    if (specific) activeDraft = specific;
  }
  if (wantsNew) {
    const blank =
      activeDraft.subject.trim() === "" &&
      activeDraft.body_text.trim() === "" &&
      activeDraft.recipients.length === 0 &&
      activeDraft.attachments.length === 0;
    if (!blank)
      activeDraft = await createBlankDraft(
        data.userId,
        data.profile.selected_goal ?? "ausbildung",
        data.accounts[0].id,
      );
  }

  // Optional server-derived prefill from an opportunity (?opp=<key>).
  // The key is validated and the opportunity re-resolved from the
  // authoritative source — nothing is trusted from the URL beyond the key.
  let prefillNotice: string | null = null;
  let prefillError: string | null = null;
  if (rawOpp) {
    const outcome = await applyOpportunityPrefill(
      { userId: data.userId, accounts: data.accounts, draft: activeDraft },
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
            from={typeof params.from === "string" ? params.from : ""}
          />
        </div>
      </div>
    </div>
  );
}
