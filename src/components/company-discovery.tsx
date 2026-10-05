"use client";

/**
 * Company & Email Discovery — page UI (Phase 2).
 *
 * Flow: the form collects what a DISCOVERY run needs — field, role, planned
 * start (4 modes), offer type, target number of UNIQUE companies with a
 * public email, and the email-only toggle (on by default). Submitting
 * registers the run and shows the LIVE state of that same run: the API
 * answers with the run id, the engine then works server-side, and this
 * component polls `GET /api/company-discovery/[runId]` for the counters the
 * engine actually measured. Nothing here is interpolated, estimated or
 * animated towards a number the server did not report.
 *
 * Stop Search posts to `POST /api/company-discovery/[runId]/cancel`; the
 * engine re-reads the run between work units, so a cancelled run never starts
 * another source pass and never overwrites the terminal state.
 *
 * Layout: responsive (1 column mobile → 2 columns from sm), logical
 * properties (ps/pe, ms/me, start/end) so Arabic (dir=rtl) mirrors.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  Activity,
  Ban,
  Building2,
  CheckCircle2,
  CopyX,
  Download,
  FileText,
  Mail,
  Play,
  RefreshCw,
  Search,
  Square,
  Target,
  XCircle,
} from "lucide-react";
import { createDiscoveryDraftAction } from "@/app/company-discovery/actions";
import { Chip, StatusPill, type StatusTone } from "@/components/ui/feedback";
import { GlassCard } from "@/components/ui/surfaces";
import { SearchOrb } from "@/components/ui/search-orb";
import type { DiscoveryCampaignRow } from "@/lib/company-discovery/campaigns";
import { isEligiblePublicEmail } from "@/lib/company-discovery/accept";
import type { RunCompanyResult } from "@/lib/company-discovery/runs";
import { useI18n } from "@/lib/i18n";
import type { TranslateVars } from "@/lib/i18n/core";
import {
  DISCOVERY_FIELD_SUGGESTIONS,
  DISCOVERY_TARGET_DEFAULT,
  DISCOVERY_TARGET_MAX,
  DISCOVERY_TARGET_MIN,
  beginnLabelOf,
  type DiscoveryBeginn,
  type DiscoveryGoal,
  type DiscoveryRun,
  type DiscoveryRunStatus,
} from "@/lib/company-discovery/types";
import {
  DISCOVERY_ERROR_FALLBACK_KEY,
  DISCOVERY_STOP_FAILED_KEY,
  discoveryErrorKey,
  isTerminalRunStatus,
  retryAfterSeconds,
  type DiscoveryErrorBody,
} from "@/lib/company-discovery/errors";

type Phase = "idle" | "submitting" | "running" | "created";
type BeginnMode = DiscoveryBeginn["mode"];
type TranslateFn = (key: string, vars?: TranslateVars) => string;

const BEGINN_MODES: BeginnMode[] = ["from_now", "date", "month", "year"];
const GOALS: DiscoveryGoal[] = ["ausbildung", "arbeit", "both"];

/** Live status polling cadence while the engine works. */
const POLL_INTERVAL_MS = 1500;
/** After this long we stop polling and hand control back to the user — the
 *  run may legitimately continue server-side; we never invent a state. */
const POLL_BUDGET_MS = 90_000;

/** A failed draft creation → the message that actually applies. */
function draftErrorKey(code: string | undefined): string {
  if (code === "no_email_account") return "companyDiscovery.campaigns.noAccount";
  if (code === "unauthorized") return "companyDiscovery.error.unauthorized";
  return "companyDiscovery.campaigns.createFailed";
}

/** Locale-aware date for the campaign history (real timestamps only). */
function formatDate(iso: string, lang: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat(lang, { dateStyle: "medium" }).format(date);
}

function beginnLabelKey(mode: BeginnMode): string {
  switch (mode) {
    case "from_now":
      return "companyDiscovery.form.beginnFromNow";
    case "date":
      return "companyDiscovery.form.beginnDate";
    case "month":
      return "companyDiscovery.form.beginnMonth";
    case "year":
      return "companyDiscovery.form.beginnYear";
  }
}

function goalLabelKey(goal: DiscoveryGoal): string {
  switch (goal) {
    case "ausbildung":
      return "companyDiscovery.form.typeAusbildung";
    case "arbeit":
      return "companyDiscovery.form.typeArbeit";
    case "both":
      return "companyDiscovery.form.typeBoth";
  }
}

/** Terminal-state badge (color follows the real status only). */
function RunStatusBadge({
  status,
  t,
}: {
  status: DiscoveryRunStatus;
  t: TranslateFn;
}) {
  return (
    <StatusPill
      tone={
        status === "completed"
          ? "success"
          : status === "failed"
            ? "blocked"
            : status === "running" || status === "pending"
              ? "running"
              : "neutral"
      }
      label={t(`companyDiscovery.status.${status}`)}
    />
  );
}

/** One premium counter tile: big real number, small label, subtle icon. */
function CounterTile({
  icon,
  value,
  label,
  sub,
  tone = "default",
}: {
  icon: ReactNode;
  value: ReactNode;
  label: string;
  sub?: string;
  tone?: "default" | "accent" | "success" | "warning" | "danger";
}) {
  const toneIcon = {
    default: "bg-surface-2 text-muted",
    accent: "bg-accent-soft text-accent",
    success: "bg-success-soft text-success",
    warning: "bg-warning-soft text-warning",
    danger: "bg-danger-soft text-danger",
  }[tone];
  return (
    <div className="surface-elevated relative flex flex-col gap-3 rounded-2xl p-4 transition-shadow duration-300 hover:shadow-[var(--shadow-float)]">
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 truncate text-[11px] font-semibold tracking-wide text-muted uppercase">
          {label}
        </p>
        <span
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl ${toneIcon}`}
        >
          {icon}
        </span>
      </div>
      <div>
        <p className="num text-2xl leading-8 font-extrabold text-ink sm:text-3xl">
          {value}
        </p>
        {sub && (
          <p className="mt-0.5 truncate text-[11px] font-medium text-faint">
            {sub}
          </p>
        )}
      </div>
    </div>
  );
}

/** Pill tone for a stored source status — colors follow the real state. */
function sourceStatusTone(status: string): StatusTone {
  switch (status) {
    case "ok":
      return "success";
    case "running":
      return "running";
    case "blocked":
    case "error":
      return "blocked";
    case "unavailable":
      return "unverified";
    case "skipped":
      return "skipped";
    case "skipped_by_policy":
      return "restricted";
    default:
      return "neutral";
  }
}

function RunCounters({ run, t }: { run: DiscoveryRun; t: TranslateFn }) {
  const sources = run.progress.sources;
  // Sources skipped by policy stay persisted in the run (audit) but are not
  // shown in the user-facing source table.
  const visibleSources = sources.filter(
    (s) => s.status !== "skipped_by_policy",
  );
  const hiddenPolicySources = sources.filter(
    (s) => s.status === "skipped_by_policy",
  ).length;
  const source = sources[0];
  const sourceLabel = !source
    ? "—"
    : source.status === "running"
      ? t("companyDiscovery.runCreated.sourceSearching")
      : source.status === "unavailable"
        ? t("companyDiscovery.runCreated.sourceUnavailable")
        : t("companyDiscovery.runCreated.sourceOk");
  // ---- the "Internet Discovery" scope (§22) — all derived, no new counters ----
  const scanned = sources.length;
  const activeSources = sources.filter((s) => s.status === "ok").length;
  const blockedSources = sources.filter((s) => s.status === "blocked").length;
  const familyCount = (cats: string[]): number =>
    visibleSources.filter((s) => s.category && cats.includes(s.category)).length;
  const families: Array<{ key: string; cats: string[] }> = [
    { key: "portals", cats: ["ausbildung", "jobs", "local-jobs", "government"] },
    { key: "search", cats: ["search"] },
    { key: "company-site", cats: ["company-site"] },
    { key: "directory", cats: ["chamber", "directory"] },
    { key: "platform", cats: ["platform"] },
  ];
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const filteredSources =
    sourceFilter === "all"
      ? visibleSources
      : visibleSources.filter(
          (s) =>
            s.category &&
            families.find((f) => f.key === sourceFilter)?.cats.includes(s.category) === true,
        );
  // The search layer's honest execution stats (persisted in the source
  // report) — 0 before the layer ran or on runs from before it existed.
  const searchStats = sources.find((s) => s.id === "search-api")?.stats;
  // Every value below is MEASURED by the running engine and persisted on the
  // run (0 before it ran / on older rows) — nothing is interpolated.
  const progress = run.progress;
  const discoveryTiles: Array<{ key: string; value: number }> = [
    { key: "scanned", value: scanned },
    { key: "active", value: activeSources },
    { key: "offers", value: progress.offersAnalyzed },
    { key: "companies", value: progress.uniqueCompanies },
    { key: "duplicates", value: progress.duplicatesRemoved },
    { key: "blocked", value: blockedSources },
    // Run-level queries (search layer + per-company lookups); the source
    // stat is the pre-migration fallback for the same measured value.
    {
      key: "queries",
      value: progress.queriesExecuted ?? searchStats?.queriesExecuted ?? 0,
    },
    { key: "results", value: searchStats?.resultsInspected ?? 0 },
    { key: "processed", value: progress.companiesProcessed },
    { key: "pagesInspected", value: progress.pagesInspected ?? 0 },
    { key: "urlsDiscovered", value: progress.urlsDiscovered ?? 0 },
    { key: "browserPages", value: progress.browserPages ?? 0 },
    { key: "browserInteractions", value: progress.browserInteractions ?? 0 },
    { key: "applicationsFound", value: progress.applicationsFound ?? 0 },
    { key: "beginnConfirmed", value: progress.beginnConfirmed ?? 0 },
  ];

  return (
    <>
      {/* The engine now spans a network of source families (§22). Shown only
          once the run has produced a source report; every number is derived
          from the REAL per-source status — nothing is interpolated. */}
      {sources.length > 0 && (
        <div className="surface-elevated mt-5 rounded-3xl p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-bold tracking-tight text-ink">
                {t("companyDiscovery.discovery.title")}
              </h3>
              <p className="mt-1 max-w-xl text-xs leading-5 text-muted">
                {t("companyDiscovery.discovery.subtitle")}
              </p>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {families.map((family) => (
                <span
                  key={family.key}
                  className="inline-flex items-center rounded-full border border-line bg-surface px-2.5 py-1 text-[11px] font-semibold text-ink-soft"
                >
                  {t(`companyDiscovery.discovery.family.${family.key}`)}
                  <span className="num ms-1.5 text-faint">{familyCount(family.cats)}</span>
                </span>
              ))}
            </div>
          </div>
          <div className="mt-4 grid grid-cols-3 gap-2 sm:gap-2.5">
            {discoveryTiles.map((tile) => (
              <div
                key={tile.key}
                className="rounded-2xl border border-line bg-surface px-3 py-2.5"
              >
                <p className="num text-xl font-extrabold text-ink">{tile.value}</p>
                <p className="mt-0.5 truncate text-[11px] font-semibold text-muted">
                  {t(`companyDiscovery.discovery.${tile.key}`)}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <CounterTile
          icon={<Target size={16} strokeWidth={1.8} />}
          value={
            <>
              {run.progress.foundCompanies}
              <span className="text-sm font-semibold text-muted">
                {" "}
                / {run.progress.targetCompanies}
              </span>
            </>
          }
          label={t("companyDiscovery.runCreated.found")}
          tone="accent"
        />
        <CounterTile
          icon={<FileText size={16} strokeWidth={1.8} />}
          value={run.progress.offersAnalyzed}
          label={t("companyDiscovery.runCreated.offers")}
        />
        <CounterTile
          icon={<Building2 size={16} strokeWidth={1.8} />}
          value={run.progress.uniqueCompanies}
          label={t("companyDiscovery.runCreated.unique")}
          tone="success"
        />
        <CounterTile
          icon={<CopyX size={16} strokeWidth={1.8} />}
          value={run.progress.duplicatesRemoved}
          label={t("companyDiscovery.runCreated.duplicates")}
        />
        <CounterTile
          icon={<XCircle size={16} strokeWidth={1.8} />}
          value={run.progress.companiesRejected}
          label={t("companyDiscovery.runCreated.rejected")}
        />
        <CounterTile
          icon={<Mail size={16} strokeWidth={1.8} />}
          value={run.progress.emailsFound}
          label={t("companyDiscovery.runCreated.emailsFound")}
          tone="accent"
        />
        <CounterTile
          icon={<Mail size={16} strokeWidth={1.8} />}
          value={run.progress.noPublicEmail}
          label={t("companyDiscovery.runCreated.noPublicEmail")}
        />
        <CounterTile
          icon={<Ban size={16} strokeWidth={1.8} />}
          value={run.progress.sourcesBlocked}
          label={t("companyDiscovery.runCreated.sourcesBlocked")}
          tone={run.progress.sourcesBlocked > 0 ? "warning" : "default"}
        />
        <CounterTile
          icon={<CheckCircle2 size={16} strokeWidth={1.8} />}
          value={run.progress.companiesProcessed}
          label={t("companyDiscovery.runCreated.verified")}
          tone="success"
        />
      </div>
      {/* Live research state — the real current source and the exact
          provider query, both measured server-side and persisted on the run
          row. Null-safe: a pre-migration run simply shows the derived label
          and the idle line. Nothing here is animated or interpolated. */}
      <div className="mt-3 rounded-2xl border border-line bg-surface px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <Activity size={15} strokeWidth={1.8} className="shrink-0 text-accent" />
          <span className="text-xs font-semibold text-muted">
            {t("companyDiscovery.runCreated.liveSource")}:
          </span>
          <span className="min-w-0 text-sm font-bold text-ink">
            {run.progress.currentSource ?? sourceLabel}
          </span>
        </div>
        <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-2 ps-6">
          <span className="shrink-0 text-xs font-semibold text-muted">
            {t("companyDiscovery.runCreated.liveQuery")}:
          </span>
          {run.progress.currentQuery ? (
            <span
              dir="ltr"
              title={run.progress.currentQuery}
              className="min-w-0 max-w-full flex-1 truncate font-mono text-[11px] text-ink-soft"
            >
              {run.progress.currentQuery}
            </span>
          ) : (
            <span className="text-xs text-faint">
              {t("companyDiscovery.runCreated.liveIdle")}
            </span>
          )}
        </div>
        {/* Current strategy — the planner's real, measured decision (which
            family of queries it is executing and why). Shown only when the
            engine reported one; null (older run / before the first batch)
            hides the line entirely — nothing is faked. */}
        {run.progress.currentStrategy ? (
          <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-2 ps-6">
            <span className="shrink-0 text-xs font-semibold text-muted">
              {t("companyDiscovery.runCreated.liveStrategy")}:
            </span>
            <span
              title={run.progress.currentStrategy}
              className="min-w-0 max-w-full flex-1 truncate text-[11px] font-medium text-ink-soft"
            >
              {run.progress.currentStrategy}
            </span>
          </div>
        ) : null}
      </div>

      {/* ---- The source report: every registered source, honestly ---------- */}
      {sources.length > 0 && (
        <div className="surface-elevated mt-4 overflow-hidden rounded-3xl">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
            <h3 className="text-sm font-bold tracking-tight text-ink">
              {t("companyDiscovery.sources.title")}
            </h3>
            <div className="flex flex-wrap gap-1.5">
              <Chip
                label={t("premium.filterAll")}
                active={sourceFilter === "all"}
                onClick={() => setSourceFilter("all")}
                count={visibleSources.length}
              />
              {families.map((family) => (
                <Chip
                  key={family.key}
                  label={t(`companyDiscovery.discovery.family.${family.key}`)}
                  active={sourceFilter === family.key}
                  onClick={() => setSourceFilter(family.key)}
                  count={familyCount(family.cats)}
                />
              ))}
            </div>
          </div>
          {hiddenPolicySources > 0 && (
            <p className="px-5 pt-3 text-[11px] leading-4 text-faint">
              {t("companyDiscovery.sources.hiddenPolicySources", {
                count: hiddenPolicySources,
              })}
            </p>
          )}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[46rem] border-collapse text-xs">
              <thead>
                <tr className="bg-surface-2/60 text-muted">
                  <th className="px-4 py-2.5 pe-3 text-start font-bold">
                    {t("companyDiscovery.sources.columns.source")}
                  </th>
                  <th className="px-4 py-2.5 pe-3 text-start font-bold">
                    {t("companyDiscovery.sources.columns.category")}
                  </th>
                  <th className="px-4 py-2.5 pe-3 text-start font-bold">
                    {t("companyDiscovery.sources.columns.policy")}
                  </th>
                  <th className="px-4 py-2.5 pe-3 text-start font-bold">
                    {t("companyDiscovery.sources.columns.status")}
                  </th>
                  <th className="px-4 py-2.5 pe-3 text-start font-bold">
                    {t("companyDiscovery.sources.columns.offers")}
                  </th>
                  <th className="px-4 py-2.5 text-start font-bold">
                    {t("companyDiscovery.sources.columns.reason")}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {filteredSources.map((entry) => (
                  <tr key={entry.id} className="transition-colors hover:bg-surface-2/40">
                    <td className="px-4 py-2.5 pe-3 font-semibold text-ink">
                      {entry.displayName ?? entry.id}
                    </td>
                    <td className="px-4 py-2.5 pe-3 text-ink-soft">
                      {entry.category
                        ? t(`companyDiscovery.sources.category.${entry.category}`)
                        : "—"}
                    </td>
                    <td className="px-4 py-2.5 pe-3 text-ink-soft">
                      {entry.policy
                        ? t(`companyDiscovery.sources.policy.${entry.policy}`)
                        : "—"}
                    </td>
                    <td className="px-4 py-2.5 pe-3">
                      <StatusPill
                        tone={sourceStatusTone(entry.status)}
                        label={t(`companyDiscovery.sources.status.${entry.status}`)}
                      />
                    </td>
                    <td className="num px-4 py-2.5 pe-3 font-semibold text-ink-soft">
                      {entry.candidates ?? 0}
                    </td>
                    <td className="max-w-[14rem] px-4 py-2.5 text-muted">
                      <span className="block truncate" title={entry.reason ?? undefined}>
                        {entry.reason ?? "—"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

/** The three company outcomes (§4.4), plus the READ-TIME legacy state. */
type EmailStatusValue =
  | "email_found"
  | "no_public_email"
  | "source_blocked"
  /**
   * Derived at read time, never stored: the company has an address row whose
   * provenance does not hold up (a BA-derived `offer`, or no source page at
   * all). It is deliberately NOT part of `discovery_companies.email_status`,
   * whose CHECK allows only the three real company outcomes — this state
   * describes the stored ADDRESS, not the company's discovery outcome.
   */
  | "unverified_legacy";

/**
 * The stored address a campaign may use: the first one that actually carries
 * provenance. A legacy row (BA-derived `offer`, or no source page at all) is
 * excluded — §4.6 forbids consuming it, and it is shown as legacy instead.
 */
function pickEligibleEmail(
  company: RunCompanyResult,
): RunCompanyResult["emails"][number] | null {
  return company.emails.find((email) => isEligiblePublicEmail(email)) ?? null;
}

/** Pill tone per outcome — a block is a warning, not a failure. */
const EMAIL_STATUS_TONE: Record<EmailStatusValue, StatusTone> = {
  email_found: "success",
  no_public_email: "neutral",
  source_blocked: "blocked",
  unverified_legacy: "unverified",
};

/**
 * The outcome of a stored company. The persisted `emailStatus` is
 * authoritative; for rows written before that column existed the outcome is
 * derived from the audit pair (`status` + `rejectReason`) — never guessed from
 * the mere absence of an address, because a blocked source is NOT "no public
 * email".
 */
function emailStatusOf(
  company: RunCompanyResult,
  address: RunCompanyResult["emails"][number] | null,
): EmailStatusValue {
  // An address row exists but NONE of them is usable (no provenance, or a
  // BA-derived legacy row): the truthful label is the derived legacy state,
  // not the stored outcome — showing "email found" beside an empty email cell
  // would contradict itself. Same condition and same token as the Excel
  // export, so the two surfaces can never drift apart (§4.5/§4.6).
  if (address === null && company.emails.length > 0) return "unverified_legacy";
  if (
    company.emailStatus === "email_found" ||
    company.emailStatus === "no_public_email" ||
    company.emailStatus === "source_blocked"
  ) {
    return company.emailStatus;
  }
  if (address) return "email_found";
  if (
    company.rejectReason === "source_blocked" ||
    company.rejectReason === "no_website_found"
  ) {
    return "source_blocked";
  }
  return "no_public_email";
}

/**
 * "Previous Campaigns" — persisted rows only: campaigns AND discovery drafts
 * that have not been sent yet, so the list is identical after a refresh, after
 * leaving the page or after a re-login. A draft opens in the composer (with the
 * journey back to this page), a campaign in its monitor.
 */
function CampaignsPanel({
  campaigns,
  t,
  lang,
}: {
  campaigns: DiscoveryCampaignRow[];
  t: TranslateFn;
  lang: string;
}) {
  return (
    <GlassCard className="mt-6 p-5 sm:p-6" as="section">
      <h2 className="text-base font-bold tracking-tight text-ink">
        {t("companyDiscovery.campaigns.title")}
      </h2>
      {campaigns.length === 0 ? (
        <p className="mt-2 text-xs leading-5 text-muted">
          {t("companyDiscovery.campaigns.empty")}
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-line">
          {campaigns.map((campaign) => (
            <li
              key={campaign.campaignId || campaign.draftId}
              className="flex flex-wrap items-center justify-between gap-3 py-3.5"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-bold text-ink">
                  {campaign.title || t("companyDiscovery.campaigns.run")}
                </p>
                <p className="mt-0.5 text-xs text-muted">
                  {t("companyDiscovery.campaigns.recipients", {
                    count: campaign.totalRecipients,
                  })}
                  {" · "}
                  {t("companyDiscovery.campaigns.created")}:{" "}
                  {formatDate(campaign.createdAt, lang)}
                  {" · "}
                  {t("companyDiscovery.campaigns.updated")}:{" "}
                  {formatDate(campaign.updatedAt, lang)}
                </p>
                {campaign.discoveryRunId && (
                  <p
                    dir="ltr"
                    className="mt-1 truncate font-mono text-[11px] text-faint"
                  >
                    {t("companyDiscovery.campaigns.run")}:{" "}
                    {campaign.discoveryRunId}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="rounded-full bg-accent-soft px-2.5 py-1 text-[11px] font-bold text-accent">
                  {t(`companyDiscovery.campaigns.status.${campaign.status}`)}
                </span>
                <Link
                  href={
                    campaign.campaignId
                      ? `/applications/campaign/${campaign.campaignId}`
                      : `/applications/new?draft=${campaign.draftId}&from=company-discovery`
                  }
                  className="rounded-xl border border-line px-3.5 py-1.5 text-xs font-semibold text-ink transition hover:bg-surface-2"
                >
                  {t("companyDiscovery.campaigns.open")}
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </GlassCard>
  );
}

export function CompanyDiscovery({
  initialRun = null,
  initialCompanies = [],
  campaigns = [],
}: {
  /** Last persisted run, rendered by the server — survives refresh/re-login. */
  initialRun?: DiscoveryRun | null;
  /** Companies + public addresses of that run, read from the database. */
  initialCompanies?: RunCompanyResult[];
  /** The user's recent campaigns (persisted rows). */
  campaigns?: DiscoveryCampaignRow[];
}) {
  const { t, lang } = useI18n();
  const router = useRouter();

  // ---- form state ----------------------------------------------------------
  const [phase, setPhase] = useState<Phase>(initialRun ? "created" : "idle");
  const [field, setField] = useState("");
  const [role, setRole] = useState("");
  const [beginnMode, setBeginnMode] = useState<BeginnMode>("from_now");
  const [beginnValue, setBeginnValue] = useState("");
  const [goal, setGoal] = useState<DiscoveryGoal>("ausbildung");
  const [target, setTarget] = useState(String(DISCOVERY_TARGET_DEFAULT));
  const [onlyPublicEmail, setOnlyPublicEmail] = useState(true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [run, setRun] = useState<DiscoveryRun | null>(initialRun);
  const [companies, setCompanies] = useState<RunCompanyResult[]>(initialCompanies);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [draftState, setDraftState] = useState<
    | { status: "saving" }
    | { status: "saved"; draftId: string; linked: boolean }
    | { status: "error"; key: string }
    | null
  >(null);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const [continuing, setContinuing] = useState(false);
  const [continueError, setContinueError] = useState<string | null>(null);
  const [pollExpired, setPollExpired] = useState(false);
  const [pollNonce, setPollNonce] = useState(0);

  const runId = run?.runId ?? null;

  const beginn: DiscoveryBeginn = useMemo(() => {
    switch (beginnMode) {
      case "date":
        return { mode: "date", date: beginnValue };
      case "month":
        return { mode: "month", month: beginnValue };
      case "year":
        return { mode: "year", year: Number(beginnValue) };
      default:
        return { mode: "from_now" };
    }
  }, [beginnMode, beginnValue]);

  // ---- validation (client pre-flight; the server re-validates with zod) ----
  function validate(): boolean {
    const next: Record<string, string> = {};
    if (!field.trim()) next.field = t("companyDiscovery.validation.fieldRequired");
    if (!role.trim()) next.role = t("companyDiscovery.validation.roleRequired");
    const parsedTarget = Number(target);
    if (
      !Number.isInteger(parsedTarget) ||
      parsedTarget < DISCOVERY_TARGET_MIN ||
      parsedTarget > DISCOVERY_TARGET_MAX
    ) {
      next.target = t("companyDiscovery.validation.targetRange", {
        min: DISCOVERY_TARGET_MIN,
        max: DISCOVERY_TARGET_MAX,
      });
    }
    if (beginnMode !== "from_now" && !beginnValue.trim()) {
      next.beginn = t("companyDiscovery.validation.beginnRequired");
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  /**
   * Turn a failed API answer into the message that actually applies.
   * The server's `code` wins; the HTTP status is the fallback; a rate limit
   * shows the documented wait when the server sent one, and the neutral
   * failure text (never an invented number) when it did not.
   */
  const applyFailure = useCallback(
    (
      status: number,
      body: DiscoveryErrorBody | null,
      headers?: Headers | null,
    ) => {
      if (body?.code === "rate_limited") {
        const seconds = retryAfterSeconds(
          body,
          headers?.get("retry-after") ?? null,
        );
        setErrors({
          submit: seconds
            ? t(discoveryErrorKey(status, body.code), { seconds })
            : t("companyDiscovery.error.searchFailed"),
        });
        return;
      }
      setErrors({ submit: t(discoveryErrorKey(status, body?.code)) });
    },
    [t],
  );

  // ---- live run state (polling; real counters only) ------------------------
  useEffect(() => {
    if (phase !== "running" || !runId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const startedAt = Date.now();

    const poll = async () => {
      if (!active) return;
      try {
        const response = await fetch(`/api/company-discovery/${runId}`, {
          cache: "no-store",
        });
        const body = (await response.json().catch(() => null)) as
          | (DiscoveryErrorBody & { run?: DiscoveryRun })
          | null;
        if (!active) return;
        if (!response.ok) {
          applyFailure(response.status, body, response.headers);
          setPhase("idle");
          return;
        }
        if (body?.run) {
          setRun(body.run);
          if (isTerminalRunStatus(body.run.status)) {
            setPhase("created");
            return;
          }
        }
      } catch {
        // Transient network hiccup — the run continues server-side, so keep
        // polling instead of reporting a failure we cannot prove.
      }
      if (!active) return;
      if (Date.now() - startedAt > POLL_BUDGET_MS) {
        setPollExpired(true);
        return;
      }
      timer = setTimeout(poll, POLL_INTERVAL_MS);
    };

    timer = setTimeout(poll, POLL_INTERVAL_MS);
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [phase, runId, applyFailure, pollNonce]);

  // ---- submit --------------------------------------------------------------
  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (phase === "submitting" || !validate()) return;
    setPhase("submitting");
    setErrors({});
    setStopError(null);
    setPollExpired(false);
    const params = {
      field: field.trim(),
      role: role.trim(),
      beginn,
      goal,
      targetCompanies: Number(target),
      onlyPublicEmail,
    };
    try {
      const response = await fetch("/api/company-discovery/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
      });
      const body = (await response.json().catch(() => null)) as
        | (DiscoveryErrorBody & { run?: DiscoveryRun })
        | null;
      if (!response.ok || !body?.run) {
        applyFailure(response.status, body, response.headers);
        setPhase("idle");
        return;
      }
      // The run exists. The engine continues server-side; the live state
      // comes from polling that same run — never from the request itself.
      setRun(body.run);
      setPhase("running");
    } catch {
      setErrors({ submit: t(DISCOVERY_ERROR_FALLBACK_KEY) });
      setPhase("idle");
    }
  }

  // ---- stop search ---------------------------------------------------------
  async function onStop() {
    if (!runId || stopping) return;
    setStopping(true);
    setStopError(null);
    try {
      const response = await fetch(`/api/company-discovery/${runId}/cancel`, {
        method: "POST",
      });
      const body = (await response.json().catch(() => null)) as
        | (DiscoveryErrorBody & { run?: DiscoveryRun })
        | null;
      if (!response.ok) {
        setStopError(t(DISCOVERY_STOP_FAILED_KEY));
        return;
      }
      if (body?.run) {
        setRun(body.run);
        if (isTerminalRunStatus(body.run.status)) setPhase("created");
      }
    } catch {
      setStopError(t(DISCOVERY_STOP_FAILED_KEY));
    } finally {
      setStopping(false);
    }
  }

  // ---- continue research (a partial run ends before its target) ------------
  // The SAME run is reopened server-side (partial → running); its persisted
  // companies are the checkpoint, so no company or email can be counted twice.
  // The live view + polling simply resume on the same runId.
  async function onContinue() {
    if (!runId || continuing) return;
    setContinuing(true);
    setContinueError(null);
    try {
      const response = await fetch(
        `/api/company-discovery/${runId}/continue`,
        { method: "POST" },
      );
      const body = (await response.json().catch(() => null)) as
        | (DiscoveryErrorBody & { run?: DiscoveryRun })
        | null;
      if (!response.ok || !body?.run) {
        if (body?.code === "rate_limited") {
          const seconds = retryAfterSeconds(
            body,
            response.headers?.get("retry-after") ?? null,
          );
          setContinueError(
            seconds
              ? t("companyDiscovery.error.rateLimited", { seconds })
              : t("companyDiscovery.continue.failed"),
          );
        } else {
          setContinueError(t("companyDiscovery.continue.failed"));
        }
        return;
      }
      // The reopened run is the same run (same id, counters intact) — the
      // live panel resumes on it immediately.
      setRun(body.run);
      setPollExpired(false);
      setPhase("running");
    } catch {
      setContinueError(t("companyDiscovery.continue.failed"));
    } finally {
      setContinuing(false);
    }
  }

  /** Manual re-check after the polling budget ran out (a real read). */
  function refresh() {
    setPollExpired(false);
    setPollNonce((value) => value + 1);
  }

  function reset() {
    setRun(null);
    setPhase("idle");
    setErrors({});
    setStopError(null);
    setPollExpired(false);
  }

  // ---- persisted results (companies + public emails) -----------------------
  // Always read from the database: the outcome of a run must be identical
  // after a refresh, a new device or a re-login — never client state only.
  useEffect(() => {
    if (phase !== "created" || !runId) return;
    let active = true;
    void (async () => {
      try {
        const response = await fetch(
          `/api/company-discovery/${runId}/results`,
          { cache: "no-store" },
        );
        const body = (await response.json().catch(() => null)) as
          | (DiscoveryErrorBody & { companies?: RunCompanyResult[] })
          | null;
        if (!active || !response.ok || !body?.companies) return;
        setCompanies(body.companies);
      } catch {
        // Keep what is already rendered: an unreadable refresh must never
        // empty a result the user can see.
      }
    })();
    return () => {
      active = false;
    };
  }, [phase, runId]);

  const acceptedCompanies = useMemo(
    () => companies.filter((company) => company.status === "accepted"),
    [companies],
  );

  function toggle(companyId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(companyId)) next.delete(companyId);
      else next.add(companyId);
      return next;
    });
  }

  /** Turn the selection into a persisted composer draft (no email sent). */
  async function onCreateCampaign() {
    if (!runId || selected.size === 0 || draftState?.status === "saving") return;
    const recipients = acceptedCompanies
      .filter((company) => selected.has(company.companyId))
      .map((company) => ({
        // §4.6: a campaign may only consume an address that HAS provenance —
        // a legacy (BA-derived or provenance-less) row is never sent to.
        email: pickEligibleEmail(company)?.email ?? "",
        companyName: company.companyName,
      }))
      .filter((recipient) => recipient.email.length > 0);
    setDraftState({ status: "saving" });
    try {
      const result = await createDiscoveryDraftAction({ runId, recipients });
      if (result.ok && result.draftId) {
        setDraftState({
          status: "saved",
          draftId: result.draftId,
          linked: result.linked !== false,
        });
        setSelected(new Set());
        // The history list is read from the database on the server, so the
        // draft must appear immediately without starting a new search.
        router.refresh();
      } else {
        setDraftState({ status: "error", key: draftErrorKey(result.code) });
      }
    } catch {
      setDraftState({
        status: "error",
        key: "companyDiscovery.campaigns.createFailed",
      });
    }
  }

  // ---- inputs (shared styling) ----------------------------------------------
  const inputClass =
    "w-full rounded-2xl border border-line bg-surface px-4 py-3 text-sm text-ink shadow-sm outline-none transition-[border-color,box-shadow] focus:border-accent focus:ring-4 focus:ring-accent/10";
  const labelClass = "mb-2 block text-xs font-bold tracking-wide text-muted";
  /** Back to the dashboard — present in EVERY state of this page. */
  const backLink = (
    <Link
      href="/dashboard"
      className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold text-muted transition hover:bg-surface-2 hover:text-ink"
    >
      <span aria-hidden="true" className="me-1.5 inline-block rtl:rotate-180">
        ←
      </span>
      {t("companyDiscovery.backToDashboard")}
    </Link>
  );

  // ===========================================================================
  // Running — the honest live state (polled, server-measured)
  // ===========================================================================
  if (phase === "running" && run) {
    // The status line is DERIVED from the real run state only — every branch
    // reads a server-measured counter, so the orb never claims a phase the
    // engine has not actually reached.
    const progress = run.progress;
    const orbLine =
      run.status === "pending"
        ? t("companyDiscovery.progress.pending")
        : progress.emailsFound > 0
          ? t("premium.orb.contacts")
          : progress.duplicatesRemoved > 0
            ? t("premium.orb.dedupe")
            : progress.sources.some((s) => s.category === "company-site")
              ? t("premium.orb.companies")
              : progress.sources.length > 0
                ? t("premium.orb.scanning")
                : progress.offersAnalyzed > 0
                  ? t("premium.orb.finding")
                  : t("premium.orb.starting");
    return (
      <div className="mx-auto max-w-5xl">
        {backLink}
        <GlassCard
          variant="surface-elevated"
          className="relative mt-4 overflow-hidden p-5 anim-fade-up sm:p-8"
        >
          <div className="hero-orb pointer-events-none absolute -end-24 -top-24 h-80 w-80 rounded-full" />
          <div className="relative grid items-center gap-6 sm:grid-cols-[auto_1fr]">
            <div className="mx-auto sm:mx-0">
              <SearchOrb active={run.status === "running"} size={128} />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-xl font-bold tracking-tight text-ink sm:text-2xl">
                  {t("companyDiscovery.progress.title")}
                </h2>
                <RunStatusBadge status={run.status} t={t} />
              </div>
              <ul role="status" aria-live="polite" className="mt-3 space-y-1.5">
                <li className="flex items-center gap-2.5 text-sm font-semibold text-ink">
                  <span
                    aria-hidden="true"
                    className={`h-2 w-2 shrink-0 rounded-full ${
                      run.status === "running"
                        ? "animate-pulse bg-accent"
                        : "bg-faint"
                    }`}
                  />
                  {orbLine}
                </li>
              </ul>
              <p className="mt-3 text-xs text-faint">
                {t("companyDiscovery.runCreated.runId")}:{' '}
                <span dir="ltr" className="font-mono">
                  {run.runId}
                </span>
              </p>
            </div>
          </div>

          <div className="relative mt-6">
            <RunCounters run={run} t={t} />

            <p className="mt-4 rounded-2xl bg-accent-soft/60 px-4 py-3 text-xs leading-5 text-ink-soft">
              {t("companyDiscovery.progress.note")}
            </p>

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={onStop}
                disabled={stopping}
                className="inline-flex h-10 items-center gap-2 rounded-2xl border border-line bg-surface px-4 text-sm font-semibold text-ink transition hover:bg-surface-2 disabled:cursor-wait disabled:opacity-60"
              >
                <Square size={15} strokeWidth={1.8} />
                {stopping
                  ? t("companyDiscovery.form.stopping")
                  : t("companyDiscovery.form.stop")}
              </button>
              <p className="text-xs leading-5 text-muted">
                {t("companyDiscovery.progress.stopNote")}
              </p>
            </div>

            {stopError && (
              <p className="mt-3 rounded-2xl bg-danger-soft px-4 py-2.5 text-sm font-semibold text-danger">
                {stopError}
              </p>
            )}

            {pollExpired && (
              <div className="mt-4 rounded-2xl bg-surface-2 px-4 py-3">
                <p className="text-xs leading-5 text-ink-soft">
                  {t("companyDiscovery.progress.keepOpen")}
                </p>
                <button
                  type="button"
                  onClick={refresh}
                  className="mt-2 inline-flex h-9 items-center gap-2 rounded-xl border border-line bg-surface px-3 text-xs font-semibold text-ink transition hover:bg-surface"
                >
                  <RefreshCw size={14} strokeWidth={1.8} />
                  {t("companyDiscovery.progress.refresh")}
                </button>
              </div>
            )}
          </div>
        </GlassCard>
      </div>
    );
  }

  // ===========================================================================
  // Finished run (honest state — every number comes from the run)
  // ===========================================================================
  if (phase === "created" && run) {
    return (
      <div className="mx-auto max-w-5xl">
        {backLink}
        <GlassCard
          variant="surface-elevated"
          className="relative mt-4 overflow-hidden p-5 anim-fade-up sm:p-8"
        >
          <div className="hero-orb pointer-events-none absolute -end-24 -top-24 h-72 w-72 rounded-full" />
          <div className="relative">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-xl font-bold tracking-tight text-ink sm:text-2xl">
                {t("companyDiscovery.runCreated.title")}
              </h2>
              <RunStatusBadge status={run.status} t={t} />
            </div>

            {/* Real run counters — measured by the engine, never simulated. */}
            <RunCounters run={run} t={t} />

            <dl className="mt-5 grid grid-cols-1 gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
              <div className="flex items-baseline justify-between gap-3 border-b border-line pb-2">
                <dt className="text-xs font-semibold text-muted">
                  {t("companyDiscovery.runCreated.field")}
                </dt>
                <dd className="truncate font-semibold text-ink">
                  {run.params.field}
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-3 border-b border-line pb-2">
                <dt className="text-xs font-semibold text-muted">
                  {t("companyDiscovery.runCreated.role")}
                </dt>
                <dd className="truncate font-semibold text-ink">
                  {run.params.role}
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-3 border-b border-line pb-2">
                <dt className="text-xs font-semibold text-muted">
                  {t("companyDiscovery.runCreated.beginn")}
                </dt>
                <dd className="font-semibold text-ink">
                  {t(beginnLabelKey(run.params.beginn.mode))}
                  {run.params.beginn.mode !== "from_now"
                    ? ` (${beginnLabelOf(run.params.beginn)})`
                    : ""}
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-3 border-b border-line pb-2">
                <dt className="text-xs font-semibold text-muted">
                  {t("companyDiscovery.runCreated.type")}
                </dt>
                <dd className="font-semibold text-ink">
                  {t(goalLabelKey(run.params.goal))}
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-3 border-b border-line pb-2 sm:col-span-2">
                <dt className="text-xs font-semibold text-muted">
                  {t("companyDiscovery.runCreated.runId")}
                </dt>
                <dd dir="ltr" className="truncate font-mono text-xs text-ink-soft">
                  {run.runId}
                </dd>
              </div>
            </dl>

            {run.status === "cancelled" && (
              <p className="mt-4 rounded-2xl bg-accent-soft px-4 py-2.5 text-xs leading-5 text-accent">
                {t("companyDiscovery.progress.stopNote")}
              </p>
            )}

            {/* Continue Research — ONLY a partial run below its target. A
                completed run reached the goal (no button), and the button
                reopens THE SAME run: the server-side checkpoint keeps every
                stored company, and dedupe runs across the whole run. */}
            {run.status === "partial" &&
              run.progress.foundCompanies < run.progress.targetCompanies && (
                <div className="mt-4 rounded-2xl border border-accent/30 bg-accent-soft/60 p-4">
                  <p className="text-xs leading-5 text-ink-soft">
                    {t("companyDiscovery.continue.note", {
                      found: run.progress.foundCompanies,
                      target: run.progress.targetCompanies,
                    })}
                  </p>
                  <button
                    type="button"
                    onClick={onContinue}
                    disabled={continuing}
                    className="btn-neon mt-3 inline-flex h-10 items-center gap-2 rounded-2xl px-5 text-sm font-semibold text-white transition disabled:cursor-wait disabled:opacity-60"
                  >
                    <Play size={15} strokeWidth={1.8} />
                    {continuing
                      ? t("companyDiscovery.continue.continuing")
                      : t("companyDiscovery.continue.button")}
                  </button>
                  {continueError && (
                    <p className="mt-3 rounded-2xl bg-danger-soft px-4 py-2.5 text-sm font-semibold text-danger">
                      {continueError}
                    </p>
                  )}
                </div>
              )}

            <p className="mt-4 rounded-2xl bg-surface-2 px-4 py-3 text-xs leading-5 text-ink-soft">
              {t("companyDiscovery.runCreated.resultsNote")}
            </p>
          </div>

          {/* ---- Public emails (only what was actually published) ---------- */}
          <div className="relative mt-6 border-t border-line pt-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-lg font-bold tracking-tight text-ink">
                {t("companyDiscovery.results.title")}
              </h3>
              {acceptedCompanies.length > 0 && (
                <span className="rounded-full bg-accent-soft px-3 py-1 text-xs font-bold text-accent">
                  <span className="num">{acceptedCompanies.length}</span>
                </span>
              )}
            </div>
            {acceptedCompanies.length === 0 ? (
              <p className="mt-3 rounded-2xl bg-surface-2 px-4 py-3 text-xs leading-5 text-ink-soft">
                {t("companyDiscovery.results.empty")}
              </p>
            ) : (
              <>
                <p className="mt-1.5 text-xs leading-5 text-muted">
                  {t("companyDiscovery.results.selectHint")}
                </p>
                <div className="mt-4 grid gap-3">
                  {acceptedCompanies.map((company) => {
                    const address = pickEligibleEmail(company);
                    // ONE derived token for the whole card: a legacy address
                    // reports `unverified_legacy` right in the badge, exactly
                    // like the Excel export — no second, divergent label.
                    const status = emailStatusOf(company, address);
                    return (
                      <article
                        key={company.companyId}
                        className="surface-elevated rounded-3xl p-4 transition-shadow duration-300 hover:shadow-[var(--shadow-float)] sm:p-5"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="flex min-w-0 flex-1 items-start gap-3">
                            {address && (
                              <input
                                type="checkbox"
                                checked={selected.has(company.companyId)}
                                onChange={() => toggle(company.companyId)}
                                aria-label={company.companyName}
                                className="mt-1 h-4 w-4 shrink-0 rounded accent-[var(--blue)]"
                              />
                            )}
                            <div className="min-w-0">
                              <h4 className="truncate text-sm font-bold text-ink">
                                {company.companyName}
                              </h4>
                              <p className="mt-0.5 truncate text-xs text-muted">
                                {company.role ?? "—"}
                                {" · "}
                                {company.city ?? "—"}
                              </p>
                            </div>
                          </div>
                          <span
                            title={
                              company.rejectReason ??
                              address?.verificationMethod ??
                              undefined
                            }
                          >
                            <StatusPill
                              tone={EMAIL_STATUS_TONE[status]}
                              label={t(`companyDiscovery.results.emailStatus.${status}`)}
                            />
                          </span>
                        </div>
                        <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2.5 text-xs sm:grid-cols-3">
                          <div className="min-w-0">
                            <dt className="text-[10px] font-bold tracking-wide text-faint uppercase">
                              {t("companyDiscovery.results.columns.email")}
                            </dt>
                            <dd dir="ltr" className="mt-1 truncate font-mono text-xs text-ink">
                              {address ? (
                                address.email
                              ) : (
                                <span className="font-sans font-semibold text-muted">
                                  {t("companyDiscovery.results.noEmail")}
                                </span>
                              )}
                            </dd>
                          </div>
                          <div className="min-w-0">
                            <dt className="text-[10px] font-bold tracking-wide text-faint uppercase">
                              {t("companyDiscovery.results.columns.source")}
                            </dt>
                            <dd className="mt-1 text-ink-soft">
                              {address
                                ? t(
                                    `companyDiscovery.results.emailSource.${address.sourceType}`,
                                  )
                                : "—"}
                            </dd>
                          </div>
                          <div className="min-w-0">
                            <dt className="text-[10px] font-bold tracking-wide text-faint uppercase">
                              {t("companyDiscovery.results.columns.sourceUrl")}
                            </dt>
                            <dd dir="ltr" className="mt-1 truncate text-ink-soft">
                              {address?.sourceUrl ? (
                                <a
                                  href={address.sourceUrl}
                                  target="_blank"
                                  rel="noopener noreferrer nofollow"
                                  title={address.sourceUrl}
                                  className="block truncate font-mono text-xs text-accent underline"
                                >
                                  {address.sourceUrl}
                                </a>
                              ) : (
                                "—"
                              )}
                            </dd>
                          </div>
                        </dl>
                      </article>
                    );
                  })}
                </div>

                <div className="mt-5 flex flex-wrap items-center gap-3">
                  <a
                    href={`/api/company-discovery/${run.runId}/export?lang=${lang}`}
                    className="btn-neon inline-flex h-10 items-center gap-2 rounded-2xl px-5 text-sm font-semibold text-white"
                  >
                    <Download size={15} strokeWidth={1.8} />
                    {t("companyDiscovery.results.download")}
                  </a>
                  <button
                    type="button"
                    onClick={onCreateCampaign}
                    disabled={selected.size === 0 || draftState?.status === "saving"}
                    className="inline-flex h-10 items-center gap-2 rounded-2xl border border-line bg-surface px-4 text-sm font-semibold text-ink transition hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {t("companyDiscovery.campaigns.create")}
                  </button>
                  <span className="text-xs font-medium text-muted">
                    {t("companyDiscovery.campaigns.selected", {
                      count: selected.size,
                    })}
                  </span>
                  {draftState?.status === "saved" && (
                    <Link
                      href={`/applications/new?draft=${draftState.draftId}&from=company-discovery`}
                      className="text-xs font-semibold text-accent underline"
                    >
                      {t("companyDiscovery.campaigns.open")}
                    </Link>
                  )}
                </div>
                {draftState?.status === "error" && (
                  <p className="mt-3 rounded-2xl bg-danger-soft px-4 py-2.5 text-sm font-semibold text-danger">
                    {t(draftState.key)}
                  </p>
                )}
                {draftState?.status === "saved" && !draftState.linked && (
                  <p className="mt-3 rounded-2xl bg-warning-soft px-4 py-2.5 text-xs leading-5 text-warning">
                    {t("companyDiscovery.campaigns.linkPending")}
                  </p>
                )}
              </>
            )}
          </div>

          <button
            type="button"
            onClick={reset}
            className="mt-6 inline-flex h-10 items-center rounded-2xl border border-line bg-surface px-4 text-sm font-semibold text-ink transition hover:bg-surface-2"
          >
            {t("companyDiscovery.runCreated.newSearch")}
          </button>
        </GlassCard>

        {/* The history lives below the result: creating a campaign from this
            very result must show up here immediately (server round trip). */}
        <CampaignsPanel campaigns={campaigns} t={t} lang={lang} />
      </div>
    );
  }

  // ===========================================================================
  // Idle / submitting — the search form
  // ===========================================================================
  return (
    <div className="mx-auto max-w-5xl">
      {backLink}
      <div className="mt-3 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="display-title text-3xl text-ink sm:text-4xl">
            {t("companyDiscovery.title")}
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">
            {t("companyDiscovery.subtitle")}
          </p>
        </div>
        <div className="hidden shrink-0 sm:block">
          <SearchOrb active={false} size={110} />
        </div>
      </div>
      <p className="mt-3 rounded-2xl bg-surface-2/70 px-4 py-3 text-xs leading-5 text-ink-soft">
        {t("companyDiscovery.intro")}
      </p>

      <form
        onSubmit={onSubmit}
        noValidate
        className="surface-elevated mt-5 rounded-3xl p-4 anim-fade-up sm:p-7"
      >
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          {/* Field */}
          <div>
            <label htmlFor="cd-field" className={labelClass}>
              {t("companyDiscovery.form.field")}
            </label>
            <input
              id="cd-field"
              list="cd-field-suggestions"
              value={field}
              onChange={(e) => setField(e.target.value)}
              placeholder={t("companyDiscovery.form.fieldPlaceholder")}
              className={inputClass}
              maxLength={120}
            />
            <datalist id="cd-field-suggestions">
              {DISCOVERY_FIELD_SUGGESTIONS.map((suggestion) => (
                <option key={suggestion} value={suggestion} />
              ))}
            </datalist>
            {errors.field && (
              <p className="mt-1.5 text-xs font-semibold text-danger">{errors.field}</p>
            )}
          </div>

          {/* Role */}
          <div>
            <label htmlFor="cd-role" className={labelClass}>
              {t("companyDiscovery.form.role")}
            </label>
            <input
              id="cd-role"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              placeholder={t("companyDiscovery.form.rolePlaceholder")}
              className={inputClass}
              maxLength={160}
            />
            {errors.role && (
              <p className="mt-1.5 text-xs font-semibold text-danger">{errors.role}</p>
            )}
          </div>

          {/* Beginn mode */}
          <div>
            <label htmlFor="cd-beginn-mode" className={labelClass}>
              {t("companyDiscovery.form.beginn")}
            </label>
            <select
              id="cd-beginn-mode"
              value={beginnMode}
              onChange={(e) => {
                setBeginnMode(e.target.value as BeginnMode);
                setBeginnValue("");
              }}
              className={inputClass}
            >
              {BEGINN_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {t(beginnLabelKey(mode))}
                </option>
              ))}
            </select>
          </div>

          {/* Beginn value (only for concrete modes) */}
          {beginnMode === "date" && (
            <div>
              <label htmlFor="cd-beginn-value" className={labelClass}>
                {t("companyDiscovery.form.beginn")}
              </label>
              <input
                id="cd-beginn-value"
                type="date"
                value={beginnValue}
                onChange={(e) => setBeginnValue(e.target.value)}
                className={inputClass}
              />
              {errors.beginn && (
                <p className="mt-1.5 text-xs font-semibold text-danger">{errors.beginn}</p>
              )}
            </div>
          )}
          {beginnMode === "month" && (
            <div>
              <label htmlFor="cd-beginn-value" className={labelClass}>
                {t("companyDiscovery.form.beginn")}
              </label>
              <input
                id="cd-beginn-value"
                type="month"
                value={beginnValue}
                onChange={(e) => setBeginnValue(e.target.value)}
                className={inputClass}
              />
              {errors.beginn && (
                <p className="mt-1.5 text-xs font-semibold text-danger">{errors.beginn}</p>
              )}
            </div>
          )}
          {beginnMode === "year" && (
            <div>
              <label htmlFor="cd-beginn-value" className={labelClass}>
                {t("companyDiscovery.form.beginn")}
              </label>
              <input
                id="cd-beginn-value"
                type="number"
                inputMode="numeric"
                min={2024}
                max={2100}
                placeholder="2027"
                value={beginnValue}
                onChange={(e) => setBeginnValue(e.target.value)}
                className={inputClass}
              />
              {errors.beginn && (
                <p className="mt-1.5 text-xs font-semibold text-danger">{errors.beginn}</p>
              )}
            </div>
          )}

          {/* Target companies */}
          <div>
            <label htmlFor="cd-target" className={labelClass}>
              {t("companyDiscovery.form.target")}
            </label>
            <input
              id="cd-target"
              type="number"
              inputMode="numeric"
              min={DISCOVERY_TARGET_MIN}
              max={DISCOVERY_TARGET_MAX}
              step={10}
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              className={inputClass}
            />
            <p className="mt-1.5 text-xs leading-5 text-muted">
              {t("companyDiscovery.form.targetHint")}
            </p>
            {errors.target && (
              <p className="mt-1.5 text-xs font-semibold text-danger">{errors.target}</p>
            )}
          </div>

          {/* Only public email */}
          <div className="sm:pt-7">
            <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-line bg-surface px-4 py-3 shadow-sm transition hover:border-line-strong">
              <input
                type="checkbox"
                checked={onlyPublicEmail}
                onChange={(e) => setOnlyPublicEmail(e.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 rounded accent-[var(--blue)]"
              />
              <span>
                <span className="block text-sm font-bold text-ink">
                  {t("companyDiscovery.form.onlyEmail")}
                </span>
                <span className="mt-0.5 block text-xs leading-5 text-muted">
                  {t("companyDiscovery.form.onlyEmailHint")}
                </span>
              </span>
            </label>
          </div>

          {/* Type */}
          <div className="sm:col-span-2">
            <span className={labelClass}>{t("companyDiscovery.form.type")}</span>
            <div className="flex flex-wrap gap-2">
              {GOALS.map((g) => (
                <label
                  key={g}
                  className={`cursor-pointer rounded-full border px-4.5 py-2 text-sm font-semibold transition ${
                    goal === g
                      ? "border-transparent bg-accent text-white shadow-[0_6px_16px_-6px_rgba(var(--glow-accent-rgb),0.5)]"
                      : "border-line-strong bg-surface text-ink-soft hover:border-faint hover:text-ink"
                  }`}
                >
                  <input
                    type="radio"
                    name="cd-goal"
                    value={g}
                    checked={goal === g}
                    onChange={() => setGoal(g)}
                    className="sr-only"
                  />
                  {t(goalLabelKey(g))}
                </label>
              ))}
            </div>
          </div>
        </div>

        {errors.submit && (
          <p className="mt-4 rounded-2xl bg-danger-soft px-4 py-2.5 text-sm font-semibold text-danger">
            {errors.submit}
          </p>
        )}

        <button
          type="submit"
          disabled={phase === "submitting"}
          className={`btn-neon mt-6 inline-flex h-12 w-full items-center justify-center gap-2 rounded-2xl px-6 text-sm font-bold text-white sm:w-auto ${
            phase === "submitting" ? "cursor-wait opacity-80" : ""
          }`}
        >
          <Search size={16} strokeWidth={2} />
          {phase === "submitting"
            ? t("companyDiscovery.form.searching")
            : t("companyDiscovery.form.search")}
        </button>
      </form>

      <CampaignsPanel campaigns={campaigns} t={t} lang={lang} />
    </div>
  );
}
