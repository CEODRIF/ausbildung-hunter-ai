import { Fragment, type ReactNode } from "react";
import type { CvExperience, CvProject } from "@/lib/templates/cv";
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
  type CvCustomizationSettings,
  type CvSectionKey,
} from "@/lib/templates/cv-customization";
import {
  applyTemplateIdentity,
  buildContactItems,
  buildOtherText,
  formatDates,
  renderPhoto,
  resolveTemplateColors,
  sheetStyle,
  type TemplateIdentity,
  type TemplateProps,
} from "./shared";

/**
 * The "professional" template — compact black-and-white design: bold black
 * name with an inline italic grey title, pipe-separated contact line,
 * uppercase headings with thin black rules, dash bullets, dates + location
 * stacked top-right, and DENSE inline lists: skills / languages /
 * certificates as pipe-separated lines ("Skill | Skill | Skill").
 * ATS-friendly (all real text).
 */

const IDENTITY: TemplateIdentity = {
  accent: "#111111",
  title: "#6b7280",
  body: "#111111",
  meta: "#444444",
  bullet: "#111111",
  link: "#111111",
  font: "sans-modern",
  baseSize: 10.5,
  fullNameSize: 28,
  sectionHeadingSize: 11,
  entryHeaderSize: 11.5,
  titleSize: 17,
  contactSize: 10,
  lineHeight: 1.4,
  spaceBetween: 9,
  leftRightMarginMm: 10,
  topBottomMarginMm: 12,
  sectionSpacing: 12,
};

type C = ReturnType<typeof resolveTemplateColors>;

export function ProfessionalCvTemplate({ cv, labels }: TemplateProps) {
  const s = applyTemplateIdentity(cv.customization ?? defaultCvCustomization(), IDENTITY);
  const c = resolveTemplateColors(s, IDENTITY);
  const font = cvFontStack(s.typography.font);
  const base = s.typography.baseSize;
  const lh = s.spacing.lineHeight;
  const present = labels.present;
  const { personal } = cv;

  const contact = buildContactItems(cv);
  const other = buildOtherText(cv);
  const hasHeader =
    Boolean(personal.fullName.trim()) ||
    Boolean(personal.professionalTitle.trim()) ||
    contact.length > 0 ||
    other.length > 0;
  const hasPhoto = Boolean(personal.photo);

  const summary = cv.summary.trim();
  const education = cv.education.filter(educationVisible);
  const experience = cv.experience.filter(experienceVisible);
  const languages = cv.languages.filter(languageVisible);
  const certificates = cv.certificates.filter(certificateVisible);
  const projects = cv.projects.filter(projectVisible);
  const skills = cv.skills.filter((x) => x.trim().length > 0);
  const interests = cv.interests.filter((x) => x.trim().length > 0);

  const blocks: ReactNode[] = [];
  for (const key of s.layout.sectionOrder) {
    if (!s.sections.visibility[key]) continue;
    const node = renderSection(key);
    if (node) blocks.push(node);
  }

  function renderSection(key: CvSectionKey): ReactNode {
    switch (key) {
      case "summary":
        return summary ? (
          <Section title={labels.summary} s={s} c={c}>
            <p style={{ margin: 0, fontSize: base, color: c.primary, lineHeight: lh }}>
              {summary}
            </p>
          </Section>
        ) : null;
      case "experience":
        return experience.length ? (
          <Section title={labels.experience} s={s} c={c}>
            {experience.map((e, i) => (
              <ProfExperience key={e.id} entry={e} index={i} s={s} c={c} present={present} />
            ))}
          </Section>
        ) : null;
      case "education":
        return education.length ? (
          <Section title={labels.education} s={s} c={c}>
            {education.map((e, i) => (
              <ProfEntry
                key={e.id}
                index={i}
                s={s}
                c={c}
                bold={e.degree.trim() || e.institution.trim() || "—"}
                italic={e.institution.trim() || undefined}
                right={formatDates(e.start, e.end, false, "")}
                location={e.location.trim() || undefined}
              />
            ))}
          </Section>
        ) : null;
      case "skills":
        return skills.length ? (
          <Section title={labels.skills} s={s} c={c}>
            <InlineList items={skills.map((x) => x.trim())} s={s} c={c} />
          </Section>
        ) : null;
      case "languages":
        return languages.length ? (
          <Section title={labels.languages} s={s} c={c}>
            <InlineList
              items={languages.map((l) =>
                l.level.trim() ? `${l.language.trim()}: ${l.level.trim()}` : l.language.trim(),
              )}
              s={s}
              c={c}
              boldLead
            />
          </Section>
        ) : null;
      case "certificates":
        return certificates.length ? (
          <Section title={labels.certificates} s={s} c={c}>
            <InlineList items={certificates.map((x) => x.name.trim() || "—")} s={s} c={c} />
          </Section>
        ) : null;
      case "projects":
        return projects.length ? (
          <Section title={labels.projects} s={s} c={c}>
            {projects.map((p, i) => (
              <ProfProject key={p.id} entry={p} index={i} s={s} c={c} />
            ))}
          </Section>
        ) : null;
      case "interests":
        return interests.length ? (
          <Section title={labels.interests} s={s} c={c}>
            <InlineList items={interests} s={s} c={c} />
          </Section>
        ) : null;
    }
  }

  return (
    <div
      dir="ltr"
      lang="de"
      className="cv-sheet"
      role="document"
      aria-label={labels.documentTitle}
      style={sheetStyle(s, font, base, lh, c.primary)}
    >
      {hasHeader && (
        <header
          style={{
            display: "grid",
            gridTemplateColumns: hasPhoto ? `1fr ${s.photo.size}px` : "1fr",
            columnGap: 26,
            alignItems: "start",
            paddingBottom: s.header.headerSpacing,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: 14,
                flexWrap: "wrap",
              }}
            >
              {personal.fullName.trim() && (
                <h1
                  style={{
                    margin: 0,
                    fontSize: s.typography.fullNameSize,
                    fontWeight: 800,
                    letterSpacing: "0.005em",
                    color: c.accent,
                    lineHeight: 1.1,
                  }}
                >
                  {personal.fullName}
                </h1>
              )}
              {personal.professionalTitle.trim() && (
                <span
                  style={{
                    fontSize: Math.max(13, s.header.titleSize - 4),
                    fontStyle: "italic",
                    color: c.title,
                  }}
                >
                  {personal.professionalTitle}
                </span>
              )}
            </div>
            {contact.length > 0 && (
              <p
                style={{
                  margin: "8px 0 0",
                  fontSize: s.header.contactSize,
                  color: c.secondary,
                  lineHeight: 1.5,
                  display: "flex",
                  flexWrap: "wrap",
                  alignItems: "center",
                  columnGap: 8,
                  rowGap: 2,
                }}
              >
                {contact.map((item, i) => (
                  <Fragment key={`${i}-${item.text}`}>
                    {i > 0 && <span aria-hidden style={{ opacity: 0.55 }}>|</span>}
                    {item.href ? (
                      <a
                        href={item.href}
                        target="_blank"
                        rel="noreferrer"
                        style={{
                          color: c.link,
                          textDecoration: s.links.underline ? "underline" : "none",
                        }}
                      >
                        {item.text}
                      </a>
                    ) : (
                      <span style={{ overflowWrap: "break-word" }}>{item.text}</span>
                    )}
                  </Fragment>
                ))}
              </p>
            )}
            {other && (
              <p
                style={{
                  margin: "3px 0 0",
                  fontSize: s.header.contactSize,
                  color: c.secondary,
                  lineHeight: 1.5,
                  overflowWrap: "break-word",
                }}
              >
                {other}
              </p>
            )}
          </div>
          {hasPhoto && (
            <div style={{ minWidth: 0 }}>
              {renderPhoto(cv, s, c.divider, labels.documentTitle)}
            </div>
          )}
        </header>
      )}

      {blocks}

      {s.footer.visible && (
        <div
          style={{
            marginTop: 22,
            paddingTop: 6,
            borderTop: `1px solid ${c.divider}`,
            display: "flex",
            justifyContent: s.footer.alignment === "center" ? "center" : "flex-start",
            fontSize: Math.max(9, s.header.contactSize - 1),
            color: c.secondary,
          }}
        >
          {s.footer.text || labels.documentTitle}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

function Section({
  title,
  s,
  c,
  children,
}: {
  title: string;
  s: CvCustomizationSettings;
  c: C;
  children: ReactNode;
}) {
  return (
    <section style={{ marginTop: s.sections.spacing }}>
      <h2
        style={{
          margin: 0,
          fontSize: Math.max(11, s.typography.sectionHeadingSize - 1),
          fontWeight: 700,
          letterSpacing: "0.05em",
          textTransform: "uppercase",
          color: c.heading,
          paddingBottom: 3,
          borderBottom: `1px solid ${c.divider}`,
        }}
      >
        {title}
      </h2>
      <div style={{ paddingTop: 7 }}>{children}</div>
    </section>
  );
}

/** Dense inline list: "item | item | item" wrapping across lines.
 *  `boldLead` bolds the part before a colon (languages: "English: Fluent"). */
function InlineList({
  items,
  s,
  c,
  boldLead,
}: {
  items: string[];
  s: CvCustomizationSettings;
  c: C;
  boldLead?: boolean;
}) {
  return (
    <p style={{ margin: 0, fontSize: s.typography.baseSize, color: c.primary, lineHeight: 1.65 }}>
      {items.map((item, i) => (
        <Fragment key={`${item}-${i}`}>
          {i > 0 && (
            <span aria-hidden style={{ margin: "0 8px", opacity: 0.55 }}>
              |
            </span>
          )}
          {boldLead && item.includes(":") ? (
            <>
              <span style={{ fontWeight: 700 }}>{item.slice(0, item.indexOf(":"))}</span>
              {item.slice(item.indexOf(":"))}
            </>
          ) : (
            item
          )}
        </Fragment>
      ))}
    </p>
  );
}

function ProfEntry({
  bold,
  italic,
  right,
  location,
  index,
  s,
  c,
  children,
}: {
  bold: string;
  italic?: string;
  right?: string;
  /** When set, dates and location render STACKED (top-right) instead of one line. */
  location?: string;
  index: number;
  s: CvCustomizationSettings;
  c: C;
  children?: ReactNode;
}) {
  const rightShown = s.entries.showDates && right;
  const locationShown = s.entries.showLocation && location;
  return (
    <div style={{ marginTop: index === 0 ? 0 : Math.max(8, s.spacing.spaceBetween - 2) }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 16 }}>
        <span style={{ fontSize: s.typography.entryHeaderSize, color: c.primary, minWidth: 0 }}>
          <span style={{ fontWeight: 700 }}>{bold}</span>
          {italic && (
            <span style={{ fontStyle: "italic", color: c.secondary }}>
              {" "}
              ,&thinsp;{italic}
            </span>
          )}
        </span>
        {(rightShown || locationShown) && (
          <span
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-end",
              fontSize: s.header.contactSize,
              color: c.secondary,
              fontVariantNumeric: "tabular-nums",
              lineHeight: 1.35,
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}
          >
            {rightShown && <span>{right}</span>}
            {locationShown && <span>{location}</span>}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

function ProfExperience({
  entry,
  index,
  s,
  c,
  present,
}: {
  entry: CvExperience;
  index: number;
  s: CvCustomizationSettings;
  c: C;
  present: string;
}) {
  const dates = formatDates(entry.start, entry.end, entry.isCurrent, present);
  const responsibilities = entry.responsibilities.filter((r) => r.trim());
  const achievements = s.entries.showAchievements ? entry.achievements.filter((a) => a.trim()) : [];
  const bullets = [...responsibilities, ...achievements];
  return (
    <ProfEntry
      index={index}
      s={s}
      c={c}
      bold={entry.company.trim() || entry.jobTitle.trim() || "—"}
      italic={entry.jobTitle.trim() || undefined}
      right={dates}
      location={entry.location.trim() || undefined}
    >

      {bullets.length > 0 && (
        <ul style={{ margin: "4px 0 0", padding: 0, listStyle: "none" }}>
          {bullets.map((b, i) => (
            <li
              key={`${b}-${i}`}
              style={{
                position: "relative",
                paddingLeft: 15,
                fontSize: s.typography.baseSize,
                color: c.primary,
                lineHeight: s.spacing.lineHeight,
                marginTop: 2,
              }}
            >
              <span aria-hidden style={{ position: "absolute", insetInlineStart: 2, top: 0 }}>
                –
              </span>
              {b}
            </li>
          ))}
        </ul>
      )}
    </ProfEntry>
  );
}

function ProfProject({
  entry,
  index,
  s,
  c,
}: {
  entry: CvProject;
  index: number;
  s: CvCustomizationSettings;
  c: C;
}) {
  return (
    <ProfEntry
      index={index}
      s={s}
      c={c}
      bold={entry.name.trim() || "—"}
      italic={entry.role.trim() || undefined}
      right={entry.date.trim() || undefined}
    >
      {entry.description.trim() && (
        <p style={{ margin: "3px 0 0", fontSize: s.typography.baseSize, color: c.secondary, lineHeight: s.spacing.lineHeight }}>
          {entry.description.trim()}
        </p>
      )}
      {entry.technologies.trim() && (
        <p style={{ margin: "2px 0 0", fontSize: s.header.contactSize, fontStyle: "italic", color: c.secondary }}>
          {entry.technologies.trim()}
        </p>
      )}
    </ProfEntry>
  );
}
