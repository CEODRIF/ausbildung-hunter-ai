import Link from "next/link";
import { redirect } from "next/navigation";
import { Card } from "@/components/ui";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { listDraftsBySender } from "@/lib/application-drafts";
import {
  getDisconnectBlockers,
  listEmailAccounts,
  type DisconnectBlockers,
  type SafeEmailAccount,
} from "@/lib/email-oauth";
import {
  disconnectEmailAccount,
  reassignDraftSender,
} from "@/app/settings/email/actions";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{
  connected?: string;
  error?: string;
  disconnected?: string;
  reassigned?: string;
}>;

const errors: Record<string, string> = {
  authorization_cancelled:
    "Authorization was cancelled. No account was connected.",
  invalid_oauth_state: "The authorization expired. Please start again.",
  session_expired: "Your session expired. Please sign in again.",
  insufficient_permissions:
    "The provider did not grant the permissions required for a future connection.",
  connection_failed: "We could not verify that account. Please try again.",
  account_not_found: "That account could not be found.",
  disconnect_failed: "We could not disconnect this account. Please try again.",
  active_campaigns:
    "This account is sending an active campaign. Cancel the campaign before disconnecting.",
  drafts_in_use:
    "One or more of your application drafts use this account as sender. Delete or reassign those drafts before disconnecting.",
  reassign_failed:
    "We could not move that draft to the other account. Please try again.",
  provider_authorization_failed:
    "The provider could not authorize the connection. Please try again.",
  gmail_not_configured: "Gmail OAuth is not configured yet.",
  outlook_not_configured: "Outlook OAuth is not configured yet.",
  unsupported_provider: "That provider is not supported.",
};

export default async function EmailSettingsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const { user } = await getCurrentUserAndProfile();
  if (!user) redirect("/login");
  const accounts = await listEmailAccounts(user.id);
  const params = await searchParams;
  const connectedLabel =
    params.connected === "gmail"
      ? "Gmail connected"
      : params.connected === "outlook"
        ? "Outlook connected"
        : null;
  return (
    <main className="min-h-screen bg-[#f6f8fb] px-5 py-8 sm:px-8 lg:px-10 lg:py-10">
      <div className="mx-auto max-w-5xl">
        <Link
          href="/dashboard"
          className="text-sm font-semibold text-[#2f6fed]"
        >
          ← Back to dashboard
        </Link>
        <div className="mt-8">
          <p className="text-sm font-semibold text-[#2f6fed]">Settings</p>
          <h1 className="mt-2 text-3xl font-bold tracking-[-0.04em] text-[#10203b]">
            Connect an email account
          </h1>
          <p className="mt-2 max-w-xl text-sm leading-6 text-[#71819a]">
            Connect the account you plan to use later for applications. We never
            ask for your provider password.
          </p>
        </div>
        {connectedLabel && (
          <Notice tone="success">
            {connectedLabel}. Your account is securely connected.
          </Notice>
        )}
        {params.disconnected && (
          <Notice tone="success">
            Email account disconnected and stored tokens deleted.
          </Notice>
        )}
        {params.reassigned === "1" && (
          <Notice tone="success">
            Draft reassigned to the new sender. You can now disconnect the old
            account.
          </Notice>
        )}
        {params.error && (
          <Notice tone="error">
            {errors[params.error] ?? "We could not complete that connection."}
          </Notice>
        )}
        <section className="mt-8 grid gap-4 md:grid-cols-2">
          <ProviderCard
            provider="gmail"
            title="Gmail"
            description="Connect a Google account for future application sending."
            href="/api/email/connect/gmail"
          />
          <ProviderCard
            provider="outlook"
            title="Outlook"
            description="Connect Microsoft Outlook or Microsoft 365 securely."
            href="/api/email/connect/outlook"
          />
        </section>
        <section className="mt-8">
          <h2 className="text-lg font-bold text-[#1d3458]">
            Connected accounts
          </h2>
          <p className="mt-1 text-sm text-[#8290a4]">
            Only safe account details are shown here. OAuth tokens stay
            server-side.
          </p>
          <div className="mt-4 space-y-3">
            {accounts.length ? (
              (
                await Promise.all(
                  accounts.map(async (account) => {
                    const blockers = await getDisconnectBlockers(
                      user.id,
                      account.id,
                    );
                    // Phase 18 — only for blocked accounts: which drafts use
                    // this sender (user-scoped read, display fields only).
                    const drafts =
                      blockers.drafts > 0
                        ? await listDraftsBySender(user.id, account.id)
                        : [];
                    return { account, blockers, drafts };
                  }),
                )
              ).map(({ account, blockers, drafts }) => (
                <AccountRow
                  key={account.id}
                  account={account}
                  blockers={blockers}
                  drafts={drafts}
                  destinations={accounts.filter(
                    (other) => other.id !== account.id && other.is_active,
                  )}
                />
              ))
            ) : (
              <Card className="p-8 text-center">
                <p className="text-sm font-semibold text-[#1d3458]">
                  No email accounts connected
                </p>
                <p className="mt-1 text-xs text-[#8290a4]">
                  Choose Gmail or Outlook above to get started.
                </p>
              </Card>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

function ProviderCard({
  provider,
  title,
  description,
  href,
}: {
  provider: "gmail" | "outlook";
  title: string;
  description: string;
  href: string;
}) {
  return (
    <Card className="p-6">
      <div className="flex items-start justify-between">
        <span
          className={`flex h-12 w-12 items-center justify-center rounded-2xl text-lg font-bold ${provider === "gmail" ? "bg-[#fff0ee] text-[#df5548]" : "bg-[#eaf2ff] text-[#2878d7]"}`}
        >
          {provider === "gmail" ? "G" : "O"}
        </span>
        <span className="rounded-lg bg-[#f4f7fc] px-2 py-1 text-[10px] font-bold uppercase tracking-[0.08em] text-[#8492a7]">
          OAuth 2.0
        </span>
      </div>
      <h3 className="mt-7 text-lg font-bold text-[#1d3458]">{title}</h3>
      <p className="mt-2 min-h-12 text-sm leading-6 text-[#8290a4]">
        {description}
      </p>
      <a
        href={href}
        className="mt-5 flex h-11 items-center justify-center rounded-xl bg-[#10203b] px-4 text-sm font-semibold text-white transition hover:bg-[#1d3458]"
      >
        Connect {title} <span className="ml-2">→</span>
      </a>
    </Card>
  );
}

function AccountRow({
  account,
  blockers,
  drafts,
  destinations,
}: {
  account: SafeEmailAccount;
  blockers: DisconnectBlockers;
  drafts: Array<{ id: string; subject: string; goal: string }>;
  destinations: SafeEmailAccount[];
}) {
  const inUse = blockers.activeCampaigns > 0 || blockers.drafts > 0;
  return (
    <div>
      <Card className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <span
            className={`flex h-10 w-10 items-center justify-center rounded-xl text-sm font-bold ${account.provider === "gmail" ? "bg-[#fff0ee] text-[#df5548]" : "bg-[#eaf2ff] text-[#2878d7]"}`}
          >
            {account.provider === "gmail" ? "G" : "O"}
          </span>
          <div>
            <p className="text-sm font-bold text-[#1d3458]">
              {account.provider === "gmail"
                ? "Gmail connected"
                : "Outlook connected"}
            </p>
            <p className="mt-1 text-xs text-[#8290a4]">{account.email}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 sm:justify-end">
          <span className="rounded-lg bg-[#eaf8f3] px-2 py-1 text-[10px] font-bold uppercase tracking-[0.08em] text-[#1b9b70]">
            {account.is_active ? "Active" : "Inactive"}
          </span>
          <span className="text-xs text-[#8b9ab0]">
            Connected {formatDate(account.created_at)}
          </span>
          {inUse && (
            <span className="rounded-lg bg-[#fdf3e2] px-2 py-1 text-[10px] font-bold uppercase tracking-[0.08em] text-[#b57a1f]">
              {blockers.activeCampaigns > 0
                ? `In use · ${blockers.activeCampaigns} active campaign${blockers.activeCampaigns === 1 ? "" : "s"}`
                : `In use · ${blockers.drafts} draft${blockers.drafts === 1 ? "" : "s"}`}
            </span>
          )}
          <form action={disconnectEmailAccount}>
            <input type="hidden" name="accountId" value={account.id} />
            <button
              className="rounded-lg border border-[#f0d9da] px-3 py-2 text-xs font-semibold text-[#c24c55] hover:bg-[#fff7f7] disabled:cursor-not-allowed disabled:opacity-50"
              disabled={inUse}
              title={
                inUse
                  ? "Resolve the active campaign or drafts using this account first"
                  : undefined
              }
              type="submit"
            >
              Disconnect
            </button>
          </form>
          <a
            href={`/api/email/connect/${account.provider}`}
            className="rounded-lg border border-[#dbe3ef] px-3 py-2 text-xs font-semibold text-[#2f6fed] hover:bg-[#f5f8ff]"
          >
            Reconnect
          </a>
        </div>
      </Card>
      {/* Phase 18 — minimal reassignment UI, shown only while drafts block
       *  this account. Server-rendered form; all checks re-run server-side. */}
      {drafts.length > 0 && (
        <div className="mt-2 rounded-xl border border-[#f0e2c4] bg-[#fdf9f0] p-4">
          <p className="text-xs font-semibold text-[#8a6116]">
            {drafts.length} draft{drafts.length === 1 ? "" : "s"} use{" "}
            {account.email} as sender. Move a draft to another connected account
            (or delete it) to unblock the disconnect:
          </p>
          <div className="mt-3 space-y-2">
            {drafts.map((draft) => (
              <form
                key={draft.id}
                action={reassignDraftSender}
                className="flex flex-wrap items-center gap-2"
              >
                <input type="hidden" name="draftId" value={draft.id} />
                <span className="max-w-56 truncate text-xs text-[#5b6b84]">
                  {draft.subject.trim() ||
                    (draft.goal === "arbeit"
                      ? "Untitled job draft"
                      : "Untitled training draft")}
                </span>
                {destinations.length ? (
                  <>
                    <select
                      name="emailAccountId"
                      defaultValue=""
                      required
                      className="rounded-lg border border-[#e2d5b8] bg-white px-2 py-1.5 text-xs text-[#1d3458]"
                    >
                      <option value="" disabled>
                        Choose a new sender…
                      </option>
                      {destinations.map((destination) => (
                        <option key={destination.id} value={destination.id}>
                          {destination.email}
                        </option>
                      ))}
                    </select>
                    <button
                      type="submit"
                      className="rounded-lg bg-[#10203b] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#1d3458]"
                    >
                      Move draft
                    </button>
                  </>
                ) : (
                  <span className="text-xs text-[#8290a4]">
                    Connect another account above to move this draft.
                  </span>
                )}
              </form>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Notice({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "success" | "error";
}) {
  return (
    <div
      className={`mt-6 rounded-xl border px-4 py-3 text-sm font-medium ${tone === "success" ? "border-[#ccefe1] bg-[#f3fcf8] text-[#187e5b]" : "border-[#f5d7da] bg-[#fff8f8] text-[#a3404b]"}`}
    >
      {children}
    </div>
  );
}
function formatDate(value: string | null) {
  return value
    ? new Intl.DateTimeFormat("en", {
        month: "short",
        day: "numeric",
        year: "numeric",
      }).format(new Date(value))
    : "Never";
}
