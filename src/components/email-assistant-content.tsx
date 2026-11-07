import { Icon } from "@/components/icon";
import { Card } from "@/components/ui";
import { disconnectEmailAccount } from "@/app/settings/email/actions";
import type {
  DisconnectBlockers,
  EmailAccountStatus,
} from "@/lib/email-oauth";
import {
  providerSection,
  type EmailProviderId,
} from "@/lib/email-provider-state";

/**
 * Presentational body of the E-Mail-Assistant settings page
 * (rendered by src/app/settings/email/page.tsx, which owns all data
 * access and the Smart Sending section). Pure layout + the server
 * action form; no auth, no DB, no fetch.
 */

type T = (path: string, vars?: Record<string, string | number>) => string;

export type EmailNotice = {
  id: string;
  tone: "success" | "error";
  body: React.ReactNode;
};

export function EmailAssistantContent({
  t,
  locale,
  accounts,
  blockersByAccountId,
  notices,
  smartSending,
}: {
  t: T;
  locale: string;
  accounts: readonly EmailAccountStatus[];
  blockersByAccountId: Record<string, DisconnectBlockers>;
  notices: readonly EmailNotice[];
  /** The static Smart Sending section (kept in page.tsx). */
  smartSending?: React.ReactNode;
}) {
  const activeCount = accounts.filter((a) => a.is_active).length;

  return (
    <div className="px-4 py-6 sm:px-6 lg:px-10">
      <div className="mx-auto max-w-5xl">
        {/* Header — icon chip + title + live status */}
        <header className="flex flex-wrap items-center gap-4">
          <span
            aria-hidden="true"
            className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl text-white shadow-[var(--shadow-card)]"
            style={{ background: "var(--gradient-neon)" }}
          >
            <Icon name="mail" className="h-6 w-6" />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="display-title text-2xl text-ink sm:text-3xl">
              {t("pages.settingsEmail.title")}
            </h1>
            <p className="mt-1 text-sm text-muted">
              {t("pages.settingsEmail.subtitle")}
            </p>
          </div>
          {activeCount > 0 && (
            <span className="flex items-center gap-1.5 rounded-full border border-success/25 bg-success-soft px-3 py-1.5 text-xs font-bold text-success">
              <span
                aria-hidden="true"
                className="h-1.5 w-1.5 rounded-full bg-success"
              />
              {t("account.connectedBadge")}
            </span>
          )}
        </header>

        {/* OAuth callback notices */}
        {notices.length > 0 && (
          <div className="mt-6 space-y-3">
            {notices.map((n) => (
              <Notice key={n.id} tone={n.tone}>
                {n.body}
              </Notice>
            ))}
          </div>
        )}

        {/* Provider cards — derived from CURRENT database state */}
        <section className="mt-8 grid gap-4 md:grid-cols-2">
          <ProviderCard
            t={t}
            provider="gmail"
            title="Gmail"
            description={t("account.gmailDesc")}
            accounts={accounts}
          />
          <ProviderCard
            t={t}
            provider="outlook"
            title="Outlook"
            description={t("account.outlookDesc")}
            accounts={accounts}
          />
        </section>

        {smartSending}

        {/* Connected accounts */}
        <section className="mt-8">
          <h2 className="text-lg font-bold text-ink-soft">
            {t("account.connectedAccounts")}
          </h2>
          <p className="mt-1 text-sm text-muted">{t("account.safeNote")}</p>
          <div className="mt-4 space-y-3">
            {accounts.length ? (
              accounts.map((account) => (
                <AccountCard
                  key={account.id}
                  t={t}
                  locale={locale}
                  account={account}
                  blockers={blockersByAccountId[account.id]}
                />
              ))
            ) : (
              <Card className="p-10 text-center">
                <span
                  aria-hidden="true"
                  className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-surface-2 text-muted"
                >
                  <Icon name="mail" className="h-5 w-5" />
                </span>
                <p className="mt-4 text-sm font-bold text-ink-soft">
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

/* ------------------------------------------------------------------ */

function BrandChip({
  provider,
  size = "lg",
}: {
  provider: EmailProviderId;
  size?: "lg" | "md";
}) {
  const dim = size === "lg" ? "h-12 w-12 text-lg" : "h-11 w-11 text-base";
  return (
    <span
      aria-hidden="true"
      className={`flex ${dim} shrink-0 items-center justify-center rounded-2xl font-bold ${
        provider === "gmail" ? "bg-danger-soft text-danger" : "bg-accent-soft text-accent-deep"
      }`}
    >
      {provider === "gmail" ? "G" : "O"}
    </span>
  );
}

/**
 * Top provider card, derived from the CURRENT database state
 * (see providerSection): a healthy account renders a green "Connected"
 * state with the linked email and NO connect button; an expired/revoked
 * account renders a separate Reconnect action; only a user without any
 * account sees the initial connect card.
 */
function ProviderCard({
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
    <div className="flex items-start justify-between gap-4">
      <BrandChip provider={provider} />
      {section.kind === "connected" ? (
        <span className="flex items-center gap-1.5 rounded-full bg-success-soft px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.08em] text-success">
          <span
            aria-hidden="true"
            className="h-1.5 w-1.5 rounded-full bg-success"
          />
          {t("account.connectedBadge")}
        </span>
      ) : (
        <span className="rounded-full bg-surface-2 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.08em] text-muted">
          OAuth 2.0
        </span>
      )}
    </div>
  );

  if (section.kind === "connected") {
    const [primary, ...rest] = section.active;
    return (
      <Card className="border-success/25 p-6 transition-shadow hover:shadow-[var(--shadow-float)]">
        {head}
        <h3 className="mt-5 text-lg font-bold text-ink-soft">{title}</h3>
        <div className="mt-3 space-y-2">
          <p
            className="flex items-center gap-2 rounded-xl bg-surface-2 px-3 py-2.5 text-sm font-semibold text-ink-soft"
            dir="ltr"
          >
            <Icon name="mail" className="h-4 w-4 shrink-0 text-muted" />
            <span className="min-w-0 truncate">{primary.email}</span>
          </p>
          {rest.length > 0 && (
            <p className="text-xs font-medium text-faint" dir="auto">
              {t("account.connectedCount", { count: section.active.length })}
            </p>
          )}
        </div>
      </Card>
    );
  }

  if (section.kind === "reconnect") {
    return (
      <Card className="border-warning/25 p-6">
        {head}
        <h3 className="mt-5 text-lg font-bold text-ink-soft">{title}</h3>
        <p
          className="mt-3 flex items-center gap-2 rounded-xl bg-surface-2 px-3 py-2.5 text-sm font-semibold text-ink-soft"
          dir="ltr"
        >
          <Icon name="mail" className="h-4 w-4 shrink-0 text-muted" />
          <span className="min-w-0 truncate">{section.account.email}</span>
        </p>
        <p className="mt-2 flex items-center gap-1.5 text-xs font-medium text-warning">
          <Icon name="alert" className="h-3.5 w-3.5 shrink-0" />
          {t("account.needReconnect")}
        </p>
        <a
          href={href}
          className="mt-5 flex h-11 items-center justify-center gap-2 rounded-xl border border-warning/40 bg-warning-soft px-4 text-sm font-semibold text-warning transition hover:opacity-90"
        >
          <Icon name="refresh" className="h-4 w-4" />
          {t("account.reconnect")}
          <Icon name="arrowRight" className="h-4 w-4 rtl:rotate-180" />
        </a>
      </Card>
    );
  }

  return (
    <Card className="p-6 transition-shadow hover:shadow-[var(--shadow-float)]">
      {head}
      <h3 className="mt-5 text-lg font-bold text-ink-soft">{title}</h3>
      <p className="mt-2 min-h-12 text-sm leading-6 text-muted">
        {description}
      </p>
      <a
        href={href}
        className="mt-5 flex h-11 items-center justify-center gap-2 rounded-xl bg-navy px-4 text-sm font-semibold text-white transition hover:bg-navy-soft"
      >
        <Icon name="mail" className="h-4 w-4" />
        {t("account.connect")} {title}
        <Icon name="arrowRight" className="h-4 w-4 rtl:rotate-180" />
      </a>
    </Card>
  );
}

function AccountCard({
  t,
  locale,
  account,
  blockers,
}: {
  t: T;
  locale: string;
  account: EmailAccountStatus;
  blockers?: DisconnectBlockers;
}) {
  const inUse =
    (blockers?.activeCampaigns ?? 0) > 0 || (blockers?.drafts ?? 0) > 0;
  const needsReconnect = !account.is_active || account.requires_reconnect;
  return (
    <Card className="p-5 transition-shadow hover:shadow-[var(--shadow-card)] sm:p-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <BrandChip provider={account.provider} size="md" />
          <div className="min-w-0">
            <p className="truncate text-sm font-bold text-ink-soft">
              {account.provider === "gmail"
                ? t("account.connectedGmail")
                : t("account.connectedOutlook")}
            </p>
            <p className="truncate text-xs text-muted" dir="ltr">
              {account.email}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 lg:justify-end">
          <span
            className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.08em] ${
              account.is_active
                ? "bg-success-soft text-success"
                : "bg-surface-2 text-muted"
            }`}
          >
            <span
              aria-hidden="true"
              className={`h-1.5 w-1.5 rounded-full ${
                account.is_active ? "bg-success" : "bg-faint"
              }`}
            />
            {account.is_active ? t("account.active") : t("account.inactive")}
          </span>
          {inUse && (
            <span className="rounded-full bg-warning-soft px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.08em] text-warning">
              {(blockers?.activeCampaigns ?? 0) > 0
                ? t("account.inUseCampaigns", {
                    count: blockers!.activeCampaigns,
                  })
                : t("account.inUseDrafts", { count: blockers!.drafts })}
            </span>
          )}
          <span className="flex items-center gap-1 text-xs text-faint">
            <Icon name="clock" className="h-3.5 w-3.5" />
            {t("account.connectedOn", {
              date: formatDate(account.created_at, locale, t),
            })}
          </span>
          <form action={disconnectEmailAccount}>
            <input type="hidden" name="accountId" value={account.id} />
            <button
              className="rounded-lg border border-danger/25 px-3 py-2 text-xs font-semibold text-danger transition hover:bg-danger-soft disabled:cursor-not-allowed disabled:opacity-50"
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
              className="rounded-lg border border-line-strong px-3 py-2 text-xs font-semibold text-accent transition hover:bg-surface-2"
            >
              {t("account.reconnect")}
            </a>
          )}
        </div>
      </div>
      {/* NOTE: the former yellow "drafts use this sender" reassignment box
          was removed from the UI on purpose. Drafts themselves, their
          storage and the server-side draft-reassignment action in
          ./actions.ts are untouched. */}
    </Card>
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
      role="status"
      className={`flex items-start gap-2.5 rounded-2xl border px-4 py-3 text-sm font-medium ${
        tone === "success"
          ? "border-success/25 bg-success-soft text-success"
          : "border-danger/25 bg-danger-soft text-danger"
      }`}
    >
      <Icon
        name={tone === "success" ? "check" : "alert"}
        className="mt-0.5 h-4 w-4 shrink-0"
      />
      <div className="min-w-0">{children}</div>
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
