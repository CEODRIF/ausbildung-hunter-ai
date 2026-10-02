import type { CSSProperties, ReactNode } from "react";
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
 * throughout, a centered name / italic title / icon contact row, uppercase
 * section headings underlined by a thin full-width black rule, right-aligned
 * dates + location, and two-column skills / languages / certificates. No
 * brand colors, no cards, no gradients. The sheet is ALWAYS light (paper) and
 * stays LTR even when the UI language is Arabic (the RTL fix lives on the
 * preview frame, not here).
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

// Passport-style profile photo (small, top-right of the header).
const PHOTO_W = 72;
const PHOTO_H = 88;

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

  // Contact row: icon-prefixed, in a fixed order (location first, to match
  // the reference). Only non-empty fields render, so the row stays fully
  // dynamic. Fields without a fitting glyph render as plain text.
  const contactItems: { icon: ContactGlyphName | null; text: string }[] = [];
  const withIcon = (icon: ContactGlyphName, value: string) => {
    if (value.trim()) contactItems.push({ icon, text: value.trim() });
  };
  const plain = (value: string) => {
    if (value.trim()) contactItems.push({ icon: null, text: value.trim() });
  };
  withIcon("location", personal.location);
  withIcon("mail", personal.email);
  withIcon("phone", personal.phone);
  withIcon("linkedin", personal.linkedin);
  withIcon("globe", personal.website);
  plain(personal.nationality);
  plain(personal.dateOfBirth);
  plain(personal.availability);

  const hasHeader = Boolean(personal.fullName.trim()) || contactItems.length > 0;
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
        <header style={{ position: "relative", minHeight: hasPhoto ? PHOTO_H + 6 : undefined }}>
          <div style={{ textAlign: "center" }}>
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
              <p style={{ margin: "3px 0 0", fontSize: 15, fontStyle: "italic", color: MUTED }}>
                {personal.professionalTitle}
              </p>
            )}
            {contactItems.length > 0 && (
              <p
                style={{
                  margin: "9px 0 0",
                  fontSize: 11,
                  color: MUTED,
                  display: "flex",
                  flexWrap: "wrap",
                  justifyContent: "center",
                  columnGap: 15,
                  rowGap: 3,
                }}
              >
                {contactItems.map((item, index) => (
                  <span
                    key={`${item.text}-${index}`}
                    style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
                  >
                    {item.icon && <ContactGlyph name={item.icon} />}
                    {item.text}
                  </span>
                ))}
              </p>
            )}
          </div>
          {hasPhoto && (
            // eslint-disable-next-line @next/next/no-img-element -- user-uploaded data URL, fixed dimensions
            <img
              src={personal.photo!}
              alt={personal.fullName.trim() ? documentTitle : ""}
              style={{
                position: "absolute",
                top: 0,
                right: 0,
                width: PHOTO_W,
                height: PHOTO_H,
                objectFit: "cover",
                objectPosition: "center 22%",
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

// ---------------------------------------------------------------------------
// Contact-row glyphs (inline SVG — render identically on screen and in print)
// ---------------------------------------------------------------------------

type ContactGlyphName = "location" | "mail" | "phone" | "linkedin" | "globe";

function ContactGlyph({ name }: { name: ContactGlyphName }) {
  const style: CSSProperties = { width: 11, height: 11, flexShrink: 0 };
  switch (name) {
    case "location":
      return (
        <svg style={style} viewBox="0 0 24 24" fill={MUTED} aria-hidden="true" focusable="false">
          <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z" />
        </svg>
      );
    case "mail":
      return (
        <svg style={style} viewBox="0 0 24 24" fill={MUTED} aria-hidden="true" focusable="false">
          <path d="M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4-8 5-8-5V6l8 5 8-5v2z" />
        </svg>
      );
    case "phone":
      return (
        <svg style={style} viewBox="0 0 24 24" fill={MUTED} aria-hidden="true" focusable="false">
          <path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z" />
        </svg>
      );
    case "linkedin":
      return (
        <svg style={style} viewBox="0 0 24 24" fill={MUTED} aria-hidden="true" focusable="false">
          <path d="M19 3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14zm-.5 15.5v-5.3a3.26 3.26 0 0 0-3.26-3.26c-.85 0-1.84.52-2.32 1.3v-1.11h-2.79v8.37h2.79v-4.93c0-.77.62-1.4 1.39-1.4a1.4 1.4 0 0 1 1.4 1.4v4.93h2.79zM6.88 8.56a1.68 1.68 0 1 0-3.36 0 1.68 1.68 0 0 0 3.36 0zM8.27 18.5v-8.37H5.5v8.37h2.77z" />
        </svg>
      );
    case "globe":
      return (
        <svg style={style} viewBox="0 0 24 24" fill={MUTED} aria-hidden="true" focusable="false">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" />
        </svg>
      );
    default:
      return null;
  }
}
