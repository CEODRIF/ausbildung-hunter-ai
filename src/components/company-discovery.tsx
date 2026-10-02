"use client";

/**
 * Company & Email Discovery — page UI (Phase 2).
 *
 * The form collects what a DISCOVERY run needs — field, role, planned start
 * (4 modes), offer type, target number of UNIQUE companies with a public
 * email, and the email-only toggle (on by default). Submitting registers
 * AND executes the Phase 2 candidate engine (BA via the shared
 * Opportunities search); the page then shows the FINAL real state from the
 * API — counters measured by the run, never simulated progress.
 *
 * Layout: responsive (1 column mobile → 2 columns from sm), logical
 * properties (ps/pe, ms/me, start/end) so Arabic (dir=rtl) mirrors.
 */

import { useMemo, useState, type FormEvent } from "react";
import { useI18n } from "@/lib/i18n";
import {
  DISCOVERY_FIELD_SUGGESTIONS,
  DISCOVERY_TARGET_DEFAULT,
  DISCOVERY_TARGET_MAX,
  DISCOVERY_TARGET_MIN,
  beginnLabelOf,
  type DiscoveryBeginn,
  type DiscoveryGoal,
  type DiscoveryRun,
} from "@/lib/company-discovery/types";

type Phase = "idle" | "submitting" | "created";
type BeginnMode = DiscoveryBeginn["mode"];

const BEGINN_MODES: BeginnMode[] = ["from_now", "date", "month", "year"];
const GOALS: DiscoveryGoal[] = ["ausbildung", "arbeit", "both"];

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

export function CompanyDiscovery() {
  const { t } = useI18n();

  // ---- form state ----------------------------------------------------------
  const [phase, setPhase] = useState<Phase>("idle");
  const [field, setField] = useState("");
  const [role, setRole] = useState("");
  const [beginnMode, setBeginnMode] = useState<BeginnMode>("from_now");
  const [beginnValue, setBeginnValue] = useState("");
  const [goal, setGoal] = useState<DiscoveryGoal>("ausbildung");
  const [target, setTarget] = useState(String(DISCOVERY_TARGET_DEFAULT));
  const [onlyPublicEmail, setOnlyPublicEmail] = useState(true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [created, setCreated] = useState<DiscoveryRun | null>(null);

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

  // ---- submit --------------------------------------------------------------
  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (phase === "submitting" || !validate()) return;
    setPhase("submitting");
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
      const data = (await response.json().catch(() => null)) as
        | { run?: DiscoveryRun; error?: string }
        | null;
      if (!response.ok || !data?.run) {
        throw new Error(data?.error ?? "unavailable");
      }
      setCreated(data.run);
      setPhase("created");
    } catch {
      setErrors({ submit: t("companyDiscovery.error.generic") });
      setPhase("idle");
    }
  }

  function reset() {
    setCreated(null);
    setPhase("idle");
    setErrors({});
  }

  // ---- inputs (shared styling) ----------------------------------------------
  const inputClass =
    "w-full rounded-xl border border-line bg-surface px-3 py-2.5 text-sm text-ink outline-none focus:border-accent";
  const labelClass = "mb-1.5 block text-xs font-semibold text-muted";

  // ===========================================================================
  // Finished run (honest state — every number comes from the run)
  // ===========================================================================
  if (phase === "created" && created) {
    const run = created;
    const source = run.progress.sources[0];
    return (
      <div className="mx-auto max-w-3xl">
        <div className="rounded-2xl border border-line bg-surface p-5 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-bold text-ink">
              {t("companyDiscovery.runCreated.title")}
            </h2>
            <span
              className={`rounded-lg px-2.5 py-1 text-xs font-bold uppercase ${
                run.status === "completed"
                  ? "bg-success-soft text-success"
                  : run.status === "failed"
                    ? "bg-danger-soft text-danger"
                    : "bg-accent-soft text-accent"
              }`}
            >
              {t(`companyDiscovery.status.${run.status}`)}
            </span>
          </div>

          {/* Real run counters — measured by the engine, never simulated. */}
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
              <dd className="text-xl font-bold text-ink">
                {run.progress.offersAnalyzed}
              </dd>
              <dt className="mt-0.5 text-xs font-semibold text-muted">
                {t("companyDiscovery.runCreated.offers")}
              </dt>
            </div>
            <div className="rounded-xl bg-surface-2 p-3">
              <dd className="text-xl font-bold text-ink">
                {run.progress.uniqueCompanies}
              </dd>
              <dt className="mt-0.5 text-xs font-semibold text-muted">
                {t("companyDiscovery.runCreated.unique")}
              </dt>
            </div>
            <div className="rounded-xl bg-surface-2 p-3">
              <dd className="text-xl font-bold text-ink">
                {run.progress.duplicatesRemoved}
              </dd>
              <dt className="mt-0.5 text-xs font-semibold text-muted">
                {t("companyDiscovery.runCreated.duplicates")}
              </dt>
            </div>
            <div className="rounded-xl bg-surface-2 p-3">
              <dd className="text-xl font-bold text-ink">
                {run.progress.companiesRejected}
              </dd>
              <dt className="mt-0.5 text-xs font-semibold text-muted">
                {t("companyDiscovery.runCreated.rejected")}
              </dt>
            </div>
            <div className="rounded-xl bg-surface-2 p-3">
              <dd className="text-sm font-bold text-ink sm:mt-1">
                {source
                  ? source.status === "unavailable"
                    ? t("companyDiscovery.runCreated.sourceUnavailable")
                    : t("companyDiscovery.runCreated.sourceOk")
                  : "—"}
              </dd>
              <dt className="mt-0.5 text-xs font-semibold text-muted">
                {t("companyDiscovery.runCreated.source")}
              </dt>
            </div>
          </dl>

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

          <p className="mt-4 rounded-xl bg-surface-2 px-3 py-2.5 text-xs leading-5 text-ink-soft">
            {t("companyDiscovery.runCreated.resultsNote")}
          </p>

          <button
            type="button"
            onClick={reset}
            className="mt-4 rounded-xl border border-line px-4 py-2 text-sm font-semibold text-ink transition hover:bg-surface-2"
          >
            {t("companyDiscovery.runCreated.newSearch")}
          </button>
        </div>
      </div>
    );
  }

  // ===========================================================================
  // Idle / submitting — the search form
  // ===========================================================================
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-xl font-bold text-ink sm:text-2xl">
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
    </div>
  );
}
