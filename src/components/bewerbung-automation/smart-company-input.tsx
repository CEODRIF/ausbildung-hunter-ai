"use client";

/**
 * Step 1 — "Add companies (smart input)".
 *
 * The guided two-step workflow:
 *
 *   1. the user pastes company information or a job advertisement; the
 *      shared deterministic parser (`@/lib/bew-ad-parser`) extracts the
 *      supported fields LIVE next to the input (with extracted /
 *      needs-review / missing / invalid states);
 *   2. "Check information" freezes the analysis of the EXACT pasted text
 *      SERVER-side (`bewCheckSmartInput` — the deterministic parse plus the
 *      AI enhancement when the dedicated GEMINI_SMART_INPUT_API_KEY is
 *      configured): every blocking problem is listed (exactly which fields
 *      need attention), and when the check passes the "Confirm and add"
 *      button appears — NOTHING is persisted by the check itself. The
 *      frozen server result (the AI-enhanced fields) becomes the review
 *      surface shown in the panel while the text is unchanged;
 *   3. "Confirm and add" sends the RAW text AND the frozen reviewed fields
 *      to the `bewAddCompany` server action, which re-validates and
 *      re-grounds every value (the deterministic re-parse is the fallback
 *      for anything that does not ground) and appends ONE independent row
 *      to the CURRENT series (the DUPLICATE_COMPANY check is the final
 *      backstop — repeated submissions never create duplicate rows).
 *
 * The input is cleared ONLY after the server has persisted the confirmed
 * row; on any failure the pasted text is kept, so nothing the user typed
 * can be lost. Clearing the input never touches already-created rows. The
 * component is memoized and the parse is debounced (the textarea itself
 * stays fully controlled and instant), so the surrounding 100-row table
 * does not re-render on every keystroke.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  bewAddCompany,
  bewCheckSmartInput,
} from "@/app/bewerbung-automation/actions";
import { Button } from "@/components/ui";
import { Icon, type IconName } from "@/components/icon";
import {
  BEW_AD_INPUT_MAX,
  parseAdvertisement,
  type ParsedAdField,
} from "@/lib/bew-ad-parser";
import type { SmartInputDiagnostic } from "@/lib/bew-ad-ai";
import {
  checkSmartAdd,
  runSmartAdd,
  type SmartAddOutcome,
  type SmartAddRow,
  type SmartCheckResult,
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

/** Preview parse debounce — the textarea stays instant, only the panel waits. */
const PARSE_DEBOUNCE_MS = 120;

export const SmartCompanyInput = memo(function SmartCompanyInput({
  campaignId,
  view,
  disabled,
  onRowAdded,
  onRefresh,
  t,
}: Props) {
  const [text, setText] = useState("");
  const [debounced, setDebounced] = useState("");
  const [inFlight, setInFlight] = useState(false);
  /** The server "Check information" round trip is in flight. */
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [briefExpanded, setBriefExpanded] = useState(false);
  /**
   * The "Check information" result — a frozen analysis of the EXACT text at
   * check time (the review surface). `snapshot` keeps it honest: the moment
   * the textarea drifts from the checked text the review is INVALID (see
   * `activeReview` below) — re-checking is required before another confirm,
   * because the fields the user reviewed must be the fields that get
   * persisted.
   */
  /**
   * The frozen review of the checked text (snapshot rule). `diagnostic` is
   * the server's NON-SENSITIVE AI-step code (e.g. "no-key", "http-401") —
   * surfaced in the review area so a production fallback is diagnosable
   * without server logs. It is shown text-only; it never drives the workflow.
   */
  const [review, setReview] = useState<
    (SmartCheckResult & { snapshot: string; diagnostic?: SmartInputDiagnostic | null }) | null
  >(null);
  // Synchronous duplicate-click guard (state updates are batched — only a
  // ref claim is race-free between two rapid clicks; the server's
  // DUPLICATE_COMPANY check is the final backstop).
  const inFlightRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const router = useRouter();

  useEffect(() => {
    if (text === debounced) return;
    const id = setTimeout(() => setDebounced(text), PARSE_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [text, debounced]);

  /** A check is only valid for the EXACT text it was run on — derived at
   *  render time (a stale snapshot is inert; no effect sync needed). */
  const activeReview = review && review.snapshot === text ? review : null;

  /** Live preview (debounced) — the SAME deterministic parser the server
   *  floor runs. */
  const parsed = useMemo(
    () => (debounced.trim() ? parseAdvertisement(debounced) : null),
    [debounced],
  );

  /** The fields the review panel shows: while a check is ACTIVE, the FROZEN
   *  server result (the reviewed truth, possibly AI-enhanced); otherwise the
   *  live deterministic preview. Reviewing what will be persisted — and only
   *  that — is the point of the two-step flow. */
  const panelParsed = activeReview?.parsed ?? parsed;

  /** Live check for the preview panel (client only — the server re-runs the
   *  same rules on check): ALL blocking issues, not just the first. Suppressed
   *  while a review is active (the review's own issue list is the source of
   *  truth then — the server check may legitimately differ from the
   *  deterministic preview, e.g. an e-mail only the AI found). */
  const liveCheck = useMemo(
    () => (debounced.trim() ? checkSmartAdd(debounced, view.applications) : null),
    [debounced, view.applications],
  );

  const errText = useCallback(
    (code: string) => {
      const key = `bewauto.err.${code}`;
      const translated = t(key);
      return translated === key ? t("bewauto.err.UNKNOWN") : translated;
    },
    [t],
  );

  /** Clear the INPUT only — already-created rows are never touched. */
  const clear = useCallback(() => {
    setText("");
    setDebounced("");
    setNotice(null);
    setError(null);
    setReview(null);
    setBriefExpanded(false);
  }, []);

  /**
   * "Check information" — the analysis step (NO write, ever): the server
   * runs the full extraction on the EXACT pasted text (deterministic parse +
   * the AI enhancement when the dedicated GEMINI_SMART_INPUT_API_KEY is
   * configured) and the frozen result becomes the review surface. When
   * something is missing or invalid, EVERY blocking problem is listed
   * (exactly which fields need attention); only when the check passes does
   * the "Confirm and add" button appear. Nothing is persisted until the
   * user confirms.
   *
   * Empty or over-limit input fails the SAME way as before, instantly and
   * WITHOUT a round trip (the deterministic rules already decide it).
   * A session expiry mid-check navigates to /login (never a generic error);
   * any other failure shows the stable CHECK_UNAVAILABLE code and keeps the
   * pasted text for a retry.
   */
  const onCheck = useCallback(() => {
    if (disabled || checking || inFlight) return;
    setError(null);
    setNotice(null);
    const local = checkSmartAdd(text, view.applications);
    if (!text.trim() || local.parsed?.tooLongInput) {
      setReview({ ...local, snapshot: text });
      return;
    }
    setReview(null);
    setChecking(true);
    const checkedText = text; // the snapshot is captured BEFORE the call
    (async () => {
      try {
        const fd = new FormData();
        fd.set("campaignId", campaignId);
        fd.set("text", checkedText);
        const res = await bewCheckSmartInput(fd);
        if (res.parsed === null) {
          // The check itself could not run (foreign campaign / internal
          // failure) — stable code, localized, text kept for the retry.
          setError(errText(res.issues[0] ?? "CHECK_UNAVAILABLE"));
          return;
        }
        // parsed !== null ⇒ the terminal codes are absent (action contract) —
        // the issues are plain SmartAddFailCodes the review surface expects.
        setReview({
          ok: res.ok,
          issues: res.issues as SmartCheckResult["issues"],
          parsed: res.parsed,
          snapshot: checkedText,
          diagnostic: res.diagnostic,
        });
      } catch (e) {
        if (isNextRedirectError(e)) {
          // Session expired mid-check: re-authenticate, keep the text.
          router.replace("/login");
          return;
        }
        setError(errText("CHECK_UNAVAILABLE"));
      } finally {
        setChecking(false);
      }
    })();
  }, [text, view.applications, campaignId, disabled, checking, inFlight, errText, router]);

  /**
   * "Confirm and add" — the persistence step. Only reachable while the
   * review is `ok` (the button is not rendered otherwise), and the pure
   * orchestration (runSmartAdd) owns the safety contract: precheck before
   * any request, onRowAdded (→ input clear) only after the server
   * confirmed, claim guard against rapid double clicks. The server
   * re-parses and re-validates the RAW text and appends ONE row to the
   * current series; DUPLICATE_COMPANY is the final backstop.
   */
  const onConfirm = useCallback(async () => {
    if (disabled || inFlightRef.current) return;
    if (!activeReview || !activeReview.ok) return; // the button only exists when ok
    setError(null);
    setNotice(null);
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
        add: async (raw, reviewed) => {
          const fd = new FormData();
          fd.set("campaignId", campaignId);
          fd.set("text", raw);
          // The frozen reviewed extraction (the exact fields the user saw at
          // check time) — the server re-validates and re-grounds every value
          // before persisting it; legacy clients omit it and get the
          // deterministic re-parse.
          if (reviewed) fd.set("reviewed", JSON.stringify(reviewed));
          // The action resolves with a JSON-safe result (a thrown error can
          // be re-wrapped by the framework and lose its stable code).
          const res = await bewAddCompany(fd);
          if (!res.ok) throw new Error(res.code); // → localized below
          return res.row as SmartAddRow;
        },
        onRowAdded: (dto) => {
          // SUCCESS — the row lands in the view FIRST, then the input clears.
          // The pasted text is never discarded before the record exists.
          onRowAdded(dto);
          setText("");
          setBriefExpanded(false);
        },
      });
    } catch (e) {
      if (isNextRedirectError(e)) {
        // Session expired mid-flow: the server asked for re-authentication.
        // Navigate instead of showing a (misleading) error — the pasted
        // text survives until the user returns. Swallowing this redirect
        // into "UNKNOWN" was the reported generic-error bug.
        router.replace("/login");
        return;
      }
      // Anything else that escaped runSmartAdd is the single existing
      // fallback — the input stays intact either way.
      setError(errText("UNKNOWN"));
      return;
    }
    if (outcome.ok) {
      setReview(null); // the confirmed snapshot is consumed
      setNotice(t("bewauto.smartSuccess", { n: outcome.row.seq, company: outcome.row.company_name }));
      // Best-effort re-sync (the server truth wins; the append above is the
      // instant feedback). A refresh failure must not hide the success.
      void Promise.resolve(onRefresh()).catch(() => undefined);
      textareaRef.current?.focus(); // ready for the next advertisement
    } else if (!outcome.busy) {
      // FAILURE — the input text is kept, the stable code is localized.
      // (Only a truly unknown server error falls back to err.UNKNOWN —
      // the single existing fallback, no new generic path.)
      setError(errText(outcome.code));
    }
  }, [text, activeReview, view.applications, disabled, campaignId, onRowAdded, onRefresh, t, errText, router]);

  return (
    <div className="rounded-2xl border border-accent/25 bg-surface-2/40 p-4">
      <div className="grid gap-4 lg:grid-cols-2">
        {/* -------- input + actions -------- */}
        <div className="min-w-0">
          <label
            htmlFor="bew-smart-input"
            className="block text-sm font-bold text-ink"
          >
            {t("bewauto.smartTitle")}
          </label>
          <p id="bew-smart-input-hint" className="mt-0.5 text-xs leading-5 text-muted">
            {t("bewauto.smartBody")}
          </p>
          <textarea
            ref={textareaRef}
            id="bew-smart-input"
            value={text}
            rows={6}
            maxLength={BEW_AD_INPUT_MAX}
            disabled={disabled}
            placeholder={t("bewauto.smartPlaceholder")}
            aria-describedby="bew-smart-input-hint"
            onChange={(e) => setText(e.target.value)}
            className="mt-2 min-h-32 w-full resize-y rounded-2xl border border-line-strong bg-surface px-3 py-2.5 text-sm leading-5 text-ink outline-none transition placeholder:text-faint focus:border-accent focus:ring-4 focus:ring-accent/10 max-sm:text-base disabled:opacity-50"
          />
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            {/* Step 1 of the workflow — analyze (no write). Becomes
                secondary once the check passed and the confirm is the
                active step. */}
             <Button
               variant={activeReview?.ok ? "secondary" : "primary"}
               disabled={disabled || inFlight || checking}
               aria-busy={checking || undefined}
               onClick={onCheck}
             >
               {checking ? (
                 <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
               ) : (
                 <Icon name="spark" size={16} />
               )}
               {t("bewauto.checkInformation")}
             </Button>
            {/* Step 2 — persist. Rendered ONLY when the check passed for
                the exact current text; the server still re-validates. */}
            {activeReview?.ok && (
              <Button
                disabled={disabled || inFlight}
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
            )}
            <Button
              variant="secondary"
              onClick={clear}
              disabled={disabled || (!text && !notice && !error && !activeReview)}
            >
              <Icon name="trash" size={15} />
              {t("bewauto.clearInput")}
            </Button>
            <span className="min-w-0 text-xs leading-5 text-faint">
              {t("bewauto.smartHint")}
            </span>
          </div>
          {/* The check result — exactly which fields need attention. */}
          {activeReview && !activeReview.ok && (
            <div
              role="alert"
              className="mt-2.5 rounded-xl border border-warning/30 bg-warning-soft px-3 py-2.5"
            >
              <p className="text-xs font-semibold text-warning">
                {t("bewauto.reviewIssues")}
              </p>
              <ul className="mt-1 list-disc space-y-0.5 ps-4 text-xs leading-5 text-warning">
                {activeReview.issues.map((code) => (
                  <li key={code}>{errText(code)}</li>
                ))}
              </ul>
            </div>
          )}
          {activeReview?.ok && (
            <p
              role="status"
              className="mt-2.5 flex items-start gap-2 text-xs font-medium text-success"
            >
              <Icon name="check" size={14} className="mt-0.5 shrink-0" />
              <span>{t("bewauto.reviewReady")}</span>
            </p>
          )}
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

        {/* -------- detected information (live preview) -------- */}
        <div className="min-w-0 rounded-2xl border border-line bg-surface p-4">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-bold text-ink">
              {t("bewauto.detectedTitle")}
            </h3>
            <span className="rounded-full border border-accent/40 bg-accent-soft px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-accent">
              {t("bewauto.livePreview")}
            </span>
          </div>
          <dl className="mt-3 space-y-2.5">
            <PreviewRow icon="briefcase" label={t("bewauto.colCompany")} field={panelParsed?.companyName} t={t} />
            <PreviewRow icon="user" label={t("bewauto.colContact")} field={panelParsed?.contactName} t={t} />
            <PreviewRow icon="pin" label={t("bewauto.colAddress")} field={panelParsed?.companyAddress} t={t} />
            <PreviewRow icon="phone" label={t("bewauto.colPhone")} field={panelParsed?.companyPhone} t={t} maxLen={80} />
            <PreviewRow icon="mail" label={t("bewauto.colEmail")} field={panelParsed?.companyEmail} t={t} />
            <PreviewRow icon="target" label={t("bewauto.positionTitle")} field={panelParsed?.positionTitle} t={t} />
            <PreviewRow icon="building" label={t("bewauto.colIndustry")} field={panelParsed?.companyIndustry} t={t} maxLen={120} />
          </dl>

          {/* AI-step status (review only, text-only, non-sensitive code):
              tells the owner WHICH fallback produced the fields when the
              dedicated Gemini key was not usable — production diagnosis
              without server logs. Hidden on the AI-success path ("ai") and
              before a check exists (live preview). */}
          {activeReview && activeReview.diagnostic && activeReview.diagnostic !== "ai" && (
            <p className="mt-2 text-[11px] font-medium text-muted">
              {t("bewauto.aiStatus", { code: activeReview.diagnostic })}
            </p>
          )}

          {/* Dedicated job-description area (multi-line, expandable). */}
          <div className="mt-3 border-t border-line pt-3">
            <div className="flex flex-wrap items-center gap-2">
              <Icon name="file" size={14} className="text-accent" />
              <span className="text-xs font-semibold text-muted">
                {t("bewauto.smartJobDescription")}
              </span>
              {panelParsed?.positionBrief.status === "suggested" && (
                <span className="rounded-full bg-warning-soft px-2 py-0.5 text-[10px] font-semibold text-warning">
                  {t("bewauto.smartReview")}
                </span>
              )}
              {panelParsed?.positionBrief.status === "invalid" && (
                <span className="rounded-full bg-danger-soft px-2 py-0.5 text-[10px] font-semibold text-danger">
                  {t("bewauto.previewInvalid")}
                </span>
              )}
            </div>
            {panelParsed?.positionBrief.value ? (
              <>
                <div
                  className={`mt-1.5 whitespace-pre-wrap rounded-xl border border-line bg-surface-2/60 p-2.5 text-xs leading-5 text-ink ${
                    briefExpanded
                      ? "max-h-48 overflow-y-auto"
                      : "line-clamp-5"
                  }`}
                >
                  {panelParsed.positionBrief.value}
                </div>
                {panelParsed.positionBrief.problem === "too_long" && (
                  <p className="mt-1 text-[11px] font-medium text-danger">
                    {t("bewauto.previewTooLong", { max: 4000 })}
                  </p>
                )}
                {panelParsed.positionBrief.value.length > 220 && (
                  <button
                    type="button"
                    onClick={() => setBriefExpanded((v) => !v)}
                    className="mt-1.5 text-xs font-semibold text-accent hover:underline"
                  >
                    {briefExpanded ? t("bewauto.collapseText") : t("bewauto.showFullText")}
                  </button>
                )}
              </>
            ) : (
              <p className="mt-1.5 text-xs text-faint">
                — {panelParsed ? t("bewauto.smartMissing") : t("bewauto.smartPlaceholder")}
              </p>
            )}
          </div>

          {/* Live check (client only; the server re-checks everything on
              check/confirm) — ALL blocking issues are listed, not just the
              first, so the exact fields needing attention are visible
              before "Check information" is even clicked. Suppressed while a
              review is active: the frozen server result (and its issue
              list, shown under the input) is the source of truth then. */}
          {!panelParsed && <p className="mt-3 text-xs text-faint">{t("bewauto.smartBody")}</p>}
          {!activeReview && liveCheck && !liveCheck.ok && (
            <ul className="mt-3 list-disc space-y-0.5 ps-4 text-xs font-medium text-warning">
              {liveCheck.issues.map((code) => (
                <li key={code}>{errText(code)}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
});

/* ------------------------------------------------------------------ */

function PreviewRow({
  icon,
  label,
  field,
  t,
  maxLen,
}: {
  icon: IconName;
  label: string;
  field: ParsedAdField | undefined;
  t: T;
  /** DB column cap for the "too long" hint (falls back to the position-title
   *  / brief rule when the row is one of those). */
  maxLen?: number;
}) {
  const status = field?.status ?? "missing";
  const value = field?.value ?? "";
  const limit =
    maxLen ?? (label === t("bewauto.positionTitle") ? 160 : 4000);
  return (
    <div className="flex items-start gap-2.5">
      <Icon name={icon} size={14} className="mt-0.5 shrink-0 text-accent" />
      <dt className="w-28 shrink-0 pt-0.5 text-xs font-semibold text-muted">
        {label}
      </dt>
      <dd className="min-w-0 flex-1 break-words pt-0.5 text-xs leading-5">
        {status === "missing" ? (
          <span className="text-faint">— {t("bewauto.smartMissing")}</span>
        ) : (
          <span
            className={
              status === "extracted"
                ? "text-ink"
                : status === "suggested"
                  ? "text-warning"
                  : "text-danger"
            }
          >
            {value}
          </span>
        )}
        {status === "suggested" && (
          <span className="ms-2 inline-block rounded-full bg-warning-soft px-2 py-0.5 align-middle text-[10px] font-semibold text-warning">
            {t("bewauto.smartReview")}
          </span>
        )}
        {status === "invalid" && (
          <span className="mt-1 block text-[11px] font-medium text-danger">
             {field?.problem === "too_long"
               ? t("bewauto.previewTooLong", { max: limit })
               : t("bewauto.previewInvalid")}
          </span>
        )}
      </dd>
    </div>
  );
}
