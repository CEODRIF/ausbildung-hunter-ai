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
  resolveTemplateColors,
  sheetStyle,
  type TemplateIdentity,
  type TemplateProps,
} from "./shared";

/**
 * The "executive" template — centered header (large dark-navy name, italic
 * slate title, centered pipe-separated contact line), uppercase black
 * section headings with thin full-width rules, "Company, Title" entries with
 * dates | location on the right, and compact multi-column skills /
 * languages / certificates. Premium corporate look; ATS-friendly (all real
 * HTML text).
 */

const IDENTITY: TemplateIdentity = {
  accent: "#1f2a44", // dark navy — name
  title: "#3d4f6d", // slate blue — italic title
  body: "#1a1a1a",
  meta: "#4b5563",
  bullet: "#1a1a1a",
  link: "#1f2a44",
  font: "sans-modern",
  baseSize: 10,
  fullNameSize: 23,
  sectionHeadingSize: 10.5,
  entryHeaderSize: 11,
  titleSize: 16,
  contactSize: 10,
  lineHeight: 1.32,
  spaceBetween: 7,
  leftRightMarginMm: 12,
  topBottomMarginMm: 9.5,
  sectionSpacing: 12,
};

export function ExecutiveCvTemplate({ cv, labels }: TemplateProps) {
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
              <ExecutiveExperience key={e.id} entry={e} index={i} s={s} c={c} present={present} />
            ))}
          </Section>
        ) : null;
      case "education":
        return education.length ? (
          <Section title={labels.education} s={s} c={c}>
            {education.map((e, i) => (
              <ExecutiveEntry
                key={e.id}
                index={i}
                s={s}
                c={c}
                bold={e.degree.trim() || e.institution.trim() || "—"}
                italic={e.institution.trim() || undefined}
                dates={formatDates(e.start, e.end, false, "")}
                meta={e.location.trim() || undefined}
                oneLineMeta
              />
            ))}
          </Section>
        ) : null;
      case "skills":
        return skills.length ? (
          <Section title={labels.skills} s={s} c={c}>
            <ColumnBullets items={skills.map((x) => x.trim())} columns={4} s={s} c={c} />
          </Section>
        ) : null;
      case "languages":
        return languages.length ? (
          <Section title={labels.languages} s={s} c={c}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: `repeat(${Math.min(3, languages.length)}, 1fr)`,
                columnGap: 24,
              }}
            >
                {languages.map((l) => (
                  <div key={l.id} style={{ minWidth: 0 }}>
                    <div style={{ fontSize: base, fontWeight: 600, color: c.primary, lineHeight: lh }}>
                      {l.language.trim()}
                    </div>
                  {l.level.trim() && (
                    <div style={{ fontSize: s.header.contactSize, color: c.secondary, lineHeight: 1.3 }}>
                      {l.level.trim()}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </Section>
        ) : null;
      case "certificates":
        return certificates.length ? (
          <Section title={labels.certificates} s={s} c={c}>
            <ColumnBullets
              items={certificates.map((x) => x.name.trim() || "—")}
              columns={4}
              s={s}
              c={c}
            />
          </Section>
        ) : null;
      case "projects":
        return projects.length ? (
          <Section title={labels.projects} s={s} c={c}>
            {projects.map((p, i) => (
              <ExecutiveProject key={p.id} entry={p} index={i} s={s} c={c} />
            ))}
          </Section>
        ) : null;
      case "interests":
        return interests.length ? (
          <Section title={labels.interests} s={s} c={c}>
            <p style={{ margin: 0, fontSize: base, color: c.primary, lineHeight: lh }}>
              {interests.join(", ")}
            </p>
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
        <header style={{ textAlign: "center", paddingBottom: s.header.headerSpacing }}>
          {personal.fullName.trim() && (
            <h1
              style={{
                margin: 0,
                fontSize: s.typography.fullNameSize,
                fontWeight: 700,
                letterSpacing: "0.01em",
                color: c.accent,
                lineHeight: 1.1,
              }}
            >
              {personal.fullName}
            </h1>
          )}
          {personal.professionalTitle.trim() && (
            <p
              style={{
                margin: "5px 0 0",
                fontSize: Math.max(13, s.header.titleSize - 4),
                fontStyle: "italic",
                color: c.title,
                lineHeight: 1.25,
              }}
            >
              {personal.professionalTitle}
            </p>
          )}
          {contact.length > 0 && (
            <p
              style={{
                margin: "10px 0 0",
                fontSize: s.header.contactSize,
                color: c.secondary,
                lineHeight: 1.5,
                display: "flex",
                flexWrap: "wrap",
                justifyContent: "center",
                alignItems: "center",
                columnGap: 8,
                rowGap: 2,
              }}
            >
              {contact.map((item, i) => (
                <Fragment key={`${i}-${item.text}`}>
                  {i > 0 && <span aria-hidden style={{ opacity: 0.6 }}>|</span>}
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
  c: ReturnType<typeof resolveTemplateColors>;
  children: ReactNode;
}) {
  return (
    <section style={{ marginTop: s.sections.spacing }}>
      <h2
        style={{
          margin: 0,
          fontSize: Math.max(11, s.typography.sectionHeadingSize - 0.5),
          fontWeight: 700,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: c.primary,
          paddingBottom: 4,
          borderBottom: `1px solid ${c.divider}`,
        }}
      >
        {title}
      </h2>
      <div style={{ paddingTop: 8 }}>{children}</div>
    </section>
  );
}

/** "Company, Title" entry: bold value + italic sub on the left, dates and
 *  location on the right (two lines, or one line for education). */
function ExecutiveEntry({
  bold,
  italic,
  dates,
  meta,
  oneLineMeta,
  index,
  s,
  c,
  children,
}: {
  bold: string;
  italic?: string;
  dates?: string;
  meta?: string;
  oneLineMeta?: boolean;
  index: number;
  s: CvCustomizationSettings;
  c: ReturnType<typeof resolveTemplateColors>;
  children?: ReactNode;
}) {
  const datesShown = s.entries.showDates ? dates : undefined;
  const metaShown = s.entries.showLocation ? meta : undefined;
  return (
    <div style={{ marginTop: index === 0 ? 0 : s.spacing.spaceBetween }}>
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
        {oneLineMeta ? (
          (datesShown || metaShown) && (
            <span
              style={{
                fontSize: s.header.contactSize,
                color: c.secondary,
                fontVariantNumeric: "tabular-nums",
                whiteSpace: "nowrap",
              }}
            >
              {[datesShown, metaShown].filter(Boolean).join("  |  ")}
            </span>
          )
        ) : (
          (datesShown || metaShown) && (
            <span
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "flex-end",
                fontSize: s.header.contactSize,
                color: c.secondary,
                fontVariantNumeric: "tabular-nums",
                lineHeight: 1.35,
                flexShrink: 0,
              }}
            >
              {datesShown && <span>{datesShown}</span>}
              {metaShown && <span>{metaShown}</span>}
            </span>
          )
        )}
      </div>
      {children}
    </div>
  );
}

function ExecutiveExperience({
  entry,
  index,
  s,
  c,
  present,
}: {
  entry: CvExperience;
  index: number;
  s: CvCustomizationSettings;
  c: ReturnType<typeof resolveTemplateColors>;
  present: string;
}) {
  const responsibilities = entry.responsibilities.filter((r) => r.trim());
  const achievements = s.entries.showAchievements ? entry.achievements.filter((a) => a.trim()) : [];
  const bullets = [...responsibilities, ...achievements];
  return (
    <ExecutiveEntry
      index={index}
      s={s}
      c={c}
      bold={entry.company.trim() || entry.jobTitle.trim() || "—"}
      italic={entry.jobTitle.trim() || undefined}
      dates={formatDates(entry.start, entry.end, entry.isCurrent, present)}
      meta={entry.location.trim() || undefined}
      oneLineMeta
    >
      {bullets.length > 0 && (
        <ul style={{ margin: "5px 0 0", padding: 0, listStyle: "none" }}>
          {bullets.map((b, i) => (
            <Bullet key={`${b}-${i}`} text={b} s={s} c={c} />
          ))}
        </ul>
      )}
    </ExecutiveEntry>
  );
}

function ExecutiveProject({
  entry,
  index,
  s,
  c,
}: {
  entry: CvProject;
  index: number;
  s: CvCustomizationSettings;
  c: ReturnType<typeof resolveTemplateColors>;
}) {
  return (
    <ExecutiveEntry
      index={index}
      s={s}
      c={c}
      bold={entry.name.trim() || "—"}
      italic={entry.role.trim() || undefined}
      dates={entry.date.trim() || undefined}
      oneLineMeta
    >
      {entry.description.trim() && (
        <p style={{ margin: "3px 0 0", fontSize: base(s), color: c.secondary, lineHeight: lh(s) }}>
          {entry.description.trim()}
        </p>
      )}
      {entry.technologies.trim() && (
        <p style={{ margin: "2px 0 0", fontSize: s.header.contactSize, fontStyle: "italic", color: c.secondary }}>
          {entry.technologies.trim()}
        </p>
      )}
    </ExecutiveEntry>
  );
}

function Bullet({ text, s, c }: { text: string; s: CvCustomizationSettings; c: ReturnType<typeof resolveTemplateColors> }) {
  return (
    <li
      style={{
        position: "relative",
        paddingLeft: 14,
        fontSize: base(s),
        color: c.primary,
        lineHeight: lh(s),
        marginTop: 2,
      }}
    >
      <span aria-hidden style={{ position: "absolute", insetInlineStart: 1, top: 0, fontSize: base(s) }}>
        •
      </span>
      {text}
    </li>
  );
}

/** Balanced n-column bullet list (fewer columns than items when sparse). */
function ColumnBullets({
  items,
  columns,
  s,
  c,
}: {
  items: string[];
  columns: number;
  s: CvCustomizationSettings;
  c: ReturnType<typeof resolveTemplateColors>;
}) {
  const cols = Math.min(columns, items.length);
  return (
    <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, columnGap: 16 }}>
      {items.map((item, i) => (
        <Bullet key={`${item}-${i}`} text={item} s={s} c={c} />
      ))}
    </div>
  );
}

const base = (s: CvCustomizationSettings) => s.typography.baseSize;
const lh = (s: CvCustomizationSettings) => s.spacing.lineHeight;
