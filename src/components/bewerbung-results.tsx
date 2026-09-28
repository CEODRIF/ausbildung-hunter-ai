"use client";

import { useState } from "react";
import Link from "next/link";
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
  const [profile, setProfile] = useState(initialProfile);
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState(false);
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
        [group]: [...profile.skills[group], "New skill"],
      },
    });
  return (
    <main className="min-h-screen bg-[#f6f8fb] px-5 py-8 sm:px-8 lg:px-10">
      <div className="mx-auto max-w-6xl">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
          <div>
            <Link
              href="/bewerbung-scanner"
              className="text-sm font-semibold text-[#2f6fed]"
            >
              ← Scan again
            </Link>
            <p className="mt-7 text-sm font-semibold text-[#2f6fed]">
              Candidate profile ·{" "}
              {profile.goal === "ausbildung" ? "Ausbildung" : "Arbeit"}
            </p>
            <h1 className="mt-2 text-3xl font-bold tracking-[-0.04em] text-[#10203b]">
              Your Bewerbung profile
            </h1>
            <p className="mt-2 text-sm text-[#71819a]">
              AI extracted information is shown with a clear review path. User
              corrections are preserved.
            </p>
          </div>
          <button
            type="button"
            onClick={() => (editing ? void save() : setEditing(true))}
            className="h-10 rounded-xl bg-[#2f6fed] px-4 text-xs font-bold text-white"
          >
            {editing ? "Save corrections" : "Edit profile"}
          </button>
        </div>
        {saved && (
          <p className="mt-5 rounded-xl border border-[#ccefe1] bg-[#f3fcf8] px-4 py-3 text-sm font-medium text-[#187e5b]">
            Profile corrections saved.
          </p>
        )}
        <div className="mt-8 grid gap-5 lg:grid-cols-[1.2fr_0.8fr]">
          <section className="space-y-5">
            <Section title="Candidate">
              <div className="grid gap-4 sm:grid-cols-2">
                <Editable
                  label="Full name"
                  value={profile.candidate.full_name ?? "Not found"}
                  editing={editing}
                  onChange={(value) =>
                    update({
                      ...profile,
                      candidate: { ...profile.candidate, full_name: value },
                    })
                  }
                />
                <Editable
                  label="Location"
                  value={profile.candidate.location ?? "Not found"}
                  editing={editing}
                  onChange={(value) =>
                    update({
                      ...profile,
                      candidate: { ...profile.candidate, location: value },
                    })
                  }
                />
              </div>
              <p className="mt-4 text-xs text-[#8290a4]">
                Contact: {profile.candidate.contact.email || "Not found"} ·{" "}
                {profile.candidate.contact.phone || "Not found"}
              </p>
            </Section>
            <Section title="Education">
              <Timeline
                items={profile.education.map((item) =>
                  [
                    item.education_level || "Education",
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
                )}
              />
            </Section>
            <Section title="Experience">
              <Timeline
                items={profile.experience.map(
                  (item) =>
                    `${item.job_title}${item.company ? ` · ${item.company}` : ""}${item.start_date || item.end_date ? ` (${item.start_date || "?"}–${item.end_date || "present"})` : ""}`,
                )}
              />
            </Section>
          </section>
          <aside className="space-y-5">
            <Section title="Target roles">
              <div className="space-y-3">
                {profile.target_roles.length ? (
                  profile.target_roles.map((role) => (
                    <div
                      key={role.role}
                      className="rounded-xl border border-[#e7ecf3] bg-white p-4"
                    >
                      <p className="text-sm font-bold text-[#1d3458]">
                        {role.role}
                      </p>
                      <p className="mt-1 text-xs leading-5 text-[#8290a4]">
                        {role.reason}
                      </p>
                    </div>
                  ))
                ) : (
                  <Empty text="No supported target roles found." />
                )}
              </div>
            </Section>
            <Section title="Skills">
              <div className="flex flex-wrap gap-2">
                {Object.values(profile.skills)
                  .flat()
                  .map((skill, index) => (
                    <span
                      key={`${skill}-${index}`}
                      className="rounded-lg bg-[#edf3ff] px-2.5 py-1.5 text-xs font-semibold text-[#2f6fed]"
                    >
                      {skill}
                    </span>
                  ))}
                {editing && (
                  <button
                    type="button"
                    onClick={() => addSkill("technical")}
                    className="rounded-lg border border-dashed border-[#b9c9e2] px-2.5 py-1.5 text-xs font-semibold text-[#2f6fed]"
                  >
                    + Add skill
                  </button>
                )}
              </div>
            </Section>
            <Section title="Languages">
              <div className="space-y-2">
                {profile.languages.length ? (
                  profile.languages.map((language) => (
                    <div
                      key={language.language}
                      className="flex justify-between rounded-xl bg-white p-3 text-xs"
                    >
                      <span className="font-semibold text-[#1d3458]">
                        {language.language}
                      </span>
                      <span className="text-[#8290a4]">
                        {language.level || "Level not stated"}
                        {language.level_is_inferred ? " · inferred" : ""}
                      </span>
                    </div>
                  ))
                ) : (
                  <Empty text="No supported languages found." />
                )}
              </div>
            </Section>
          </aside>
        </div>
        <div className="mt-5 grid gap-5 lg:grid-cols-3">
          <ListSection
            title="Strengths"
            items={profile.strengths}
            tone="success"
          />
          <ListSection
            title="Missing information"
            items={profile.missing_information}
            tone="neutral"
          />
          <ListSection
            title="Potential concerns"
            items={profile.potential_concerns}
            tone="warning"
          />
        </div>
        <Section title="Keywords">
          <div className="flex flex-wrap gap-2">
            {profile.keywords.map((keyword) => (
              <span
                key={keyword}
                className="rounded-lg bg-[#f1f4f8] px-2.5 py-1.5 text-xs font-semibold text-[#546783]"
              >
                {keyword}
              </span>
            ))}
          </div>
        </Section>
        <Section title="Scan history">
          <div className="flex flex-wrap gap-2">
            {history.map((item) => (
              <Link
                key={item.id}
                href={`/bewerbung-scanner/${item.id}`}
                className="rounded-xl border border-[#e7ecf3] bg-white px-3 py-2 text-xs font-semibold text-[#546783]"
              >
                {item.goal} · {item.status} ·{" "}
                {new Date(item.created_at).toLocaleDateString("en")}
              </Link>
            ))}
          </div>
        </Section>
      </div>
    </main>
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
    <section className="rounded-2xl border border-[#e7ecf3] bg-white p-5 sm:p-6">
      <h2 className="font-bold text-[#1d3458]">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}
function Timeline({ items }: { items: string[] }) {
  return items.length ? (
    <div className="space-y-3">
      {items.map((item, index) => (
        <div
          key={`${item}-${index}`}
          className="border-l-2 border-[#dce8ff] pl-4 text-sm leading-6 text-[#546783]"
        >
          <span className="mr-2 inline-block rounded-md bg-[#f4f7fc] px-1.5 py-0.5 text-[10px] font-bold uppercase text-[#2f6fed]">
            AI extracted
          </span>
          {item}
        </div>
      ))}
    </div>
  ) : (
    <Empty text="No supported information found." />
  );
}
function Editable({
  label,
  value,
  editing,
  onChange,
}: {
  label: string;
  value: string;
  editing: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="text-xs text-[#8290a4]">{label}</span>
      {editing ? (
        <input
          className="mt-1 h-10 w-full rounded-xl border border-[#dfe6f0] px-3 text-sm text-[#1d3458]"
          value={value === "Not found" ? "" : value}
          onChange={(event) => onChange(event.target.value || (null as never))}
        />
      ) : (
        <p className="mt-1 text-sm font-semibold text-[#1d3458]">{value}</p>
      )}
    </label>
  );
}
function ListSection({
  title,
  items,
  tone,
}: {
  title: string;
  items: string[];
  tone: "success" | "neutral" | "warning";
}) {
  const colors = {
    success: "text-[#187e5b]",
    neutral: "text-[#546783]",
    warning: "text-[#a56a1e]",
  };
  return (
    <Section title={title}>
      <ul className={`space-y-2 text-sm leading-6 ${colors[tone]}`}>
        {items.length ? (
          items.map((item) => <li key={item}>• {item}</li>)
        ) : (
          <li className="text-[#8290a4]">
            None identified from the uploaded documents.
          </li>
        )}
      </ul>
    </Section>
  );
}
function Empty({ text }: { text: string }) {
  return <p className="text-xs text-[#8290a4]">{text}</p>;
}
