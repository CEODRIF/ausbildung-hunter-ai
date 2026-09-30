import type { ReactNode } from "react";
import type {
  CvCertificate,
  CvDocument,
  CvEducation,
  CvExperience,
  CvProject,
} from "@/lib/templates/cv";
import {
  certificateVisible,
  educationVisible,
  experienceVisible,
  languageVisible,
  projectVisible,
} from "@/lib/templates/cv";

/**
 * "Professional Classic" — the single CV template.
 *
 * A pure presentational renderer of the CvDocument: no state, no network,
 * no editor chrome. Used twice:
 *   1. live preview (right column, scaled to fit)
 *   2. print root (portal on <body>, rendered only in @media print)
 * so the exported PDF is byte-for-byte the same document as the preview.
 *
 * Style: conservative German Lebenslauf — single column, strong typographic
 * hierarchy, subtle dividers, no colors beyond ink/gray/navy, ATS-friendly.
 * The sheet is ALWAYS light (paper): it never follows the dark theme, and
 * it stays LTR even when the UI language is Arabic.
 */

export const CV_SHEET_WIDTH = 794; // 210mm @ 96dpi
export const CV_SHEET_MIN_HEIGHT = 1123; // 297mm @ 96dpi

const INK = "#1c2430";
const MUTED = "#5b6470";
const FAINT = "#8a93a0";
const NAVY = "#16233c";
const RULE = "#d8dce3";

/** Localized labels for the document (resolved upstream — the renderer
 *  itself stays pure so it works inside the print portal). */
export interface CvLabels {
  summary: string;
  experience: string;
  education: string;
  skills: string;
  languages: string;
  certificates: string;
  projects: string;
  interests: string;
  /** "present"-style label for open-ended experience dates. */
  present: string;
  /** Accessible document title. */
  documentTitle: string;
}

interface Props {
  cv: CvDocument;
  labels: CvLabels;
}

export function CvDocument({ cv, labels }: Props) {
  const presentLabel = labels.present;
  const documentTitle = labels.documentTitle;
  const { personal } = cv;
  const contactItems = [
    personal.email,
    personal.phone,
    personal.location,
    personal.linkedin,
    personal.website,
    personal.nationality,
    personal.dateOfBirth,
    personal.availability,
  ].filter((v): v is string => Boolean(v && v.trim()));

  const hasHeader = Boolean(personal.fullName.trim()) || contactItems.length > 0;

  const education = cv.education.filter(educationVisible);
  const experience = cv.experience.filter(experienceVisible);
  const languages = cv.languages.filter(languageVisible);
  const certificates = cv.certificates.filter(certificateVisible);
  const projects = cv.projects.filter(projectVisible);
  const skills = cv.skills.filter((s) => s.trim().length > 0);
  const interests = cv.interests.filter((s) => s.trim().length > 0);
  const summary = cv.summary.trim();

  return (
    <div
      dir="ltr"
      lang="de"
      className="cv-sheet"
      role="document"
      aria-label={documentTitle}
      style={{
        width: CV_SHEET_WIDTH,
        minHeight: CV_SHEET_MIN_HEIGHT,
        backgroundColor: "#ffffff",
        color: INK,
        padding: "44px 52px 52px",
        fontFamily: "inherit",
        fontSize: 12,
        lineHeight: 1.45,
      }}
    >
      {/* ---------------------------------------------------------------- */}
      {hasHeader && (
        <header
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: personal.photo
              ? "space-between"
              : "center",
            textAlign: personal.photo ? "left" : "center",
            gap: 24,
          }}
        >
          <div
            style={{
              flex: 1,
              minWidth: 0,
              display: personal.photo ? undefined : "flex",
              flexDirection: "column",
              alignItems: personal.photo ? undefined : "center",
            }}
          >
            {personal.fullName.trim() && (
              <h1
                style={{
                  margin: 0,
                  fontSize: 27,
                  fontWeight: 700,
                  letterSpacing: "0.01em",
                  color: INK,
                  lineHeight: 1.15,
                }}
              >
                {personal.fullName}
              </h1>
            )}
            {personal.professionalTitle.trim() && (
              <p
                style={{
                  margin: "4px 0 0",
                  fontSize: 14,
                  fontStyle: "italic",
                  color: MUTED,
                }}
              >
                {personal.professionalTitle}
              </p>
            )}
            {contactItems.length > 0 && (
              <p
                style={{
                  margin: "10px 0 0",
                  fontSize: 11.5,
                  color: MUTED,
                  display: "flex",
                  flexWrap: "wrap",
                  justifyContent: personal.photo ? "flex-start" : "center",
                  columnGap: 7,
                  rowGap: 2,
                }}
              >
                {contactItems.map((item, index) => (
                  <span key={`${item}-${index}`} style={{ whiteSpace: "nowrap" }}>
                    {index > 0 && (
                      <span style={{ color: FAINT, marginInlineEnd: 7 }}>·</span>
                    )}
                    {item}
                  </span>
                ))}
              </p>
            )}
          </div>
          {personal.photo && (
            // eslint-disable-next-line @next/next/no-img-element -- user-uploaded data URL, fixed dimensions
            <img
              src={personal.photo}
              alt={personal.fullName.trim() ? documentTitle : ""}
              style={{
                width: 88,
                height: 104,
                objectFit: "cover",
                borderRadius: 4,
                border: `1px solid ${RULE}`,
                flexShrink: 0,
              }}
            />
          )}
        </header>
      )}

      {/* ---------------------------------------------------------------- */}
      {summary && (
        <CvSection title={labels.summary}>
          <p style={{ margin: 0, fontSize: 12, color: INK, lineHeight: 1.55 }}>
            {summary}
          </p>
        </CvSection>
      )}

      {experience.length > 0 && (
        <CvSection title={labels.experience}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {experience.map((entry) => (
              <CvExperienceBlock
                key={entry.id}
                entry={entry}
                presentLabel={presentLabel}
              />
            ))}
          </div>
        </CvSection>
      )}

      {education.length > 0 && (
        <CvSection title={labels.education}>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {education.map((entry) => (
              <CvEducationBlock key={entry.id} entry={entry} />
            ))}
          </div>
        </CvSection>
      )}

      {skills.length > 0 && (
        <CvSection title={labels.skills}>
          <CvDottedGrid items={skills} />
        </CvSection>
      )}

      {languages.length > 0 && (
        <CvSection title={labels.languages}>
          <CvDottedGrid
            items={languages.map(
              (l) =>
                [l.language.trim(), l.level.trim()]
                  .filter(Boolean)
                  .join(" — "),
            )}
          />
        </CvSection>
      )}

      {certificates.length > 0 && (
        <CvSection title={labels.certificates}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {certificates.map((entry) => (
              <CvCertificateBlock key={entry.id} entry={entry} />
            ))}
          </div>
        </CvSection>
      )}

      {projects.length > 0 && (
        <CvSection title={labels.projects}>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {projects.map((entry) => (
              <CvProjectBlock key={entry.id} entry={entry} />
            ))}
          </div>
        </CvSection>
      )}

      {interests.length > 0 && (
        <CvSection title={labels.interests}>
          <p style={{ margin: 0, fontSize: 12, color: INK }}>
            {interests.join(", ")}
          </p>
        </CvSection>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

function CvSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ marginTop: 18 }}>
      <h2
        style={{
          margin: 0,
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: NAVY,
          paddingBottom: 5,
          borderBottom: `1px solid ${RULE}`,
        }}
      >
        {title}
      </h2>
      <div style={{ paddingTop: 10 }}>{children}</div>
    </section>
  );
}

function CvEntryHead({
  title,
  subtitle,
  dates,
  meta,
}: {
  title: string;
  subtitle?: string;
  dates?: string;
  meta?: string;
}) {
  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          gap: 16,
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 700, color: INK }}>{title}</span>
        {dates && (
          <span
            style={{
              fontSize: 11.5,
              color: MUTED,
              fontVariantNumeric: "tabular-nums",
              whiteSpace: "nowrap",
            }}
          >
            {dates}
          </span>
        )}
      </div>
      {(subtitle || meta) && (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            gap: 16,
            marginTop: 1,
          }}
        >
          {subtitle && (
            <span style={{ fontSize: 12.5, fontStyle: "italic", color: MUTED }}>
              {subtitle}
            </span>
          )}
          {meta && (
            <span style={{ fontSize: 11.5, color: FAINT, whiteSpace: "nowrap" }}>
              {meta}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function formatDates(
  start: string,
  end: string,
  isCurrent: boolean,
  presentLabel: string,
): string {
  const s = start.trim();
  let e = end.trim();
  if (isCurrent) e = presentLabel;
  if (!s && !e) return "";
  if (!e) return s;
  return `${s} – ${e}`;
}

function CvBullets({ items }: { items: string[] }) {
  const visible = items.filter((i) => i.trim().length > 0);
  if (visible.length === 0) return null;
  return (
    <ul style={{ margin: "5px 0 0", padding: 0, listStyle: "none" }}>
      {visible.map((item, index) => (
        <li
          key={`${item}-${index}`}
          style={{
            position: "relative",
            paddingLeft: 13,
            fontSize: 12,
            color: INK,
            lineHeight: 1.5,
            marginTop: index === 0 ? 0 : 2.5,
          }}
        >
          <span
            style={{
              position: "absolute",
              insetInlineStart: 2,
              top: 7.5,
              width: 3.5,
              height: 3.5,
              borderRadius: "50%",
              backgroundColor: FAINT,
            }}
          />
          {item}
        </li>
      ))}
    </ul>
  );
}

function CvDottedGrid({ items }: { items: string[] }) {
  const visible = items.filter((i) => i.trim().length > 0);
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        columnGap: 24,
        rowGap: 4,
      }}
    >
      {visible.map((item, index) => (
        <span
          key={`${item}-${index}`}
          style={{ position: "relative", paddingLeft: 13, fontSize: 12, color: INK }}
        >
          <span
            style={{
              position: "absolute",
              insetInlineStart: 2,
              top: 6,
              width: 3.5,
              height: 3.5,
              borderRadius: "50%",
              backgroundColor: FAINT,
            }}
          />
          {item}
        </span>
      ))}
    </div>
  );
}

function CvExperienceBlock({
  entry,
  presentLabel,
}: {
  entry: CvExperience;
  presentLabel: string;
}) {
  return (
    <div>
      <CvEntryHead
        title={entry.jobTitle.trim() || entry.company.trim() || "—"}
        subtitle={entry.company.trim() || undefined}
        dates={formatDates(entry.start, entry.end, entry.isCurrent, presentLabel)}
        meta={entry.location.trim() || undefined}
      />
      <CvBullets items={entry.responsibilities} />
      {entry.achievements.some((a) => a.trim()) && (
        <div style={{ marginTop: 6 }}>
          <CvBullets items={entry.achievements} />
        </div>
      )}
    </div>
  );
}

function CvEducationBlock({ entry }: { entry: CvEducation }) {
  return (
    <div>
      <CvEntryHead
        title={entry.degree.trim() || entry.institution.trim() || "—"}
        subtitle={entry.institution.trim() || undefined}
        dates={formatDates(entry.start, entry.end, false, "")}
        meta={entry.location.trim() || undefined}
      />
      {entry.description.trim() && (
        <p style={{ margin: "4px 0 0", fontSize: 12, color: MUTED, lineHeight: 1.5 }}>
          {entry.description}
        </p>
      )}
    </div>
  );
}

function CvCertificateBlock({ entry }: { entry: CvCertificate }) {
  return (
    <CvEntryHead
      title={entry.name.trim() || "—"}
      subtitle={entry.issuer.trim() || undefined}
      dates={entry.date.trim() || undefined}
    />
  );
}

function CvProjectBlock({ entry }: { entry: CvProject }) {
  return (
    <div>
      <CvEntryHead
        title={entry.name.trim() || "—"}
        subtitle={entry.role.trim() || undefined}
        dates={entry.date.trim() || undefined}
      />
      {entry.description.trim() && (
        <p style={{ margin: "4px 0 0", fontSize: 12, color: MUTED, lineHeight: 1.5 }}>
          {entry.description}
        </p>
      )}
      {entry.technologies.trim() && (
        <p
          style={{
            margin: "3px 0 0",
            fontSize: 11.5,
            fontStyle: "italic",
            color: FAINT,
          }}
        >
          {entry.technologies}
        </p>
      )}
    </div>
  );
}
