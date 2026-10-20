"use client";

/**
 * Step 1 — "Add companies (smart input)" — the SIMPLIFIED flow.
 *
 * The UI is exactly four elements (nothing else):
 *
 *   1. a big text area for the pasted advertisement;
 *   2. ONE button — "Text analysieren" — which runs the server-side analysis
 *      (deterministic parse + the AI enhancement when the dedicated
 *      GEMINI_SMART_INPUT_API_KEY is configured) and FILLS the form;
 *   3. ONE form of EDITABLE fields, pre-filled with the extraction (the user
 *      reviews and corrects anything — every value is editable before saving,
 *      so nothing has to be copied from a section to another);
 *   4. ONE button — "Bestätigen und hinzufügen" — which persists the form.
 *
 * Honesty contract:
 *   - the form is filled only from the analysis (extracted / suggested /
 *     missing states decide pre-fill); the server re-validates EVERY value on
 *     confirm (shape, e-mail validity, length caps). The values are
 *     USER-VERIFIED — grounding is NOT re-applied to them (a corrected value
 *     is the user's own data, the same trust model as the manual row editor);
 *   - when the AI step FAILED, a clear warning with the non-sensitive code
 *     and a RETRY button is shown — the deterministic pre-fill is explicitly
 *     labeled as "standard analysis", never presented as an AI success;
 *   - the input is cleared ONLY after the server has persisted the confirmed
 *     row; on any failure the pasted text AND the filled form are kept, so
 *     nothing the user typed can be lost;
 *   - the duplicate / cap backstops live server-side (DUPLICATE_COMPANY),
 *     the client precheck only avoids a pointless round trip.
 */
import { memo, useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  bewAddCompany,
  bewCheckSmartInput,
} from "@/app/bewerbung-automation/actions";
import { Button } from "@/components/ui";
import { Icon } from "@/components/icon";
import {
  BEW_AD_INPUT_MAX,
  BEW_DATE_MAX,
  BEW_INDUSTRY_MAX,
  BEW_PHONE_MAX,
  type ParsedAdField,
  type ParsedAdvertisement,
} from "@/lib/bew-ad-parser";
import {
  BEW_POSITION_BRIEF_MAX,
  BEW_POSITION_TITLE_MAX,
} from "@/lib/bewerbung-automation";
import type { SmartInputDiagnostic } from "@/lib/bew-ad-ai";
import {
  checkSmartAdd,
  runSmartAdd,
  type SmartAddFailCode,
  type SmartAddOutcome,
  type SmartAddRow,
} from "./smart-input-state";
import { isNextRedirectError } from "./types";
import type { BewApplicationDTO, BewViewDTO } from "./types";

type T = (k: string, v?: Record<string, string | number>) => string;

interface Props {
  campaignId: string;
  view: BewViewDTO;
  /** Series still being created / send in flight / step-level busy. */
  disabled: boolean;
  /** Append the persisted row to the wizard view (stable reference). */
  onRowAdded: (row: BewApplicationDTO) => void;
  /** Best-effort fresh view after a successful add (stable reference). */
  onRefresh: () => Promise<unknown>;
  t: T;
}

/** The editable form — the single review surface of the simplified flow. */
interface SmartForm {
  companyName: string;
  companyEmail: string;
  contactName: string;
  companyAddress: string;
  companyPhone: string;
  positionTitle: string;
  companyIndustry: string;
  startDate: string;
  endDate: string;
  deadline: string;
  positionBrief: string;
}

/** Fill the form from an analysis result (missing fields stay editable-empty). */
function formFromParsed(parsed: ParsedAdvertisement): SmartForm {
  const v = (f: ParsedAdField) => (f.status === "missing" ? "" : f.value);
  return {
    companyName: v(parsed.companyName),
    companyEmail: v(parsed.companyEmail),
    contactName: v(parsed.contactName),
    companyAddress: v(parsed.companyAddress),
    companyPhone: v(parsed.companyPhone),
    positionTitle: v(parsed.positionTitle),
    companyIndustry: v(parsed.companyIndustry),
    startDate: v(parsed.startDate),
    endDate: v(parsed.endDate),
    deadline: v(parsed.deadline),
    positionBrief: v(parsed.positionBrief),
  };
}

/**
 * Serialize the user's (possibly corrected) form into the reviewed payload.
 * Every value is "extracted" = USER-VERIFIED (the server validates shape,
 * e-mail and length — it does not re-ground user edits). Over-limit values
 * carry the `too_long` problem so the client precheck flags them BEFORE the
 * round trip (POSITION_TOO_LONG), instead of the server rejecting them.
 */
function formToParsed(form: SmartForm): ParsedAdvertisement {
  const f = (value: string, max: number): ParsedAdField => {
    const t = value.trim();
    if (!t) return { value: "", status: "missing" };
    if (t.length > max) return { value: t, status: "invalid", problem: "too_long" };
    return { value: t, status: "extracted" };
  };
  return {
    companyName: f(form.companyName, 200),
    companyEmail: f(form.companyEmail, 320),
    contactName: f(form.contactName, 120),
    companyAddress: f(form.companyAddress, 200),
    companyPhone: f(form.companyPhone, BEW_PHONE_MAX),
    companyIndustry: f(form.companyIndustry, BEW_INDUSTRY_MAX),
    positionTitle: f(form.positionTitle, BEW_POSITION_TITLE_MAX),
    positionBrief: f(form.positionBrief, BEW_POSITION_BRIEF_MAX),
    startDate: f(form.startDate, BEW_DATE_MAX),
    endDate: f(form.endDate, BEW_DATE_MAX),
    deadline: f(form.deadline, BEW_DATE_MAX),
    tooLongInput: false,
  };
}

/** Shared input styling (matches the page's field language). */
const FIELD_CLS =
  "w-full rounded-xl border border-line-strong bg-surface px-3 py-2 text-sm leading-5 text-ink outline-none transition placeholder:text-faint focus:border-accent focus:ring-4 focus:ring-accent/10 max-sm:text-base disabled:opacity-50";

export const SmartCompanyInput = memo(function SmartCompanyInput({
  campaignId,
  view,
  disabled,
  onRowAdded,
  onRefresh,
  t,
}: Props) {
  const [text, setText] = useState("");
  /** The server "Text analysieren" round trip is in flight. */
  const [analyzing, setAnalyzing] = useState(false);
  /** The blocking issues + AI diagnostic of the LAST analysis (null = none yet). */
  const [analysis, setAnalysis] = useState<{
    issues: SmartAddFailCode[];
    diagnostic: SmartInputDiagnostic | null;
    /** Safe upstream detail for `http-*` diagnostics (never for success). */
    diagnosticDetail: string | null;
  } | null>(null);
  /** The editable form (null = nothing analyzed yet). */
  const [form, setForm] = useState<SmartForm | null>(null);
  /** The "Confirm and add" round trip is in flight. */
  const [inFlight, setInFlight] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Synchronous duplicate-click guard (state updates are batched — only a
  // ref claim is race-free between two rapid clicks; the server's
  // DUPLICATE_COMPANY check is the final backstop).
  const inFlightRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const router = useRouter();

  const errText = useCallback(
    (code: string) => {
      const key = `bewauto.err.${code}`;
      const translated = t(key);
      return translated === key ? t("bewauto.err.UNKNOWN") : translated;
    },
    [t],
  );

  /**
   * "Text analysieren" — the SINGLE analysis step (NO write, ever): the
   * server runs the full extraction on the EXACT pasted text (deterministic
   * parse + the AI enhancement when the dedicated key is configured) and the
   * result pre-fills the editable form.
   *
   * Empty or over-limit input fails the SAME way as before, instantly and
   * WITHOUT a round trip (the deterministic rules already decide it).
   * A session expiry mid-analysis navigates to /login (never a generic
   * error); any other failure shows the stable CHECK_UNAVAILABLE code and
   * keeps the pasted text for a retry.
   */
  const onAnalyze = useCallback(() => {
    if (disabled || analyzing || inFlight) return;
    setError(null);
    setNotice(null);
    if (!text.trim() || text.length > BEW_AD_INPUT_MAX) {
      const local = checkSmartAdd(text, view.applications);
      setForm(null);
      setAnalysis(null);
      setError(errText(local.issues[0] ?? "EMPTY_INPUT"));
      return;
    }
    setAnalyzing(true);
    (async () => {
      try {
        const fd = new FormData();
        fd.set("campaignId", campaignId);
        fd.set("text", text);
        const res = await bewCheckSmartInput(fd);
        if (res.parsed === null) {
          // The check itself could not run (foreign campaign / internal
          // failure) — stable code, localized, text kept for the retry.
          setError(errText(res.issues[0] ?? "CHECK_UNAVAILABLE"));
          setForm(null);
          setAnalysis(null);
          return;
        }
        setForm(formFromParsed(res.parsed));
        setAnalysis({
          issues: res.issues as SmartAddFailCode[],
          diagnostic: res.diagnostic,
          diagnosticDetail: res.diagnosticDetail,
        });
      } catch (e) {
        if (isNextRedirectError(e)) {
          // Session expired mid-analysis: re-authenticate, keep the text.
          router.replace("/login");
          return;
        }
        setError(errText("CHECK_UNAVAILABLE"));
      } finally {
        setAnalyzing(false);
      }
    })();
  }, [text, view.applications, campaignId, disabled, analyzing, inFlight, errText, router]);

  /** Update ONE form field (the user owns every value from here on). */
  const setField = useCallback(
    (key: keyof SmartForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setForm((f) => (f ? { ...f, [key]: e.target.value } : f)),
    [],
  );

  const formReady =
    !!form && form.companyName.trim() !== "" && form.companyEmail.trim() !== "";

  /**
   * "Bestätigen und hinzufügen" — the persistence step. The FORM (the
   * user-verified, possibly corrected values) is sent as `reviewed`; the
   * server re-validates it (shape / e-mail / length — no grounding) and
   * appends ONE row to the current series. The input + form clear ONLY after
   * the server confirmed; on failure both stay intact.
   */
  const onConfirm = useCallback(async () => {
    if (disabled || inFlightRef.current || analyzing || !form || !formReady) return;
    setError(null);
    setNotice(null);
    const reviewed = formToParsed(form);
    let outcome: SmartAddOutcome;
    try {
      outcome = await runSmartAdd(text, view.applications, {
        claim: () => {
          if (inFlightRef.current) return false;
          inFlightRef.current = true;
          setInFlight(true);
          return true;
        },
        release: () => {
          inFlightRef.current = false;
          setInFlight(false);
        },
        add: async (raw, reviewedPayload) => {
          const fd = new FormData();
          fd.set("campaignId", campaignId);
          fd.set("text", raw);
          // The user-verified form values — the server re-validates every
          // one (shape, e-mail, length) before persisting it.
          if (reviewedPayload) fd.set("reviewed", JSON.stringify(reviewedPayload));
          const res = await bewAddCompany(fd);
          if (!res.ok) throw new Error(res.code); // → localized below
          return res.row as SmartAddRow;
        },
        onRowAdded: (dto) => {
          // SUCCESS — the row lands in the view FIRST, then the input and
          // the form clear. The pasted text is never discarded before the
          // record exists.
          onRowAdded(dto);
          setText("");
          setForm(null);
          setAnalysis(null);
        },
      }, reviewed);
    } catch (e) {
      if (isNextRedirectError(e)) {
        // Session expired mid-flow: re-authenticate, keep the text.
        router.replace("/login");
        return;
      }
      // Anything else that escaped runSmartAdd is the single existing
      // fallback — the input and the form stay intact either way.
      setError(errText("UNKNOWN"));
      return;
    }
    if (outcome.ok) {
      setNotice(t("bewauto.smartSuccess", { n: outcome.row.seq, company: outcome.row.company_name }));
      // Best-effort re-sync (the server truth wins; the append above is the
      // instant feedback). A refresh failure must not hide the success.
      void Promise.resolve(onRefresh()).catch(() => undefined);
      textareaRef.current?.focus(); // ready for the next advertisement
    } else if (!outcome.busy) {
      // FAILURE — the pasted text AND the filled form are kept, the stable
      // code is localized.
      setError(errText(outcome.code));
    }
  }, [text, form, formReady, view.applications, campaignId, disabled, analyzing, onRowAdded, onRefresh, t, errText, router]);

  const aiFailed =
    !!analysis && analysis.diagnostic !== null && analysis.diagnostic !== "ai";

  return (
    <div className="rounded-2xl border border-accent/25 bg-surface-2/40 p-4">
      {/* 1 — the big paste area */}
      <label htmlFor="bew-smart-input" className="block text-sm font-bold text-ink">
        {t("bewauto.smartTitle")}
      </label>
      <p id="bew-smart-input-hint" className="mt-0.5 text-xs leading-5 text-muted">
        {t("bewauto.smartBody")}
      </p>
      <textarea
        ref={textareaRef}
        id="bew-smart-input"
        value={text}
        rows={7}
        maxLength={BEW_AD_INPUT_MAX}
        disabled={disabled}
        placeholder={t("bewauto.smartPlaceholder")}
        aria-describedby="bew-smart-input-hint"
        onChange={(e) => setText(e.target.value)}
        className="mt-2 min-h-44 w-full resize-y rounded-2xl border border-line-strong bg-surface px-3 py-2.5 text-sm leading-5 text-ink outline-none transition placeholder:text-faint focus:border-accent focus:ring-4 focus:ring-accent/10 max-sm:text-base disabled:opacity-50"
      />

      {/* 2 — the single analysis button */}
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          disabled={disabled || inFlight || analyzing}
          aria-busy={analyzing || undefined}
          onClick={onAnalyze}
        >
          {analyzing ? (
            <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
          ) : (
            <Icon name="spark" size={16} />
          )}
          {t("bewauto.analyzeText")}
        </Button>
        {/* 4 — the persistence button (active once the form carries the two
            required fields; the server re-validates everything anyway). */}
        <Button
          disabled={disabled || inFlight || analyzing || !formReady}
          onClick={() => void onConfirm()}
          aria-busy={inFlight || undefined}
        >
          {inFlight ? (
            <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
          ) : (
            <Icon name="check" size={16} />
          )}
          {t("bewauto.confirmAdd")}
        </Button>
      </div>

      {/* AI failure — a CLEAR warning (never a silent fallback): which
          non-sensitive code fired + the SAFE upstream detail (allowlisted
          provider status + sanitized message fragment, `http-*` only) + an
          explicit retry. The form below is still the deterministic pre-fill,
          explicitly labeled as such. */}
      {aiFailed && (
        <div
          role="alert"
          className="mt-2.5 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-warning/30 bg-warning-soft px-3 py-2.5"
        >
          <div className="min-w-0">
            <p className="text-xs font-semibold text-warning">
              {t("bewauto.aiFailed", { code: analysis!.diagnostic! })}
            </p>
            {analysis!.diagnosticDetail ? (
              <p className="mt-0.5 break-words font-mono text-[11px] leading-4 text-warning">
                {analysis!.diagnosticDetail}
              </p>
            ) : null}
          </div>
          <Button
            variant="secondary"
            disabled={disabled || analyzing || inFlight}
            onClick={onAnalyze}
          >
            {t("bewauto.retryAnalysis")}
          </Button>
        </div>
      )}

      {/* Blocking issues of the last analysis (duplicate / cap) — the exact
          fields that need attention before the row can be added. */}
      {form && analysis && analysis.issues.length > 0 && (
        <div
          role="alert"
          className="mt-2.5 rounded-xl border border-warning/30 bg-warning-soft px-3 py-2.5"
        >
          <p className="text-xs font-semibold text-warning">
            {t("bewauto.reviewIssues")}
          </p>
          <ul className="mt-1 list-disc space-y-0.5 ps-4 text-xs leading-5 text-warning">
            {analysis.issues.map((code) => (
              <li key={code}>{errText(code)}</li>
            ))}
          </ul>
        </div>
      )}

      {/* 3 — the single editable form, pre-filled by the analysis */}
      {form && (
        <div className="mt-3 rounded-xl border border-line bg-surface p-3">
          <h3 className="text-xs font-bold text-ink">
            {t("bewauto.formTitle")}
          </h3>
          <div className="mt-2.5 grid gap-2.5 sm:grid-cols-2">
            <Field label={`${t("bewauto.colCompany")} *`} id="si-company">
              <input
                id="si-company"
                value={form.companyName}
                onChange={setField("companyName")}
                className={FIELD_CLS}
                aria-required="true"
              />
            </Field>
            <Field label={`${t("bewauto.applicationEmail")} *`} id="si-email">
              <input
                id="si-email"
                type="email"
                value={form.companyEmail}
                onChange={setField("companyEmail")}
                className={FIELD_CLS}
                aria-required="true"
              />
            </Field>
            <Field label={t("bewauto.colContact")} id="si-contact">
              <input
                id="si-contact"
                value={form.contactName}
                onChange={setField("contactName")}
                className={FIELD_CLS}
              />
            </Field>
            <Field label={t("bewauto.colAddress")} id="si-address">
              <input
                id="si-address"
                value={form.companyAddress}
                onChange={setField("companyAddress")}
                className={FIELD_CLS}
              />
            </Field>
            <Field label={t("bewauto.colPhone")} id="si-phone">
              <input
                id="si-phone"
                value={form.companyPhone}
                onChange={setField("companyPhone")}
                className={FIELD_CLS}
              />
            </Field>
            <Field label={t("bewauto.colPositionTitle")} id="si-position">
              <input
                id="si-position"
                value={form.positionTitle}
                onChange={setField("positionTitle")}
                className={FIELD_CLS}
              />
            </Field>
            <Field label={t("bewauto.colIndustry")} id="si-industry">
              <input
                id="si-industry"
                value={form.companyIndustry}
                onChange={setField("companyIndustry")}
                className={FIELD_CLS}
              />
            </Field>
            <div className="grid grid-cols-3 gap-2.5 sm:col-span-2">
              <Field label={t("bewauto.colStartDate")} id="si-start">
                <input
                  id="si-start"
                  value={form.startDate}
                  onChange={setField("startDate")}
                  placeholder={t("bewauto.datePlaceholder")}
                  className={FIELD_CLS}
                />
              </Field>
              <Field label={t("bewauto.colEndDate")} id="si-end">
                <input
                  id="si-end"
                  value={form.endDate}
                  onChange={setField("endDate")}
                  placeholder={t("bewauto.datePlaceholder")}
                  className={FIELD_CLS}
                />
              </Field>
              <Field label={t("bewauto.colDeadline")} id="si-deadline">
                <input
                  id="si-deadline"
                  value={form.deadline}
                  onChange={setField("deadline")}
                  placeholder={t("bewauto.datePlaceholder")}
                  className={FIELD_CLS}
                />
              </Field>
            </div>
            <div className="sm:col-span-2">
              <Field label={t("bewauto.smartJobDescription")} id="si-brief">
                <textarea
                  id="si-brief"
                  value={form.positionBrief}
                  rows={4}
                  onChange={setField("positionBrief")}
                  className={`${FIELD_CLS} min-h-24 resize-y`}
                />
              </Field>
            </div>
          </div>
        </div>
      )}

      {/* Feedback (success / error) — kept for the save outcome only. */}
      {notice && (
        <p
          role="status"
          className="mt-2.5 flex items-start gap-2 text-xs font-medium text-success"
        >
          <Icon name="check" size={14} className="mt-0.5 shrink-0" />
          <span>{notice}</span>
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="mt-2.5 flex items-start gap-2 text-xs font-medium text-danger"
        >
          <Icon name="alert" size={14} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
});

/** One labelled, editable form field. */
function Field({
  label,
  id,
  children,
}: {
  label: string;
  id: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="mb-1 block text-xs font-semibold text-muted">
        {label}
      </label>
      {children}
    </div>
  );
}
