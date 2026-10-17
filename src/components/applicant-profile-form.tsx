"use client";

import {
  useRef,
  useState,
  useTransition,
  type FormEvent,
} from "react";
import { updateApplicantProfile } from "@/app/settings/profile/actions";
import { Icon } from "@/components/icon";
import { useI18n } from "@/lib/i18n";
import {
  APPLICANT_FIELD_MAX,
  validateApplicantProfile,
  type ApplicantProfileField,
} from "@/lib/bewerbung-automation";

/**
 * Applicant profile form (the seven mandatory fields of the Anschreiben
 * header): full name, street, postal code, city, country, e-mail, phone.
 *
 *  - Base = last PERSISTED values (updated only after a successful save);
 *    the working copy can be freely edited without touching the database.
 *  - ALL-OR-NOTHING: the server (and this form) only accepts a complete,
 *    valid set — an existing profile can never be degraded to a partial
 *    write, and nothing is ever saved as empty/fabricated.
 *  - The same pure rules (validateApplicantProfile) run on client AND
 *    server — the client check only prevents a known-bad round trip.
 *  - Double submission is blocked by an in-flight ref AND useTransition.
 *  - `supported=false` (migration 20261114000000 pending): the inputs are
 *    not rendered; a localized notice explains why (the section stays
 *    visible so the page is not a mystery).
 */

type Values = Record<ApplicantProfileField, string>;

type Status =
  | { kind: "success" }
  | { kind: "error"; code: "invalid_profile" | "columns_pending" | "unauthorized" | "failed" }
  | null;

export function ApplicantProfileForm({
  initial,
  supported,
}: {
  initial: Values;
  supported: boolean;
}) {
  const { t } = useI18n();
  const [base, setBase] = useState<Values>(initial);
  const [values, setValues] = useState<Values>(initial);
  const [status, setStatus] = useState<Status>(null);
  const [isPending, startTransition] = useTransition();
  const inFlight = useRef(false);

  const set = (field: ApplicantProfileField) => (v: string) => {
    setValues((prev) => ({ ...prev, [field]: v }));
  };

  const dirty = (Object.keys(values) as ApplicantProfileField[]).some(
    (f) => values[f].trim() !== base[f].trim(),
  );

  /** Per-field message (empty = no problem) — mirrors the server rules. */
  const fieldErrors: Record<ApplicantProfileField, string> = {
    fullName: "",
    street: "",
    postalCode: "",
    city: "",
    country: "",
    email: "",
    phone: "",
  };
  {
    const check = validateApplicantProfile(values);
    if (!check.ok) {
      for (const f of check.missing) fieldErrors[f] = t("profile.page.applicant.errorRequired");
      for (const f of check.invalid) {
        const v = (values[f] ?? "").trim();
        if (v.length > APPLICANT_FIELD_MAX[f])
          fieldErrors[f] = t("profile.page.applicant.errorTooLong");
        else if (f === "email") fieldErrors[f] = t("profile.page.applicant.errorEmail");
        else if (f === "phone") fieldErrors[f] = t("profile.page.applicant.errorPhone");
      }
    }
  }

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (inFlight.current || isPending || !supported) return;
    // Client pre-check (server re-validates — never trust the client alone).
    if (!validateApplicantProfile(values).ok) return;
    inFlight.current = true;
    setStatus(null);
    startTransition(async () => {
      const fd = new FormData();
      for (const f of [
        "fullName",
        "street",
        "postalCode",
        "city",
        "country",
        "email",
        "phone",
      ] as ApplicantProfileField[]) fd.set(f, values[f]);
      const result = await updateApplicantProfile(fd).catch(() => ({
        ok: false as const,
        error: "failed" as const,
      }));
      inFlight.current = false;
      if (result.ok) {
        setBase(values);
        setStatus({ kind: "success" });
      } else {
        setStatus({ kind: "error", code: result.error });
      }
    });
  };

  const onReset = () => {
    if (inFlight.current || isPending) return;
    setValues(base);
    setStatus(null);
  };

  if (!supported) {
    return (
      <p className="rounded-xl bg-surface-2 px-4 py-3 text-sm text-muted">
        {t("profile.page.applicant.pending")}
      </p>
    );
  }

  const fields: Array<{
    id: ApplicantProfileField;
    labelKey: "fullName" | "street" | "postalCode" | "city" | "country" | "email" | "phone";
    placeholderKey: "fullName" | "street" | "postalCode" | "city" | "country" | "email" | "phone";
    type: "text" | "email" | "tel";
  }> = [
    { id: "fullName", labelKey: "fullName", placeholderKey: "fullName", type: "text" },
    { id: "street", labelKey: "street", placeholderKey: "street", type: "text" },
    { id: "postalCode", labelKey: "postalCode", placeholderKey: "postalCode", type: "text" },
    { id: "city", labelKey: "city", placeholderKey: "city", type: "text" },
    { id: "country", labelKey: "country", placeholderKey: "country", type: "text" },
    { id: "email", labelKey: "email", placeholderKey: "email", type: "email" },
    { id: "phone", labelKey: "phone", placeholderKey: "phone", type: "tel" },
  ];

  const errorText =
    status && status.kind === "error"
      ? status.code === "invalid_profile"
        ? t("profile.page.applicant.errorInvalid")
        : t("profile.page.applicant.error")
      : null;

  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-4 sm:grid-cols-2">
      {fields.map((f) => {
        const label = t(`profile.page.applicant.labels.${f.labelKey}`);
        const error = fieldErrors[f.id];
        return (
          <div
            key={f.id}
            className={f.id === "fullName" ? "sm:col-span-2" : undefined}
          >
            <label
              htmlFor={`applicant-${f.id}`}
              className="mb-1.5 block text-xs font-semibold text-muted"
            >
              {label}
              <span className="ms-1 text-danger" aria-hidden="true">
                *
              </span>
            </label>
            <input
              id={`applicant-${f.id}`}
              name={f.id}
              type={f.type}
              value={values[f.id]}
              onChange={(e) => set(f.id)(e.target.value)}
              placeholder={t(`profile.page.applicant.placeholders.${f.placeholderKey}`)}
              autoComplete={
                f.id === "fullName"
                  ? "name"
                  : f.id === "street"
                    ? "street-address"
                    : f.id === "postalCode"
                      ? "postal-code"
                      : f.id === "city"
                        ? "address-level2"
                        : f.id === "country"
                          ? "country-name"
                          : f.id === "email"
                            ? "email"
                            : f.id === "phone"
                              ? "tel"
                              : undefined
              }
              required
              maxLength={APPLICANT_FIELD_MAX[f.id] + 10}
              aria-required="true"
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `applicant-${f.id}-error` : undefined}
              className={`w-full rounded-xl border bg-surface px-3.5 py-2.5 text-sm text-ink shadow-[var(--shadow-card)] outline-none transition-colors placeholder:text-faint focus:border-accent focus:ring-2 focus:ring-accent/30 ${
                error ? "border-danger/70" : "border-line-strong"
              }`}
            />
            {error && (
              <p
                id={`applicant-${f.id}-error`}
                role="alert"
                className="mt-1.5 text-xs font-medium text-danger"
              >
                {error}
              </p>
            )}
          </div>
        );
      })}

      <div className="sm:col-span-2 mt-1 flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={!dirty || isPending}
          className="inline-flex h-11 items-center gap-2 rounded-xl bg-accent px-5 text-sm font-bold text-white shadow-[var(--shadow-card)] transition-all hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Icon name="check" size={15} />
          {isPending
            ? t("profile.page.applicant.saving")
            : t("profile.page.applicant.save")}
        </button>
        {dirty && !isPending && (
          <button
            type="button"
            onClick={onReset}
            className="inline-flex h-11 items-center rounded-xl border border-line-strong bg-surface px-4 text-sm font-semibold text-muted transition-colors hover:text-ink"
          >
            {t("profile.page.edit.cancel")}
          </button>
        )}
        {status?.kind === "success" && (
          <p role="status" className="text-sm font-medium text-success">
            {t("profile.page.applicant.saved")}
          </p>
        )}
        {errorText && (
          <p role="alert" className="text-sm font-medium text-danger">
            {errorText}
          </p>
        )}
      </div>
    </form>
  );
}
