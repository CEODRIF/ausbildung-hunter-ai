import { redirect } from "next/navigation";
import { Icon } from "@/components/icon";
import { Card } from "@/components/ui";
import {
  EmailAssistantContent,
  type EmailNotice,
} from "@/components/email-assistant-content";
import { getCurrentUserAndProfile } from "@/lib/auth";
import {
  getDisconnectBlockers,
  listEmailAccountsWithStatus,
  type EmailAccountStatus,
} from "@/lib/email-oauth";
import { getServerT, getRequestLang } from "@/lib/i18n/server";
import { localeForLang } from "@/lib/i18n/core";

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

  const notices: EmailNotice[] = [];
  if (params.connected === "gmail") {
    notices.push({
      id: "connected-gmail",
      tone: "success",
      body: (
        <>
          {t("account.connectedGmail")}. {t("account.connectedNotice")}
        </>
      ),
    });
  } else if (params.connected === "outlook") {
    notices.push({
      id: "connected-outlook",
      tone: "success",
      body: (
        <>
          {t("account.connectedOutlook")}. {t("account.connectedNotice")}
        </>
      ),
    });
  }
  if (params.disconnected) {
    notices.push({
      id: "disconnected",
      tone: "success",
      body: t("account.disconnectedNotice"),
    });
  }
  if (params.reassigned === "1") {
    notices.push({
      id: "reassigned",
      tone: "success",
      body: t("account.reassignedNotice"),
    });
  }
  if (params.error) {
    notices.push({
      id: "error",
      tone: "error",
      body: (
        <>
          {t(ERROR_KEYS[params.error] ?? "account.genericConnectionError")}
          {params.reason && (
            <span className="mt-1 block text-xs font-normal">
              {t("account.errProviderReason", {
                reason: params.reason,
                status: params.status ? ` · HTTP ${params.status}` : "",
              })}
            </span>
          )}
        </>
      ),
    });
  }
  if (accountLoadError) {
    notices.push({
      id: "status-load-error",
      tone: "error",
      body: t("account.statusLoadError"),
    });
  }

  // Disconnect blockers are computed server-side per account row.
  const blockersByAccountId = Object.fromEntries(
    await Promise.all(
      accounts.map(async (account) => [
        account.id,
        await getDisconnectBlockers(user.id, account.id),
      ]),
    ),
  );

  return (
    <EmailAssistantContent
      t={t}
      locale={locale}
      accounts={accounts}
      blockersByAccountId={blockersByAccountId}
      notices={notices}
      smartSending={<SmartSendingSection />}
    />
  );
}

/** Smart Sending — always-on sender pacing. Deliberately static:
    there is no control that can lower the interval below the
    5-second floor (the floor is also enforced in the database). */
export function SmartSendingSection() {
  return (
    <section className="mt-8">
      <h2 className="text-lg font-bold text-ink-soft">Smart Sending</h2>
      <Card className="mt-4 p-6">
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex items-center gap-2 text-sm font-bold text-ink-soft">
            <span className="relative flex h-2.5 w-2.5">
              <span
                aria-hidden="true"
                className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-50"
              />
              <span
                aria-hidden="true"
                className="relative inline-flex h-2.5 w-2.5 rounded-full bg-success"
              />
            </span>
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
          <div className="rounded-2xl bg-surface-2 px-4 py-3">
            <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted">
              Minimum interval
            </dt>
            <dd className="mt-1 font-bold text-ink-soft">5–6 seconds</dd>
          </div>
          <div className="rounded-2xl bg-surface-2 px-4 py-3">
            <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted">
              Recommended
            </dt>
            <dd className="mt-1 font-bold text-ink-soft">6 seconds</dd>
          </div>
          <div className="rounded-2xl bg-surface-2 px-4 py-3">
            <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted">
              Minimum allowed
            </dt>
            <dd className="mt-1 font-bold text-ink-soft">5 seconds</dd>
          </div>
        </dl>
        <p className="mt-4 flex items-center gap-1.5 text-xs text-faint">
          <Icon name="clock" className="h-3.5 w-3.5 shrink-0" />
          <span>
            The interval applies per sender account across all of your
            campaigns and workers — it cannot be lowered below 5 seconds.
          </span>
        </p>
      </Card>
    </section>
  );
}
