"use client";

/**
 * Bewerbung Automation — the five-step client.
 *
 * State flow (server is the source of truth for everything that matters):
 *
 *   setup → 1 companies → 2 documents → 3 generate → 4 review → 5 send
 *
 * The client only ever READS the campaign view (initial RSC prop, then the
 * `bewGetView` poll while sending) and issues explicit user actions. Nothing
 * on this page sends e-mail until the user confirms step 5 — generation and
 * page opens are strictly side-effect free with respect to delivery.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  bewCancelSend,
  bewCreateCampaignView,
  bewGetView,
  bewRefreshSend,
} from "@/app/bewerbung-automation/actions";
import { useI18n } from "@/lib/i18n";
import {
  BEW_MAX_COUNT,
  BEW_MIN_COUNT,
  isValidEmail,
  type BewPurpose,
} from "@/lib/bewerbung-automation";
import { Card } from "@/components/ui";
import { GradientMesh } from "@/components/ui/surfaces";
import { QuotaIndicator, makeQuotaLabels } from "@/components/quota-indicator";
import { Icon } from "@/components/icon";
import {
  appSendFlags,
  hasRequiredDocuments,
  isNextRedirectError,
  resolveBewError,
  type BewApplicationDTO,
  type BewViewDTO,
  type Step,
} from "./types";
import { appendRowToView } from "./smart-input-state";
import { CompaniesStep } from "./companies-step";
import { DocumentsStep } from "./documents-step";
import { GenerateStep } from "./generate-step";
import { ReviewStep } from "./review-step";
import { SendStep } from "./send-step";

const STEPS: Step[] = [1, 2, 3, 4, 5];

interface Props {
  schemaOk: boolean;
  initialView: BewViewDTO | null;
  /**
   * True when the SERVER-SIDE initial load failed (DB/network error): the
   * page must then show an actionable retry state — NEVER the "no series"
   * empty state (an error is not an empty result). The empty state is
   * rendered only when the query SUCCEEDED and returned no campaign.
   */
  initialLoadError: boolean;
  userName: string;
  userEmail: string;
}

/** Step 2 gate: a CV + at least one certificate/supporting document. */
function documentsReady(view: BewViewDTO | null): boolean {
  if (!view) return false;
  const docs = view.documents;
  return (
    docs.some((d) => d.kind === "cv") &&
    docs.some((d) => d.kind === "certificate" || d.kind === "supporting")
  );
}

/**
 * A stored row counts as a valid company when it carries a non-empty name
 * AND a structurally valid recipient address (the exact rule the step UI
 * applies per row). Excluded/cancelled rows never count.
 */
export function isCompanyRowComplete(app: {
  status: string;
  company_name: string;
  company_email: string;
}): boolean {
  if (app.status === "excluded" || app.status === "cancelled") return false;
  return (
    (app.company_name ?? "").trim().length > 0 && isValidEmail(app.company_email ?? "")
  );
}

/**
 * Step 1 gate: at least one fully valid company record.
 *
 * Derived from the APPLICATION ROWS — the source of truth — and NOT from the
 * denormalized `campaign.valid_count` column: that column was silently left
 * at 0 after a company import (a broken DB trigger made every campaign UPDATE
 * fail and the engine swallowed the error), which locked the wizard here with
 * no visible way to advance. Counters may lag or drift; the rows cannot.
 */
function companiesReady(view: BewViewDTO | null): boolean {
  if (!view) return false;
  return view.applications.some(isCompanyRowComplete);
}

/** Step 4/5 gate: generation has finished (nothing pending/generating) and at
 *  least one application reached a post-generation state. Failed letters do
 *  NOT block review — the user can retry only those from step 3. */
function lettersReady(view: BewViewDTO | null): boolean {
  if (!view) return false;
  const open = view.applications.filter(
    (a) => a.status !== "excluded" && a.status !== "cancelled",
  );
  if (open.length === 0) return false;
  const inProgress = open.some(
    (a) => a.status === "pending" || a.status === "generating",
  );
  if (inProgress) return false;
  return open.some((a) =>
    ["generated", "sent", "queued", "sending", "needs_attention", "failed"].includes(a.status),
  );
}

export function BewerbungAutomation({
  schemaOk,
  initialView,
  initialLoadError,
  userName,
  userEmail,
}: Props) {
  const { t } = useI18n();
  const router = useRouter();
  const [view, setView] = useState<BewViewDTO | null>(initialView);
  const [step, setStep] = useState<Step>(1);
  const [error, setError] = useState<string | null>(null);

  /* First-series creation (the ONLY creation entry point on this page —
     the three-dot series menu was removed on 2026-10-20). The form renders
     ONLY in the verified no-series state (the initial query succeeded and
     found no campaign); a page load never auto-creates — creation happens
     exclusively on an explicit submit, through the server action
     `bewCreateCampaignView` (validated + persisted server-side). The
     CompaniesStep `creatingSeries` / `seriesConfirmation` props stay
     defensive and inert. */
  const [count, setCount] = useState("10");
  const [purpose, setPurpose] = useState<BewPurpose>("ausbildung");
  const [positionTitle, setPositionTitle] = useState("");
  const [creatingSeries, setCreatingSeries] = useState(false);
  const countNum = Number(count);
  const countOk =
    Number.isInteger(countNum) && countNum >= BEW_MIN_COUNT && countNum <= BEW_MAX_COUNT;
  const submitCreateSeries = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      if (!countOk || creatingSeries) return; // the server re-checks 1..100
      const fd = new FormData();
      fd.set("count", String(countNum));
      fd.set("purpose", purpose);
      if (positionTitle.trim()) fd.set("positionTitle", positionTitle.trim());
      void (async () => {
        setCreatingSeries(true);
        setError(null);
        try {
          // Create + return the fresh, PERSISTED view in one action (the
          // returned view is the server truth of the brand-new series).
          const fresh = await bewCreateCampaignView(fd);
          if (fresh) setView(fresh);
        } catch (e) {
          // Actionable failure message (localized error code, or the
          // session-expiry navigation) — never a silent empty state.
          setError(resolveBewError(e, t, (p) => router.replace(p)));
        } finally {
          setCreatingSeries(false);
        }
      })();
    },
    [countOk, countNum, purpose, positionTitle, creatingSeries, t, router],
  );

  /* Latest view for the STABLE callbacks (refresh/pump/patch) — a callback
     that depends on `view` would be recreated on every poll and re-render
     every (memoized) step. */
  const viewRef = useRef(view);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  /* Send selection: everything ELIGIBLE is selected by default; the user can
     opt rows out (checkbox) or they drop out automatically when they become
     ineligible. We store the Deselected ids so a fresh poll can re-add rows. */
  const [deselected, setDeselected] = useState<Set<string>>(new Set());
  const selectedIds = useMemo(() => {
    if (!view) return new Set<string>();
    const docs = hasRequiredDocuments(view.documents);
    const set = new Set<string>();
    for (const app of view.applications) {
      const eligible =
        appSendFlags(app).length === 0 && docs.cv && docs.certs;
      if (eligible && !deselected.has(app.id)) set.add(app.id);
    }
    return set;
  }, [view, deselected]);
  const toggleSelect = useCallback((id: string, selected: boolean) => {
    setDeselected((prev) => {
      const next = new Set(prev);
      if (selected) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /** Fresh campaign view (the caller may use the returned server truth;
   *  the displayed view is updated as a side effect). */
  const refresh = useCallback(async (): Promise<BewViewDTO | null> => {
    const current = viewRef.current;
    if (!current) return null;
    const fresh = await bewGetView(current.campaign.id);
    if (fresh) setView(fresh);
    return fresh;
  }, []);

  /**
   * Append ONE persisted application row to the view (the smart-input
   * "Auto-organize" success path). The row comes back from the server
   * action (already validated + persisted); the counters are re-derived
   * from the rows with the SAME rule the engine uses, so the header and
   * the step-1→2 gate react immediately. Other rows keep their exact
   * references (memoized rows are untouched). A later `refresh()`
   * converges the view to the server truth.
   */
  const appendApplication = useCallback((dto: BewApplicationDTO) => {
    setView((v) => (v ? appendRowToView(v, dto) : v));
  }, []);

  /* Step-5 pump: fresh view + one bounded drain of THIS campaign's due
      queue (the same atomic claim core the cron tick uses — nothing sends
      before its due instant, and overlapping drivers cannot double-send).
      Returns true when a fresh view was received (false = not found /
      not owned — the displayed view is left untouched). */
  const pump = useCallback(async (): Promise<boolean> => {
    const current = viewRef.current;
    if (!current) return false;
    const fresh = await bewRefreshSend(current.campaign.id);
    if (fresh) setView(fresh);
    return Boolean(fresh);
  }, []);

  /**
   * Apply fields to ONE application row in the current view (the
   * Companies step's optimistic / confirmed / rollback row patches).
   * Rows the view no longer contains are skipped (no-op) — the caller
   * detects that and resyncs if needed.
   */
  const patchApplication = useCallback((appId: string, fields: Partial<BewApplicationDTO>) => {
    setView((v) => {
      if (!v) return v;
      return {
        ...v,
        applications: v.applications.map((a) => (a.id === appId ? { ...a, ...fields } : a)),
      };
    });
  }, []);

  /* Poll (and CONTINUE) the send every 3 s while it is in flight. The
      browser is one of the concurrent drivers — the server action runs the
      same bounded, SKIP-LOCKED drain the cron tick does, so a scheduled
      batch that is now due is released at the due instant (the Actions
      cron runs at an irregular cadence and is only the durable fallback),
      and the remainder of an immediate send keeps flowing while the user
      is here. The engine's atomic claims keep all drivers safe. */
  const campaignId = view?.campaign.id ?? null;
  const sending = view?.campaign.status === "sending";
  useEffect(() => {
    if (!campaignId || !sending) return;
    const id = setInterval(() => {
      bewRefreshSend(campaignId)
        .then((fresh) => {
          if (fresh) setView(fresh);
        })
        .catch((e) => {
          // A silent poll must not mask an expired session: when the action
          // asked for re-authentication, navigate (the page state is stale
          // anyway) instead of swallowing the error forever.
          if (isNextRedirectError(e)) router.replace("/login");
        });
    }, 3000);
    return () => clearInterval(id);
  }, [campaignId, sending, router]);

  const run = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T | null> => {
      setError(null);
      try {
        return await fn();
      } catch (e) {
        // `null` = the session expired mid-flow: the user is navigated to
        // /login and NOTHING is shown (re-authentication is not an operation
        // failure — the generic message was part of the recurring bug).
        const message = resolveBewError(e, t, (p) => router.replace(p));
        if (message !== null) setError(message);
        return null;
      }
    },
    [t, router],
  );

  const cancelCurrentSend = useCallback(
    () =>
      run(async () => {
        const current = viewRef.current;
        if (!current) return null;
        const fd = new FormData();
        fd.set("campaignId", current.campaign.id);
        const result = await bewCancelSend(fd);
        await refresh();
        return result;
      }),
    [run, refresh],
  );

  const goToDocuments = useCallback(() => setStep(2), []);

  /* ---------------------------------------------------------------- */

  if (!schemaOk) {
    return (
      <div className="relative mx-auto max-w-3xl px-4 py-6">
        <GradientMesh />
        <Card className="relative p-5 text-center sm:p-6">
          <h1 className="text-xl font-bold text-ink">{t("bewauto.title")}</h1>
          <p className="mt-3 text-sm leading-6 text-muted">
            {t("bewauto.schemaPending")}
          </p>
        </Card>
      </div>
    );
  }

  /* -------- initial load FAILED --------
     A failed query is NOT an empty result: show an actionable retry state
     (the data may exist — the read simply did not succeed). */
  if (initialLoadError && !view) {
    return (
      <div className="relative mx-auto max-w-3xl px-4 py-6">
        <GradientMesh />
        <Card className="relative p-5 sm:p-6">
          <h1 className="text-2xl font-extrabold tracking-tight text-ink">
            {t("bewauto.title")}
          </h1>
          <p className="mt-3 text-sm font-semibold text-danger">
            {t("bewauto.loadErrorTitle")}
          </p>
          <p className="mt-2 text-sm leading-6 text-muted">
            {t("bewauto.loadErrorBody")}
          </p>
          <button
            type="button"
            onClick={() => router.refresh()}
            className="mt-4 rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90"
          >
            {t("bewauto.retry")}
          </button>
        </Card>
      </div>
    );
  }

  /* -------- no series yet (query SUCCEEDED, genuinely none) --------
     The creation form: the only series-creation entry point on this page.
     A page load never auto-creates — the series is created only on an
     explicit submit (server-validated, server-persisted). */
  if (!view) {
    return (
      <div className="relative mx-auto max-w-3xl px-4 py-6">
        <GradientMesh />
        <Card className="relative p-5 sm:p-6">
          <h1 className="text-2xl font-extrabold tracking-tight text-ink">
            {t("bewauto.title")}
          </h1>
          <p className="mt-3 text-sm leading-6 text-muted">
            {t("bewauto.setupBody")} {userName}
          </p>
          <form onSubmit={submitCreateSeries} className="mt-5 grid gap-4">
            <div>
              <label
                htmlFor="bew-count"
                className="block text-xs font-bold uppercase tracking-[0.12em] text-faint"
              >
                {t("bewauto.countQuestion")}
              </label>
              <input
                id="bew-count"
                type="number"
                min={BEW_MIN_COUNT}
                max={BEW_MAX_COUNT}
                step={1}
                value={count}
                onChange={(e) => setCount(e.target.value)}
                required
                className={`mt-1.5 w-full rounded-xl border bg-surface-2 px-3 py-2 text-sm text-ink outline-none transition focus:border-accent ${countOk ? "border-line-strong" : "border-danger"}`}
              />
              <p className="mt-1 text-xs text-muted">{t("bewauto.countHint")}</p>
              {!countOk && (
                <p className="mt-1 text-xs font-semibold text-danger">
                  {t("bewauto.countError")}
                </p>
              )}
            </div>
            <div>
              <label
                htmlFor="bew-purpose"
                className="block text-xs font-bold uppercase tracking-[0.12em] text-faint"
              >
                {t("bewauto.purposeLabel")}
              </label>
              <select
                id="bew-purpose"
                value={purpose}
                onChange={(e) => setPurpose(e.target.value as BewPurpose)}
                className="mt-1.5 w-full rounded-xl border border-line-strong bg-surface-2 px-3 py-2 text-sm text-ink outline-none transition focus:border-accent"
              >
                <option value="ausbildung">
                  {t("bewauto.purposeAusbildung")}
                </option>
                <option value="arbeit">{t("bewauto.purposeArbeit")}</option>
                <option value="praktikum">
                  {t("bewauto.purposePraktikum")}
                </option>
              </select>
            </div>
            <div>
              <label
                htmlFor="bew-position-title"
                className="block text-xs font-bold uppercase tracking-[0.12em] text-faint"
              >
                {t("bewauto.positionTitle")} · {t("bewauto.positionOptional")}
              </label>
              <input
                id="bew-position-title"
                type="text"
                value={positionTitle}
                onChange={(e) => setPositionTitle(e.target.value)}
                className="mt-1.5 w-full rounded-xl border border-line-strong bg-surface-2 px-3 py-2 text-sm text-ink outline-none transition focus:border-accent"
              />
              <p className="mt-1 text-xs text-muted">
                {t("bewauto.positionTitleHint")}
              </p>
            </div>
            {error && (
              <p className="text-sm font-semibold text-danger">{error}</p>
            )}
            <button
              type="submit"
              disabled={!countOk || creatingSeries}
              className="rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {creatingSeries ? t("bewauto.newSeriesCreating") : t("bewauto.setupStart")}
            </button>
          </form>
        </Card>
      </div>
    );
  }

  /* -------- campaign exists: stepper + current step -------- */
  const gates: Record<Step, boolean> = {
    1: true,
    2: companiesReady(view),
    3: documentsReady(view),
    4: lettersReady(view) || view.campaign.status === "sending" || view.campaign.sent_count > 0,
    5: lettersReady(view) || view.campaign.status === "sending" || view.campaign.sent_count > 0,
  };

  /** Exact reason the Companies step cannot advance right now (null = ready). */
  const companiesBlockedReason =
    view.campaign.status === "sending"
      ? t("bewauto.continueDocsLocked")
      : !gates[2]
        ? t("bewauto.continueDocsNoValid", {
            valid: view.applications.filter(isCompanyRowComplete).length,
            total: view.applications.length,
          })
        : null;

  return (
    <div className="relative mx-auto max-w-5xl px-4 py-6">
      <GradientMesh />
      <div className="relative">
        {/* Header row */}
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight text-ink">
              {t("bewauto.title")}
            </h1>
            <p className="mt-1 text-sm text-muted">
              {t("bewauto.campaignSummary", {
                sent: view.campaign.sent_count,
                failed: view.campaign.failed_count,
                total: view.campaign.total_count,
              })}
            </p>
          </div>
          <div className="flex items-center gap-3">
            {/* Shared green quota indicator (P0 quota audit): used/limit,
                remaining and the UTC reset label from the SERVER view —
                the old StatusPill only showed the remaining count and an
                arbitrary "unverified" tone below 10. Nulls = honest
                unknown state (never a fabricated 0). */}
            <QuotaIndicator
              data={{
                used:
                  view.usage.remaining !== null && view.usage.daily_limit !== null
                    ? view.usage.daily_limit - view.usage.remaining
                    : null,
                limit: view.usage.daily_limit,
                remaining: view.usage.remaining,
              }}
              unit={t("quota.unitEmails")}
              resetLabel={t("quota.resetsDaily")}
              labels={makeQuotaLabels(t)}
              upgradeHint={t("quota.upgrade")}
            />
            {/* No series management here on purpose: the primary entry point
                is the Smart Input on step 1, and series creation has no UI
                entry point on this page at all. */}
          </div>
        </div>

        {/* Stepper
            Phones (<sm): the five chips wrap 3 + 2 and stack the number
            ABOVE the label — five chips across clipped and overlapped
            labels like "Anschreiben" at 320 px. From sm up the classes
            (sm:grid-cols-5, sm:flex-row, sm:justify-center, sm:gap-0 +
            the span's sm:mr-1.5) reproduce the original five-across inline
            layout exactly; step order, gating and the desktop appearance
            are unchanged. */}
        <nav aria-label={t("bewauto.stepsAria")} className="mb-6">
          <ol className="grid grid-cols-3 gap-2 sm:grid-cols-5">
            {STEPS.map((s) => {
              const done = gates[s] && s < step;
              const active = s === step;
              return (
                <li key={s} className="min-w-0">
                  <button
                    type="button"
                    disabled={!gates[s]}
                    onClick={() => setStep(s)}
                    className={`flex min-w-0 w-full flex-col items-center gap-1.5 break-words rounded-2xl border px-1.5 py-2 text-center text-xs font-semibold transition sm:flex-row sm:justify-center sm:gap-0 sm:px-2 sm:py-2.5 sm:text-sm ${
                      active
                        ? "border-accent bg-accent-soft text-accent"
                        : done
                          ? "border-line-strong bg-surface text-ink-soft hover:border-faint"
                          : gates[s]
                            ? "border-line bg-surface/60 text-muted hover:border-line-strong"
                            : "cursor-not-allowed border-line bg-surface/40 text-faint"
                    }`}
                  >
                    <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface-2 text-[11px] font-bold sm:mr-1.5">
                      {s}
                    </span>
                    {t(`bewauto.step${s}`)}
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>

        {error && (
          <ErrorLine
            message={error}
            className="mb-4"
            onDismiss={() => setError(null)}
            dismissLabel={t("bewauto.dismissError")}
          />
        )}

        {/* Step 1 stays MOUNTED (hidden) while the user works on later steps:
            unsaved row edits and an in-flight import preview must survive the
            round trip back to Companies. (Memoized: it only re-renders when
            its own props change, not on every parent re-render.) */}
        <div className={step === 1 ? undefined : "hidden"}>
          <CompaniesStep
            view={view}
            refresh={refresh}
            onNext={goToDocuments}
            nextBlockedReason={companiesBlockedReason}
            /* Series creation is not possible from this page — the guards
               the step applies while a creation is in flight are inert. */
            creatingSeries={false}
            seriesConfirmation={null}
            patchApplication={patchApplication}
            appendApplication={appendApplication}
          />
        </div>
        {step === 2 && <DocumentsStep view={view} refresh={refresh} />}
        {step === 3 && <GenerateStep view={view} refresh={refresh} />}
        {/* Step 4 stays MOUNTED (hidden) like Step 1: the campaign e-mail
            draft (subject + body, until saved) must survive navigating to
            the Send step and back. */}
        <div className={step === 4 ? undefined : "hidden"}>
          <ReviewStep
            view={view}
            refresh={refresh}
            selectedIds={selectedIds}
            onToggle={toggleSelect}
            applicantName={userName}
            applicantEmail={userEmail}
          />
        </div>
        {step === 5 && (
          <SendStep
            view={view}
            refresh={refresh}
            pump={pump}
            selectedIds={selectedIds}
            onCancelSend={cancelCurrentSend}
            sending={sending}
          />
        )}

        <p className="mt-6 text-xs leading-5 text-faint">
          <Link href="/settings/email" className="underline decoration-line underline-offset-2 hover:text-muted">
            {t("bewauto.emailSettingsLink")}
          </Link>
        </p>
      </div>
    </div>
  );
}

// NOTE (P0 quota audit 2026-10-25): the old `usageTone` helper (success /
// unverified / blocked / neutral, with an arbitrary "warn below 10
// remaining" rule) was removed — quota state is now rendered by the shared
// QuotaIndicator, whose tone rules live in ONE place for all 13 surfaces.
// null = the quota read failed = the indicator's honest unknown state
// (never a fabricated 0 / blocked tone).

/**
 * The page-level error banner. Dismissible: an error that already happened
 * (the state it describes is gone) must not stay pinned above the workflow —
 * the previous permanent banner is half of the "persistent error message"
 * complaint. `onDismiss` is optional so other usages can render it read-only.
 */
export function ErrorLine({
  message,
  className = "",
  onDismiss,
  dismissLabel,
}: {
  message: string;
  className?: string;
  onDismiss?: () => void;
  dismissLabel?: string;
}) {
  return (
    <div
      role="alert"
      className={`flex items-start gap-2.5 rounded-2xl border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger ${className}`}
    >
      <Icon name="alert" size={16} className="mt-0.5 shrink-0" />
      <span className="min-w-0 flex-1">{message}</span>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={dismissLabel ?? "Dismiss"}
          className="-m-1 shrink-0 rounded-lg p-1 transition hover:bg-danger/10"
        >
          <Icon name="x" size={14} />
        </button>
      )}
    </div>
  );
}
