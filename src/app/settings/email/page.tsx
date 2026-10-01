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
import { getServerT, getRequestLang } from "@/lib/i18n/server";
import { localeForLang } from "@/lib/i18n/core";
import {
  disconnectEmailAccount,
  reassignDraftSender,
} from "@/app/settings/email/actions";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{
  connected?: string;
  error?: string;
  /** Safe reason code from the OAuth callback (e.g. invalid_grant). */
  reason?: string;
  /** Provider HTTP status when the failure came from the provider. */
  status?: string;
  disconnected?: string;
  reassigned?: string;
}>;

/** Error code → i18n key (all live under `account.*`). */
const ERROR_KEYS: Record<string, string> = {
  authorization_cancelled: "account.errAuthorizationCancelled",
  invalid_oauth_state: "account.errInvalidOAuthState",
  session_expired: "account.errSessionExpired",
  insufficient_permissions: "account.errInsufficientPermissions",
  connection_failed: "account.errConnectionFailed",
  account_not_found: "account.errAccountNotFound",
  disconnect_failed: "account.errDisconnectFailed",
  active_campaigns: "account.errActiveCampaigns",
  drafts_in_use: "account.errDraftsInUse",
  reassign_failed: "account.errReassignFailed",
  provider_authorization_failed: "account.errProviderAuthorization",
  gmail_not_configured: "account.errGmailNotConfigured",
  outlook_not_configured: "account.errOutlookNotConfigured",
  unsupported_provider: "account.errUnsupportedProvider",
};

type T = (path: string, vars?: Record<string, string | number>) => string;

export default async function EmailSettingsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const { user } = await getCurrentUserAndProfile();
  if (!user) redirect("/login");
  const accounts = await listEmailAccounts(user.id);
  const params = await searchParams;
  const [t, lang] = await Promise.all([getServerT(), getRequestLang()]);
  const locale = localeForLang(lang);
  const connectedLabel =
    params.connected === "gmail"
      ? t("account.connectedGmail")
      : params.connected === "outlook"
        ? t("account.connectedOutlook")
        : null;
  return (
    <div className="px-4 py-6 sm:px-6 lg:px-10">
      <div className="mx-auto max-w-5xl">
        {connectedLabel && (
          <Notice tone="success">
            {connectedLabel}. {t("account.connectedNotice")}
          </Notice>
        )}
        {params.disconnected && (
          <Notice tone="success">{t("account.disconnectedNotice")}</Notice>
        )}
        {params.reassigned === "1" && (
          <Notice tone="success">{t("account.reassignedNotice")}</Notice>
        )}
        {params.error && (
          <Notice tone="error">
            {t(ERROR_KEYS[params.error] ?? "account.genericConnectionError")}
            {params.reason && (
              <span className="mt-1 block text-xs font-normal">
                {t("account.errProviderReason", {
                  reason: params.reason,
                  status: params.status ? ` · HTTP ${params.status}` : "",
                })}
              </span>
            )}
          </Notice>
        )}
        <section className="mt-2 grid gap-4 md:grid-cols-2">
          <ProviderCard
            t={t}
            provider="gmail"
            title="Gmail"
            description={t("account.gmailDesc")}
            href="/api/email/connect/gmail"
          />
          <ProviderCard
            t={t}
            provider="outlook"
            title="Outlook"
            description={t("account.outlookDesc")}
            href="/api/email/connect/outlook"
          />
        </section>
        <section className="mt-8">
          <h2 className="text-lg font-bold text-ink-soft">
            {t("account.connectedAccounts")}
          </h2>
          <p className="mt-1 text-sm text-muted">{t("account.safeNote")}</p>
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
                  t={t}
                  locale={locale}
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
                <p className="text-sm font-semibold text-ink-soft">
                  {t("account.noAccountsTitle")}
                </p>
                <p className="mt-1 text-xs text-muted">
                  {t("account.noAccountsBody")}
                </p>
              </Card>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function ProviderCard({
  t,
  provider,
  title,
  description,
  href,
}: {
  t: T;
  provider: "gmail" | "outlook";
  title: string;
  description: string;
  href: string;
}) {
  return (
    <Card className="p-6">
      <div className="flex items-start justify-between">
        <span
          className={`flex h-12 w-12 items-center justify-center rounded-2xl text-lg font-bold ${provider === "gmail" ? "bg-danger-soft text-danger" : "bg-accent-soft text-accent-deep"}`}
        >
          {provider === "gmail" ? "G" : "O"}
        </span>
        <span className="rounded-lg bg-surface-2 px-2 py-1 text-[10px] font-bold uppercase tracking-[0.08em] text-muted">
          OAuth 2.0
        </span>
      </div>
      <h3 className="mt-7 text-lg font-bold text-ink-soft">{title}</h3>
      <p className="mt-2 min-h-12 text-sm leading-6 text-muted">
        {description}
      </p>
      <a
        href={href}
        className="mt-5 flex h-11 items-center justify-center rounded-xl bg-navy px-4 text-sm font-semibold text-white transition hover:bg-navy-soft"
      >
        {t("account.connect")} {title} <span className="ms-2">→</span>
      </a>
    </Card>
  );
}

function AccountRow({
  t,
  locale,
  account,
  blockers,
  drafts,
  destinations,
}: {
  t: T;
  locale: string;
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
            className={`flex h-10 w-10 items-center justify-center rounded-xl text-sm font-bold ${account.provider === "gmail" ? "bg-danger-soft text-danger" : "bg-accent-soft text-accent-deep"}`}
          >
            {account.provider === "gmail" ? "G" : "O"}
          </span>
          <div>
            <p className="text-sm font-bold text-ink-soft">
              {account.provider === "gmail"
                ? t("account.connectedGmail")
                : t("account.connectedOutlook")}
            </p>
            <p className="mt-1 text-xs text-muted">{account.email}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 sm:justify-end">
          <span className="rounded-lg bg-success-soft px-2 py-1 text-[10px] font-bold uppercase tracking-[0.08em] text-success">
            {account.is_active ? t("account.active") : t("account.inactive")}
          </span>
          <span className="text-xs text-faint">
            {t("account.connectedOn", {
              date: formatDate(account.created_at, locale, t),
            })}
          </span>
          {inUse && (
            <span className="rounded-lg bg-warning-soft px-2 py-1 text-[10px] font-bold uppercase tracking-[0.08em] text-warning">
              {blockers.activeCampaigns > 0
                ? t("account.inUseCampaigns", {
                    count: blockers.activeCampaigns,
                  })
                : t("account.inUseDrafts", { count: blockers.drafts })}
            </span>
          )}
          <form action={disconnectEmailAccount}>
            <input type="hidden" name="accountId" value={account.id} />
            <button
              className="rounded-lg border border-danger/25 px-3 py-2 text-xs font-semibold text-danger hover:bg-danger-soft disabled:cursor-not-allowed disabled:opacity-50"
              disabled={inUse}
              title={inUse ? t("account.resolveFirst") : undefined}
              type="submit"
            >
              {t("account.disconnect")}
            </button>
          </form>
          <a
            href={`/api/email/connect/${account.provider}`}
            className="rounded-lg border border-line-strong px-3 py-2 text-xs font-semibold text-accent hover:bg-surface-2"
          >
            {t("account.reconnect")}
          </a>
        </div>
      </Card>
      {/* Phase 18 — minimal reassignment UI, shown only while drafts block
       *  this account. Server-rendered form; all checks re-run server-side. */}
      {drafts.length > 0 && (
        <div className="mt-2 rounded-xl border border-warning/25 bg-warning-soft p-4">
          <p className="text-xs font-semibold text-warning">
            {t("account.draftsBlockIntro", {
              count: drafts.length,
              email: account.email,
            })}
          </p>
          <div className="mt-3 space-y-2">
            {drafts.map((draft) => (
              <form
                key={draft.id}
                action={reassignDraftSender}
                className="flex flex-wrap items-center gap-2"
              >
                <input type="hidden" name="draftId" value={draft.id} />
                <span className="max-w-56 truncate text-xs text-muted">
                  {draft.subject.trim() ||
                    (draft.goal === "arbeit"
                      ? t("account.untitledArbeit")
                      : t("account.untitledAusbildung"))}
                </span>
                {destinations.length ? (
                  <>
                    <select
                      name="emailAccountId"
                      defaultValue=""
                      required
                      className="rounded-lg border border-warning/25 bg-surface px-2 py-1.5 text-xs text-ink-soft"
                    >
                      <option value="" disabled>
                        {t("account.chooseSender")}
                      </option>
                      {destinations.map((destination) => (
                        <option key={destination.id} value={destination.id}>
                          {destination.email}
                        </option>
                      ))}
                    </select>
                    <button
                      type="submit"
                      className="rounded-lg bg-navy px-3 py-1.5 text-xs font-semibold text-white hover:bg-navy-soft"
                    >
                      {t("account.moveDraft")}
                    </button>
                  </>
                ) : (
                  <span className="text-xs text-muted">
                    {t("account.connectOther")}
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
      className={`mt-6 rounded-xl border px-4 py-3 text-sm font-medium ${tone === "success" ? "border-success/25 bg-success-soft text-success" : "border-danger/25 bg-danger-soft text-danger"}`}
    >
      {children}
    </div>
  );
}
function formatDate(
  value: string | null,
  locale: string,
  t: T,
): string {
  return value
    ? new Intl.DateTimeFormat(locale, {
        month: "short",
        day: "numeric",
        year: "numeric",
      }).format(new Date(value))
    : t("account.never");
}
