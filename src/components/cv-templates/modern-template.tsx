import { type ReactNode } from "react";
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
 * The "modern" template — left-aligned header with a prominent steel-blue
 * name, lighter-blue title and an icon contact line; steel-blue section
 * headings with thin blue rules; "Role, Company" entries with dates +
 * location stacked top-right; two-column skills, three-column languages,
 * two-column certificates. Modern corporate look; ATS-friendly (real text,
 * icons are decorative inline SVGs).
 */

const IDENTITY: TemplateIdentity = {
  accent: "#2f5c99", // steel blue — name, headings, rules
  title: "#4a78b0", // lighter steel — professional title
  body: "#1f2937",
  meta: "#555f6b",
  bullet: "#1f2937",
  link: "#2f5c99",
  font: "sans-modern",
  baseSize: 12,
  fullNameSize: 30,
  sectionHeadingSize: 13,
  entryHeaderSize: 13,
  titleSize: 19,
  contactSize: 11.5,
  lineHeight: 1.5,
  spaceBetween: 12,
  leftRightMarginMm: 10,
  topBottomMarginMm: 12,
  sectionSpacing: 16,
};

type C = ReturnType<typeof resolveTemplateColors>;

export function ModernCvTemplate({ cv, labels }: TemplateProps) {
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
              <ModernExperience key={e.id} entry={e} index={i} s={s} c={c} present={present} />
            ))}
          </Section>
        ) : null;
      case "education":
        return education.length ? (
          <Section title={labels.education} s={s} c={c}>
            {education.map((e, i) => (
              <ModernEntry
                key={e.id}
                index={i}
                s={s}
                c={c}
                bold={e.degree.trim() || e.institution.trim() || "—"}
                italic={e.institution.trim() || undefined}
                dates={formatDates(e.start, e.end, false, "")}
                meta={e.location.trim() || undefined}
              >
                {e.description.trim() && (
                  <p style={{ margin: "3px 0 0", fontSize: base, color: c.secondary, lineHeight: lh }}>
                    {e.description.trim()}
                  </p>
                )}
              </ModernEntry>
            ))}
          </Section>
        ) : null;
      case "skills":
        return skills.length ? (
          <Section title={labels.skills} s={s} c={c}>
            <ColumnBullets items={skills.map((x) => x.trim())} columns={2} s={s} c={c} />
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
              columns={2}
              s={s}
              c={c}
            />
          </Section>
        ) : null;
      case "projects":
        return projects.length ? (
          <Section title={labels.projects} s={s} c={c}>
            {projects.map((p, i) => (
              <ModernProject key={p.id} entry={p} index={i} s={s} c={c} />
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
                  margin: "4px 0 0",
                  fontSize: Math.max(13, s.header.titleSize - 4),
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
                  margin: "12px 0 0",
                  fontSize: s.header.contactSize,
                  color: c.secondary,
                  lineHeight: 1.5,
                  display: "flex",
                  flexWrap: "wrap",
                  alignItems: "center",
                  columnGap: 16,
                  rowGap: 4,
                }}
              >
                {contact.map((item, i) => (
                  <span
                    key={`${i}-${item.text}`}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 5,
                      overflowWrap: "break-word",
                    }}
                  >
                    <span aria-hidden style={{ display: "inline-flex", color: c.primary }}>
                      <ContactIcon kind={iconKindFor(item)} />
                    </span>
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
                      <span>{item.text}</span>
                    )}
                  </span>
                ))}
              </p>
            )}
            {other && (
              <p
                style={{
                  margin: "4px 0 0",
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
// Contact icons (decorative inline SVG — no text, ATS-safe)
// ---------------------------------------------------------------------------

type IconKind = "mail" | "phone" | "pin" | "linkedin" | "globe";

function iconKindFor(item: { text: string; href?: string }): IconKind {
  if (item.href) {
    return /linkedin\./i.test(item.text) ? "linkedin" : "globe";
  }
  const t = item.text;
  if (/@/.test(t)) return "mail";
  if (/^[\d+()\s.-]{5,}$/.test(t)) return "phone";
  return "pin";
}

function ContactIcon({ kind }: { kind: IconKind }) {
  const size = 11;
  const stroke = {
    fill: "none" as const,
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (kind) {
    case "mail":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
          <rect x="2.5" y="5" width="19" height="14" rx="2" {...stroke} />
          <path d="m3.5 7 8.5 6 8.5-6" {...stroke} />
        </svg>
      );
    case "phone":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"
            {...stroke}
          />
        </svg>
      );
    case "pin":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 21s-6.5-5.5-6.5-10.5a6.5 6.5 0 0 1 13 0C18.5 15.5 12 21 12 21Z" {...stroke} />
          <circle cx="12" cy="10.5" r="2.2" {...stroke} />
        </svg>
      );
    case "globe":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="9" {...stroke} />
          <path d="M3 12h18M12 3a14.5 14.5 0 0 1 0 18M12 3a14.5 14.5 0 0 0 0 18" {...stroke} />
        </svg>
      );
    case "linkedin":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
          <rect x="2.5" y="2.5" width="19" height="19" rx="2.5" fill="currentColor" />
          <g fill="#ffffff">
            <circle cx="8" cy="7.7" r="1.5" />
            <path d="M6.9 10.8h2.2V19H6.9z" />
            <path d="M11.6 10.8h2.15v1.05c.5-.75 1.35-1.25 2.5-1.25 2.4 0 3.25 1.55 3.25 3.9V19h-2.2v-4.05c0-1.15-.15-2.1-1.55-2.1-1.45 0-1.95 1.05-1.95 2.1V19h-2.2z" />
          </g>
        </svg>
      );
  }
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
          fontSize: s.typography.sectionHeadingSize,
          fontWeight: 700,
          letterSpacing: "0.02em",
          color: c.heading,
          paddingBottom: 4,
          borderBottom: `1.5px solid ${c.divider}`,
        }}
      >
        {title}
      </h2>
      <div style={{ paddingTop: 8 }}>{children}</div>
    </section>
  );
}

function ModernEntry({
  bold,
  italic,
  dates,
  meta,
  index,
  s,
  c,
  children,
}: {
  bold: string;
  italic?: string;
  dates?: string;
  meta?: string;
  index: number;
  s: CvCustomizationSettings;
  c: C;
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
        {(datesShown || metaShown) && (
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
        )}
      </div>
      {children}
    </div>
  );
}

function ModernExperience({
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
  const responsibilities = entry.responsibilities.filter((r) => r.trim());
  const achievements = s.entries.showAchievements ? entry.achievements.filter((a) => a.trim()) : [];
  const bullets = [...responsibilities, ...achievements];
  return (
    <ModernEntry
      index={index}
      s={s}
      c={c}
      bold={entry.jobTitle.trim() || entry.company.trim() || "—"}
      italic={entry.company.trim() || undefined}
      dates={formatDates(entry.start, entry.end, entry.isCurrent, present)}
      meta={entry.location.trim() || undefined}
    >
      {bullets.length > 0 && (
        <ul style={{ margin: "5px 0 0", padding: 0, listStyle: "none" }}>
          {bullets.map((b, i) => (
            <Bullet key={`${b}-${i}`} text={b} s={s} c={c} />
          ))}
        </ul>
      )}
    </ModernEntry>
  );
}

function ModernProject({
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
    <ModernEntry
      index={index}
      s={s}
      c={c}
      bold={entry.name.trim() || "—"}
      italic={entry.role.trim() || undefined}
      dates={entry.date.trim() || undefined}
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
    </ModernEntry>
  );
}

function Bullet({ text, s, c }: { text: string; s: CvCustomizationSettings; c: C }) {
  return (
    <li
      style={{
        position: "relative",
        paddingLeft: 14,
        fontSize: s.typography.baseSize,
        color: c.primary,
        lineHeight: s.spacing.lineHeight,
        marginTop: 2,
      }}
    >
      <span aria-hidden style={{ position: "absolute", insetInlineStart: 1, top: 0, fontSize: s.typography.baseSize }}>
        •
      </span>
      {text}
    </li>
  );
}

function ColumnBullets({
  items,
  columns,
  s,
  c,
}: {
  items: string[];
  columns: number;
  s: CvCustomizationSettings;
  c: C;
}) {
  const cols = Math.min(columns, items.length);
  return (
    <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, columnGap: 28 }}>
      {items.map((item, i) => (
        <Bullet key={`${item}-${i}`} text={item} s={s} c={c} />
      ))}
    </div>
  );
}
