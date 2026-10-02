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
} from "react";
import { createDiscoveryDraftAction } from "@/app/company-discovery/actions";
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
  const tone =
    status === "completed"
      ? "bg-success-soft text-success"
      : status === "failed"
        ? "bg-danger-soft text-danger"
        : "bg-accent-soft text-accent";
  return (
    <span className={`rounded-lg px-2.5 py-1 text-xs font-bold uppercase ${tone}`}>
      {t(`companyDiscovery.status.${status}`)}
    </span>
  );
}

/**
 * The six REAL counters, shared by the running panel and the finished card.
 * A source can be `running` (queried right now), `unavailable` (it failed —
 * the run continues honestly without inventing rows) or `ok`.
 */
function RunCounters({ run, t }: { run: DiscoveryRun; t: TranslateFn }) {
  const source = run.progress.sources[0];
  const sourceLabel = !source
    ? "—"
    : source.status === "running"
      ? t("companyDiscovery.runCreated.sourceSearching")
      : source.status === "unavailable"
        ? t("companyDiscovery.runCreated.sourceUnavailable")
        : t("companyDiscovery.runCreated.sourceOk");
  return (
    <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
      <div className="rounded-xl bg-surface-2 p-3">
        <dd className="text-xl font-bold text-ink">
          {run.progress.foundCompanies}
          <span className="text-sm font-semibold text-muted">
            {" "}
            / {run.progress.targetCompanies}
          </span>
        </dd>
        <dt className="mt-0.5 text-xs font-semibold text-muted">
          {t("companyDiscovery.runCreated.found")}
        </dt>
      </div>
      <div className="rounded-xl bg-surface-2 p-3">
        <dd className="text-xl font-bold text-ink">{run.progress.offersAnalyzed}</dd>
        <dt className="mt-0.5 text-xs font-semibold text-muted">
          {t("companyDiscovery.runCreated.offers")}
        </dt>
      </div>
      <div className="rounded-xl bg-surface-2 p-3">
        <dd className="text-xl font-bold text-ink">{run.progress.uniqueCompanies}</dd>
        <dt className="mt-0.5 text-xs font-semibold text-muted">
          {t("companyDiscovery.runCreated.unique")}
        </dt>
      </div>
      <div className="rounded-xl bg-surface-2 p-3">
        <dd className="text-xl font-bold text-ink">{run.progress.duplicatesRemoved}</dd>
        <dt className="mt-0.5 text-xs font-semibold text-muted">
          {t("companyDiscovery.runCreated.duplicates")}
        </dt>
      </div>
      <div className="rounded-xl bg-surface-2 p-3">
        <dd className="text-xl font-bold text-ink">{run.progress.companiesRejected}</dd>
        <dt className="mt-0.5 text-xs font-semibold text-muted">
          {t("companyDiscovery.runCreated.rejected")}
        </dt>
      </div>
      {/* The three outcome counters of §4.8. `sourcesBlocked` is deliberately a
          separate tile: a blocked source is NOT "no public email". */}
      <div className="rounded-xl bg-surface-2 p-3">
        <dd className="text-xl font-bold text-ink">{run.progress.emailsFound}</dd>
        <dt className="mt-0.5 text-xs font-semibold text-muted">
          {t("companyDiscovery.runCreated.emailsFound")}
        </dt>
      </div>
      <div className="rounded-xl bg-surface-2 p-3">
        <dd className="text-xl font-bold text-ink">{run.progress.noPublicEmail}</dd>
        <dt className="mt-0.5 text-xs font-semibold text-muted">
          {t("companyDiscovery.runCreated.noPublicEmail")}
        </dt>
      </div>
      <div className="rounded-xl bg-surface-2 p-3">
        <dd className="text-xl font-bold text-ink">{run.progress.sourcesBlocked}</dd>
        <dt className="mt-0.5 text-xs font-semibold text-muted">
          {t("companyDiscovery.runCreated.sourcesBlocked")}
        </dt>
      </div>
      <div className="rounded-xl bg-surface-2 p-3">
        <dd className="text-sm font-bold text-ink sm:mt-1">{sourceLabel}</dd>
        <dt className="mt-0.5 text-xs font-semibold text-muted">
          {t("companyDiscovery.runCreated.source")}
        </dt>
      </div>
    </dl>
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

/** Badge tones per outcome — a block is a warning, not a failure. */
const EMAIL_STATUS_TONE: Record<EmailStatusValue, string> = {
  email_found: "bg-accent-soft text-accent",
  no_public_email: "bg-surface-2 text-muted",
  source_blocked: "bg-surface-2 text-warning",
  unverified_legacy: "bg-surface-2 text-muted",
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
    <section className="mt-6 rounded-2xl border border-line bg-surface p-4 sm:p-5">
      <h2 className="text-sm font-bold text-ink">
        {t("companyDiscovery.campaigns.title")}
      </h2>
      {campaigns.length === 0 ? (
        <p className="mt-2 text-xs leading-5 text-muted">
          {t("companyDiscovery.campaigns.empty")}
        </p>
      ) : (
        <ul className="mt-2 divide-y divide-line">
          {campaigns.map((campaign) => (
            <li
              key={campaign.campaignId || campaign.draftId}
              className="flex flex-wrap items-center justify-between gap-3 py-3"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-ink">
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
                    className="mt-0.5 truncate font-mono text-xs text-ink-soft"
                  >
                    {t("companyDiscovery.campaigns.run")}:{" "}
                    {campaign.discoveryRunId}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="rounded-lg bg-accent-soft px-2.5 py-1 text-xs font-bold text-accent">
                  {t(`companyDiscovery.campaigns.status.${campaign.status}`)}
                </span>
                <Link
                  href={
                    campaign.campaignId
                      ? `/applications/campaign/${campaign.campaignId}`
                      : `/applications/new?draft=${campaign.draftId}&from=company-discovery`
                  }
                  className="rounded-xl border border-line px-3 py-1.5 text-xs font-semibold text-ink transition hover:bg-surface-2"
                >
                  {t("companyDiscovery.campaigns.open")}
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
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
    "w-full rounded-xl border border-line bg-surface px-3 py-2.5 text-sm text-ink outline-none focus:border-accent";
  const labelClass = "mb-1.5 block text-xs font-semibold text-muted";
  /** Back to the dashboard — present in EVERY state of this page. */
  const backLink = (
    <Link
      href="/dashboard"
      className="inline-flex items-center text-xs font-semibold text-muted transition hover:text-ink"
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
    return (
      <div className="mx-auto max-w-3xl">
        {backLink}
        <div className="mt-4 rounded-2xl border border-line bg-surface p-5 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-bold text-ink">
              {t("companyDiscovery.progress.title")}
            </h2>
            <RunStatusBadge status={run.status} t={t} />
          </div>
          {run.status === "pending" && (
            <p className="mt-2 text-xs leading-5 text-muted">
              {t("companyDiscovery.progress.pending")}
            </p>
          )}

          <RunCounters run={run} t={t} />

          <p className="mt-3 truncate font-mono text-xs text-ink-soft">
            {t("companyDiscovery.runCreated.runId")}: {run.runId}
          </p>
          <p className="mt-4 rounded-xl bg-surface-2 px-3 py-2.5 text-xs leading-5 text-ink-soft">
            {t("companyDiscovery.progress.note")}
          </p>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={onStop}
              disabled={stopping}
              className="rounded-xl border border-line px-4 py-2 text-sm font-semibold text-ink transition hover:bg-surface-2 disabled:cursor-wait disabled:opacity-60"
            >
              {stopping
                ? t("companyDiscovery.form.stopping")
                : t("companyDiscovery.form.stop")}
            </button>
            <p className="text-xs leading-5 text-muted">
              {t("companyDiscovery.progress.stopNote")}
            </p>
          </div>

          {stopError && (
            <p className="mt-3 rounded-xl bg-danger-soft px-3 py-2 text-sm font-semibold text-danger">
              {stopError}
            </p>
          )}

          {pollExpired && (
            <div className="mt-4 rounded-xl bg-surface-2 px-3 py-2.5">
              <p className="text-xs leading-5 text-ink-soft">
                {t("companyDiscovery.progress.keepOpen")}
              </p>
              <button
                type="button"
                onClick={refresh}
                className="mt-2 rounded-xl border border-line px-3 py-1.5 text-xs font-semibold text-ink transition hover:bg-surface"
              >
                {t("companyDiscovery.progress.refresh")}
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ===========================================================================
  // Finished run (honest state — every number comes from the run)
  // ===========================================================================
  if (phase === "created" && run) {
    return (
      <div className="mx-auto max-w-3xl">
        {backLink}
        <div className="mt-4 rounded-2xl border border-line bg-surface p-5 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-bold text-ink">
              {t("companyDiscovery.runCreated.title")}
            </h2>
            <RunStatusBadge status={run.status} t={t} />
          </div>

          {/* Real run counters — measured by the engine, never simulated. */}
          <RunCounters run={run} t={t} />

          <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
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
            <p className="mt-4 rounded-xl bg-accent-soft px-3 py-2.5 text-xs leading-5 text-accent">
              {t("companyDiscovery.progress.stopNote")}
            </p>
          )}

          <p className="mt-4 rounded-xl bg-surface-2 px-3 py-2.5 text-xs leading-5 text-ink-soft">
            {t("companyDiscovery.runCreated.resultsNote")}
          </p>

          {/* ---- Public emails (only what was actually published) ---------- */}
          <div className="mt-5 border-t border-line pt-4">
            <h3 className="text-sm font-bold text-ink">
              {t("companyDiscovery.results.title")}
            </h3>
            {acceptedCompanies.length === 0 ? (
              <p className="mt-2 rounded-xl bg-surface-2 px-3 py-2.5 text-xs leading-5 text-ink-soft">
                {t("companyDiscovery.results.empty")}
              </p>
            ) : (
              <>
                <p className="mt-1 text-xs leading-5 text-muted">
                  {t("companyDiscovery.results.selectHint")}
                </p>
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full min-w-[52rem] border-collapse text-sm">
                    <thead>
                      <tr className="text-xs uppercase text-muted">
                        <th className="w-8 py-2 pe-2" />
                        <th className="py-2 pe-3 text-start">
                          {t("companyDiscovery.results.columns.company")}
                        </th>
                        <th className="py-2 pe-3 text-start">
                          {t("companyDiscovery.results.columns.role")}
                        </th>
                        <th className="py-2 pe-3 text-start">
                          {t("companyDiscovery.results.columns.city")}
                        </th>
                        <th className="py-2 pe-3 text-start">
                          {t("companyDiscovery.results.columns.email")}
                        </th>
                        <th className="py-2 pe-3 text-start">
                          {t("companyDiscovery.results.columns.source")}
                        </th>
                        <th className="py-2 pe-3 text-start">
                          {t("companyDiscovery.results.columns.sourceUrl")}
                        </th>
                        <th className="py-2 text-start">
                          {t("companyDiscovery.results.columns.status")}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {acceptedCompanies.map((company) => {
                        const address = pickEligibleEmail(company);
                        return (
                          <tr key={company.companyId} className="border-t border-line">
                            <td className="py-2 pe-2">
                              {address && (
                                <input
                                  type="checkbox"
                                  checked={selected.has(company.companyId)}
                                  onChange={() => toggle(company.companyId)}
                                  aria-label={company.companyName}
                                />
                              )}
                            </td>
                            <td className="py-2 pe-3 font-semibold text-ink">
                              {company.companyName}
                            </td>
                            <td className="py-2 pe-3 text-ink-soft">
                              {company.role ?? "—"}
                            </td>
                            <td className="py-2 pe-3 text-ink-soft">
                              {company.city ?? "—"}
                            </td>
                            <td dir="ltr" className="py-2 pe-3 font-mono text-xs">
                              {address ? (
                                address.email
                              ) : (
                                <span className="font-sans font-semibold text-muted">
                                  {t("companyDiscovery.results.noEmail")}
                                </span>
                              )}
                            </td>
                            <td className="py-2 pe-3 text-xs text-ink-soft">
                              {address
                                ? t(
                                    `companyDiscovery.results.emailSource.${address.sourceType}`,
                                  )
                                : "—"}
                            </td>
                            <td className="max-w-[16rem] py-2 pe-3 text-xs">
                              {address?.sourceUrl ? (
                                <a
                                  href={address.sourceUrl}
                                  target="_blank"
                                  rel="noopener noreferrer nofollow"
                                  title={address.sourceUrl}
                                  dir="ltr"
                                  className="block truncate text-accent underline"
                                >
                                  {address.sourceUrl}
                                </a>
                              ) : (
                                "—"
                              )}
                            </td>
                            <td className="py-2 text-xs">
                               {(() => {
                                 // ONE derived token for the whole row: a
                                 // legacy address reports `unverified_legacy`
                                 // right in the badge, exactly like the Excel
                                 // export — no second, divergent label.
                                 const status = emailStatusOf(company, address);
                                 return (
                                   <span
                                     className={`inline-flex w-fit rounded-lg px-2 py-0.5 font-bold ${EMAIL_STATUS_TONE[status]}`}
                                     title={
                                       company.rejectReason ??
                                       address?.verificationMethod ??
                                       undefined
                                     }
                                   >
                                     {t(`companyDiscovery.results.emailStatus.${status}`)}
                                   </span>
                                 );
                               })()}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <a
                    href={`/api/company-discovery/${run.runId}/export?lang=${lang}`}
                    className="rounded-xl bg-navy px-4 py-2 text-sm font-semibold text-white transition hover:bg-accent"
                  >
                    {t("companyDiscovery.results.download")}
                  </a>
                  <button
                    type="button"
                    onClick={onCreateCampaign}
                    disabled={selected.size === 0 || draftState?.status === "saving"}
                    className="rounded-xl border border-line px-4 py-2 text-sm font-semibold text-ink transition hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {t("companyDiscovery.campaigns.create")}
                  </button>
                  <span className="text-xs text-muted">
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
                  <p className="mt-3 rounded-xl bg-danger-soft px-3 py-2 text-sm font-semibold text-danger">
                    {t(draftState.key)}
                  </p>
                )}
                {draftState?.status === "saved" && !draftState.linked && (
                  <p className="mt-3 rounded-xl bg-surface-2 px-3 py-2 text-xs leading-5 text-warning">
                    {t("companyDiscovery.campaigns.linkPending")}
                  </p>
                )}
              </>
            )}
          </div>

          <button
            type="button"
            onClick={reset}
            className="mt-4 rounded-xl border border-line px-4 py-2 text-sm font-semibold text-ink transition hover:bg-surface-2"
          >
            {t("companyDiscovery.runCreated.newSearch")}
          </button>
        </div>

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
    <div className="mx-auto max-w-3xl">
      {backLink}
      <h1 className="mt-3 text-xl font-bold text-ink sm:text-2xl">
        {t("companyDiscovery.title")}
      </h1>
      <p className="mt-2 text-sm leading-6 text-muted">
        {t("companyDiscovery.subtitle")}
      </p>
      <p className="mt-2 rounded-xl bg-surface-2 px-3 py-2.5 text-xs leading-5 text-ink-soft">
        {t("companyDiscovery.intro")}
      </p>

      <form
        onSubmit={onSubmit}
        noValidate
        className="mt-5 rounded-2xl border border-line bg-surface p-4 sm:p-5"
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
              <p className="mt-1 text-xs font-semibold text-danger">{errors.field}</p>
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
              <p className="mt-1 text-xs font-semibold text-danger">{errors.role}</p>
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
                <p className="mt-1 text-xs font-semibold text-danger">{errors.beginn}</p>
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
                <p className="mt-1 text-xs font-semibold text-danger">{errors.beginn}</p>
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
                <p className="mt-1 text-xs font-semibold text-danger">{errors.beginn}</p>
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
            <p className="mt-1 text-xs leading-5 text-muted">
              {t("companyDiscovery.form.targetHint")}
            </p>
            {errors.target && (
              <p className="mt-1 text-xs font-semibold text-danger">{errors.target}</p>
            )}
          </div>

          {/* Only public email */}
          <div className="sm:pt-6">
            <label className="flex cursor-pointer items-start gap-2.5 rounded-xl bg-surface-2 px-3 py-2.5">
              <input
                type="checkbox"
                checked={onlyPublicEmail}
                onChange={(e) => setOnlyPublicEmail(e.target.checked)}
                className="mt-0.5 h-4 w-4"
              />
              <span>
                <span className="block text-sm font-semibold text-ink">
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
                  className={`cursor-pointer rounded-xl border px-3.5 py-2 text-sm font-semibold transition ${
                    goal === g
                      ? "border-accent bg-accent-soft text-accent"
                      : "border-line bg-surface text-ink-soft hover:bg-surface-2"
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
          <p className="mt-3 rounded-xl bg-danger-soft px-3 py-2 text-sm font-semibold text-danger">
            {errors.submit}
          </p>
        )}

        <button
          type="submit"
          disabled={phase === "submitting"}
          className={`mt-5 w-full rounded-xl px-5 py-3 text-sm font-semibold text-white transition sm:w-auto ${
            phase === "submitting"
              ? "cursor-wait bg-accent"
              : "bg-navy hover:bg-accent disabled:opacity-60"
          }`}
        >
          {phase === "submitting"
            ? t("companyDiscovery.form.searching")
            : t("companyDiscovery.form.search")}
        </button>
      </form>

      <CampaignsPanel campaigns={campaigns} t={t} lang={lang} />
    </div>
  );
}
