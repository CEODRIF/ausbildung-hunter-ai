import { redirect } from "next/navigation";
import { Card } from "@/components/ui";
import { getCurrentUserAndProfile } from "@/lib/auth";
import {
  getDisconnectBlockers,
  listEmailAccountsWithStatus,
  type DisconnectBlockers,
  type EmailAccountStatus,
} from "@/lib/email-oauth";
import {
  providerSection,
  type EmailProviderId,
} from "@/lib/email-provider-state";
import { getServerT, getRequestLang } from "@/lib/i18n/server";
import { localeForLang } from "@/lib/i18n/core";
import { disconnectEmailAccount } from "@/app/settings/email/actions";

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
  // Server-derived CURRENT account state (fresh row per request — no cached
  // client state). On read failure we must not claim any connection: render
  // the neutral connect cards plus an explicit error notice.
  let accounts: EmailAccountStatus[] = [];
  let accountLoadError = false;
  try {
    accounts = await listEmailAccountsWithStatus(user.id);
  } catch {
    accountLoadError = true;
  }
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
        {accountLoadError && (
          <Notice tone="error">{t("account.statusLoadError")}</Notice>
        )}
        <section className="mt-2 grid gap-4 md:grid-cols-2">
          <ProviderSectionCard
            t={t}
            provider="gmail"
            title="Gmail"
            description={t("account.gmailDesc")}
            accounts={accounts}
          />
          <ProviderSectionCard
            t={t}
            provider="outlook"
            title="Outlook"
            description={t("account.outlookDesc")}
            accounts={accounts}
          />
        </section>
        {/* Smart Sending — always-on sender pacing. Deliberately static:
            there is no control that can lower the interval below the
            5-second floor (the floor is also enforced in the database). */}
        <section className="mt-8">
          <h2 className="text-lg font-bold text-ink-soft">Smart Sending</h2>
          <Card className="mt-4 p-6">
            <div className="flex flex-wrap items-center gap-2">
              <span className="flex items-center gap-2 text-sm font-bold text-ink-soft">
                <span
                  aria-hidden="true"
                  className="h-2.5 w-2.5 rounded-full bg-success"
                />
                Enabled
              </span>
              <span className="rounded-lg bg-success-soft px-2 py-1 text-[10px] font-bold uppercase tracking-[0.08em] text-success">
                Always on
              </span>
            </div>
            <p className="mt-3 text-sm leading-6 text-muted">
              Your emails are sent gradually with a minimum 5-second interval
              between messages from the same account.
            </p>
            <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
              <div className="rounded-xl bg-surface-2 px-4 py-3">
                <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted">
                  Minimum interval
                </dt>
                <dd className="mt-1 font-bold text-ink-soft">5–6 seconds</dd>
              </div>
              <div className="rounded-xl bg-surface-2 px-4 py-3">
                <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted">
                  Recommended
                </dt>
                <dd className="mt-1 font-bold text-ink-soft">6 seconds</dd>
              </div>
              <div className="rounded-xl bg-surface-2 px-4 py-3">
                <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted">
                  Minimum allowed
                </dt>
                <dd className="mt-1 font-bold text-ink-soft">5 seconds</dd>
              </div>
            </dl>
            <p className="mt-4 text-xs text-faint">
              The interval applies per sender account across all of your
              campaigns and workers — it cannot be lowered below 5 seconds.
            </p>
          </Card>
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
                  accounts.map(async (account) => ({
                    account,
                    blockers: await getDisconnectBlockers(user.id, account.id),
                  })),
                )
              ).map(({ account, blockers }) => (
                <AccountRow
                  key={account.id}
                  t={t}
                  locale={locale}
                  account={account}
                  blockers={blockers}
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

/**
 * Top provider card, derived from the CURRENT database state
 * (see providerSection): a healthy account renders a green "Connected"
 * state with the linked email and NO connect button; an expired/revoked
 * account renders a separate Reconnect action; only a user without any
 * account sees the initial connect card.
 */
function ProviderSectionCard({
  t,
  provider,
  title,
  description,
  accounts,
}: {
  t: T;
  provider: EmailProviderId;
  title: string;
  description: string;
  accounts: readonly EmailAccountStatus[];
}) {
  const section = providerSection(accounts, provider);
  const href = `/api/email/connect/${provider}`;
  const head = (
    <div className="flex items-start justify-between">
      <span
        className={`flex h-12 w-12 items-center justify-center rounded-2xl text-lg font-bold ${provider === "gmail" ? "bg-danger-soft text-danger" : "bg-accent-soft text-accent-deep"}`}
      >
        {provider === "gmail" ? "G" : "O"}
      </span>
      {section.kind === "connected" ? (
        <span className="flex items-center gap-1.5 rounded-lg bg-success-soft px-2 py-1 text-[10px] font-bold uppercase tracking-[0.08em] text-success">
          <span
            aria-hidden="true"
            className="h-1.5 w-1.5 rounded-full bg-success"
          />
          {t("account.connectedBadge")}
        </span>
      ) : (
        <span className="rounded-lg bg-surface-2 px-2 py-1 text-[10px] font-bold uppercase tracking-[0.08em] text-muted">
          OAuth 2.0
        </span>
      )}
    </div>
  );

  if (section.kind === "connected") {
    const [primary, ...rest] = section.active;
    return (
      <Card className="border-success/25 p-6">
        {head}
        <h3 className="mt-7 text-lg font-bold text-ink-soft">{title}</h3>
        <p className="mt-2 min-h-12 text-sm leading-6 text-ink-soft" dir="ltr">
          {primary.email}
          {rest.length > 0 && (
            <span className="mt-1 block text-xs text-faint" dir="auto">
              {t("account.connectedCount", { count: section.active.length })}
            </span>
          )}
        </p>
      </Card>
    );
  }

  if (section.kind === "reconnect") {
    return (
      <Card className="border-warning/25 p-6">
        {head}
        <h3 className="mt-7 text-lg font-bold text-ink-soft">{title}</h3>
        <p className="mt-2 min-h-12 text-sm leading-6 text-muted" dir="ltr">
          {section.account.email}
        </p>
        <p className="mt-1 text-xs font-medium text-warning">
          {t("account.needReconnect")}
        </p>
        <a
          href={href}
          className="mt-5 flex h-11 items-center justify-center rounded-xl border border-warning/40 bg-warning-soft px-4 text-sm font-semibold text-warning transition hover:opacity-90"
        >
          {t("account.reconnect")} <span className="ms-2">→</span>
        </a>
      </Card>
    );
  }

  return (
    <Card className="p-6">
      {head}
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
}: {
  t: T;
  locale: string;
  account: EmailAccountStatus;
  blockers: DisconnectBlockers;
}) {
  const inUse = blockers.activeCampaigns > 0 || blockers.drafts > 0;
  const needsReconnect = !account.is_active || account.requires_reconnect;
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
            <p className="mt-1 text-xs text-muted" dir="ltr">
              {account.email}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 sm:justify-end">
          <span
            className={`rounded-lg px-2 py-1 text-[10px] font-bold uppercase tracking-[0.08em] ${
              account.is_active
                ? "bg-success-soft text-success"
                : "bg-surface-2 text-muted"
            }`}
          >
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
          {/* Reconnect is a SEPARATE action, shown only when the current
              status actually requires re-authorization. Healthy accounts
              have no re-link control here (the top card also hides the
              connect button in that case). */}
          {needsReconnect && (
            <a
              href={`/api/email/connect/${account.provider}`}
              className="rounded-lg border border-line-strong px-3 py-2 text-xs font-semibold text-accent hover:bg-surface-2"
            >
              {t("account.reconnect")}
            </a>
          )}
        </div>
      </Card>
      {/* NOTE: the former yellow "drafts use this sender" reassignment box
          was removed from the UI on purpose. Drafts themselves, their
          storage and the server-side draft-reassignment action in
          ./actions.ts are untouched. */}
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
