"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useI18n } from "@/lib/i18n";
import { localeForLang } from "@/lib/i18n/core";
import { bulkDeleteScans } from "@/app/bewerbung-scanner/actions";
import type { CandidateProfile } from "@/lib/bewerbung-schema";

export function BewerbungResults({
  scanId,
  profile: initialProfile,
  history,
}: {
  scanId: string;
  profile: CandidateProfile;
  history: Array<{
    id: string;
    status: string;
    goal: string;
    created_at: string;
  }>;
}) {
  const { t, lang } = useI18n();
  const locale = localeForLang(lang);
  const [profile, setProfile] = useState(initialProfile);
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState(false);
  // Phase 19 — bulk selection (UX state only; every check is re-run
  // server-side by the bulkDeleteScans action).
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const selectableHistory = history.filter((item) => item.id !== scanId);
  const toggleSelected = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const update = (next: CandidateProfile) => {
    setProfile({ ...next });
    setSaved(false);
  };
  const save = async () => {
    const response = await fetch(`/api/bewerbung-scanner/${scanId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile }),
    });
    if (!response.ok) return;
    setSaved(true);
    setEditing(false);
  };
  const addSkill = (group: keyof CandidateProfile["skills"]) =>
    update({
      ...profile,
      skills: {
        ...profile.skills,
        [group]: [...profile.skills[group], t("profile.newSkill")],
      },
    });
  const notFound = t("profile.notFound");
  return (
    <div className="px-4 py-6 sm:px-6 lg:px-10">
      <div className="mx-auto max-w-6xl">
        <div className="mt-2 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
          <div>
            <p className="text-sm font-semibold text-accent">
              {t("profile.candidate")} ·{" "}
              {profile.goal === "ausbildung"
                ? t("dash.goalAusbildung")
                : t("dash.goalArbeit")}
            </p>
            <h2 className="mt-2 text-2xl font-bold tracking-[-0.04em] text-ink">
              {t("profile.title")}
            </h2>
            <p className="mt-2 text-sm text-muted">
              {t("profile.note")}
            </p>
          </div>
          <button
            type="button"
            onClick={() => (editing ? void save() : setEditing(true))}
            className="h-10 shrink-0 rounded-xl bg-accent px-4 text-xs font-bold text-white"
          >
            {editing ? t("profile.save") : t("profile.edit")}
          </button>
        </div>
        {saved && (
          <p className="mt-5 rounded-xl border border-success/25 bg-success-soft px-4 py-3 text-sm font-medium text-success">
            {t("profile.saved")}
          </p>
        )}
        <div className="mt-8 grid gap-5 lg:grid-cols-[1.2fr_0.8fr]">
          <section className="space-y-5">
            <Section title={t("profile.candidate")}>
              <div className="grid gap-4 sm:grid-cols-2">
                <Editable
                  label={t("profile.fullName")}
                  value={profile.candidate.full_name ?? notFound}
                  notFound={notFound}
                  editing={editing}
                  onChange={(value) =>
                    update({
                      ...profile,
                      candidate: { ...profile.candidate, full_name: value },
                    })
                  }
                />
                <Editable
                  label={t("profile.location")}
                  value={profile.candidate.location ?? notFound}
                  notFound={notFound}
                  editing={editing}
                  onChange={(value) =>
                    update({
                      ...profile,
                      candidate: { ...profile.candidate, location: value },
                    })
                  }
                />
              </div>
              <p className="mt-4 text-xs text-muted">
                {t("profile.contact")}:{" "}
                {profile.candidate.contact.email || notFound} ·{" "}
                {profile.candidate.contact.phone || notFound}
                {profile.candidate.contact.linkedin
                  ? ` · ${profile.candidate.contact.linkedin}`
                  : ""}
              </p>
            </Section>
            <Section title={t("profile.education")}>
              <Timeline
                t={t}
                items={profile.education.map((item) => ({
                  text: [
                    item.education_level || t("profile.education"),
                    [
                      item.school,
                      item.university,
                      item.degree,
                      item.field_of_study,
                    ]
                      .filter(Boolean)
                      .join(" · "),
                    item.graduation_year ? String(item.graduation_year) : "",
                  ]
                    .filter(Boolean)
                    .join(" — "),
                }))}
              />
            </Section>
            <Section title={t("profile.training")}>
              <Timeline
                t={t}
                items={profile.training.map((item) => ({
                  text: [
                    item.name,
                    item.provider ? `· ${item.provider}` : "",
                    item.year ? `(${item.year})` : "",
                  ]
                    .filter(Boolean)
                    .join(" "),
                }))}
              />
            </Section>
            <Section title={t("profile.experience")}>
              <Timeline
                t={t}
                items={profile.experience.map((item) => ({
                  text: `${item.job_title}${item.company ? ` · ${item.company}` : ""}${item.start_date || item.end_date ? ` (${item.start_date || "?"}–${item.end_date || t("profile.present")})` : ""}`,
                  details: item.responsibilities,
                }))}
              />
            </Section>
          </section>
          <aside className="space-y-5">
            <Section title={t("profile.targetRoles")}>
              <div className="space-y-3">
                {profile.target_roles.length ? (
                  profile.target_roles.map((role) => (
                    <div
                      key={role.role}
                      className="rounded-xl border border-line bg-surface p-4"
                    >
                      <p className="text-sm font-bold text-ink-soft">
                        {role.role}
                      </p>
                      <p className="mt-1 text-xs leading-5 text-muted">
                        {role.reason}
                      </p>
                    </div>
                  ))
                ) : (
                  <Empty text={t("profile.noRoles")} />
                )}
              </div>
            </Section>
            <Section title={t("profile.skills")}>
              {Object.values(profile.skills).flat().length === 0 &&
                !editing && <Empty text={t("profile.noSupportedInfo")} />}
              <div className="flex flex-wrap gap-2">
                {Object.values(profile.skills)
                  .flat()
                  .map((skill, index) => (
                    <span
                      key={`${skill}-${index}`}
                      className="rounded-lg bg-accent-soft px-2.5 py-1.5 text-xs font-semibold text-accent"
                    >
                      {skill}
                    </span>
                  ))}
                {editing && (
                  <button
                    type="button"
                    onClick={() => addSkill("technical")}
                    className="rounded-lg border border-dashed border-line-strong px-2.5 py-1.5 text-xs font-semibold text-accent"
                  >
                    + {t("profile.addSkill")}
                  </button>
                )}
              </div>
            </Section>
            <Section title={t("profile.languages")}>
              <div className="space-y-2">
                {profile.languages.length ? (
                  profile.languages.map((language) => (
                    <div
                      key={language.language}
                      className="flex justify-between rounded-xl bg-surface p-3 text-xs"
                    >
                      <span className="font-semibold text-ink-soft">
                        {language.language}
                      </span>
                      <span className="text-muted">
                        {language.level || t("profile.levelNotStated")}
                        {language.level_is_inferred
                          ? ` · ${t("profile.inferred")}`
                          : ""}
                      </span>
                    </div>
                  ))
                ) : (
                  <Empty text={t("profile.noLanguages")} />
                )}
              </div>
            </Section>
          </aside>
        </div>
        <div className="mt-5 grid gap-5 lg:grid-cols-3">
          <ListSection
            t={t}
            title={t("profile.strengths")}
            items={profile.strengths}
            tone="success"
          />
          <ListSection
            t={t}
            title={t("profile.missing")}
            items={profile.missing_information}
            tone="neutral"
          />
          <ListSection
            t={t}
            title={t("profile.concerns")}
            items={profile.potential_concerns}
            tone="warning"
          />
        </div>
        <Section title={t("profile.keywords")}>
          {profile.keywords.length === 0 ? (
            <Empty text={t("profile.noSupportedInfo")} />
          ) : (
            <div className="flex flex-wrap gap-2">
              {profile.keywords.map((keyword, index) => (
                <span
                  key={`${keyword}-${index}`}
                  className="rounded-lg bg-surface-2 px-2.5 py-1.5 text-xs font-semibold text-muted"
                >
                  {keyword}
                </span>
              ))}
            </div>
          )}
        </Section>
        <Section title={t("profile.scanHistory")}>
          <div className="flex flex-wrap gap-2">
            {history.map((item) => {
              const selectable = item.id !== scanId;
              const dateLabel = new Date(item.created_at).toLocaleDateString(
                locale,
              );
              return (
                <span
                  key={item.id}
                  className="flex items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2"
                >
                  {selectable && (
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-accent"
                      checked={selected.has(item.id)}
                      onChange={() => toggleSelected(item.id)}
                      aria-label={`Scan vom ${dateLabel} auswählen`}
                    />
                  )}
                  <Link
                    href={`/bewerbung-scanner/${item.id}`}
                    className="text-xs font-semibold text-muted"
                  >
                    {item.goal} · {item.status} · {dateLabel}
                  </Link>
                </span>
              );
            })}
          </div>
          {selectableHistory.length > 0 && (
            /* Phase 19 — bulk delete of the selected scans. The browser
             * only submits ids; ownership, limits and validation happen
             * server-side. */
            <form
              action={bulkDeleteScans}
              className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-danger/25 bg-danger-soft px-4 py-3"
            >
              <input type="hidden" name="currentScanId" value={scanId} />
              {[...selected].map((id) => (
                <input key={id} type="hidden" name="scanId" value={id} />
              ))}
              <span className="text-xs font-semibold text-muted">
                {t("profile.selectedOf", {
                  selected: selected.size,
                  total: selectableHistory.length,
                })}
              </span>
              <BulkDeleteButton t={t} count={selected.size} />
            </form>
          )}
        </Section>
      </div>
    </div>
  );
}
/** Phase 19 — two-step confirmation for bulk scan deletion (UX only; the
 *  server re-validates every id before touching anything). First click
 *  arms the button for five seconds; the second submits the form. */
function BulkDeleteButton({
  t,
  count,
}: {
  t: (path: string, vars?: Record<string, string | number>) => string;
  count: number;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), 5000);
    return () => window.clearTimeout(timer);
  }, [armed]);
  return (
    <button
      type="submit"
      disabled={count === 0}
      className={
        armed
          ? "rounded-lg bg-danger px-3 py-2 text-xs font-semibold text-white hover:bg-danger"
          : "rounded-lg border border-danger/25 px-3 py-2 text-xs font-semibold text-danger hover:bg-surface disabled:cursor-not-allowed disabled:opacity-50"
      }
      onClick={(event) => {
        if (!armed) {
          event.preventDefault();
          setArmed(true);
        }
      }}
    >
      {armed
        ? t("profile.confirmDelete", { count })
        : t("profile.deleteSelected")}
    </button>
  );
}
function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-line bg-surface p-5 sm:p-6">
      <h2 className="font-bold text-ink-soft">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}
function Timeline({
  t,
  items,
}: {
  t: (path: string, vars?: Record<string, string | number>) => string;
  items: Array<{ text: string; details?: string[] }>;
}) {
  return items.length ? (
    <div className="space-y-3">
      {items.map((item, index) => (
        <div
          key={`${item.text}-${index}`}
          className="border-s-2 border-accent/25 ps-4 text-sm leading-6 text-muted"
        >
          <span className="me-2 inline-block rounded-md bg-surface-2 px-1.5 py-0.5 text-[10px] font-bold uppercase text-accent">
            {t("profile.aiExtracted")}
          </span>
          {item.text}
          {item.details && item.details.length > 0 && (
            <ul className="mt-1.5 list-disc space-y-1 ps-5 text-xs leading-5">
              {item.details.map((detail, detailIndex) => (
                <li key={`${detail}-${detailIndex}`}>{detail}</li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  ) : (
    <Empty text={t("profile.noSupportedInfo")} />
  );
}
function Editable({
  label,
  value,
  notFound,
  editing,
  onChange,
}: {
  label: string;
  value: string;
  notFound: string;
  editing: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="text-xs text-muted">{label}</span>
      {editing ? (
        <input
          className="mt-1 h-10 w-full rounded-xl border border-line-strong bg-surface px-3 text-sm text-ink-soft"
          value={value === notFound ? "" : value}
          onChange={(event) => onChange(event.target.value || (null as never))}
        />
      ) : (
        <p className="mt-1 text-sm font-semibold text-ink-soft">{value}</p>
      )}
    </label>
  );
}
function ListSection({
  t,
  title,
  items,
  tone,
}: {
  t: (path: string, vars?: Record<string, string | number>) => string;
  title: string;
  items: string[];
  tone: "success" | "neutral" | "warning";
}) {
  const colors = {
    success: "text-success",
    neutral: "text-muted",
    warning: "text-warning",
  };
  return (
    <Section title={title}>
      <ul className={`space-y-2 text-sm leading-6 ${colors[tone]}`}>
        {items.length ? (
          items.map((item) => <li key={item}>• {item}</li>)
        ) : (
          <li className="text-muted">{t("profile.noneIdentified")}</li>
        )}
      </ul>
    </Section>
  );
}
function Empty({ text }: { text: string }) {
  return <p className="text-xs text-muted">{text}</p>;
}
