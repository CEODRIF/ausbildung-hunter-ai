import { Fragment, type CSSProperties, type ReactNode } from "react";
import type { CvDocument, CvEducation, CvExperience, CvProject } from "@/lib/templates/cv";
import {
  certificateVisible,
  educationVisible,
  experienceVisible,
  languageVisible,
  projectVisible,
} from "@/lib/templates/cv";
import {
  cvFontStack,
  defaultCvCustomization,
  photoAspect,
  photoRadius,
  type CvCustomizationSettings,
  type CvSectionKey,
} from "@/lib/templates/cv-customization";

/**
 * The single CV template — a pure presentational renderer of the CvDocument,
 * driven by `cv.customization` (appearance settings; see cv-customization.ts).
 *
 * Used twice:
 *   1. live preview (right column, scaled to fit)
 *   2. print root (portal on <body>, rendered only in @media print)
 * so the exported PDF is the same document as the preview.
 *
 * The defaults (defaultCvCustomization) reproduce the "Editorial Serif" design
 * exactly: monochrome classic-serif A4, centered… no — left header, thin black
 * rules, right-aligned dates, two-column lists. Every setting is reactive; the
 * sheet stays LTR (the RTL fix lives on the preview frame, not here).
 */

export const CV_SHEET_WIDTH = 794; // 210mm @ 96dpi
export const CV_SHEET_MIN_HEIGHT = 1123; // 297mm @ 96dpi

/** Fixed muted tone for dates/location (kept separate from the configurable
 *  "secondary" text so the default look is preserved). */
const META = "#5a5a5a";
const HEADER_COL_GAP = 26; // gap between the text column and the photo column

/** Sections that live in the wide "main" column of the two-column layout. */
const PRIMARY_SIDE: ReadonlySet<CvSectionKey> = new Set<CvSectionKey>([
  "summary",
  "experience",
  "education",
  "projects",
]);

const CASE_TRANSFORM: Record<CvCustomizationSettings["headings"]["headingCase"], string> = {
  uppercase: "uppercase",
  title: "capitalize",
  none: "none",
};

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
  const s = cv.customization ?? defaultCvCustomization();
  const presentLabel = labels.present;
  const documentTitle = labels.documentTitle;
  const { personal } = cv;

  // Resolved tokens (defaults reproduce the current template exactly).
  const font = cvFontStack(s.typography.font);
  const base = s.typography.baseSize;
  const lh = s.spacing.lineHeight;
  const primary = s.colors.primary;
  const secondary = s.colors.secondary;
  const divider = s.colors.divider;
  const link = s.colors.link;
  const sectionGap = s.sections.spacing;

  const photoW = s.photo.size;
  const photoH = Math.round(photoW * photoAspect(s.photo.shape));
  const hasPhoto = Boolean(personal.photo);

  // Contact line (left): email, phone, location, website, linkedin. Website &
  // linkedin render as functional anchors styled by the link settings.
  const contactItems: { text: string; href?: string }[] = [];
  for (const v of [personal.email, personal.phone, personal.location]) {
    const t = v.trim();
    if (t) contactItems.push({ text: t });
  }
  const website = personal.website.trim();
  const linkedin = personal.linkedin.trim();
  if (website) contactItems.push({ text: website, href: hrefFrom(website) });
  if (linkedin) contactItems.push({ text: linkedin, href: hrefFrom(linkedin) });
  const otherText = [personal.nationality, personal.dateOfBirth, personal.availability]
    .map((v) => v.trim())
    .filter(Boolean)
    .join("  |  ");

  const hasHeader =
    Boolean(personal.fullName.trim()) ||
    Boolean(personal.professionalTitle.trim()) ||
    contactItems.length > 0 ||
    otherText.length > 0;

  // Filtered content.
  const summary = cv.summary.trim();
  const education = cv.education.filter(educationVisible);
  const experience = cv.experience.filter(experienceVisible);
  const languages = cv.languages.filter(languageVisible);
  const certificates = cv.certificates.filter(certificateVisible);
  const projects = cv.projects.filter(projectVisible);
  const skills = cv.skills.filter((x) => x.trim().length > 0);
  const interests = cv.interests.filter((x) => x.trim().length > 0);

  // Build the ordered, visible list of section blocks (respects order + the
  // show/hide toggles). Each block is a <CvSection>; empty ones are dropped.
  const blocks: { key: CvSectionKey; node: ReactNode }[] = [];
  for (const key of s.layout.sectionOrder) {
    if (!s.sections.visibility[key]) continue;
    const node = renderSection(key);
    if (node) blocks.push({ key, node });
  }

  function renderSection(key: CvSectionKey): ReactNode {
    switch (key) {
      case "summary":
        return summary ? (
          <CvSection title={labels.summary} s={s}>
            <p
              style={{
                margin: 0,
                fontSize: base,
                color: primary,
                lineHeight: lh,
                textAlign: "justify",
              }}
            >
              {summary}
            </p>
          </CvSection>
        ) : null;
      case "experience":
        return experience.length ? (
          <CvSection title={labels.experience} s={s}>
            {experience.map((e, i) => (
              <CvExperienceBlock key={e.id} entry={e} presentLabel={presentLabel} s={s} index={i} />
            ))}
          </CvSection>
        ) : null;
      case "education":
        return education.length ? (
          <CvSection title={labels.education} s={s}>
            {education.map((e, i) => (
              <CvEducationBlock key={e.id} entry={e} s={s} index={i} />
            ))}
          </CvSection>
        ) : null;
      case "skills":
        return skills.length ? (
          <CvSection title={labels.skills} s={s}>
            <CvTwoColumnList items={skills.map((x) => x.trim())} s={s} />
          </CvSection>
        ) : null;
      case "languages":
        return languages.length ? (
          <CvSection title={labels.languages} s={s}>
            <CvTwoColumnList
              s={s}
              items={languages.map((l) => (
                <span key={l.id}>
                  {l.language.trim()}
                  {l.level.trim() && <span style={{ color: secondary }}> — {l.level.trim()}</span>}
                </span>
              ))}
            />
          </CvSection>
        ) : null;
      case "certificates":
        return certificates.length ? (
          <CvSection title={labels.certificates} s={s}>
            <CvTwoColumnList
              s={s}
              items={certificates.map((c) => {
                const meta = [c.issuer.trim(), c.date.trim()].filter(Boolean).join(" — ");
                return (
                  <span key={c.id}>
                    {c.name.trim() || "—"}
                    {meta && <span style={{ color: META }}> — {meta}</span>}
                  </span>
                );
              })}
            />
          </CvSection>
        ) : null;
      case "projects":
        return projects.length ? (
          <CvSection title={labels.projects} s={s}>
            {projects.map((e, i) => (
              <CvProjectBlock key={e.id} entry={e} s={s} index={i} />
            ))}
          </CvSection>
        ) : null;
      case "interests":
        return interests.length ? (
          <CvSection title={labels.interests} s={s}>
            <p style={{ margin: 0, fontSize: base, color: primary, lineHeight: lh }}>
              {interests.join(", ")}
            </p>
          </CvSection>
        ) : null;
    }
  }

  // Arrange the blocks by the chosen column layout.
  function renderBlocks(): ReactNode {
    const column = (list: ReactNode[]) => <div style={{ minWidth: 0 }}>{list}</div>;
    if (s.layout.columns === "two") {
      const primaryBlocks = blocks.filter((b) => PRIMARY_SIDE.has(b.key)).map((b) => b.node);
      const sideBlocks = blocks.filter((b) => !PRIMARY_SIDE.has(b.key)).map((b) => b.node);
      return (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1.55fr) minmax(0, 1fr)",
            columnGap: 34,
            alignItems: "start",
          }}
        >
          {column(primaryBlocks)}
          {column(sideBlocks)}
        </div>
      );
    }
    if (s.layout.columns === "mix") {
      const top = blocks.slice(0, 2).map((b) => b.node);
      const rest = blocks.slice(2);
      return (
        <>
          {top}
          {rest.length > 0 && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                columnGap: 34,
                rowGap: sectionGap,
                alignItems: "start",
              }}
            >
              {rest.map((b, i) => (
                <div key={i} style={{ minWidth: 0 }}>
                  {b.node}
                </div>
              ))}
            </div>
          )}
        </>
      );
    }
    return <>{blocks.map((b) => b.node)}</>;
  }

  // Sheet style — margins in mm (matching the print rule), plus CSS variables
  // so the @media print padding (globals.css) uses the same configurable values.
  const sheetStyle: CSSProperties = {
    width: CV_SHEET_WIDTH,
    minHeight: CV_SHEET_MIN_HEIGHT,
    backgroundColor: "#ffffff",
    color: primary,
    padding: `${s.spacing.topBottomMarginMm}mm ${s.spacing.leftRightMarginMm}mm`,
    fontFamily: font,
    fontSize: base,
    lineHeight: lh,
  };
  (sheetStyle as Record<string, string | number>)["--cv-pad-block"] = `${s.spacing.topBottomMarginMm}mm`;
  (sheetStyle as Record<string, string | number>)["--cv-pad-inline"] = `${s.spacing.leftRightMarginMm}mm`;

  const photoEl = personal.photo && (
    <div
      style={{
        width: photoW,
        height: photoH,
        overflow: "hidden",
        borderRadius: photoRadius(s.photo.shape),
        border: `1px solid ${divider}`,
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- user-uploaded data URL */}
      <img
        src={personal.photo}
        alt={personal.fullName.trim() ? documentTitle : ""}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          objectPosition: `${s.photo.posX}% ${s.photo.posY}%`,
          transform: `scale(${s.photo.zoom})`,
          display: "block",
        }}
      />
    </div>
  );

  const align = s.header.alignment;
  const textBlock = (
    <div style={{ minWidth: 0, textAlign: align, paddingBottom: s.header.headerSpacing }}>
      {personal.fullName.trim() && (
        <h1
          style={{
            margin: 0,
            fontSize: s.typography.fullNameSize,
            fontWeight: s.header.nameWeight,
            letterSpacing: "0.01em",
            color: primary,
            lineHeight: 1.1,
          }}
        >
          {personal.fullName}
        </h1>
      )}
      {personal.professionalTitle.trim() && (
        <p
          style={{
            margin: "4px 0 0",
            fontSize: s.header.titleSize,
            fontWeight: 400,
            fontStyle: s.header.titleStyle === "italic" ? "italic" : "normal",
            color: primary,
            lineHeight: 1.2,
          }}
        >
          {personal.professionalTitle}
        </p>
      )}
      {contactItems.length > 0 && (
        <p
          style={{
            margin: "11px 0 0",
            fontSize: s.header.contactSize,
            color: secondary,
            lineHeight: 1.4,
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            columnGap: 8,
            rowGap: 3,
          }}
        >
          {contactItems.map((item, i) => (
            <Fragment key={`${i}-${item.text}`}>
              {i > 0 && <span aria-hidden style={{ opacity: 0.65 }}>|</span>}
              {item.href ? (
                <a
                  href={item.href}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    color: link,
                    textDecoration: s.links.underline ? "underline" : "none",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 3,
                  }}
                >
                  {item.text}
                  {s.links.icon && (
                    <span aria-hidden style={{ fontSize: "0.8em" }}>
                      ↗
                    </span>
                  )}
                </a>
              ) : (
                <span style={{ overflowWrap: "break-word" }}>{item.text}</span>
              )}
            </Fragment>
          ))}
        </p>
      )}
      {otherText && (
        <p
          style={{
            margin: "3px 0 0",
            fontSize: s.header.contactSize,
            color: secondary,
            lineHeight: 1.4,
            overflowWrap: "break-word",
          }}
        >
          {otherText}
        </p>
      )}
    </div>
  );

  return (
    <div
      dir="ltr"
      lang="de"
      className="cv-sheet"
      role="document"
      aria-label={documentTitle}
      style={sheetStyle}
    >
      {hasHeader && (
        <header
          style={{
            display: "grid",
            gridTemplateColumns: hasPhoto
              ? align === "center"
                ? `1fr ${photoW}px 1fr`
                : s.header.photoPlacement === "right"
                  ? `1fr ${photoW}px`
                  : `${photoW}px 1fr`
              : "1fr",
            columnGap: hasPhoto ? HEADER_COL_GAP : 0,
            alignItems: "start",
          }}
        >
          {hasPhoto && s.header.photoPlacement === "left" && <div style={{ minWidth: 0 }}>{photoEl}</div>}
          {textBlock}
          {hasPhoto && s.header.photoPlacement === "right" && <div style={{ minWidth: 0 }}>{photoEl}</div>}
        </header>
      )}

      {renderBlocks()}

      {s.footer.visible && (
        <div
          style={{
            marginTop: 22,
            paddingTop: 6,
            borderTop: `1px solid ${divider}`,
            display: "flex",
            justifyContent: s.footer.alignment === "center" ? "center" : "flex-start",
            fontSize: Math.max(9, s.header.contactSize - 1),
            color: secondary,
          }}
        >
          {s.footer.text || documentTitle}
        </div>
      )}
    </div>
  );
}

function hrefFrom(value: string): string {
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

function CvSection({ title, s, children }: { title: string; s: CvCustomizationSettings; children: ReactNode }) {
  const rule = s.headings.rule ? `1px solid ${s.colors.divider}` : "none";
  return (
    <section style={{ marginTop: s.sections.spacing }}>
      <h2
        style={{
          margin: 0,
          fontSize: s.typography.sectionHeadingSize,
          fontWeight: s.headings.weight,
          letterSpacing: `${s.headings.letterSpacing}em`,
          textTransform: CASE_TRANSFORM[s.headings.headingCase],
          color: s.colors.heading,
          paddingBottom: 3,
          borderBottom: rule,
        }}
      >
        {title}
      </h2>
      <div style={{ paddingTop: 8 }}>{children}</div>
    </section>
  );
}

/**
 * Two balanced columns (left-to-right, top-to-bottom). Used for skills,
 * languages and certificates. Accepts ReactNode so entries can carry a muted
 * sub-value (language level / certificate issuer) inline.
 */
function CvTwoColumnList({ items, s }: { items: ReactNode[]; s: CvCustomizationSettings }) {
  const visible = items.filter((i) => (typeof i === "string" ? i.trim().length > 0 : Boolean(i)));
  if (visible.length === 0) return null;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", columnGap: 40 }}>
      {visible.map((item, index) => (
        <span
          key={`${typeof item === "string" ? item : "cell"}-${index}`}
          style={{
            position: "relative",
            paddingLeft: 13,
            fontSize: s.typography.baseSize,
            color: s.colors.primary,
            lineHeight: s.spacing.lineHeight,
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
              backgroundColor: s.colors.accent,
            }}
          />
          {item}
        </span>
      ))}
    </div>
  );
}

function formatDates(start: string, end: string, isCurrent: boolean, presentLabel: string): string {
  const s0 = start.trim();
  let e = end.trim();
  if (isCurrent) e = presentLabel;
  if (!s0 && !e) return "";
  if (!e) return s0;
  return `${s0} – ${e}`;
}

function CvBullets({ items, s }: { items: string[]; s: CvCustomizationSettings }) {
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
            fontSize: s.typography.baseSize,
            color: s.colors.primary,
            lineHeight: s.spacing.lineHeight,
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
              backgroundColor: s.colors.accent,
            }}
          />
          {item}
        </li>
      ))}
    </ul>
  );
}

/** Shared two-line head: bold title + muted italic subtitle on the left,
 *  muted dates + location on the right. Dates/location respect the entry
 *  toggles (showDates / showLocation). */
function CvEntryHead({
  title,
  subtitle,
  dates,
  meta,
  s,
}: {
  title: string;
  subtitle?: string;
  dates?: string;
  meta?: string;
  s: CvCustomizationSettings;
}) {
  const datesShown = s.entries.showDates ? dates : undefined;
  const metaShown = s.entries.showLocation ? meta : undefined;
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 16 }}>
        <span style={{ fontSize: s.typography.entryHeaderSize, fontWeight: 700, color: s.colors.primary }}>
          {title}
        </span>
        {datesShown && (
          <span
            style={{
              fontSize: s.header.contactSize,
              color: META,
              fontVariantNumeric: "tabular-nums",
              whiteSpace: "nowrap",
            }}
          >
            {datesShown}
          </span>
        )}
      </div>
      {(subtitle || metaShown) && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 16, marginTop: 1 }}>
          {subtitle && (
            <span style={{ fontSize: s.typography.baseSize, fontStyle: "italic", color: s.colors.secondary }}>
              {subtitle}
            </span>
          )}
          {metaShown && (
            <span style={{ fontSize: s.header.contactSize, color: META, whiteSpace: "nowrap" }}>{metaShown}</span>
          )}
        </div>
      )}
    </div>
  );
}

function CvExperienceBlock({
  entry,
  presentLabel,
  s,
  index,
}: {
  entry: CvExperience;
  presentLabel: string;
  s: CvCustomizationSettings;
  index: number;
}) {
  return (
    <div style={{ marginTop: index === 0 ? 0 : s.spacing.spaceBetween }}>
      <CvEntryHead
        s={s}
        title={entry.jobTitle.trim() || entry.company.trim() || "—"}
        subtitle={entry.company.trim() || undefined}
        dates={formatDates(entry.start, entry.end, entry.isCurrent, presentLabel)}
        meta={entry.location.trim() || undefined}
      />
      <CvBullets s={s} items={entry.responsibilities} />
      {s.entries.showAchievements && entry.achievements.some((a) => a.trim()) && (
        <div style={{ marginTop: 4 }}>
          <CvBullets s={s} items={entry.achievements} />
        </div>
      )}
    </div>
  );
}

function CvEducationBlock({ entry, s, index }: { entry: CvEducation; s: CvCustomizationSettings; index: number }) {
  return (
    <div style={{ marginTop: index === 0 ? 0 : s.spacing.spaceBetween }}>
      <CvEntryHead
        s={s}
        title={entry.degree.trim() || entry.institution.trim() || "—"}
        subtitle={entry.institution.trim() || undefined}
        dates={formatDates(entry.start, entry.end, false, "")}
        meta={entry.location.trim() || undefined}
      />
      {entry.description.trim() && (
        <p style={{ margin: "3px 0 0", fontSize: s.typography.baseSize, color: s.colors.secondary, lineHeight: s.spacing.lineHeight }}>
          {entry.description}
        </p>
      )}
    </div>
  );
}

function CvProjectBlock({ entry, s, index }: { entry: CvProject; s: CvCustomizationSettings; index: number }) {
  return (
    <div style={{ marginTop: index === 0 ? 0 : s.spacing.spaceBetween }}>
      <CvEntryHead
        s={s}
        title={entry.name.trim() || "—"}
        subtitle={entry.role.trim() || undefined}
        dates={entry.date.trim() || undefined}
      />
      {entry.description.trim() && (
        <p style={{ margin: "3px 0 0", fontSize: s.typography.baseSize, color: s.colors.secondary, lineHeight: s.spacing.lineHeight }}>
          {entry.description}
        </p>
      )}
      {entry.technologies.trim() && (
        <p style={{ margin: "2px 0 0", fontSize: s.header.contactSize, fontStyle: "italic", color: META }}>
          {entry.technologies}
        </p>
      )}
    </div>
  );
}
