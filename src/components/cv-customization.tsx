"use client";

/**
 * CV customization panel — the appearance editor for the single CV template.
 *
 * Vertical category rail (Layout, Font Size, Spacing, Entries, Headings,
 * Font, Colors, Header, Photo, Links, Footer, Sections) + one clean panel per
 * category. Every control mutates the single `CvCustomizationSettings` object
 * via `onChange(next)`, so the live preview (same `CvDocument` instance) and
 * the PDF export update instantly — there is no separate "save" step.
 *
 * Purely presentational + stateless controls; all data lives on the document.
 */
import { useState, type CSSProperties, type ReactNode } from "react";
import { useI18n } from "@/lib/i18n";
import { Icon, type IconName } from "@/components/icon";
import { Card } from "@/components/ui";
import {
  CV_COLOR_PRESETS,
  CV_FONTS,
  CvSectionKeys,
  type CvAlign,
  type CvColumns,
  type CvCustomizationSettings,
  type CvFontId,
  type CvHeadingCase,
  type CvPhotoPlacement,
  type CvPhotoShape,
  type CvSectionKey,
  type CvTitleStyle,
} from "@/lib/templates/cv-customization";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CvCustomizationPanelProps {
  settings: CvCustomizationSettings;
  onChange: (next: CvCustomizationSettings) => void;
  hasPhoto: boolean;
}

type CategoryId =
  | "layout"
  | "fontSize"
  | "spacing"
  | "entries"
  | "headings"
  | "font"
  | "colors"
  | "header"
  | "photo"
  | "links"
  | "footer"
  | "sections";

const CATEGORIES: { id: CategoryId; icon: IconName; labelKey: string }[] = [
  { id: "layout", icon: "grid", labelKey: "templates.catLayout" },
  { id: "fontSize", icon: "file", labelKey: "templates.catFontSize" },
  { id: "spacing", icon: "menu", labelKey: "templates.catSpacing" },
  { id: "entries", icon: "briefcase", labelKey: "templates.catEntries" },
  { id: "headings", icon: "activity", labelKey: "templates.catHeadings" },
  { id: "font", icon: "edit", labelKey: "templates.catFont" },
  { id: "colors", icon: "spark", labelKey: "templates.catColors" },
  { id: "header", icon: "user", labelKey: "templates.catHeader" },
  { id: "photo", icon: "image", labelKey: "templates.catPhoto" },
  { id: "links", icon: "globe", labelKey: "templates.catLinks" },
  { id: "footer", icon: "bookmark", labelKey: "templates.catFooter" },
  { id: "sections", icon: "folder", labelKey: "templates.catSections" },
];

/** Full professional palettes applied by the Colors presets. */
const PRESET_PALETTE: Record<(typeof CV_COLOR_PRESETS)[number]["id"], CvCustomizationSettings["colors"]> = {
  classic: {
    primary: "#141414",
    secondary: "#3a3a3a",
    heading: "#141414",
    accent: "#2a2a2a",
    divider: "#141414",
    link: "#3a3a3a",
  },
  charcoal: {
    primary: "#2b2b2b",
    secondary: "#4a4a4a",
    heading: "#2b2b2b",
    accent: "#404040",
    divider: "#2b2b2b",
    link: "#4a4a4a",
  },
  darkGray: {
    primary: "#3a3a3a",
    secondary: "#575757",
    heading: "#3a3a3a",
    accent: "#4d4d4d",
    divider: "#3a3a3a",
    link: "#575757",
  },
  navy: {
    primary: "#1f3a5f",
    secondary: "#44586e",
    heading: "#1f3a5f",
    accent: "#33517a",
    divider: "#1f3a5f",
    link: "#33517a",
  },
};

// ---------------------------------------------------------------------------
// Reusable controls
// ---------------------------------------------------------------------------

const fmt = (v: number, decimals: number) => (decimals > 0 ? v.toFixed(decimals) : String(Math.round(v)));

function PanelCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card as="section" className="p-4 sm:p-5">
      <h3 className="mb-4 text-sm font-bold text-ink">{title}</h3>
      <div className="space-y-5">{children}</div>
    </Card>
  );
}

function RowLabel({ label, value }: { label: string; value?: string }) {
  return (
    <div className="mb-2 flex items-baseline justify-between gap-3">
      <span className="text-xs font-semibold text-ink">{label}</span>
      {value !== undefined && (
        <span className="text-xs font-bold tabular-nums text-muted">{value}</span>
      )}
    </div>
  );
}

/**
 * Tick slider: a row of tick cells (click to jump), the current value, and
 * minus/plus stepper buttons. Matches the reference UI of the Font Size /
 * Spacing panels.
 */
function TickSlider({
  label,
  value,
  min,
  max,
  step,
  ticks = 9,
  decimals = 0,
  unit = "",
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  ticks?: number;
  decimals?: number;
  unit?: string;
  onChange: (v: number) => void;
}) {
  const span = max - min;
  const count = Math.max(2, ticks);
  const activeIdx = Math.max(0, Math.min(count - 1, Math.round(((value - min) / span) * (count - 1))));
  const valueAt = (i: number) => {
    const raw = min + (i / (count - 1)) * span;
    return decimals > 0 ? Number(raw.toFixed(decimals)) : Math.round(raw / step) * step;
  };
  const bump = (dir: 1 | -1) => {
    const next = Number((value + dir * step).toFixed(decimals));
    onChange(Math.min(max, Math.max(min, next)));
  };
  const stepBtn =
    "flex h-9 w-10 shrink-0 items-center justify-center rounded-lg border border-line-strong bg-surface text-ink transition-colors hover:bg-surface-2";
  return (
    <div>
      <RowLabel label={label} value={`${fmt(value, decimals)}${unit}`} />
      <div className="flex items-center gap-2.5">
        <div
          className="grid min-w-0 flex-1 gap-1"
          style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}
          role="group"
          aria-label={label}
        >
          {Array.from({ length: count }, (_, i) => (
            <button
              key={i}
              type="button"
              onClick={() => onChange(valueAt(i))}
              aria-label={`${label}: ${fmt(valueAt(i), decimals)}${unit}`}
              aria-pressed={i === activeIdx}
              className="flex h-9 items-center justify-center rounded-md border border-line bg-surface-2/50 transition-colors hover:border-accent/60"
            >
              <span
                aria-hidden
                className={`h-4 w-full rounded-sm ${i === activeIdx ? "bg-accent" : "bg-line"}`}
              />
            </button>
          ))}
        </div>
        <button type="button" className={stepBtn} onClick={() => bump(-1)} aria-label={`${label} −`}>
          <span aria-hidden className="text-base leading-none">
            −
          </span>
        </button>
        <button type="button" className={stepBtn} onClick={() => bump(1)} aria-label={`${label} +`}>
          <Icon name="plus" size={14} strokeWidth={2.4} />
        </button>
      </div>
    </div>
  );
}

/** Segmented choice (strings or numbers) — alignment, case, styles, weights. */
function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label?: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div>
      {label && <div className="mb-2 text-xs font-semibold text-ink">{label}</div>}
      <div className="inline-flex max-w-full flex-wrap rounded-xl border border-line-strong bg-surface p-1">
        {options.map((o) => (
          <button
            key={String(o.value)}
            type="button"
            aria-pressed={value === o.value}
            onClick={() => onChange(o.value)}
            className={`rounded-lg px-3 py-1.5 text-xs font-bold transition-colors ${
              value === o.value ? "bg-accent text-white" : "text-muted hover:text-ink"
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex w-full items-center justify-between gap-3 text-start"
    >
      <span className="text-xs font-semibold text-ink">{label}</span>
      <span
        aria-hidden
        className={`relative inline-flex h-6 w-11 shrink-0 rounded-full transition-colors ${
          checked ? "bg-accent" : "bg-line-strong"
        }`}
      >
        <span
          className={`absolute start-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
            checked ? "translate-x-5 rtl:-translate-x-5" : ""
          }`}
        />
      </span>
    </button>
  );
}

/** Color swatch + HEX input + optional preset row. Commits valid hex only. */
function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  // null = "not editing" → render the prop (so external changes, e.g. preset
  // apply, are reflected without an effect); a string = in-flight draft.
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? value;
  const commitText = (text: string) => {
    setDraft(text);
    const v = text.trim().toLowerCase();
    if (/^#?[0-9a-f]{6}$/.test(v)) onChange(`#${v.replace(/^#/, "")}`);
  };
  return (
    <div>
      <RowLabel label={label} value={value.toUpperCase()} />
      <div className="flex items-center gap-2">
        <span className="relative inline-flex h-9 w-12 shrink-0 items-center justify-center rounded-lg border border-line-strong bg-surface p-1">
          <span aria-hidden className="absolute inset-1 rounded-md" style={{ backgroundColor: value }} />
          <input
            type="color"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            aria-label={label}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          />
        </span>
        <input
          type="text"
          value={shown}
          onChange={(e) => commitText(e.target.value)}
          onBlur={() => setDraft(null)}
          spellCheck={false}
          maxLength={7}
          aria-label={`${label} (HEX)`}
          className="h-9 w-24 rounded-lg border border-line-strong bg-surface px-2.5 font-mono text-xs uppercase text-ink outline-none transition focus:border-accent focus:ring-4 focus:ring-accent/10"
        />
      </div>
    </div>
  );
}

/** One / Two / Mixed column layouts with mini-previews. */
function ColumnPicker({
  label,
  value,
  labels,
  onChange,
}: {
  label: string;
  value: CvColumns;
  labels: Record<CvColumns, string>;
  onChange: (v: CvColumns) => void;
}) {
  const options: { value: CvColumns; preview: ReactNode }[] = [
    {
      value: "one",
      preview: (
        <span className="flex flex-col gap-1">
          <span aria-hidden className="h-1 w-full rounded-full bg-ink/50" />
          <span aria-hidden className="h-1 w-3/4 rounded-full bg-ink/25" />
          <span aria-hidden className="h-1 w-full rounded-full bg-ink/50" />
        </span>
      ),
    },
    {
      value: "two",
      preview: (
        <span className="flex items-start gap-1.5">
          <span className="flex flex-1 flex-col gap-1">
            <span aria-hidden className="h-1 w-full rounded-full bg-ink/50" />
            <span aria-hidden className="h-1 w-full rounded-full bg-ink/25" />
          </span>
          <span className="flex flex-1 flex-col gap-1">
            <span aria-hidden className="h-1 w-full rounded-full bg-ink/25" />
            <span aria-hidden className="h-1 w-3/4 rounded-full bg-ink/25" />
          </span>
        </span>
      ),
    },
    {
      value: "mix",
      preview: (
        <span className="flex flex-col gap-1">
          <span aria-hidden className="h-1 w-full rounded-full bg-ink/50" />
          <span className="flex gap-1.5">
            <span aria-hidden className="h-1 flex-1 rounded-full bg-ink/25" />
            <span aria-hidden className="h-1 flex-1 rounded-full bg-ink/25" />
          </span>
        </span>
      ),
    },
  ];
  return (
    <div>
      <div className="mb-2 text-xs font-semibold text-ink">{label}</div>
      <div className="grid grid-cols-3 gap-2">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            aria-pressed={value === o.value}
            onClick={() => onChange(o.value)}
            className={`flex flex-col items-center gap-2 rounded-xl border p-2.5 transition-colors ${
              value === o.value
                ? "border-accent bg-accent-soft/40"
                : "border-line bg-surface hover:border-accent/50"
            }`}
          >
            <span className="flex h-10 w-full items-center justify-center rounded-md bg-surface-2/70 px-1.5">
              {o.preview}
            </span>
            <span className="text-[11px] font-bold text-ink">{labels[o.value]}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

const SHAPE_OPTIONS: { value: CvPhotoShape; labelKey: string; box: CSSProperties }[] = [
  { value: "circle", labelKey: "templates.shapeCircle", box: { width: 26, height: 26, borderRadius: "9999px" } },
  { value: "square", labelKey: "templates.shapeSquare", box: { width: 26, height: 26, borderRadius: 2 } },
  { value: "rounded", labelKey: "templates.shapeRounded", box: { width: 26, height: 26, borderRadius: 6 } },
  { value: "portrait", labelKey: "templates.shapePortrait", box: { width: 22, height: 30, borderRadius: 2 } },
  { value: "rounded-portrait", labelKey: "templates.shapeRoundedPortrait", box: { width: 22, height: 30, borderRadius: 6 } },
];

function ShapePicker({
  label,
  value,
  onChange,
}: {
  label: string;
  value: CvPhotoShape;
  onChange: (v: CvPhotoShape) => void;
}) {
  const { t } = useI18n();
  return (
    <div>
      <div className="mb-2 text-xs font-semibold text-ink">{label}</div>
      <div className="grid grid-cols-5 gap-2">
        {SHAPE_OPTIONS.map((o) => (
          <button
            key={o.value}
            type="button"
            aria-pressed={value === o.value}
            onClick={() => onChange(o.value)}
            className={`flex flex-col items-center gap-1.5 rounded-xl border px-1 pb-1.5 pt-3 transition-colors ${
              value === o.value
                ? "border-accent bg-accent-soft/40"
                : "border-line bg-surface hover:border-accent/50"
            }`}
          >
            <span aria-hidden className="inline-block border-2 border-ink/60" style={o.box} />
            <span className="text-center text-[10px] font-bold leading-tight text-ink">
              {t(o.labelKey)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Reorderable section list (up/down; order only — data is never touched). */
function SectionOrderList({
  order,
  labels,
  onMove,
}: {
  order: CvSectionKey[];
  labels: Record<CvSectionKey, string>;
  onMove: (index: number, dir: -1 | 1) => void;
}) {
  const { t } = useI18n();
  const moveBtn =
    "rounded-md p-1 text-faint transition-colors hover:bg-surface-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-30";
  return (
    <ul className="space-y-1.5">
      {order.map((key, i) => (
        <li
          key={key}
          className="flex items-center justify-between gap-2 rounded-lg border border-line bg-surface px-3 py-1.5"
        >
          <span className="truncate text-xs font-semibold text-ink">{labels[key]}</span>
          <span className="flex shrink-0 gap-0.5">
            <button
              type="button"
              className={moveBtn}
              disabled={i === 0}
              onClick={() => onMove(i, -1)}
              aria-label={`${labels[key]}: ${t("templates.moveUp")}`}
            >
              <Icon name="arrowUp" size={13} strokeWidth={2.2} />
            </button>
            <button
              type="button"
              className={moveBtn}
              disabled={i === order.length - 1}
              onClick={() => onMove(i, 1)}
              aria-label={`${labels[key]}: ${t("templates.moveDown")}`}
            >
              <Icon name="arrowUp" size={13} strokeWidth={2.2} className="rotate-180" />
            </button>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Font family cards — each previewed in its own (web-safe) stack. */
function FontPicker({
  value,
  onChange,
}: {
  value: CvFontId;
  onChange: (v: CvFontId) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {CV_FONTS.map((f) => (
        <button
          key={f.id}
          type="button"
          aria-pressed={value === f.id}
          onClick={() => onChange(f.id)}
          className={`rounded-xl border p-3 text-start transition-colors ${
            value === f.id
              ? "border-accent bg-accent-soft/40"
              : "border-line bg-surface hover:border-accent/50"
          }`}
        >
          <span
            aria-hidden
            className="block text-2xl leading-8 text-ink"
            style={{ fontFamily: f.stack }}
          >
            Aa
          </span>
          <span className="mt-1 block truncate text-xs font-bold text-ink">{t(f.labelKey)}</span>
          <span className="block text-[11px] text-muted">
            {f.category === "serif" ? t("templates.fontSerif") : t("templates.fontSans")}
          </span>
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

export function CvCustomizationPanel({
  settings,
  onChange,
  hasPhoto,
}: CvCustomizationPanelProps) {
  const { t } = useI18n();
  const [active, setActive] = useState<CategoryId>("layout");
  const s = settings;

  const sectionLabels = {
    summary: t("templates.sectionSummary"),
    experience: t("templates.sectionExperience"),
    education: t("templates.sectionEducation"),
    skills: t("templates.sectionSkills"),
    languages: t("templates.sectionLanguages"),
    certificates: t("templates.sectionCertificates"),
    projects: t("templates.sectionProjects"),
    interests: t("templates.sectionInterests"),
  };

  const weightOptions = (values: number[]) =>
    values.map((v) => ({
      value: v,
      label:
        v === 400
          ? t("templates.weightRegular")
          : v === 500
            ? t("templates.weightMedium")
            : v === 600
              ? t("templates.weightSemiBold")
              : t("templates.weightBold"),
    }));

  const alignOptions = (values: CvAlign[]) =>
    values.map((v) => ({
      value: v,
      label: v === "left" ? t("templates.alignLeft") : t("templates.alignCenter"),
    }));

  const patch = <K extends keyof CvCustomizationSettings>(group: K, p: Partial<CvCustomizationSettings[K]>) =>
    onChange({ ...s, [group]: { ...s[group], ...p } });

  const moveSection = (index: number, dir: -1 | 1) => {
    const order = [...s.layout.sectionOrder];
    const to = index + dir;
    if (to < 0 || to >= order.length) return;
    [order[index], order[to]] = [order[to], order[index]];
    patch("layout", { sectionOrder: order });
  };

  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
      {/* ------------------------- Category rail ------------------------- */}
      <nav
        aria-label={t("templates.tabCustomize")}
        className="flex shrink-0 gap-1.5 overflow-x-auto pb-1 lg:max-h-[calc(100vh-11rem)] lg:w-40 lg:flex-col lg:overflow-x-visible lg:overflow-y-auto lg:pb-0 lg:pe-1"
      >
        {CATEGORIES.map((c) => (
          <button
            key={c.id}
            type="button"
            aria-pressed={active === c.id}
            onClick={() => setActive(c.id)}
            className={`flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-xs font-bold transition-colors lg:w-full ${
              active === c.id
                ? "bg-accent text-white"
                : "bg-surface text-muted hover:bg-surface-2 hover:text-ink"
            }`}
          >
            <Icon name={c.icon} size={14} strokeWidth={2} />
            {t(c.labelKey)}
          </button>
        ))}
      </nav>

      {/* --------------------------- Active panel ------------------------- */}
      <div className="min-w-0 flex-1">
        {active === "layout" && (
          <PanelCard title={t("templates.catLayout")}>
            <ColumnPicker
              label={t("templates.columns")}
              value={s.layout.columns}
              labels={{
                one: t("templates.colOne"),
                two: t("templates.colTwo"),
                mix: t("templates.colMix"),
              }}
              onChange={(columns) => patch("layout", { columns })}
            />
            <div>
              <div className="mb-2 text-xs font-semibold text-ink">{t("templates.sectionOrder")}</div>
              <SectionOrderList
                order={s.layout.sectionOrder}
                labels={sectionLabels}
                onMove={moveSection}
              />
            </div>
          </PanelCard>
        )}

        {active === "fontSize" && (
          <PanelCard title={t("templates.catFontSize")}>
            <TickSlider
              label={t("templates.baseSize")}
              value={s.typography.baseSize}
              min={9}
              max={20}
              step={1}
              unit="px"
              onChange={(baseSize) => patch("typography", { baseSize })}
            />
            <TickSlider
              label={t("templates.fullName")}
              value={s.typography.fullNameSize}
              min={16}
              max={60}
              step={2}
              unit="px"
              onChange={(fullNameSize) => patch("typography", { fullNameSize })}
            />
            <TickSlider
              label={t("templates.sectionHeadings")}
              value={s.typography.sectionHeadingSize}
              min={10}
              max={24}
              step={1}
              unit="px"
              onChange={(sectionHeadingSize) => patch("typography", { sectionHeadingSize })}
            />
            <TickSlider
              label={t("templates.entryHeader")}
              value={s.typography.entryHeaderSize}
              min={10}
              max={24}
              step={1}
              unit="px"
              onChange={(entryHeaderSize) => patch("typography", { entryHeaderSize })}
            />
          </PanelCard>
        )}

        {active === "spacing" && (
          <PanelCard title={t("templates.catSpacing")}>
            <TickSlider
              label={t("templates.lineHeight")}
              value={s.spacing.lineHeight}
              min={1.05}
              max={2.2}
              step={0.05}
              ticks={10}
              decimals={2}
              onChange={(lineHeight) => patch("spacing", { lineHeight })}
            />
            <TickSlider
              label={t("templates.spaceBetween")}
              value={s.spacing.spaceBetween}
              min={0}
              max={40}
              step={2}
              unit="px"
              onChange={(spaceBetween) => patch("spacing", { spaceBetween })}
            />
            <TickSlider
              label={t("templates.lrMargin")}
              value={s.spacing.leftRightMarginMm}
              min={8}
              max={30}
              step={0.5}
              ticks={12}
              decimals={1}
              unit="mm"
              onChange={(leftRightMarginMm) => patch("spacing", { leftRightMarginMm })}
            />
            <TickSlider
              label={t("templates.tbMargin")}
              value={s.spacing.topBottomMarginMm}
              min={8}
              max={30}
              step={0.5}
              ticks={12}
              decimals={1}
              unit="mm"
              onChange={(topBottomMarginMm) => patch("spacing", { topBottomMarginMm })}
            />
          </PanelCard>
        )}

        {active === "entries" && (
          <PanelCard title={t("templates.catEntries")}>
            <Toggle
              label={t("templates.showDates")}
              checked={s.entries.showDates}
              onChange={(showDates) => patch("entries", { showDates })}
            />
            <Toggle
              label={t("templates.showLocation")}
              checked={s.entries.showLocation}
              onChange={(showLocation) => patch("entries", { showLocation })}
            />
            <Toggle
              label={t("templates.showAchievements")}
              checked={s.entries.showAchievements}
              onChange={(showAchievements) => patch("entries", { showAchievements })}
            />
          </PanelCard>
        )}

        {active === "headings" && (
          <PanelCard title={t("templates.catHeadings")}>
            <Segmented<CvHeadingCase>
              label={t("templates.headingCase")}
              value={s.headings.headingCase}
              options={[
                { value: "uppercase", label: t("templates.caseUppercase") },
                { value: "title", label: t("templates.caseTitle") },
                { value: "none", label: t("templates.caseNone") },
              ]}
              onChange={(headingCase) => patch("headings", { headingCase })}
            />
            <Segmented<number>
              label={t("templates.headingWeight")}
              value={s.headings.weight}
              options={weightOptions([400, 600, 700])}
              onChange={(weight) => patch("headings", { weight })}
            />
            <Toggle
              label={t("templates.headingRule")}
              checked={s.headings.rule}
              onChange={(rule) => patch("headings", { rule })}
            />
            <TickSlider
              label={t("templates.letterSpacing")}
              value={s.headings.letterSpacing}
              min={0}
              max={0.3}
              step={0.01}
              ticks={10}
              decimals={2}
              unit="em"
              onChange={(letterSpacing) => patch("headings", { letterSpacing })}
            />
          </PanelCard>
        )}

        {active === "font" && (
          <PanelCard title={t("templates.catFont")}>
            <FontPicker value={s.typography.font} onChange={(font) => patch("typography", { font })} />
          </PanelCard>
        )}

        {active === "colors" && (
          <PanelCard title={t("templates.catColors")}>
            <div>
              <div className="mb-2 text-xs font-semibold text-ink">{t("templates.presets")}</div>
              <div className="flex flex-wrap gap-2">
                {CV_COLOR_PRESETS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    aria-pressed={s.colors.primary === p.value && s.colors.heading === p.value}
                    onClick={() => onChange({ ...s, colors: { ...PRESET_PALETTE[p.id] } })}
                    className="flex items-center gap-2 rounded-full border border-line bg-surface py-1 pe-3 ps-1 text-[11px] font-bold text-ink transition-colors hover:border-accent/60"
                  >
                    <span
                      aria-hidden
                      className="h-5 w-5 rounded-full border border-line-strong"
                      style={{ backgroundColor: p.value }}
                    />
                    {t(p.labelKey)}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid gap-5 sm:grid-cols-2">
              <ColorField
                label={t("templates.colorPrimary")}
                value={s.colors.primary}
                onChange={(primary) => patch("colors", { primary })}
              />
              <ColorField
                label={t("templates.colorSecondary")}
                value={s.colors.secondary}
                onChange={(secondary) => patch("colors", { secondary })}
              />
              <ColorField
                label={t("templates.colorHeading")}
                value={s.colors.heading}
                onChange={(heading) => patch("colors", { heading })}
              />
              <ColorField
                label={t("templates.colorAccent")}
                value={s.colors.accent}
                onChange={(accent) => patch("colors", { accent })}
              />
              <ColorField
                label={t("templates.colorDivider")}
                value={s.colors.divider}
                onChange={(divider) => patch("colors", { divider })}
              />
              <ColorField
                label={t("templates.colorLink")}
                value={s.colors.link}
                onChange={(link) => patch("colors", { link })}
              />
            </div>
          </PanelCard>
        )}

        {active === "header" && (
          <PanelCard title={t("templates.catHeader")}>
            <Segmented<number>
              label={t("templates.nameWeight")}
              value={s.header.nameWeight}
              options={weightOptions([400, 500, 600, 700])}
              onChange={(nameWeight) => patch("header", { nameWeight })}
            />
            <TickSlider
              label={t("templates.titleSize")}
              value={s.header.titleSize}
              min={12}
              max={30}
              step={1}
              unit="px"
              onChange={(titleSize) => patch("header", { titleSize })}
            />
            <Segmented<CvTitleStyle>
              label={t("templates.titleStyle")}
              value={s.header.titleStyle}
              options={[
                { value: "normal", label: t("templates.styleNormal") },
                { value: "italic", label: t("templates.styleItalic") },
              ]}
              onChange={(titleStyle) => patch("header", { titleStyle })}
            />
            <TickSlider
              label={t("templates.contactSize")}
              value={s.header.contactSize}
              min={9}
              max={16}
              step={0.5}
              decimals={1}
              unit="px"
              onChange={(contactSize) => patch("header", { contactSize })}
            />
            <TickSlider
              label={t("templates.headerSpacing")}
              value={s.header.headerSpacing}
              min={0}
              max={40}
              step={4}
              unit="px"
              onChange={(headerSpacing) => patch("header", { headerSpacing })}
            />
            <Segmented<CvAlign>
              label={t("templates.alignment")}
              value={s.header.alignment}
              options={alignOptions(["left", "center"])}
              onChange={(alignment) => patch("header", { alignment })}
            />
            <Segmented<CvPhotoPlacement>
              label={t("templates.photoPlacement")}
              value={s.header.photoPlacement}
              options={[
                { value: "right", label: t("templates.placementRight") },
                { value: "left", label: t("templates.placementLeft") },
              ]}
              onChange={(photoPlacement) => patch("header", { photoPlacement })}
            />
          </PanelCard>
        )}

        {active === "photo" && (
          <PanelCard title={t("templates.catPhoto")}>
            {!hasPhoto && (
              <p className="rounded-lg border border-line bg-surface-2/60 px-3 py-2 text-xs leading-5 text-muted">
                {t("templates.noPhoto")}
              </p>
            )}
            <ShapePicker
              label={t("templates.shape")}
              value={s.photo.shape}
              onChange={(shape) => patch("photo", { shape })}
            />
            <TickSlider
              label={t("templates.photoSize")}
              value={s.photo.size}
              min={72}
              max={220}
              step={4}
              ticks={10}
              unit="px"
              onChange={(size) => patch("photo", { size })}
            />
            <TickSlider
              label={t("templates.zoom")}
              value={s.photo.zoom}
              min={1}
              max={2.5}
              step={0.05}
              ticks={10}
              decimals={2}
              unit="×"
              onChange={(zoom) => patch("photo", { zoom })}
            />
            <TickSlider
              label={t("templates.posX")}
              value={s.photo.posX}
              min={0}
              max={100}
              step={5}
              unit="%"
              onChange={(posX) => patch("photo", { posX })}
            />
            <TickSlider
              label={t("templates.posY")}
              value={s.photo.posY}
              min={0}
              max={100}
              step={5}
              unit="%"
              onChange={(posY) => patch("photo", { posY })}
            />
          </PanelCard>
        )}

        {active === "links" && (
          <PanelCard title={t("templates.catLinks")}>
            <ColorField
              label={t("templates.colorLink")}
              value={s.colors.link}
              onChange={(link) => patch("colors", { link })}
            />
            <Toggle
              label={t("templates.underline")}
              checked={s.links.underline}
              onChange={(underline) => patch("links", { underline })}
            />
            <Toggle
              label={t("templates.linkIcon")}
              checked={s.links.icon}
              onChange={(icon) => patch("links", { icon })}
            />
          </PanelCard>
        )}

        {active === "footer" && (
          <PanelCard title={t("templates.catFooter")}>
            <Toggle
              label={t("templates.footerVisible")}
              checked={s.footer.visible}
              onChange={(visible) => patch("footer", { visible })}
            />
            {s.footer.visible && (
              <>
                <div>
                  <div className="mb-2 text-xs font-semibold text-ink">
                    {t("templates.footerText")}
                  </div>
                  <input
                    type="text"
                    value={s.footer.text}
                    maxLength={200}
                    onChange={(e) => patch("footer", { text: e.target.value })}
                    placeholder={t("templates.footerPlaceholder")}
                    aria-label={t("templates.footerText")}
                    className="h-10 w-full rounded-xl border border-line-strong bg-surface px-3.5 text-sm text-ink outline-none transition placeholder:text-faint focus:border-accent focus:ring-4 focus:ring-accent/10"
                  />
                </div>
                <Segmented<CvAlign>
                  label={t("templates.alignment")}
                  value={s.footer.alignment}
                  options={alignOptions(["left", "center"])}
                  onChange={(alignment) => patch("footer", { alignment })}
                />
              </>
            )}
          </PanelCard>
        )}

        {active === "sections" && (
          <PanelCard title={t("templates.catSections")}>
            {CvSectionKeys.map((key) => (
              <Toggle
                key={key}
                label={sectionLabels[key]}
                checked={s.sections.visibility[key]}
                onChange={(v) =>
                  onChange({
                    ...s,
                    sections: { ...s.sections, visibility: { ...s.sections.visibility, [key]: v } },
                  })
                }
              />
            ))}
            <TickSlider
              label={t("templates.sectionSpacing")}
              value={s.sections.spacing}
              min={0}
              max={48}
              step={4}
              unit="px"
              onChange={(spacing) => patch("sections", { spacing })}
            />
          </PanelCard>
        )}
      </div>
    </div>
  );
}
