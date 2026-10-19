"use client";

/**
 * Step 1 — "Add companies (smart input)".
 *
 * Paste a company block or a complete German job advertisement → the shared
 * deterministic parser (`@/lib/bew-ad-parser`) extracts the supported fields
 * LIVE next to the input (with extracted / needs-review / missing / invalid
 * states) → "Auto-organize" sends the RAW text to the `bewAddCompany` server
 * action, which re-parses, re-validates and appends ONE independent row.
 *
 * The input is cleared ONLY after the server has persisted the row; on any
 * failure the pasted text is kept, so nothing the user typed can be lost.
 * The component is memoized and the parse is debounced (the textarea itself
 * stays fully controlled and instant), so the surrounding 100-row table does
 * not re-render on every keystroke.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { bewAddCompany } from "@/app/bewerbung-automation/actions";
import { Button } from "@/components/ui";
import { Icon, type IconName } from "@/components/icon";
import {
  BEW_AD_INPUT_MAX,
  parseAdvertisement,
  type ParsedAdField,
} from "@/lib/bew-ad-parser";
import {
  precheckSmartAdd,
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
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [briefExpanded, setBriefExpanded] = useState(false);
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

  /** Live preview (debounced) — the SAME parser the server runs. */
  const parsed = useMemo(
    () => (debounced.trim() ? parseAdvertisement(debounced) : null),
    [debounced],
  );

  /** Precheck for the preview hint (client only — the server re-runs it). */
  const precheck = useMemo(
    () => precheckSmartAdd(parsed, view.applications),
    [parsed, view.applications],
  );

  const errText = useCallback(
    (code: string) => {
      const key = `bewauto.err.${code}`;
      const translated = t(key);
      return translated === key ? t("bewauto.err.UNKNOWN") : translated;
    },
    [t],
  );

  const clear = useCallback(() => {
    setText("");
    setDebounced("");
    setNotice(null);
    setError(null);
    setBriefExpanded(false);
  }, []);

  const submit = useCallback(async () => {
    if (disabled) return;
    setError(null);
    setNotice(null);
    // The pure orchestration (runSmartAdd) owns the safety contract:
    // precheck before any request, onRowAdded (→ input clear) only after
    // the server confirmed, claim guard against rapid double clicks.
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
        add: async (raw) => {
          const fd = new FormData();
          fd.set("campaignId", campaignId);
          fd.set("text", raw);
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
  }, [text, view.applications, disabled, campaignId, onRowAdded, onRefresh, t, errText, router]);

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
            <Button
              disabled={disabled || inFlight}
              onClick={() => void submit()}
              aria-busy={inFlight || undefined}
            >
              {inFlight ? (
                <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
              ) : (
                <Icon name="spark" size={16} />
              )}
              {t("bewauto.autoOrganize")}
              <Icon name="arrowRight" size={16} />
            </Button>
            <Button
              variant="secondary"
              onClick={clear}
              disabled={disabled || (!text && !notice && !error)}
            >
              <Icon name="trash" size={15} />
              {t("bewauto.clearInput")}
            </Button>
            <span className="min-w-0 text-xs leading-5 text-faint">
              {t("bewauto.smartHint")}
            </span>
          </div>
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
            <PreviewRow icon="briefcase" label={t("bewauto.colCompany")} field={parsed?.companyName} t={t} />
            <PreviewRow icon="user" label={t("bewauto.colContact")} field={parsed?.contactName} t={t} />
            <PreviewRow icon="pin" label={t("bewauto.colAddress")} field={parsed?.companyAddress} t={t} />
            <PreviewRow icon="mail" label={t("bewauto.colEmail")} field={parsed?.companyEmail} t={t} />
            <PreviewRow icon="target" label={t("bewauto.positionTitle")} field={parsed?.positionTitle} t={t} />
          </dl>

          {/* Dedicated job-description area (multi-line, expandable). */}
          <div className="mt-3 border-t border-line pt-3">
            <div className="flex flex-wrap items-center gap-2">
              <Icon name="file" size={14} className="text-accent" />
              <span className="text-xs font-semibold text-muted">
                {t("bewauto.smartJobDescription")}
              </span>
              {parsed?.positionBrief.status === "suggested" && (
                <span className="rounded-full bg-warning-soft px-2 py-0.5 text-[10px] font-semibold text-warning">
                  {t("bewauto.smartReview")}
                </span>
              )}
              {parsed?.positionBrief.status === "invalid" && (
                <span className="rounded-full bg-danger-soft px-2 py-0.5 text-[10px] font-semibold text-danger">
                  {t("bewauto.previewInvalid")}
                </span>
              )}
            </div>
            {parsed?.positionBrief.value ? (
              <>
                <div
                  className={`mt-1.5 whitespace-pre-wrap rounded-xl border border-line bg-surface-2/60 p-2.5 text-xs leading-5 text-ink ${
                    briefExpanded
                      ? "max-h-48 overflow-y-auto"
                      : "line-clamp-5"
                  }`}
                >
                  {parsed.positionBrief.value}
                </div>
                {parsed.positionBrief.problem === "too_long" && (
                  <p className="mt-1 text-[11px] font-medium text-danger">
                    {t("bewauto.previewTooLong", { max: 4000 })}
                  </p>
                )}
                {parsed.positionBrief.value.length > 220 && (
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
                — {parsed ? t("bewauto.smartMissing") : t("bewauto.smartPlaceholder")}
              </p>
            )}
          </div>

          {/* Precheck hint (client only; the server re-checks everything). */}
          {!parsed && <p className="mt-3 text-xs text-faint">{t("bewauto.smartBody")}</p>}
          {parsed && !precheck.ok && (
            <p className="mt-3 text-xs font-medium text-warning">
              {errText(precheck.code as SmartAddFailCode)}
            </p>
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
}: {
  icon: IconName;
  label: string;
  field: ParsedAdField | undefined;
  t: T;
}) {
  const status = field?.status ?? "missing";
  const value = field?.value ?? "";
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
              ? t("bewauto.previewTooLong", {
                  max: label === t("bewauto.positionTitle") ? 160 : 4000,
                })
              : t("bewauto.previewInvalid")}
          </span>
        )}
      </dd>
    </div>
  );
}
