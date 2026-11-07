"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Check, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui";
import { Icon, type IconName } from "@/components/icon";
import { StatusPill, type StatusTone } from "@/components/ui/feedback";
import { useI18n } from "@/lib/i18n";
import { resolveAutoBewerbRecipient } from "@/lib/auto-bewerb/schema";
import type {
  AutoBewerbCompanyRow,
  AutoBewerbLetter,
  AutoBewerbWorkspace,
} from "@/lib/auto-bewerb/schema";
import type { CvDocument } from "@/lib/templates/cv";

/**
 * AUTO BEWERB — shared client plumbing (context, step shell, status mapping).
 *
 * Data flow contract: the server workspace (`AutoBewerbWorkspace`) is the
 * ONLY source of truth. Every durable mutation (server action) is followed
 * by `refresh()` — the client never patches a copy of a server row by hand,
 * so edits made in one step are preserved and visible in every other step.
 * AI results (CV / letter / email drafts) are applied locally first (fast
 * preview) and become durable via the save actions; until then they are
 * clearly "unsaved" and never counted as completed.
 */

export type ToastKind = "success" | "error" | "info";

/** Generated documents that are buffered but NOT yet saved — they survive
 *  step navigation within the session and are clearly marked "unsaved"
 *  until the save action persists them (the server row stays untouched). */
export interface AutoBewerbDrafts {
  cv: Record<string, CvDocument | null>;
  letter: Record<string, AutoBewerbLetter | null>;
}

export interface AutoBewerbContextValue {
  ws: AutoBewerbWorkspace;
  /** Re-read the whole workspace from the server (the single sync path). */
  refresh: (silent?: boolean) => Promise<void>;
  step: number;
  goToStep: (n: number) => void;
  toast: { kind: ToastKind; text: string } | null;
  notify: (kind: ToastKind, text: string) => void;
  dismissToast: () => void;
  /** True while a full-workspace refresh is in flight. */
  syncing: boolean;
  /** Currently selected company (steps 3-7 share one selection). */
  companyId: string | null;
  selectCompany: (id: string | null) => void;
  /** Unsaved generated documents (per company, per document kind). */
  drafts: AutoBewerbDrafts;
  setDraft: (
    kind: "cv" | "letter",
    companyId: string,
    value: CvDocument | AutoBewerbLetter | null,
  ) => void;
}

export const AutoBewerbContext = createContext<AutoBewerbContextValue | null>(null);

export function useAutoBewerb(): AutoBewerbContextValue {
  const ctx = useContext(AutoBewerbContext);
  if (!ctx) throw new Error("useAutoBewerb must be used inside AutoBewerbClient");
  return ctx;
}

// ---------------------------------------------------------------------------
// Status → UI mapping (honest: a status is only what the server says)
// ---------------------------------------------------------------------------

const STATUS_TONE: Record<AutoBewerbCompanyRow["status"], StatusTone> = {
  draft: "neutral",
  ready: "active",
  scheduled: "running",
  sending: "running",
  sent: "success",
  failed: "blocked",
  cancelled: "skipped",
};

export function statusPill(status: AutoBewerbCompanyRow["status"], t: ReturnType<typeof useI18n>["t"]) {
  const label =
    status === "draft"
      ? t("autoBewerb.statusDraft")
      : status === "ready"
        ? t("autoBewerb.statusReady")
        : status === "scheduled"
          ? t("autoBewerb.statusScheduled")
          : status === "sending"
            ? t("autoBewerb.statusSending")
            : status === "sent"
              ? t("autoBewerb.statusSent")
              : status === "failed"
                ? t("autoBewerb.statusFailed")
                : t("autoBewerb.statusCancelled");
  return <StatusPill tone={STATUS_TONE[status]} label={label} />;
}

/** Company display name + job title (never invents: extraction-driven). */
export function companyLabel(company: AutoBewerbCompanyRow): { name: string; job: string } {
  const ex = company.ad_extracted;
  return {
    name: company.company || ex?.company || "—",
    job: ex?.jobTitle || ex?.occupation || "",
  };
}

// ---------------------------------------------------------------------------
// Step completion (drives the progress indicator + nav hints)
// ---------------------------------------------------------------------------

export function computeStepState(ws: AutoBewerbWorkspace): {
  done: boolean;
  /** Prerequisites for this step are met (false = the step shows a hint). */
  ready: boolean;
}[] {
  const companies = ws.companies;
  return [
    // 1 CV
    { done: Boolean(ws.profile?.extracted), ready: true },
    // 2 companies
    {
      done: companies.length > 0 && companies.every((c) => Boolean(c.company.ad_extracted)),
      ready: companies.length > 0,
    },
    // 3 documents (GLOBAL library, optional — never blocks)
    { done: ws.attachments.length > 0, ready: true },
    // 4 tailored CV
    {
      done: companies.length > 0 && companies.every((c) => Boolean(c.cv)),
      ready: companies.length > 0 && Boolean(ws.profile?.extracted),
    },
    // 5 letters
    {
      done: companies.length > 0 && companies.every((c) => Boolean(c.letter)),
      ready: companies.length > 0 && Boolean(ws.profile?.extracted),
    },
    // 6 email — the ONE global configuration (supported) or the legacy
    // per-company values (database without the settings migration)
    {
      done:
        ws.emailSettingsSupported && ws.emailSettings
          ? ws.emailSettings.body.trim().length > 0 &&
            ws.emailSettings.subject.trim().length > 0 &&
            Boolean(ws.emailSettings.accountId) &&
            companies.length > 0 &&
            companies.every(
              (c) =>
                Boolean(
                  resolveAutoBewerbRecipient(
                    "",
                    c.company.recipient_email,
                    c.company.ad_extracted,
                  ),
                ),
            )
          : ws.emailTemplate.trim().length > 0 &&
            companies.length > 0 &&
            companies.every(
              (c) => Boolean(c.company.recipient_email) && Boolean(c.company.email_subject),
            ),
      ready: companies.length > 0,
    },
    // 7 review — done when at least one application was DELIVERED. Sent
    // companies leave the active list on success (auto-removal), so the proof
    // is the persisted history / stats, never a "sent" row in the active set.
    { done: (ws.sendHistory?.length ?? 0) > 0 || (ws.sendStats?.sentToday ?? 0) > 0, ready: companies.length > 0 },
  ];
}

// ---------------------------------------------------------------------------
// Step shell (header + progress + prev/next)
// ---------------------------------------------------------------------------

const STEP_KEYS = [
  "autoBewerb.step1",
  "autoBewerb.step2",
  "autoBewerb.step3",
  "autoBewerb.step4",
  "autoBewerb.step5",
  "autoBewerb.step6",
  "autoBewerb.step7",
] as const;

export function StepShell({
  title,
  subtitle,
  children,
  primary,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  primary?: ReactNode;
}) {
  const { t } = useI18n();
  const { ws, step, goToStep } = useAutoBewerb();
  const states = computeStepState(ws);
  const atLast = step === 7;

  const doneCount = states.filter((s) => s.done).length;
  const progress = Math.round((doneCount / states.length) * 100);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
      {/* Step rail — premium stepper card: overall progress + 7 steps
          (grid on sm+, scrollable rail on phones). */}
      <nav aria-label={t("autoBewerb.navLabel")} className="mb-6">
        <div className="surface-elevated rounded-3xl p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
            <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-faint">
              {t("autoBewerb.progressStep", {
                current: step,
                total: states.length,
              })}
            </p>
            <p className="num text-[11px] font-bold text-muted">
              {doneCount}/{states.length} · {progress} %
            </p>
          </div>
          <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-surface-2">
            <div
              className="h-full rounded-full transition-[width] duration-500"
              style={{ width: `${progress}%`, backgroundImage: "var(--gradient-neon)" }}
            />
          </div>
          <ol className="mt-4 grid max-sm:grid-flow-col max-sm:auto-cols-[88px] max-sm:overflow-x-auto sm:grid-cols-4 lg:grid-cols-7">
            {STEP_KEYS.map((key, i) => {
              const n = i + 1;
              const active = step === n;
              const done = states[i].done;
              return (
                <li key={key} className="min-w-0">
                  <button
                    type="button"
                    onClick={() => goToStep(n)}
                    aria-current={active ? "step" : undefined}
                    className={`flex w-full flex-col items-center gap-2 rounded-2xl px-1 py-2.5 transition-colors ${
                      active ? "bg-accent-soft/70" : "hover:bg-surface-2/60"
                    }`}
                  >
                    <span
                      className={`flex h-9 w-9 items-center justify-center rounded-full text-xs font-bold transition-colors ${
                        active
                          ? "text-white shadow-[var(--shadow-card)]"
                          : done
                            ? "bg-success text-white"
                            : "border border-line-strong bg-surface text-muted"
                      }`}
                      style={active ? { backgroundImage: "var(--gradient-neon)" } : undefined}
                    >
                      {done && !active ? (
                        <Check size={14} strokeWidth={3} />
                      ) : (
                        n
                      )}
                    </span>
                    <span
                      className={`max-w-full truncate text-[10px] font-semibold leading-tight sm:max-w-none sm:text-center sm:text-xs ${
                        active ? "text-accent" : done ? "text-ink-soft" : "text-muted"
                      }`}
                    >
                      {t(key)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
      </nav>

      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="display-title text-2xl text-ink sm:text-3xl">{title}</h1>
          <p className="mt-1.5 max-w-2xl text-sm leading-6 text-muted">{subtitle}</p>
        </div>
        {primary}
      </header>

      <div>{children}</div>

      <footer className="mt-8 flex flex-wrap items-center justify-between gap-3">
        <Button
          variant="secondary"
          size="md"
          onClick={() => step > 1 && goToStep(step - 1)}
          disabled={step <= 1}
          className="h-11 rounded-2xl px-5 rtl:flex-row-reverse"
        >
          <ChevronLeft size={16} className="rtl:rotate-180" />
          {t("common.back")}
        </Button>
        <div className="flex items-center gap-3">
          {primary && null}
          {!atLast && (
            <Button
              variant="primary"
              size="md"
              onClick={() => goToStep(step + 1)}
              className="h-11 rounded-2xl px-6 rtl:flex-row-reverse"
            >
              {t("common.continue")}
              <ChevronRight size={16} className="rtl:rotate-180" />
            </Button>
          )}
        </div>
      </footer>
    </div>
  );
}

/** Inline toast host (top of the workflow area). The context toast is the
 *  single source of truth; auto-hide runs in the timer callback. */
export function ToastHost() {
  const { toast, dismissToast } = useAutoBewerb();

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(dismissToast, 5000);
    return () => clearTimeout(timer);
  }, [toast, dismissToast]);

  if (!toast) return null;
  return (
    <div className="fixed inset-x-0 top-4 z-[60] flex justify-center px-4" role="status" aria-live="polite">
      <div
        className={`max-w-lg rounded-2xl border px-4 py-3 text-sm font-semibold shadow-lg ${
          toast.kind === "success"
            ? "border-success/30 bg-success-soft text-success"
            : toast.kind === "error"
              ? "border-danger/30 bg-danger-soft text-danger"
              : "border-line-strong bg-surface text-ink-soft"
        }`}
      >
        {toast.text}
      </div>
    </div>
  );
}

/** Company selector (used by steps 4–7 to pick the active company). */
export function CompanyPicker({
  value,
  onChange,
  disableSent = false,
}: {
  value: string | null;
  onChange: (id: string) => void;
  disableSent?: boolean;
}) {
  const { ws } = useAutoBewerb();
  const { t } = useI18n();
  const list = useMemo(() => ws.companies, [ws.companies]);
  if (list.length === 0) return null;
  return (
    <div className="mb-5 grid gap-2 sm:grid-cols-2 xl:grid-cols-3" role="tablist" aria-label={t("autoBewerb.pickCompany")}>
      {list.map((c) => {
        const { name, job } = companyLabel(c.company);
        const active = value === c.company.id;
        const disabled = disableSent && c.company.status === "sent";
        return (
          <button
            key={c.company.id}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={disabled}
            onClick={() => onChange(c.company.id)}
            className={`flex min-w-0 items-center gap-3 rounded-2xl border p-3 text-left transition-[border-color,box-shadow,background-color] duration-300 disabled:cursor-not-allowed disabled:opacity-50 ${
              active
                ? "border-accent bg-accent-soft/60 shadow-[var(--shadow-card)]"
                : "border-line bg-surface hover:border-line-strong hover:shadow-[var(--shadow-card)]"
            }`}
          >
            <span
              aria-hidden="true"
              className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-sm font-extrabold ${
                active ? "text-white" : "bg-accent-soft text-accent"
              }`}
              style={active ? { backgroundImage: "var(--gradient-neon)" } : undefined}
            >
              {companyInitials(name)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-bold text-ink">{name}</span>
              {job && <span className="block truncate text-xs text-muted">{job}</span>}
            </span>
            {statusPill(c.company.status, t)}
          </button>
        );
      })}
    </div>
  );
}

/** Deterministic avatar initials for the company picker cards. */
function companyInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "—";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Small labelled section wrapper (cards keep the premium surface language).
 *  Optional `icon` renders the brand icon chip next to the title. */
export function SectionCard({
  title,
  aside,
  children,
  className = "",
  icon,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  icon?: IconName;
}) {
  return (
    <section
      className={`rounded-3xl border border-line bg-surface p-5 shadow-[var(--shadow-card)] transition-shadow duration-300 hover:shadow-[var(--shadow-float)] sm:p-6 ${className}`}
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          {icon && (
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
              <Icon name={icon} size={16} />
            </span>
          )}
          <h2 className="min-w-0 text-base font-bold text-ink">{title}</h2>
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** Inline note (success / error / info) — never blocks the layout. */
export function Note({ kind, children }: { kind: ToastKind; children: ReactNode }) {
  const cls =
    kind === "success"
      ? "border-success/25 bg-success-soft/60 text-success"
      : kind === "error"
        ? "border-danger/25 bg-danger-soft/60 text-danger"
        : "border-line-strong bg-surface-2 text-muted";
  return <div className={`rounded-2xl border px-4 py-3 text-sm leading-6 ${cls}`}>{children}</div>;
}

/** Hook: a debounced "saved" indicator for optimistic server writes. */
export function useSaveFlash(): [boolean, (text?: string) => void] {
  const { t } = useI18n();
  const [flash, setFlash] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = useCallback(
    (text?: string) => {
      setFlash(text ?? t("autoBewerb.saved"));
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setFlash(null), 2500);
    },
    [t],
  );
  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);
  return [Boolean(flash), show];
}
