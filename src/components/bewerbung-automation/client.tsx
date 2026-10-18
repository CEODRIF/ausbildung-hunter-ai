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
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  bewCancelSend,
  bewCreateCampaign,
  bewGetView,
} from "@/app/bewerbung-automation/actions";
import { useI18n } from "@/lib/i18n";
import {
  BEW_MAX_COUNT,
  BEW_MIN_COUNT,
  isValidEmail,
} from "@/lib/bewerbung-automation";
import { Button, Card, Input, Textarea } from "@/components/ui";
import { GradientMesh } from "@/components/ui/surfaces";
import { StatusPill } from "@/components/ui/feedback";
import { Icon } from "@/components/icon";
import {
  appSendFlags,
  bewErrorCode,
  hasRequiredDocuments,
  type BewViewDTO,
  type Step,
} from "./types";
import { CompaniesStep } from "./companies-step";
import { DocumentsStep } from "./documents-step";
import { GenerateStep } from "./generate-step";
import { ReviewStep } from "./review-step";
import { SendStep } from "./send-step";

const STEPS: Step[] = [1, 2, 3, 4, 5];

interface Props {
  schemaOk: boolean;
  initialView: BewViewDTO | null;
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

export function BewerbungAutomation({ schemaOk, initialView, userName, userEmail }: Props) {
  const { t } = useI18n();
  const [view, setView] = useState<BewViewDTO | null>(initialView);
  const [step, setStep] = useState<Step>(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  // Setup form (only used while there is no campaign yet).
  const [count, setCount] = useState("10");
  const [purpose, setPurpose] = useState("ausbildung");
  const [positionTitle, setPositionTitle] = useState("");
  const [positionBrief, setPositionBrief] = useState("");
  const [employerFacts, setEmployerFacts] = useState("");

  const refresh = useCallback(async () => {
    if (!view) return;
    const fresh = await bewGetView(view.campaign.id);
    if (fresh) setView(fresh);
  }, [view]);

  /* Poll the view while a send is draining (the browser is just one of the
     concurrent drivers; the engine's atomic claims keep it safe). */
  const campaignId = view?.campaign.id ?? null;
  const sending = view?.campaign.status === "sending";
  useEffect(() => {
    if (!campaignId || !sending) return;
    const id = setInterval(() => {
      bewGetView(campaignId)
        .then((fresh) => {
          if (fresh) setView(fresh);
        })
        .catch(() => undefined);
    }, 3000);
    return () => clearInterval(id);
  }, [campaignId, sending]);

  const errText = useCallback(
    (e: unknown) => {
      const code = bewErrorCode(e);
      const key = `bewauto.err.${code}`;
      const translated = t(key);
      return translated === key ? t("bewauto.err.UNKNOWN") : translated;
    },
    [t],
  );

  async function run<T>(fn: () => Promise<T>): Promise<T | null> {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(errText(e));
      return null;
    } finally {
      setBusy(false);
    }
  }

  const createCampaign = () =>
    run(async () => {
      const fd = new FormData();
      fd.set("count", count);
      fd.set("purpose", purpose);
      fd.set("positionTitle", positionTitle);
      fd.set("positionBrief", positionBrief);
      fd.set("employerFacts", employerFacts);
      const result = await bewCreateCampaign(fd);
      if (result) {
        const fresh = await bewGetView(result.campaignId);
        if (fresh) setView(fresh);
        setDeselected(new Set());
        setStep(1);
        setCount("10");
        setPositionTitle("");
        setPositionBrief("");
        setEmployerFacts("");
      }
      return result;
    });

  const cancelCurrentSend = () =>
    run(async () => {
      if (!view) return null;
      const fd = new FormData();
      fd.set("campaignId", view.campaign.id);
      const result = await bewCancelSend(fd);
      await refresh();
      return result;
    });

  /* ---------------------------------------------------------------- */

  if (!schemaOk) {
    return (
      <div className="relative mx-auto max-w-3xl px-4 py-10">
        <GradientMesh />
        <Card className="relative p-5 text-center sm:p-8">
          <h1 className="text-xl font-bold text-ink">{t("bewauto.title")}</h1>
          <p className="mt-3 text-sm leading-6 text-muted">
            {t("bewauto.schemaPending")}
          </p>
        </Card>
      </div>
    );
  }

  /* -------- setup (no campaign yet) -------- */
  if (!view) {
    const countNum = Number(count);
    const countOk =
      Number.isInteger(countNum) &&
      countNum >= BEW_MIN_COUNT &&
      countNum <= BEW_MAX_COUNT;
    return (
      <div className="relative mx-auto max-w-3xl px-4 py-10">
        <GradientMesh />
        <Card className="relative p-5 sm:p-8">
          <h1 className="text-2xl font-extrabold tracking-tight text-ink">
            {t("bewauto.title")}
          </h1>
          <p className="mt-2 text-sm leading-6 text-muted">
            {t("bewauto.setupBody")} {userName}
          </p>

          <div className="mt-8 grid gap-6 sm:grid-cols-2">
            <Input
              id="bew-count"
              label={t("bewauto.countQuestion")}
              hint={t("bewauto.countHint")}
              type="number"
              min={BEW_MIN_COUNT}
              max={BEW_MAX_COUNT}
              step={1}
              value={count}
              error={count && !countOk ? t("bewauto.countError") : undefined}
              onChange={(e) => setCount(e.target.value)}
            />
            <label className="block">
              <span className="mb-2 block text-sm font-semibold text-ink-soft">
                {t("bewauto.purposeLabel")}
              </span>
              <select
                value={purpose}
                onChange={(e) => setPurpose(e.target.value)}
                className="h-12 w-full rounded-2xl border border-line-strong bg-surface px-3.5 text-base text-ink outline-none transition focus:border-accent focus:ring-4 focus:ring-accent/10 lg:text-sm"
              >
                <option value="ausbildung">{t("bewauto.purposeAusbildung")}</option>
                <option value="arbeit">{t("bewauto.purposeArbeit")}</option>
                <option value="praktikum">{t("bewauto.purposePraktikum")}</option>
              </select>
            </label>
          </div>

          <div className="mt-2 grid gap-4">
            <div className="text-sm font-semibold text-ink-soft">
              {t("bewauto.positionSection")}
            </div>
            <Input
              id="bew-position-title"
              label={`${t("bewauto.positionTitle")} · ${t("bewauto.positionOptional")}`}
              hint={t("bewauto.positionTitleHint")}
              value={positionTitle}
              onChange={(e) => setPositionTitle(e.target.value)}
            />
            <Textarea
              id="bew-position-brief"
              label={`${t("bewauto.positionBrief")} · ${t("bewauto.positionOptional")}`}
              hint={t("bewauto.positionBriefHint")}
              rows={3}
              /* 16 px on phones (iOS Safari zooms in on <16 px inputs).
                 The shared Textarea hard-codes text-sm; a plain text-base
                 here would LOSE the cascade (text-sm is emitted later in
                 the utility sheet), so the mobile-only max-sm variant —
                 emitted after both — wins below 640 px and desktop keeps
                 the component's original 14 px untouched. */
              className="max-sm:text-base"
              value={positionBrief}
              onChange={(e) => setPositionBrief(e.target.value)}
            />
            <Textarea
              id="bew-employer-facts"
              label={`${t("bewauto.employerFacts")} · ${t("bewauto.positionOptional")}`}
              hint={t("bewauto.employerFactsHint")}
              rows={2}
              className="max-sm:text-base"
              value={employerFacts}
              onChange={(e) => setEmployerFacts(e.target.value)}
            />
          </div>

          {error && <ErrorLine message={error} />}

          <div className="mt-8">
            <Button
              size="lg"
              disabled={busy || !countOk}
              onClick={() => void createCampaign()}
            >
              <Icon name="spark" size={18} />
              {t("bewauto.setupStart")}
            </Button>
          </div>
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
    <div className="relative mx-auto max-w-6xl px-4 py-8">
      <GradientMesh />
      <div className="relative">
        {/* Header row */}
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
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
            <StatusPill
              tone={usageTone(view)}
              label={t("bewauto.usageLeft", { n: view.usage.remaining })}
            />
            <Button variant="secondary" size="sm" onClick={() => void createCampaign()} disabled={busy}>
              <Icon name="plus" size={15} />
              {t("bewauto.newCampaign")}
            </Button>
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

        {error && <ErrorLine message={error} className="mb-4" />}

        {/* Step 1 stays MOUNTED (hidden) while the user works on later steps:
            unsaved row edits and an in-flight import preview must survive the
            round trip back to Companies. */}
        <div className={step === 1 ? undefined : "hidden"}>
          <CompaniesStep
            view={view}
            refresh={refresh}
            onNext={() => setStep(2)}
            nextBlockedReason={companiesBlockedReason}
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
            selectedIds={selectedIds}
            onCancelSend={() => void cancelCurrentSend()}
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

function usageTone(view: BewViewDTO): "success" | "unverified" | "blocked" {
  if (view.usage.remaining <= 0) return "blocked";
  if (view.usage.remaining < 10) return "unverified";
  return "success";
}

function ErrorLine({ message, className = "" }: { message: string; className?: string }) {
  return (
    <div
      role="alert"
      className={`flex items-start gap-2.5 rounded-2xl border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger ${className}`}
    >
      <Icon name="alert" size={16} className="mt-0.5 shrink-0" />
      <span>{message}</span>
    </div>
  );
}
