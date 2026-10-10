"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { createSendGate } from "@/lib/send-gate";
import { dictionaries, useI18n } from "@/lib/i18n";
import { localeForLang } from "@/lib/i18n/core";
import {
  SUPPORTED_TIMEZONES,
  formatScheduledLocal,
  offsetLabelAt,
  wallClockToUtc,
  type DstResolution,
  type WallClockTime,
} from "@/lib/schedule-time";

const SELECT_CLASS =
  "h-11 w-full rounded-2xl border border-line bg-surface px-3 text-xs font-medium text-ink shadow-[var(--shadow-card)] outline-none focus:border-accent focus:ring-4 focus:ring-accent/10";
const LABEL_CLASS = "text-[11px] font-bold text-ink-soft";

export type ScheduleDefaults = WallClockTime & { timeZone: string };

/**
 * Self-contained scheduling form: day/month/year + 24h hour/minute + IANA
 * timezone with a LIVE preview of the exact UTC instant that will be
 * stored. DST gaps are rejected, DST folds require an explicit user choice
 * — both computed here with the same pure function the server action
 * re-runs authoritatively. The browser clock only PREFILLS the defaults;
 * nothing about "is this in the future" is trusted from the client.
 *
 * Renders one <form> whose action is the given server action; the hidden
 * inputs carry scheduleYear..scheduleTimezone (+ dstResolution + any
 * extraHidden) so the payload is complete for both uses (new composer
 * dialog and campaign reschedule).
 */
export function ScheduleForm({
  action,
  extraHidden = [],
  defaults,
  submitLabel,
  pendingLabel,
  cancelLabel,
  onCancel,
}: {
  action: (formData: FormData) => void | Promise<void>;
  extraHidden?: Array<{ name: string; value: string }>;
  defaults?: ScheduleDefaults;
  submitLabel: string;
  pendingLabel: string;
  cancelLabel?: string;
  onCancel?: () => void;
}) {
  const { t, lang } = useI18n();
  const locale = localeForLang(lang);
  const months = dictionaries[lang].apps.schedule.months;

  // Default prefill: the campaign's CURRENT schedule (reschedule) or the
  // next half hour in the user's own zone if it is offered (new schedule).
  const initial = useMemo(() => {
    if (defaults) return defaults;
    const browserZone =
      typeof Intl !== "undefined"
        ? Intl.DateTimeFormat().resolvedOptions().timeZone
        : "";
    const zone =
      SUPPORTED_TIMEZONES.find((candidate) => candidate.id === browserZone)?.id ??
      "Europe/Berlin";
    const soon = new Date(Date.now() + 30 * 60_000);
    return {
      year: soon.getFullYear(),
      month: soon.getMonth() + 1,
      day: soon.getDate(),
      hour: soon.getHours(),
      minute: Math.ceil(soon.getMinutes() / 5) * 5 % 60,
      timeZone: zone,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [year, setYear] = useState(initial.year);
  const [month, setMonth] = useState(initial.month);
  const [day, setDay] = useState(initial.day);
  const [hour, setHour] = useState(initial.hour);
  const [minute, setMinute] = useState(initial.minute);
  const [timeZone, setTimeZone] = useState(initial.timeZone);
  const [resolution, setResolution] = useState<DstResolution | null>(null);
  const [isPending, startTransition] = useTransition();
  // One submit per operation: the gate rejects a second call in the same
  // tick (double click) and while the first request is in flight.
  const gate = useRef(createSendGate()).current;

  const currentYear = new Date().getFullYear();
  const years = [currentYear, currentYear + 1, currentYear + 2];
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

  // Live preview — same pure function, same rules, as the server action.
  // resolution === null keeps an ambiguous (fold) time unresolved; once the
  // user picks an occurrence the exact instant appears immediately.
  const preview = useMemo(() => {
    const wall: WallClockTime = { year, month, day, hour, minute };
    return wallClockToUtc(wall, timeZone, resolution);
  }, [year, month, day, hour, minute, timeZone, resolution]);

  const isAmbiguousUnresolved =
    !preview.ok && preview.reason === "ambiguous" && resolution === null;
  const isInPast =
    preview.ok && preview.utcMs - Date.now() < 60_000;
  const canSubmit =
    preview.ok && !isInPast && !isPending;

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!gate.begin()) return;
    const formData = new FormData(event.currentTarget);
    startTransition(async () => {
      try {
        await action(formData);
      } finally {
        gate.end();
      }
    });
  }

  return (
    <form action={action} onSubmit={handleSubmit} className="space-y-4">
      {extraHidden.map((field) => (
        <input key={field.name} type="hidden" name={field.name} value={field.value} />
      ))}
      <input type="hidden" name="scheduleYear" value={String(year)} />
      <input type="hidden" name="scheduleMonth" value={String(month)} />
      <input type="hidden" name="scheduleDay" value={String(day)} />
      <input type="hidden" name="scheduleHour" value={String(hour)} />
      <input type="hidden" name="scheduleMinute" value={String(minute)} />
      <input type="hidden" name="scheduleTimezone" value={timeZone} />
      <input type="hidden" name="dstResolution" value={resolution ?? ""} />

      <div className="grid grid-cols-3 gap-2">
        <div>
          <label className={LABEL_CLASS}>{t("apps.schedule.day")}</label>
          <select
            value={day}
            onChange={(event) => setDay(Number(event.target.value))}
            className={`mt-1 ${SELECT_CLASS}`}
          >
            {Array.from({ length: daysInMonth }, (_, index) => index + 1).map(
              (value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ),
            )}
          </select>
        </div>
        <div>
          <label className={LABEL_CLASS}>{t("apps.schedule.month")}</label>
          <select
            value={month}
            onChange={(event) => {
              const nextMonth = Number(event.target.value);
              setMonth(nextMonth);
              // Keep the day valid when the month gets shorter.
              const nextDays = new Date(Date.UTC(year, nextMonth, 0)).getUTCDate();
              if (day > nextDays) setDay(nextDays);
            }}
            className={`mt-1 ${SELECT_CLASS}`}
          >
            {months.map((name, index) => (
              <option key={name} value={index + 1}>
                {name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={LABEL_CLASS}>{t("apps.schedule.year")}</label>
          <select
            value={year}
            onChange={(event) => {
              const nextYear = Number(event.target.value);
              setYear(nextYear);
              const nextDays = new Date(Date.UTC(nextYear, month, 0)).getUTCDate();
              if (day > nextDays) setDay(nextDays);
            }}
            className={`mt-1 ${SELECT_CLASS}`}
          >
            {years.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className={LABEL_CLASS}>{t("apps.schedule.hour")}</label>
          <select
            value={hour}
            onChange={(event) => setHour(Number(event.target.value))}
            className={`mt-1 ${SELECT_CLASS}`}
          >
            {Array.from({ length: 24 }, (_, index) => index).map((value) => (
              <option key={value} value={value}>
                {String(value).padStart(2, "0")}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={LABEL_CLASS}>{t("apps.schedule.minute")}</label>
          <select
            value={minute}
            onChange={(event) => setMinute(Number(event.target.value))}
            className={`mt-1 ${SELECT_CLASS}`}
          >
            {Array.from({ length: 60 }, (_, index) => index).map((value) => (
              <option key={value} value={value}>
                {String(value).padStart(2, "0")}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <label className={LABEL_CLASS}>{t("apps.schedule.timezone")}</label>
        <select
          value={timeZone}
          onChange={(event) => {
            setTimeZone(event.target.value);
            // A zone change can turn an ambiguous time unique (or vice
            // versa) — drop the stale explicit resolution.
            setResolution(null);
          }}
          className={`mt-1 ${SELECT_CLASS}`}
        >
          {SUPPORTED_TIMEZONES.map((zone) => (
            <option key={zone.id} value={zone.id}>
              {zone.label}
            </option>
          ))}
        </select>
      </div>

      {/* Live preview of the EXACT instant the server will store. */}
      {preview.ok ? (
        <div
          className={`rounded-2xl px-4 py-3 text-xs font-semibold ${
            isInPast ? "bg-warning-soft text-warning" : "bg-accent-soft text-accent-deep"
          }`}
        >
          <p className="text-[10px] font-bold uppercase tracking-[0.12em] opacity-70">
            {t("apps.schedule.previewLabel")}
          </p>
          <p className="mt-1">
            {formatScheduledLocal(preview.utcIso, timeZone, locale)}{" "}
            <span className="opacity-80">
              ({offsetLabelAt(preview.utcIso, timeZone)} · {timeZone})
            </span>
          </p>
          {isInPast ? (
            <p className="mt-1">{t("apps.schedule.inPast")}</p>
          ) : (
            <p className="mt-1 leading-5 opacity-80">
              {t("apps.schedule.scheduleHint")}
            </p>
          )}
        </div>
      ) : isAmbiguousUnresolved ? (
        <div className="rounded-2xl bg-warning-soft px-4 py-3 text-xs font-semibold text-warning">
          <p>{t("apps.schedule.ambiguousTitle")}</p>
          <p className="mt-1 leading-5">{t("apps.schedule.ambiguousBody")}</p>
          <div className="mt-3 space-y-2">
            {(
              [
                ["start", t("apps.schedule.first"), preview.firstUtcIso],
                ["end", t("apps.schedule.second"), preview.secondUtcIso],
              ] as const
            ).map(([value, label, utcIso]) => (
              <label
                key={value}
                className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-line bg-surface px-3 py-2.5"
              >
                <input
                  type="radio"
                  name="dst-resolution"
                  value={value}
                  checked={resolution === value}
                  onChange={() => setResolution(value)}
                  className="mt-0.5 accent-accent-deep"
                />
                <span className="text-ink-soft">
                  {label}
                  <span className="mt-0.5 block font-normal text-muted">
                    {formatScheduledLocal(utcIso, timeZone, locale)}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </div>
      ) : (
        <div className="rounded-2xl bg-danger-soft px-4 py-3 text-xs font-semibold text-danger">
          {preview.reason === "nonexistent"
            ? t("apps.schedule.nonexistent")
            : t("apps.schedule.invalid")}
        </div>
      )}

      <div className="flex justify-end gap-3 pt-1">
        {cancelLabel && (
          <button
            type="button"
            onClick={onCancel}
            disabled={isPending}
            className="h-11 rounded-2xl border border-line bg-surface px-4 text-sm font-bold text-muted shadow-[var(--shadow-card)] transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {cancelLabel}
          </button>
        )}
        <button
          type="submit"
          disabled={!canSubmit}
          aria-busy={isPending}
          className="btn-neon flex h-11 items-center gap-2 rounded-2xl px-5 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-70"
        >
          {isPending && (
            <span
              aria-hidden="true"
              className="inline-block h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-white/40 border-t-white"
            />
          )}
          {isPending ? pendingLabel : submitLabel}
        </button>
      </div>
    </form>
  );
}
