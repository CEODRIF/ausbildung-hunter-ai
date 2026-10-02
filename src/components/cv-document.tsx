import type { ReactNode } from "react";
import type {
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
 * "Editorial Serif" — the single CV template.
 *
 * A pure presentational renderer of the CvDocument: no state, no network,
 * no editor chrome. Used twice:
 *   1. live preview (right column, scaled to fit)
 *   2. print root (portal on <body>, rendered only in @media print)
 * so the exported PDF is byte-for-byte the same document as the preview.
 *
 * Style: a traditionally typeset, monochrome A4 résumé. Classic serif
 * throughout, a two-column header (left: bold name, normal title and
 * pipe-separated contact lines; right: a fixed-width rectangular photo),
 * uppercase section headings underlined by a thin full-width black rule,
 * right-aligned dates + location, and two-column skills / languages /
 * certificates. No brand colors, no cards, no gradients. The sheet is ALWAYS
 * light (paper) and stays LTR even when the UI language is Arabic (the RTL
 * fix lives on the preview frame, not here).
 */

export const CV_SHEET_WIDTH = 794; // 210mm @ 96dpi
export const CV_SHEET_MIN_HEIGHT = 1123; // 297mm @ 96dpi

// Monochrome ink scale — black / dark-gray only, no UI/brand colors.
const INK = "#141414"; // name, headings, titles, body, bullets
const MUTED = "#3a3a3a"; // company / institution italic, contact text
const FAINT = "#5a5a5a"; // dates, location, secondary meta
const RULE = "#141414"; // thin black rule under section headings
const DOT = "#2a2a2a"; // bullet dots

// Classic serif stack. Both the live preview and the print/PDF export are
// painted by the SAME browser, so a web-safe serif renders identically in
// both — no webfont, no extra dependency, no font-loading flash in print.
const SERIF =
  '"Times New Roman", Times, "Liberation Serif", "DejaVu Serif", Georgia, serif';

// Passport-style profile photo — the top-right COLUMN of the header.
// ~128px wide, portrait aspect, rectangular (no border-radius) per the design
// brief. The header is a CSS grid (text column `1fr` + this fixed-width
// column), so the photo can never overlap the text.
const PHOTO_W = 128;
const PHOTO_H = 170;
const HEADER_COL_GAP = 26; // gap between the text column and the photo column

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

  // Header = two-column grid (text left, photo right). The text is split into
  // a contact line and a "more" line, each pipe-joined and fully dynamic
  // (non-empty fields only). The photo sits in its own fixed-width column, so
  // the left text is physically constrained to stop before it — no overlap.
  const contactLine = [
    personal.email,
    personal.phone,
    personal.location,
    personal.website,
    personal.linkedin,
  ]
    .map((v) => v.trim())
    .filter(Boolean);
  const otherLine = [
    personal.nationality,
    personal.dateOfBirth,
    personal.availability,
  ]
    .map((v) => v.trim())
    .filter(Boolean);

  const hasHeader =
    Boolean(personal.fullName.trim()) ||
    Boolean(personal.professionalTitle.trim()) ||
    contactLine.length > 0 ||
    otherLine.length > 0;
  const hasPhoto = Boolean(personal.photo);

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
        // Identical to the print padding (globals.css: `14mm 15mm`) so the
        // on-screen preview and the exported PDF carry the same margins.
        padding: "14mm 15mm",
        fontFamily: SERIF,
        fontSize: 12,
        lineHeight: 1.5,
      }}
    >
      {/* ---------------------------------------------------------------- */}
      {hasHeader && (
        <header
          style={{
            display: "grid",
            gridTemplateColumns: hasPhoto ? `1fr ${PHOTO_W}px` : "1fr",
            columnGap: hasPhoto ? HEADER_COL_GAP : 0,
            alignItems: "start",
          }}
        >
          <div style={{ minWidth: 0 }}>
            {personal.fullName.trim() && (
              <h1
                style={{
                  margin: 0,
                  fontSize: 30,
                  fontWeight: 700,
                  letterSpacing: "0.01em",
                  color: INK,
                  lineHeight: 1.1,
                }}
              >
                {personal.fullName}
              </h1>
            )}
            {personal.professionalTitle.trim() && (
              <p
                style={{ margin: "4px 0 0", fontSize: 19, fontWeight: 400, color: INK, lineHeight: 1.2 }}
              >
                {personal.professionalTitle}
              </p>
            )}
            {contactLine.length > 0 && (
              <p
                style={{
                  margin: "11px 0 0",
                  fontSize: 11.5,
                  color: MUTED,
                  lineHeight: 1.4,
                  overflowWrap: "break-word",
                }}
              >
                {contactLine.join(" | ")}
              </p>
            )}
            {otherLine.length > 0 && (
              <p
                style={{
                  margin: "3px 0 0",
                  fontSize: 11.5,
                  color: MUTED,
                  lineHeight: 1.4,
                  overflowWrap: "break-word",
                }}
              >
                {otherLine.join(" | ")}
              </p>
            )}
          </div>
          {hasPhoto && (
            // eslint-disable-next-line @next/next/no-img-element -- user-uploaded data URL, fixed dimensions
            <img
              src={personal.photo!}
              alt={personal.fullName.trim() ? documentTitle : ""}
              style={{
                width: PHOTO_W,
                height: PHOTO_H,
                objectFit: "cover",
                objectPosition: "center 20%",
                border: `1px solid ${RULE}`,
                display: "block",
              }}
            />
          )}
        </header>
      )}

      {/* ---------------------------------------------------------------- */}
      {summary && (
        <CvSection title={labels.summary}>
          <p
            style={{
              margin: 0,
              fontSize: 12,
              color: INK,
              lineHeight: 1.5,
              textAlign: "justify",
            }}
          >
            {summary}
          </p>
        </CvSection>
      )}

      {experience.length > 0 && (
        <CvSection title={labels.experience}>
          {experience.map((entry, index) => (
            <CvExperienceBlock
              key={entry.id}
              entry={entry}
              presentLabel={presentLabel}
              index={index}
            />
          ))}
        </CvSection>
      )}

      {education.length > 0 && (
        <CvSection title={labels.education}>
          {education.map((entry, index) => (
            <CvEducationBlock key={entry.id} entry={entry} index={index} />
          ))}
        </CvSection>
      )}

      {skills.length > 0 && (
        <CvSection title={labels.skills}>
          <CvTwoColumnList items={skills.map((s) => s.trim())} />
        </CvSection>
      )}

      {languages.length > 0 && (
        <CvSection title={labels.languages}>
          <CvTwoColumnList
            items={languages.map((l) => (
              <span key={l.id}>
                {l.language.trim()}
                {l.level.trim() && <span style={{ color: FAINT }}> — {l.level.trim()}</span>}
              </span>
            ))}
          />
        </CvSection>
      )}

      {certificates.length > 0 && (
        <CvSection title={labels.certificates}>
          <CvTwoColumnList
            items={certificates.map((c) => {
              const meta = [c.issuer.trim(), c.date.trim()].filter(Boolean).join(" — ");
              return (
                <span key={c.id}>
                  {c.name.trim() || "—"}
                  {meta && <span style={{ color: FAINT }}> — {meta}</span>}
                </span>
              );
            })}
          />
        </CvSection>
      )}

      {projects.length > 0 && (
        <CvSection title={labels.projects}>
          {projects.map((entry, index) => (
            <CvProjectBlock key={entry.id} entry={entry} index={index} />
          ))}
        </CvSection>
      )}

      {interests.length > 0 && (
        <CvSection title={labels.interests}>
          <p style={{ margin: 0, fontSize: 12, color: INK, lineHeight: 1.5 }}>
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
    <section style={{ marginTop: 16 }}>
      <h2
        style={{
          margin: 0,
          fontSize: 13,
          fontWeight: 700,
          letterSpacing: "0.05em",
          textTransform: "uppercase",
          color: INK,
          paddingBottom: 3,
          borderBottom: `1px solid ${RULE}`,
        }}
      >
        {title}
      </h2>
      <div style={{ paddingTop: 8 }}>{children}</div>
    </section>
  );
}

/**
 * Two balanced columns (left-to-right, top-to-bottom — the existing grid
 * order, so the user's entry order reads naturally). Used for skills,
 * languages and certificates. Accepts ReactNode so entries can carry a muted
 * sub-value (language level / certificate issuer) inline.
 */
function CvTwoColumnList({ items }: { items: ReactNode[] }) {
  const visible = items.filter((i) =>
    typeof i === "string" ? i.trim().length > 0 : Boolean(i),
  );
  if (visible.length === 0) return null;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", columnGap: 40 }}>
      {visible.map((item, index) => (
        <span
          key={`${typeof item === "string" ? item : "cell"}-${index}`}
          style={{
            position: "relative",
            paddingLeft: 13,
            fontSize: 12,
            color: INK,
            lineHeight: 1.5,
          }}
        >
          <span
            style={{
              position: "absolute",
              insetInlineStart: 1,
              top: 7,
              width: 4,
              height: 4,
              borderRadius: "50%",
              backgroundColor: DOT,
            }}
          />
          {item}
        </span>
      ))}
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
            marginTop: index === 0 ? 0 : 2,
          }}
        >
          <span
            style={{
              position: "absolute",
              insetInlineStart: 1,
              top: 7,
              width: 4,
              height: 4,
              borderRadius: "50%",
              backgroundColor: DOT,
            }}
          />
          {item}
        </li>
      ))}
    </ul>
  );
}

/** Shared two-line head: bold title + muted italic subtitle on the left,
 *  muted dates + location on the right (the reference's right-aligned meta). */
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
              color: FAINT,
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
            <span style={{ fontSize: 12, fontStyle: "italic", color: MUTED }}>{subtitle}</span>
          )}
          {meta && (
            <span style={{ fontSize: 11.5, color: FAINT, whiteSpace: "nowrap" }}>{meta}</span>
          )}
        </div>
      )}
    </div>
  );
}

function CvExperienceBlock({
  entry,
  presentLabel,
  index,
}: {
  entry: CvExperience;
  presentLabel: string;
  index: number;
}) {
  return (
    <div style={{ marginTop: index === 0 ? 0 : 12 }}>
      <CvEntryHead
        title={entry.jobTitle.trim() || entry.company.trim() || "—"}
        subtitle={entry.company.trim() || undefined}
        dates={formatDates(entry.start, entry.end, entry.isCurrent, presentLabel)}
        meta={entry.location.trim() || undefined}
      />
      <CvBullets items={entry.responsibilities} />
      {entry.achievements.some((a) => a.trim()) && (
        <div style={{ marginTop: 4 }}>
          <CvBullets items={entry.achievements} />
        </div>
      )}
    </div>
  );
}

function CvEducationBlock({ entry, index }: { entry: CvEducation; index: number }) {
  return (
    <div style={{ marginTop: index === 0 ? 0 : 10 }}>
      <CvEntryHead
        title={entry.degree.trim() || entry.institution.trim() || "—"}
        subtitle={entry.institution.trim() || undefined}
        dates={formatDates(entry.start, entry.end, false, "")}
        meta={entry.location.trim() || undefined}
      />
      {entry.description.trim() && (
        <p style={{ margin: "3px 0 0", fontSize: 12, color: MUTED, lineHeight: 1.5 }}>
          {entry.description}
        </p>
      )}
    </div>
  );
}

function CvProjectBlock({ entry, index }: { entry: CvProject; index: number }) {
  return (
    <div style={{ marginTop: index === 0 ? 0 : 10 }}>
      <CvEntryHead
        title={entry.name.trim() || "—"}
        subtitle={entry.role.trim() || undefined}
        dates={entry.date.trim() || undefined}
      />
      {entry.description.trim() && (
        <p style={{ margin: "3px 0 0", fontSize: 12, color: MUTED, lineHeight: 1.5 }}>
          {entry.description}
        </p>
      )}
      {entry.technologies.trim() && (
        <p
          style={{ margin: "2px 0 0", fontSize: 11.5, fontStyle: "italic", color: FAINT }}
        >
          {entry.technologies}
        </p>
      )}
    </div>
  );
}
