"use client";

/**
 * Templates — CV Builder (single template: "Professional Classic").
 *
 *  - LEFT: section-based editor (personal, summary, experience, education,
 *    skills, languages, certificates, projects, interests) with add /
 *    remove / reorder controls and an "Add content" grid modal.
 *  - RIGHT: live A4 preview rendered by the pure <CvDocument> — the exact
 *    same component is portalled onto <body> and printed, so the exported
 *    PDF is byte-for-byte the preview (no editor UI, no chrome).
 *  - Persistence: per-user localStorage (smallest possible structure,
 *    zero new Supabase surface). The first visit can pre-fill name/email
 *    from the account profile and import the latest Bewerbung Scanner
 *    candidate profile — mapping only what exists, inventing nothing.
 */
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n";
import { Icon, type IconName } from "@/components/icon";
import {
  Button,
  Card,
  Input,
  LoadingState,
  Modal,
  Textarea,
} from "@/components/ui";
import {
  CvDocument as CvDocumentSheet,
  CV_SHEET_MIN_HEIGHT,
  CV_SHEET_WIDTH,
  type CvLabels,
} from "@/components/cv-document";
import { CvTemplateSelector } from "@/components/cv-template-selector";
import { TEMPLATE_NAME_KEYS } from "@/components/cv-templates";
import { buildDemoCv } from "@/components/cv-templates/demo-cv";
import { CvCustomizationPanel } from "@/components/cv-customization";
import {
  defaultCvCustomization,
  type CvCustomizationSettings,
} from "@/lib/templates/cv-customization";
import { candidateProfileSchema } from "@/lib/bewerbung-schema";
import { useScaledSheet } from "@/lib/use-scaled-sheet";
import {
  cvEmpty,
  cvHasContent,
  emptyCertificate,
  emptyEducation,
  emptyExperience,
  emptyLanguage,
  emptyProject,
  importCandidateProfileToCv,
  moveEntry,
  removeEntry,
  sanitizeCvDocument,
  type CvDocument,
  type CvListSection,
  type CvPersonal,
  type CvTemplateId,
} from "@/lib/templates/cv";

interface CvBuilderProps {
  userId: string;
  profileFullName: string;
  profileEmail: string;
}

const cvStorageKey = (userId: string) => `aha:cv:${userId}`;
const cvStartedKey = (userId: string) => `aha:cv-started:${userId}`;
// "Last edited" timestamp (display metadata only — NOT part of CvDocument).
const cvSavedAtKey = (userId: string) => `aha:cv-saved-at:${userId}`;

type BuilderStep = "start" | "template" | "edit";

type AddContentSection =
  | "summary"
  | "experience"
  | "education"
  | "skills"
  | "languages"
  | "certificates"
  | "projects"
  | "interests";

// ---------------------------------------------------------------------------
// Editor building blocks
// ---------------------------------------------------------------------------

function SectionCard({
  icon,
  title,
  count,
  addLabel,
  onAdd,
  onSectionRef,
  children,
}: {
  icon: IconName;
  title: string;
  count?: number;
  addLabel?: string;
  onAdd?: () => void;
  onSectionRef?: (el: HTMLDivElement | null) => void;
  children: React.ReactNode;
}) {
  return (
    <Card className="p-4 sm:p-5" as="section">
      <div ref={onSectionRef} className="scroll-mt-24" />
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
            <Icon name={icon} size={15} />
          </span>
          <h3 className="truncate text-sm font-bold text-ink">{title}</h3>
          {count !== undefined && count > 0 && (
            <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-bold text-muted">
              {count}
            </span>
          )}
        </div>
        {onAdd && addLabel && (
          <Button variant="secondary" size="sm" onClick={onAdd}>
            <Icon name="plus" size={14} strokeWidth={2.5} />
            {addLabel}
          </Button>
        )}
      </div>
      {children}
    </Card>
  );
}

function EntryCard({
  index,
  count,
  onMoveUp,
  onMoveDown,
  onRemove,
  children,
}: {
  index: number;
  count: number;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  const iconButton =
    "rounded-lg p-1.5 text-faint transition-colors hover:bg-surface-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-35";
  return (
    <div className="rounded-xl border border-line bg-surface-2/40 p-3.5">
      <div className="mb-3 flex items-center justify-end gap-0.5">
        <button
          type="button"
          className={iconButton}
          disabled={index === 0}
          onClick={onMoveUp}
          aria-label={t("templates.moveUp")}
        >
          <Icon name="arrowUp" size={14} strokeWidth={2.25} />
        </button>
        <button
          type="button"
          className={iconButton}
          disabled={index === count - 1}
          onClick={onMoveDown}
          aria-label={t("templates.moveDown")}
        >
          <Icon name="arrowUp" size={14} strokeWidth={2.25} className="rotate-180" />
        </button>
        <button
          type="button"
          className={`${iconButton} hover:text-danger`}
          onClick={onRemove}
          aria-label={t("templates.remove")}
        >
          <Icon name="trash" size={14} strokeWidth={2} />
        </button>
      </div>
      {children}
    </div>
  );
}

function ChipInput({
  values,
  onChange,
  placeholder,
  label,
  removeLabel,
  inputRef,
}: {
  values: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  label: string;
  removeLabel: string;
  inputRef?: RefObject<HTMLInputElement | null>;
}) {
  const [draft, setDraft] = useState("");
  const commit = () => {
    const value = draft.trim();
    if (!value) return;
    const exists = values.some(
      (v) => v.trim().toLowerCase() === value.toLowerCase(),
    );
    if (!exists) onChange([...values, value]);
    setDraft("");
  };
  return (
    <div>
      {values.length > 0 && (
        <ul className="mb-3 flex flex-wrap gap-2" aria-label={label}>
          {values.map((value, i) => (
            <li
              key={`${value}-${i}`}
              className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1.5 text-xs font-semibold text-ink"
            >
              {value}
              <button
                type="button"
                onClick={() => onChange(values.filter((_, j) => j !== i))}
                aria-label={`${removeLabel}: ${value}`}
                className="text-faint transition-colors hover:text-danger"
              >
                <Icon name="x" size={12} strokeWidth={2.5} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Backspace" && draft === "" && values.length > 0) {
            onChange(values.slice(0, -1));
          }
        }}
        onBlur={() => {
          if (draft.trim()) commit();
        }}
        placeholder={placeholder}
        aria-label={label}
        className="h-10 w-full rounded-xl border border-line-strong bg-surface px-3.5 text-sm text-ink outline-none transition placeholder:text-faint focus:border-accent focus:ring-4 focus:ring-accent/10"
      />
    </div>
  );
}

function BulletEditor({
  values,
  onChange,
  addLabel,
  itemLabel,
  removeLabel,
}: {
  values: string[];
  onChange: (next: string[]) => void;
  addLabel: string;
  itemLabel: string;
  removeLabel: string;
}) {
  return (
    <div>
      <div className="space-y-2">
        {values.map((value, i) => (
          <div key={i} className="flex items-center gap-2">
            <input
              value={value}
              onChange={(e) =>
                onChange(values.map((v, j) => (j === i ? e.target.value : v)))
              }
              aria-label={`${itemLabel} ${i + 1}`}
              className="h-10 w-full min-w-0 flex-1 rounded-xl border border-line-strong bg-surface px-3.5 text-sm text-ink outline-none transition placeholder:text-faint focus:border-accent focus:ring-4 focus:ring-accent/10"
            />
            <button
              type="button"
              onClick={() => onChange(values.filter((_, j) => j !== i))}
              aria-label={`${removeLabel} ${i + 1}`}
              className="shrink-0 rounded-lg p-2 text-faint transition-colors hover:bg-surface-2 hover:text-danger"
            >
              <Icon name="x" size={14} strokeWidth={2} />
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => onChange([...values, ""])}
        className="mt-2 inline-flex items-center gap-1.5 rounded-lg px-1 py-0.5 text-xs font-bold text-accent transition-colors hover:text-accent-deep"
      >
        <Icon name="plus" size={13} strokeWidth={2.5} />
        {addLabel}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// "Add content" grid modal (same interaction model as the shared Modal)
// ---------------------------------------------------------------------------

function AddContentModal({
  open,
  onClose,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (section: AddContentSection) => void;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) =>
      event.key === "Escape" && onClose();
    document.addEventListener("keydown", onKeyDown);
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  if (!open) return null;

  const items: Array<{
    key: AddContentSection;
    icon: IconName;
    titleKey: string;
    descKey: string;
  }> = [
    { key: "summary", icon: "edit", titleKey: "templates.sectionSummary", descKey: "templates.addContentSummary" },
    { key: "experience", icon: "briefcase", titleKey: "templates.sectionExperience", descKey: "templates.addContentExperience" },
    { key: "education", icon: "chart", titleKey: "templates.sectionEducation", descKey: "templates.addContentEducation" },
    { key: "skills", icon: "spark", titleKey: "templates.sectionSkills", descKey: "templates.addContentSkills" },
    { key: "languages", icon: "globe", titleKey: "templates.sectionLanguages", descKey: "templates.addContentLanguages" },
    { key: "certificates", icon: "check", titleKey: "templates.sectionCertificates", descKey: "templates.addContentCertificates" },
    { key: "projects", icon: "folder", titleKey: "templates.sectionProjects", descKey: "templates.addContentProjects" },
    { key: "interests", icon: "target", titleKey: "templates.sectionInterests", descKey: "templates.addContentInterests" },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        className="absolute inset-0 bg-navy/45 backdrop-blur-[2px] dark:bg-black/60"
        aria-label={t("common.close")}
        onClick={onClose}
      />
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={t("templates.addContentTitle")}
        className="relative z-10 max-h-[85vh] w-full max-w-3xl overflow-y-auto rounded-2xl border border-line bg-surface p-5 shadow-2xl outline-none sm:p-7"
      >
        <div className="mb-5 flex items-start justify-between gap-4">
          <h2 className="text-lg font-bold text-ink sm:text-xl">
            {t("templates.addContentTitle")}
          </h2>
          <button
            className="rounded-lg p-1.5 text-faint transition-colors hover:bg-surface-2 hover:text-ink"
            onClick={onClose}
            aria-label={t("common.close")}
          >
            <Icon name="x" size={17} strokeWidth={2} />
          </button>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => onPick(item.key)}
              className="flex items-start gap-3.5 rounded-xl border border-line bg-surface-2/50 p-4 text-start transition-colors hover:border-accent/50 hover:bg-accent-soft/40"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
                <Icon name={item.icon} size={18} />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-bold text-ink">
                  {t(item.titleKey)}
                </span>
                <span className="mt-1 block text-xs leading-5 text-muted">
                  {t(item.descKey)}
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step indicator — 1 Start · 2 Template · 3 Edit
// Current step is highlighted; completed steps are clickable to go back;
// not-yet-reachable steps render disabled (no skipping into invalid states).
// ---------------------------------------------------------------------------

function StepIndicator({
  current,
  canTemplate,
  canEdit,
  onNavigate,
}: {
  current: BuilderStep;
  canTemplate: boolean;
  canEdit: boolean;
  onNavigate: (step: BuilderStep) => void;
}) {
  const { t } = useI18n();
  const order: BuilderStep[] = ["start", "template", "edit"];
  const labels: Record<BuilderStep, string> = {
    start: t("templates.stepStart"),
    template: t("templates.stepTemplate"),
    edit: t("templates.stepEdit"),
  };
  return (
    <nav aria-label={t("templates.stepNav")} className="mt-3 flex flex-wrap items-center gap-y-1 text-xs">
      {order.map((id, i) => {
        const isCurrent = id === current;
        const enabled =
          id === "start" ? true : id === "template" ? canTemplate : canEdit;
        const bullet = (
          <span
            aria-hidden="true"
            className={`flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-full border text-[10px] font-bold ${
              isCurrent
                ? "border-accent bg-accent text-white"
                : enabled
                  ? "border-line-strong text-muted"
                  : "border-line text-faint"
            }`}
          >
            {isCurrent ? <Icon name="check" size={9} strokeWidth={3} /> : i + 1}
          </span>
        );
        return (
          <Fragment key={id}>
            {i > 0 && (
              <span aria-hidden="true" className="mx-2 h-px w-6 bg-line-strong" />
            )}
            {isCurrent ? (
              <span
                aria-current="step"
                className="flex items-center gap-1.5 rounded-full bg-accent-soft px-2.5 py-1 font-bold text-accent"
              >
                {bullet}
                {labels[id]}
              </span>
            ) : enabled ? (
              <button
                type="button"
                onClick={() => onNavigate(id)}
                className="flex items-center gap-1.5 rounded-full px-2 py-1 font-semibold text-muted transition-colors hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                {bullet}
                {labels[id]}
              </button>
            ) : (
              <span
                aria-disabled="true"
                className="flex items-center gap-1.5 px-2 py-1 font-semibold text-faint/70"
              >
                {bullet}
                {labels[id]}
              </span>
            )}
          </Fragment>
        );
      })}
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function CvBuilder({
  userId,
  profileFullName,
  profileEmail,
}: CvBuilderProps) {
  const { t, lang } = useI18n();
  const router = useRouter();

  const [cv, setCv] = useState<CvDocument>(cvEmpty);
  const [ready, setReady] = useState(false);
  const [started, setStarted] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [mobileView, setMobileView] = useState<"edit" | "preview">("edit");
  // Content tab = the section editor, Design tab = CvCustomizationPanel,
  // Preview tab = the A4 sheet full-width (desktop).
  const [view, setView] = useState<"content" | "design" | "preview">("content");
  // 3-step flow: start → template → edit. Entering the builder ALWAYS lands
  // on "start" (empty variant without a saved CV, continue variant with one)
  // so the long editor is never the first thing a user sees.
  const [step, setStep] = useState<BuilderStep>("start");
  // The template step has been entered this session (new scratch / import) —
  // this is what makes step 2 clickable in the indicator before the document
  // is committed with started=true.
  const [templateReached, setTemplateReached] = useState(false);
  const [newCvConfirmOpen, setNewCvConfirmOpen] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importNotice, setImportNotice] = useState<"" | "notfound" | "error">("");
  const [importPending, setImportPending] = useState<CvDocument | null>(null);
  const [photoError, setPhotoError] = useState<"" | "large" | "invalid">("");

  // Section anchors for "Add content" scrolling (callback refs — no ref
  // objects are read during render, which the react-hooks/refs rule bans).
  const sectionEls = useRef<Record<AddContentSection, HTMLDivElement | null>>({
    summary: null,
    experience: null,
    education: null,
    skills: null,
    languages: null,
    certificates: null,
    projects: null,
    interests: null,
  });
  const bindSection = useCallback(
    (key: AddContentSection) => (el: HTMLDivElement | null) => {
      sectionEls.current[key] = el;
    },
    [],
  );
  const skillInputRef = useRef<HTMLInputElement | null>(null);
  const interestInputRef = useRef<HTMLInputElement | null>(null);
  const photoFileRef = useRef<HTMLInputElement | null>(null);
  const previewOuterRef = useRef<HTMLDivElement | null>(null);
  const previewSheetRef = useRef<HTMLDivElement | null>(null);
  const preview = useScaledSheet(previewOuterRef, previewSheetRef, {
    sheetWidth: CV_SHEET_WIDTH,
    sheetMinHeight: CV_SHEET_MIN_HEIGHT,
    active: mobileView === "preview",
  });

  // Focus lands on the current step's heading after every step change
  // (never on initial mount — the app shell keeps its natural focus).
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const prevStep = useRef<BuilderStep>(step);
  useEffect(() => {
    if (prevStep.current !== step) {
      prevStep.current = step;
      headingRef.current?.focus();
    }
  }, [step]);

  // ---- Load persisted document (post-hydration; server render stays empty) --
  useEffect(() => {
    let loaded: CvDocument | null = null;
    let hadStored = false;
    try {
      const raw = window.localStorage.getItem(cvStorageKey(userId));
      hadStored = Boolean(raw);
      if (raw) loaded = sanitizeCvDocument(JSON.parse(raw));
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSavedAt(window.localStorage.getItem(cvSavedAtKey(userId)));
    } catch {
      /* corrupt storage — start fresh */
    }
    let initial: CvDocument;
    let initialStarted: boolean;
    if (loaded && cvHasContent(loaded)) {
      initial = loaded;
      initialStarted = true;
    } else if (hadStored) {
      // Stored but empty (user cleared everything) — respect their document.
      initial = loaded ?? cvEmpty();
      initialStarted = window.localStorage.getItem(cvStartedKey(userId)) === "true";
    } else {
      initial = cvEmpty();
      // Pre-fill from the account profile: the user's own name and email —
      // never invented, never copied from anywhere else.
      const name = profileFullName.trim();
      const email = profileEmail.trim();
      if (name) initial.personal.fullName = name;
      if (email) initial.personal.email = email;
      initialStarted = false;
    }
    // Intentional post-hydration restore of the persisted CV (localStorage);
    // the server render uses the empty document on purpose (no mismatch).
    setCv(initial);
    setStarted(initialStarted);
    setReady(true);
  }, [userId, profileFullName, profileEmail]);

  // ---- Autosave (debounced) + save indicator --------------------------------
  // The first effect run after mount is only the hydration restore (cv just
  // became "ready") — it must NOT touch the "last edited" timestamp; only
  // real document changes update it.
  const firstSaveRun = useRef(true);
  useEffect(() => {
    if (!ready) return;
    const isFirstRun = firstSaveRun.current;
    firstSaveRun.current = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSaveState("saving");
    const timer = window.setTimeout(() => {
      try {
        window.localStorage.setItem(cvStorageKey(userId), JSON.stringify(cv));
        window.localStorage.setItem(cvStartedKey(userId), started ? "true" : "false");
        if (!isFirstRun) {
          const now = new Date().toISOString();
          window.localStorage.setItem(cvSavedAtKey(userId), now);
          setSavedAt(now);
        }
      } catch {
        /* storage full/unavailable — in-memory doc still works */
      }
      setSaveState("saved");
    }, 400);
    return () => window.clearTimeout(timer);
  }, [cv, started, ready, userId]);

  // ---- Body class for the print scope (hidden on other pages) ---------------
  useEffect(() => {
    document.body.classList.add("cv-builder-active");
    return () => document.body.classList.remove("cv-builder-active");
  }, []);

  // Gallery-only demo document for the template previews (see demo-cv.ts —
  // never written to or mixed with the user's CV).
  const demoCv = useMemo(() => buildDemoCv(), []);

  const cvLabels = useMemo<CvLabels>(
    () => ({
      summary: t("templates.docSummary"),
      experience: t("templates.docExperience"),
      education: t("templates.docEducation"),
      skills: t("templates.docSkills"),
      languages: t("templates.docLanguages"),
      certificates: t("templates.docCertificates"),
      projects: t("templates.docProjects"),
      interests: t("templates.docInterests"),
      present: t("templates.docPresent"),
      documentTitle: t("templates.docTitle"),
    }),
    [t],
  );

  const hasContent = cvHasContent(cv);

  // ---- Update helpers --------------------------------------------------------
  const setPersonal = useCallback((patch: Partial<CvPersonal>) => {
    setCv((c) => ({ ...c, personal: { ...c.personal, ...patch } }));
  }, []);

  const setSummary = useCallback((value: string) => {
    setCv((c) => ({ ...c, summary: value }));
  }, []);

  const updateList = useCallback(
    <K extends CvListSection>(
      key: K,
      updater: (list: CvDocument[K]) => CvDocument[K],
    ) => {
      setCv((c) => {
        const next = { ...c };
        (next as unknown as Record<K, unknown>)[key] = updater(c[key]);
        return next;
      });
    },
    [],
  );

  const updateEntry = useCallback(
    <K extends CvListSection, T extends { id: string }>(
      key: K,
      id: string,
      patch: (item: T) => T,
    ) => {
      setCv((c) => {
        const next = { ...c };
        (next as unknown as Record<K, T[]>)[key] = (
          c[key] as unknown as T[]
        ).map((item) => (item.id === id ? patch(item) : item));
        return next;
      });
    },
    [],
  );

  // Appearance settings live on the document itself (cv.customization), so
  // they persist with the exact same autosave/localStorage path as the content.
  const updateCustomization = useCallback((next: CvCustomizationSettings) => {
    setCv((c) => ({ ...c, customization: next }));
  }, []);

  // Template selection lives on the document too (cv.templateId) — switching
  // only changes the presentation; the CV data and customization are kept.
  const selectTemplate = useCallback((id: CvTemplateId) => {
    setCv((c) => ({ ...c, templateId: id }));
  }, []);

  // ---- Import existing scanner profile ---------------------------------------
  const applyImport = useCallback((doc: CvDocument) => {
    setCv(doc);
    setStarted(true);
    setImportPending(null);
    setImportNotice("");
    // Imported content → next flow step: pick a template for the document.
    setTemplateReached(true);
    setView("content");
    setMobileView("edit");
    setStep("template");
  }, []);

  const runImport = useCallback(async () => {
    setImporting(true);
    setImportNotice("");
    try {
      const supabase = createClient();
      // Owner-scoped read via the existing RLS policy on candidate_profiles
      // (same "manage their own" contract the scanner writes through).
      const { data, error } = await supabase
        .from("candidate_profiles")
        .select("profile_json, updated_at")
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(error.message);
      const row = data as { profile_json: unknown } | null;
      const parsed = candidateProfileSchema.safeParse(row?.profile_json);
      if (!parsed.success) {
        setImportNotice("notfound");
        return;
      }
      const imported = importCandidateProfileToCv(parsed.data);
      if (cvHasContent(cv)) setImportPending(imported);
      else applyImport(imported);
    } catch {
      setImportNotice("error");
    } finally {
      setImporting(false);
    }
  }, [cv, applyImport]);

  // ---- Add content ------------------------------------------------------------
  const handleAddContent = useCallback(
    (section: AddContentSection) => {
      setAddOpen(false);
      if (section === "education" && cv.education.length === 0)
        updateList("education", (l) => [...l, emptyEducation()]);
      if (section === "experience" && cv.experience.length === 0)
        updateList("experience", (l) => [...l, emptyExperience()]);
      if (section === "languages" && cv.languages.length === 0)
        updateList("languages", (l) => [...l, emptyLanguage()]);
      if (section === "certificates" && cv.certificates.length === 0)
        updateList("certificates", (l) => [...l, emptyCertificate()]);
      if (section === "projects" && cv.projects.length === 0)
        updateList("projects", (l) => [...l, emptyProject()]);
      sectionEls.current[section]?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
      if (section === "skills")
        window.setTimeout(() => skillInputRef.current?.focus(), 250);
      if (section === "interests")
        window.setTimeout(() => interestInputRef.current?.focus(), 250);
    },
    [cv, updateList],
  );

  // ---- Photo ------------------------------------------------------------------
  const handlePhotoFile = useCallback(
    (file: File) => {
      if (file.type !== "image/jpeg" && file.type !== "image/png") {
        setPhotoError("invalid");
        return;
      }
      if (file.size > 1_000_000) {
        setPhotoError("large");
        return;
      }
      setPhotoError("");
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === "string") setPersonal({ photo: reader.result });
      };
      reader.readAsDataURL(file);
    },
    [setPersonal],
  );

  // ---- 3-step flow: start → template → edit ----------------------------------
  const goTemplate = useCallback(() => {
    setTemplateReached(true);
    setStep("template");
  }, []);

  // Committing the document: started=true makes the autosave persist the
  // document (with its templateId) — this is the only point where a brand-new
  // CV is written to storage.
  const handleContinueFromTemplate = useCallback(() => {
    setStarted(true);
    setStep("edit");
  }, []);

  // "Create a new CV" — the reset happens ONLY inside this confirmed handler:
  // a fresh, profile-prefilled document in memory, back to the start screen.
  // The stored CV is untouched until the next autosave (which only fires
  // because the in-memory document legitimately changed).
  const handleConfirmNewCv = useCallback(() => {
    setNewCvConfirmOpen(false);
    const fresh = cvEmpty();
    const name = profileFullName.trim();
    const email = profileEmail.trim();
    if (name) fresh.personal.fullName = name;
    if (email) fresh.personal.email = email;
    setCv(fresh);
    setStarted(false);
    setTemplateReached(false);
    setView("content");
    setMobileView("edit");
    setStep("start");
  }, [profileFullName, profileEmail]);

  // Back: start → previous dashboard page (history), template → start,
  // edit → template. Going backward NEVER touches the document.
  const handleBack = useCallback(() => {
    if (step === "start") {
      router.back();
      return;
    }
    if (step === "template") {
      setStep("start");
      return;
    }
    setStep("template");
  }, [step, router]);

  const handleStepNavigate = useCallback(
    (target: BuilderStep) => {
      if (target === "start") setStep("start");
      if (target === "template") goTemplate();
      if (target === "edit") setStep("edit");
    },
    [goTemplate],
  );

  // Invalid-state guard for the indicator: template needs a document in the
  // flow (saved CV, committed, or entered this session), edit needs a
  // committed document.
  const canTemplate = started || templateReached || cvHasContent(cv);
  const canEdit = started;

  const lastEditedLabel = useMemo(() => {
    if (!savedAt) return "";
    const d = new Date(savedAt);
    if (Number.isNaN(d.getTime())) return "";
    try {
      return new Intl.DateTimeFormat(lang, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(d);
    } catch {
      return d.toLocaleString();
    }
  }, [savedAt, lang]);

  const handlePrint = useCallback(() => {
    window.print();
  }, []);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (!ready) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <LoadingState />
      </div>
    );
  }

  const personal = cv.personal;

  // A4 preview subtree — the single source of truth for the preview geometry
  // (direction-independent flex centering, tight LTR frame, uniform scale).
  // Used by BOTH the pinned preview pane and the desktop "Preview" tab;
  // exactly one instance is mounted at a time (the pane unmounts while the
  // tab shows).
  const previewBlock = (
    <div ref={previewOuterRef} className="w-full overflow-x-clip">
      <div className="flex w-full justify-center">
        <div
          className="overflow-hidden rounded-[6px]"
          style={{
            direction: "ltr",
            width: CV_SHEET_WIDTH * preview.scale,
            height: preview.sheetHeight * preview.scale,
          }}
        >
          <div
            ref={previewSheetRef}
            className="shadow-[0_16px_48px_rgba(16,32,59,0.16)] dark:shadow-[0_16px_48px_rgba(0,0,0,0.5)]"
            style={{
              width: CV_SHEET_WIDTH,
              transform: `scale(${preview.scale})`,
              transformOrigin: "top left",
            }}
          >
            <CvDocumentSheet cv={cv} labels={cvLabels} />
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div>
      {/* ============================ Compact header ==========================
          One row: [← Back] [CV Builder] [Template badge] … [Saved ✓] [PDF].
          The long subtitle of the old top bar is gone — the 3-step flow
          itself explains the page. Mobile: title row wraps above the
          full-width control row (same single-column discipline as before). */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            onClick={handleBack}
            aria-label={t("templates.back")}
            className="shrink-0 rounded-lg p-1.5 text-muted transition-colors hover:bg-surface-2 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <Icon
              name="arrowLeft"
              size={17}
              strokeWidth={2.2}
              className="rtl:rotate-180"
            />
          </button>
          <h2
            ref={step === "edit" ? headingRef : undefined}
            tabIndex={step === "edit" ? -1 : undefined}
            className="truncate text-lg font-bold tracking-tight text-ink"
            // Programmatic focus target (tabIndex -1, not keyboard-reachable) —
            // the global [tabindex]:focus-visible rule would draw a box here,
            // so suppress it inline (inline wins over unlayered author CSS).
            style={{ outline: "none" }}
          >
            {t("templates.builderTitle")}
          </h2>
          {step !== "start" && (
            <span className="hidden shrink-0 rounded-full border border-line bg-surface px-2.5 py-1 text-[11px] font-bold text-muted md:inline">
              {t("templates.templateLabel")}: {t(TEMPLATE_NAME_KEYS[cv.templateId])}
            </span>
          )}
        </div>
        <div className="flex w-full flex-wrap items-center gap-2.5 sm:w-auto sm:justify-end">
          {step === "edit" && saveState !== "idle" && started && (
            <span
              role="status"
              className="hidden items-center gap-1.5 text-xs font-semibold text-muted sm:inline-flex"
            >
              <Icon name={saveState === "saved" ? "check" : "clock"} size={13} />
              {saveState === "saved"
                ? t("templates.saved")
                : t("templates.saving")}
            </span>
          )}
          {step === "edit" && (
            <Button
              variant="dark"
              onClick={handlePrint}
              disabled={!hasContent}
              className="w-full whitespace-nowrap sm:w-auto"
            >
              <Icon name="download" size={15} />
              {t("templates.downloadPdf")}
            </Button>
          )}
        </div>
      </div>

      <StepIndicator
        current={step}
        canTemplate={canTemplate}
        canEdit={canEdit}
        onNavigate={handleStepNavigate}
      />

      {/* ============================ STEP 1 — START ==========================
          Never a wall of forms: either the two ways to begin (no saved CV)
          or the continue card (saved CV — the stored document is untouched
          until the user explicitly confirms "Create a new CV"). */}
      {step === "start" && (
        <div className="mx-auto mt-8 max-w-2xl sm:mt-12">
          {started ? (
            <Card className="p-8 text-center sm:p-10">
              <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-soft text-accent">
                <Icon name="file" size={24} />
              </span>
              <h3
                ref={headingRef}
                tabIndex={-1}
                className="mt-5 text-2xl font-bold tracking-tight text-ink sm:text-3xl"
                style={{ outline: "none" }}
              >
                {t("templates.continueTitle")}
              </h3>
              <p className="mt-2 text-sm leading-6 text-muted">
                {t("templates.continueText")}
              </p>
              {lastEditedLabel && (
                <p className="mt-3 text-xs font-medium text-faint">
                  {t("templates.lastEdited")}: {lastEditedLabel}
                </p>
              )}
              <div className="mt-7 flex flex-col justify-center gap-3 sm:flex-row">
                <Button size="lg" onClick={() => setStep("edit")}>
                  {t("templates.continueEditing")}
                </Button>
                <Button
                  size="lg"
                  variant="secondary"
                  onClick={() => setNewCvConfirmOpen(true)}
                >
                  {t("templates.createNewCv")}
                </Button>
              </div>
            </Card>
          ) : (
            <div>
              <div className="text-center">
                <h3
                  ref={headingRef}
                  tabIndex={-1}
                  className="text-2xl font-bold tracking-tight text-ink sm:text-3xl"
                  style={{ outline: "none" }}
                >
                  {t("templates.startTitle")}
                </h3>
                <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted">
                  {t("templates.startSubtitle")}
                </p>
              </div>
              <div className="mt-8 grid gap-4 text-start sm:grid-cols-2">
                <button
                  type="button"
                  onClick={goTemplate}
                  className="rounded-2xl border border-line bg-surface p-6 text-start transition-all hover:border-accent/50 hover:shadow-[0_10px_30px_rgba(var(--glow-accent-rgb),0.12)] focus:outline-none focus-visible:ring-4 focus-visible:ring-accent/25"
                >
                  <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent-soft text-accent">
                    <Icon name="edit" size={22} />
                  </span>
                  <span className="mt-4 block text-base font-bold text-ink">
                    {t("templates.startCardScratch")}
                  </span>
                  <span className="mt-1.5 block text-sm leading-6 text-muted">
                    {t("templates.startCardScratchDesc")}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => void runImport()}
                  disabled={importing}
                  className="rounded-2xl border border-line bg-surface p-6 text-start transition-all hover:border-accent/50 hover:shadow-[0_10px_30px_rgba(var(--glow-accent-rgb),0.12)] focus:outline-none focus-visible:ring-4 focus-visible:ring-accent/25 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent-soft text-accent">
                    <Icon name={importing ? "clock" : "upload"} size={22} />
                  </span>
                  <span className="mt-4 block text-base font-bold text-ink">
                    {importing
                      ? t("templates.importing")
                      : t("templates.startCardUpload")}
                  </span>
                  <span className="mt-1.5 block text-sm leading-6 text-muted">
                    {t("templates.startCardUploadDesc")}
                  </span>
                </button>
              </div>
              {importNotice === "notfound" && (
                <p
                  role="status"
                  className="mt-5 text-center text-xs font-medium text-muted"
                >
                  {t("templates.importNotFound")}
                </p>
              )}
              {importNotice === "error" && (
                <p
                  role="alert"
                  className="mt-5 text-center text-xs font-medium text-danger"
                >
                  {t("templates.importFailed")}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* ========================= STEP 2 — TEMPLATE ===========================
          Large A4-ratio gallery cards (2-col desktop, 1-col mobile). Each
          card renders the ACTUAL template renderer with the dedicated demo
          document (reference-like density) so the complete visual identity —
          header, sections, columns, rules, colors, typography — is visible
          before selection. The demo data is gallery-only: the user's CV is
          never touched. Selecting only swaps cv.templateId; "Continue"
          commits the document (started=true) and opens the editor. */}
      {step === "template" && (
        <div className="mx-auto mt-8 max-w-5xl sm:mt-10">
          <div className="text-center">
            <h3
              ref={headingRef}
              tabIndex={-1}
              className="text-2xl font-bold tracking-tight text-ink sm:text-3xl"
              style={{ outline: "none" }}
            >
              {t("templates.chooseTemplateTitle")}
            </h3>
            <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted">
              {t("templates.chooseTemplateText")}
            </p>
          </div>
          <div className="mt-7">
            <CvTemplateSelector
              size="large"
              showTitle={false}
              cv={cv}
              previewCv={demoCv}
              labels={cvLabels}
              selected={cv.templateId}
              onSelect={selectTemplate}
            />
          </div>
          <div className="mt-8 flex justify-center">
            <Button size="lg" onClick={handleContinueFromTemplate}>
              {t("templates.continueCta")}
              <Icon
                name="arrowRight"
                size={15}
                strokeWidth={2.2}
                className="rtl:rotate-180"
              />
            </Button>
          </div>
        </div>
      )}

      {/* ============================ STEP 3 — EDIT ===========================
          Only now does the full editor appear. Desktop: tab row
          [Content | Design | Preview] + editor column + pinned A4 pane.
          Mobile: the existing [Content|Design] + [Edit|Preview] toggles,
          strictly single column. */}
      {step === "edit" && (
        <div className="mt-6">
          {/* Mobile: control groups get their own full row on phones. */}
          <div className="mb-4 flex flex-wrap items-center gap-2.5 lg:hidden">
            <div className="flex w-full rounded-xl border border-line-strong bg-surface p-1 sm:w-auto">
              <button
                type="button"
                aria-pressed={view === "content"}
                onClick={() => setView("content")}
                className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xs font-bold transition-colors sm:flex-none ${
                  view === "content"
                    ? "bg-accent text-white"
                    : "text-muted hover:text-ink"
                }`}
              >
                <Icon name="edit" size={13} strokeWidth={2.2} />
                {t("templates.tabContent")}
              </button>
              <button
                type="button"
                aria-pressed={view === "design"}
                onClick={() => setView("design")}
                className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xs font-bold transition-colors sm:flex-none ${
                  view === "design"
                    ? "bg-accent text-white"
                    : "text-muted hover:text-ink"
                }`}
              >
                <Icon name="spark" size={13} strokeWidth={2.2} />
                {t("templates.tabDesign")}
              </button>
            </div>
            <div className="flex w-full rounded-xl border border-line-strong bg-surface p-1 sm:w-auto lg:hidden">
              <button
                type="button"
                aria-pressed={mobileView === "edit"}
                onClick={() => setMobileView("edit")}
                className={`flex flex-1 items-center justify-center rounded-lg px-3.5 py-1.5 text-xs font-bold transition-colors sm:flex-none ${
                  mobileView === "edit"
                    ? "bg-accent text-white"
                    : "text-muted hover:text-ink"
                }`}
              >
                {t("templates.tabEdit")}
              </button>
              <button
                type="button"
                aria-pressed={mobileView === "preview"}
                onClick={() => setMobileView("preview")}
                className={`flex flex-1 items-center justify-center rounded-lg px-3.5 py-1.5 text-xs font-bold transition-colors sm:flex-none ${
                  mobileView === "preview"
                    ? "bg-accent text-white"
                    : "text-muted hover:text-ink"
                }`}
              >
                {t("templates.tabPreview")}
              </button>
            </div>
          </div>

          {/* Desktop: the [Content | Design | Preview] tab row. */}
          <div className="mb-4 hidden max-w-fit lg:block">
            <div className="flex items-center rounded-xl border border-line-strong bg-surface p-1">
              <button
                type="button"
                aria-pressed={view === "content"}
                onClick={() => setView("content")}
                className={`flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xs font-bold transition-colors ${
                  view === "content"
                    ? "bg-accent text-white"
                    : "text-muted hover:text-ink"
                }`}
              >
                <Icon name="edit" size={13} strokeWidth={2.2} />
                {t("templates.tabContent")}
              </button>
              <button
                type="button"
                aria-pressed={view === "design"}
                onClick={() => setView("design")}
                className={`flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xs font-bold transition-colors ${
                  view === "design"
                    ? "bg-accent text-white"
                    : "text-muted hover:text-ink"
                }`}
              >
                <Icon name="spark" size={13} strokeWidth={2.2} />
                {t("templates.tabDesign")}
              </button>
              <button
                type="button"
                aria-pressed={view === "preview"}
                onClick={() => setView("preview")}
                className={`flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xs font-bold transition-colors ${
                  view === "preview"
                    ? "bg-accent text-white"
                    : "text-muted hover:text-ink"
                }`}
              >
                {t("templates.tabPreview")}
              </button>
            </div>
          </div>

          {/* ============================ Workspace ============================ */}
          <div className="grid w-full grid-cols-1 gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:items-start">
          {/* ------------------------------ Editor ----------------------------- */}
          {/* w-full min-w-0: the editor column is EXACTLY the viewport
              content width on phones (single column), and can shrink
              inside the 2/3fr desktop grid. No fixed widths in between. */}
          <div className={`min-w-0 w-full ${mobileView === "edit" ? "" : "hidden lg:block"}`}>
            {view === "content" ? (
            <Fragment>
            <Button
              variant="secondary"
              className="mb-4 w-full"
              onClick={() => setAddOpen(true)}
            >
              <Icon name="plus" size={15} strokeWidth={2.5} />
              {t("templates.addContent")}
            </Button>

            <div className="space-y-4">
              {/* Personal details */}
              <SectionCard icon="user" title={t("templates.sectionPersonal")}>
                <div className="grid gap-3.5 sm:grid-cols-2">
                  <div className="sm:col-span-2">
                    <Input
                      label={t("templates.fullName")}
                      value={personal.fullName}
                      onChange={(e) => setPersonal({ fullName: e.target.value })}
                    />
                  </div>
                  <Input
                    label={t("templates.professionalTitle")}
                    value={personal.professionalTitle}
                    onChange={(e) =>
                      setPersonal({ professionalTitle: e.target.value })
                    }
                  />
                  <Input
                    label={t("templates.email")}
                    type="email"
                    value={personal.email}
                    onChange={(e) => setPersonal({ email: e.target.value })}
                  />
                  <Input
                    label={t("templates.phone")}
                    type="tel"
                    value={personal.phone}
                    onChange={(e) => setPersonal({ phone: e.target.value })}
                  />
                  <Input
                    label={t("templates.location")}
                    value={personal.location}
                    onChange={(e) => setPersonal({ location: e.target.value })}
                  />
                  <Input
                    label={t("templates.linkedin")}
                    value={personal.linkedin}
                    onChange={(e) => setPersonal({ linkedin: e.target.value })}
                  />
                  <Input
                    label={t("templates.website")}
                    value={personal.website}
                    onChange={(e) => setPersonal({ website: e.target.value })}
                  />
                  <Input
                    label={t("templates.nationality")}
                    value={personal.nationality}
                    onChange={(e) => setPersonal({ nationality: e.target.value })}
                  />
                  <Input
                    label={t("templates.dateOfBirth")}
                    value={personal.dateOfBirth}
                    onChange={(e) => setPersonal({ dateOfBirth: e.target.value })}
                  />
                  <Input
                    label={t("templates.availability")}
                    value={personal.availability}
                    onChange={(e) => setPersonal({ availability: e.target.value })}
                  />
                  <div className="sm:col-span-2">
                    <span className="mb-2 block text-sm font-semibold text-ink-soft">
                      {t("templates.photo")}
                    </span>
                    <div className="flex items-center gap-4">
                      {personal.photo ? (
                        <>
                          {/* eslint-disable-next-line @next/next/no-img-element -- user photo data URL, fixed dimensions */}
                          <img
                            src={personal.photo}
                            alt={t("templates.photo")}
                            className="h-24 w-20 rounded-lg border border-line object-cover"
                          />
                          <div className="flex flex-col gap-2">
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => photoFileRef.current?.click()}
                            >
                              {t("templates.uploadPhoto")}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-danger hover:bg-danger-soft hover:text-danger"
                              onClick={() => {
                                setPersonal({ photo: null });
                                setPhotoError("");
                              }}
                            >
                              {t("templates.removePhoto")}
                            </Button>
                          </div>
                        </>
                      ) : (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => photoFileRef.current?.click()}
                        >
                          <Icon name="upload" size={14} />
                          {t("templates.uploadPhoto")}
                        </Button>
                      )}
                    </div>
                    {photoError ? (
                      <p className="mt-2 text-xs font-medium text-danger">
                        {photoError === "large"
                          ? t("templates.photoTooLarge")
                          : t("templates.photoInvalid")}
                      </p>
                    ) : (
                      <p className="mt-2 text-xs text-muted">
                        {t("templates.photoHint")}
                      </p>
                    )}
                    <input
                      ref={photoFileRef}
                      type="file"
                      accept="image/jpeg,image/png"
                      className="sr-only"
                      aria-label={t("templates.uploadPhoto")}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) handlePhotoFile(file);
                        e.target.value = "";
                      }}
                    />
                  </div>
                </div>
              </SectionCard>

              {/* Summary */}
              <SectionCard
                icon="edit"
                title={t("templates.sectionSummary")}
                onSectionRef={bindSection("summary")}
              >
                <Textarea
                  value={cv.summary}
                  onChange={(e) => setSummary(e.target.value)}
                  placeholder={t("templates.summaryPlaceholder")}
                />
              </SectionCard>

              {/* Experience */}
              <SectionCard
                icon="briefcase"
                title={t("templates.sectionExperience")}
                count={cv.experience.length}
                addLabel={t("templates.addExperience")}
                onAdd={() =>
                  updateList("experience", (l) => [...l, emptyExperience()])
                }
                onSectionRef={bindSection("experience")}
              >
                <div className="space-y-3">
                  {cv.experience.map((entry, index) => (
                    <EntryCard
                      key={entry.id}
                      index={index}
                      count={cv.experience.length}
                      onMoveUp={() =>
                        updateList("experience", (l) => moveEntry(l, index, -1))
                      }
                      onMoveDown={() =>
                        updateList("experience", (l) => moveEntry(l, index, 1))
                      }
                      onRemove={() =>
                        updateList("experience", (l) => removeEntry(l, index))
                      }
                    >
                      <div className="grid gap-3 sm:grid-cols-2">
                        <Input
                          label={t("templates.jobTitle")}
                          value={entry.jobTitle}
                          onChange={(e) =>
                            updateEntry("experience", entry.id, (x) => ({
                              ...x,
                              jobTitle: e.target.value,
                            }))
                          }
                        />
                        <Input
                          label={t("templates.company")}
                          value={entry.company}
                          onChange={(e) =>
                            updateEntry("experience", entry.id, (x) => ({
                              ...x,
                              company: e.target.value,
                            }))
                          }
                        />
                        <Input
                          label={t("templates.location")}
                          value={entry.location}
                          onChange={(e) =>
                            updateEntry("experience", entry.id, (x) => ({
                              ...x,
                              location: e.target.value,
                            }))
                          }
                        />
                        <div className="grid grid-cols-2 gap-3">
                          <Input
                            label={t("templates.start")}
                            hint={t("templates.dateHint")}
                            value={entry.start}
                            onChange={(e) =>
                              updateEntry("experience", entry.id, (x) => ({
                                ...x,
                                start: e.target.value,
                              }))
                            }
                          />
                          <Input
                            label={t("templates.end")}
                            hint={t("templates.dateHint")}
                            value={entry.end}
                            disabled={entry.isCurrent}
                            onChange={(e) =>
                              updateEntry("experience", entry.id, (x) => ({
                                ...x,
                                end: e.target.value,
                              }))
                            }
                          />
                        </div>
                      </div>
                      <label className="mt-3.5 flex w-fit cursor-pointer items-center gap-2.5 text-sm font-medium text-ink-soft">
                        <input
                          type="checkbox"
                          checked={entry.isCurrent}
                          onChange={(e) =>
                            updateEntry("experience", entry.id, (x) => ({
                              ...x,
                              isCurrent: e.target.checked,
                            }))
                          }
                          className="h-4 w-4 rounded border-line-strong accent-accent"
                        />
                        {t("templates.currentPosition")}
                      </label>
                      <div className="mt-4 space-y-4">
                        <div>
                          <p className="mb-2 text-sm font-semibold text-ink-soft">
                            {t("templates.responsibilities")}
                          </p>
                          <BulletEditor
                            values={entry.responsibilities}
                            onChange={(next) =>
                              updateEntry("experience", entry.id, (x) => ({
                                ...x,
                                responsibilities: next,
                              }))
                            }
                            addLabel={t("templates.addResponsibility")}
                            itemLabel={t("templates.responsibilities")}
                            removeLabel={t("templates.remove")}
                          />
                        </div>
                        <div>
                          <p className="mb-2 text-sm font-semibold text-ink-soft">
                            {t("templates.achievements")}
                          </p>
                          <BulletEditor
                            values={entry.achievements}
                            onChange={(next) =>
                              updateEntry("experience", entry.id, (x) => ({
                                ...x,
                                achievements: next,
                              }))
                            }
                            addLabel={t("templates.addAchievement")}
                            itemLabel={t("templates.achievements")}
                            removeLabel={t("templates.remove")}
                          />
                        </div>
                      </div>
                    </EntryCard>
                  ))}
                </div>
              </SectionCard>

              {/* Education */}
              <SectionCard
                icon="chart"
                title={t("templates.sectionEducation")}
                count={cv.education.length}
                addLabel={t("templates.addEducation")}
                onAdd={() =>
                  updateList("education", (l) => [...l, emptyEducation()])
                }
                onSectionRef={bindSection("education")}
              >
                <div className="space-y-3">
                  {cv.education.map((entry, index) => (
                    <EntryCard
                      key={entry.id}
                      index={index}
                      count={cv.education.length}
                      onMoveUp={() =>
                        updateList("education", (l) => moveEntry(l, index, -1))
                      }
                      onMoveDown={() =>
                        updateList("education", (l) => moveEntry(l, index, 1))
                      }
                      onRemove={() =>
                        updateList("education", (l) => removeEntry(l, index))
                      }
                    >
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div className="sm:col-span-2">
                          <Input
                            label={t("templates.degree")}
                            value={entry.degree}
                            onChange={(e) =>
                              updateEntry("education", entry.id, (x) => ({
                                ...x,
                                degree: e.target.value,
                              }))
                            }
                          />
                        </div>
                        <Input
                          label={t("templates.institution")}
                          value={entry.institution}
                          onChange={(e) =>
                            updateEntry("education", entry.id, (x) => ({
                              ...x,
                              institution: e.target.value,
                            }))
                          }
                        />
                        <Input
                          label={t("templates.location")}
                          value={entry.location}
                          onChange={(e) =>
                            updateEntry("education", entry.id, (x) => ({
                              ...x,
                              location: e.target.value,
                            }))
                          }
                        />
                        <Input
                          label={t("templates.start")}
                          hint={t("templates.dateHint")}
                          value={entry.start}
                          onChange={(e) =>
                            updateEntry("education", entry.id, (x) => ({
                              ...x,
                              start: e.target.value,
                            }))
                          }
                        />
                        <Input
                          label={t("templates.end")}
                          hint={t("templates.dateHint")}
                          value={entry.end}
                          onChange={(e) =>
                            updateEntry("education", entry.id, (x) => ({
                              ...x,
                              end: e.target.value,
                            }))
                          }
                        />
                        <div className="sm:col-span-2">
                          <Textarea
                            label={t("templates.description")}
                            value={entry.description}
                            onChange={(e) =>
                              updateEntry("education", entry.id, (x) => ({
                                ...x,
                                description: e.target.value,
                              }))
                            }
                            className="min-h-20"
                          />
                        </div>
                      </div>
                    </EntryCard>
                  ))}
                </div>
              </SectionCard>

              {/* Skills */}
              <SectionCard
                icon="spark"
                title={t("templates.sectionSkills")}
                count={cv.skills.length}
                onSectionRef={bindSection("skills")}
              >
                <ChipInput
                  values={cv.skills}
                  onChange={(next) =>
                    setCv((c) => ({ ...c, skills: next }))
                  }
                  placeholder={t("templates.addSkill")}
                  label={t("templates.skill")}
                  removeLabel={t("templates.remove")}
                  inputRef={skillInputRef}
                />
              </SectionCard>

              {/* Languages */}
              <SectionCard
                icon="globe"
                title={t("templates.sectionLanguages")}
                count={cv.languages.length}
                addLabel={t("templates.addLanguage")}
                onAdd={() =>
                  updateList("languages", (l) => [...l, emptyLanguage()])
                }
                onSectionRef={bindSection("languages")}
              >
                <div className="space-y-3">
                  {cv.languages.map((entry, index) => (
                    <EntryCard
                      key={entry.id}
                      index={index}
                      count={cv.languages.length}
                      onMoveUp={() =>
                        updateList("languages", (l) => moveEntry(l, index, -1))
                      }
                      onMoveDown={() =>
                        updateList("languages", (l) => moveEntry(l, index, 1))
                      }
                      onRemove={() =>
                        updateList("languages", (l) => removeEntry(l, index))
                      }
                    >
                      <div className="grid grid-cols-2 gap-3">
                        <Input
                          label={t("templates.language")}
                          value={entry.language}
                          onChange={(e) =>
                            updateEntry("languages", entry.id, (x) => ({
                              ...x,
                              language: e.target.value,
                            }))
                          }
                        />
                        <Input
                          label={t("templates.level")}
                          value={entry.level}
                          onChange={(e) =>
                            updateEntry("languages", entry.id, (x) => ({
                              ...x,
                              level: e.target.value,
                            }))
                          }
                        />
                      </div>
                    </EntryCard>
                  ))}
                </div>
              </SectionCard>

              {/* Certificates */}
              <SectionCard
                icon="check"
                title={t("templates.sectionCertificates")}
                count={cv.certificates.length}
                addLabel={t("templates.addCertificate")}
                onAdd={() =>
                  updateList("certificates", (l) => [...l, emptyCertificate()])
                }
                onSectionRef={bindSection("certificates")}
              >
                <div className="space-y-3">
                  {cv.certificates.map((entry, index) => (
                    <EntryCard
                      key={entry.id}
                      index={index}
                      count={cv.certificates.length}
                      onMoveUp={() =>
                        updateList("certificates", (l) => moveEntry(l, index, -1))
                      }
                      onMoveDown={() =>
                        updateList("certificates", (l) => moveEntry(l, index, 1))
                      }
                      onRemove={() =>
                        updateList("certificates", (l) => removeEntry(l, index))
                      }
                    >
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div className="sm:col-span-2">
                          <Input
                            label={t("templates.certificateName")}
                            value={entry.name}
                            onChange={(e) =>
                              updateEntry("certificates", entry.id, (x) => ({
                                ...x,
                                name: e.target.value,
                              }))
                            }
                          />
                        </div>
                        <Input
                          label={t("templates.issuer")}
                          value={entry.issuer}
                          onChange={(e) =>
                            updateEntry("certificates", entry.id, (x) => ({
                              ...x,
                              issuer: e.target.value,
                            }))
                          }
                        />
                        <Input
                          label={t("templates.date")}
                          value={entry.date}
                          onChange={(e) =>
                            updateEntry("certificates", entry.id, (x) => ({
                              ...x,
                              date: e.target.value,
                            }))
                          }
                        />
                        <div className="sm:col-span-2">
                          <Textarea
                            label={t("templates.description")}
                            value={entry.description}
                            onChange={(e) =>
                              updateEntry("certificates", entry.id, (x) => ({
                                ...x,
                                description: e.target.value,
                              }))
                            }
                            className="min-h-20"
                          />
                        </div>
                      </div>
                    </EntryCard>
                  ))}
                </div>
              </SectionCard>

              {/* Projects */}
              <SectionCard
                icon="folder"
                title={t("templates.sectionProjects")}
                count={cv.projects.length}
                addLabel={t("templates.addProject")}
                onAdd={() =>
                  updateList("projects", (l) => [...l, emptyProject()])
                }
                onSectionRef={bindSection("projects")}
              >
                <div className="space-y-3">
                  {cv.projects.map((entry, index) => (
                    <EntryCard
                      key={entry.id}
                      index={index}
                      count={cv.projects.length}
                      onMoveUp={() =>
                        updateList("projects", (l) => moveEntry(l, index, -1))
                      }
                      onMoveDown={() =>
                        updateList("projects", (l) => moveEntry(l, index, 1))
                      }
                      onRemove={() =>
                        updateList("projects", (l) => removeEntry(l, index))
                      }
                    >
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div className="sm:col-span-2">
                          <Input
                            label={t("templates.projectName")}
                            value={entry.name}
                            onChange={(e) =>
                              updateEntry("projects", entry.id, (x) => ({
                                ...x,
                                name: e.target.value,
                              }))
                            }
                          />
                        </div>
                        <Input
                          label={t("templates.role")}
                          value={entry.role}
                          onChange={(e) =>
                            updateEntry("projects", entry.id, (x) => ({
                              ...x,
                              role: e.target.value,
                            }))
                          }
                        />
                        <Input
                          label={t("templates.date")}
                          value={entry.date}
                          onChange={(e) =>
                            updateEntry("projects", entry.id, (x) => ({
                              ...x,
                              date: e.target.value,
                            }))
                          }
                        />
                        <div className="sm:col-span-2">
                          <Textarea
                            label={t("templates.description")}
                            value={entry.description}
                            onChange={(e) =>
                              updateEntry("projects", entry.id, (x) => ({
                                ...x,
                                description: e.target.value,
                              }))
                            }
                            className="min-h-20"
                          />
                        </div>
                        <div className="sm:col-span-2">
                          <Input
                            label={t("templates.technologies")}
                            value={entry.technologies}
                            onChange={(e) =>
                              updateEntry("projects", entry.id, (x) => ({
                                ...x,
                                technologies: e.target.value,
                              }))
                            }
                          />
                        </div>
                      </div>
                    </EntryCard>
                  ))}
                </div>
              </SectionCard>

              {/* Interests */}
              <SectionCard
                icon="target"
                title={t("templates.sectionInterests")}
                count={cv.interests.length}
                onSectionRef={bindSection("interests")}
              >
                <ChipInput
                  values={cv.interests}
                  onChange={(next) =>
                    setCv((c) => ({ ...c, interests: next }))
                  }
                  placeholder={t("templates.addInterest")}
                  label={t("templates.interest")}
                  removeLabel={t("templates.remove")}
                  inputRef={interestInputRef}
                />
              </SectionCard>
            </div>
            </Fragment>
            ) : view === "design" ? (
            <CvCustomizationPanel
              settings={cv.customization ?? defaultCvCustomization()}
              onChange={updateCustomization}
              hasPhoto={Boolean(personal.photo)}
            />
            ) : (
            /* Desktop "Preview" tab: the A4 sheet, centered full-width. */
            <div className="mx-auto max-w-2xl">{previewBlock}</div>
            )}
          </div>

          {/* ----------------------------- Preview -----------------------------
              Desktop: the pane stays pinned in place so the A4 preview is
              visible while the editor column scrolls. top-20 = 80px = the
              AppShell header (h-16 = 64px) + 16px breathing room. The grid's
              lg:items-start gives the pane a content-height box whose
              containing block is the full row track (sized by the taller
              editor column), so the pane releases naturally at the end of
              the builder container — no JS, desktop-only via lg:.
              The pane unmounts while the desktop "Preview" tab is active —
              the same preview subtree then lives in the editor column, so
              the refs are attached in exactly one place at a time. */}
          {view !== "preview" && (
            <div
              className={`min-w-0 lg:sticky lg:top-20 ${mobileView === "preview" ? "" : "hidden lg:block"}`}
            >
              {previewBlock}
            </div>
          )}
        </div>
        </div>
      )}

      {/* =============================== Modals =============================== */}
      <AddContentModal
        open={addOpen && step === "edit"}
        onClose={() => setAddOpen(false)}
        onPick={handleAddContent}
      />

      {/* "Create a new CV" — the ONLY place the document is reset, and it
          requires this explicit confirmation. Dismissing it keeps the saved
          CV untouched. */}
      <Modal
        open={newCvConfirmOpen}
        onClose={() => setNewCvConfirmOpen(false)}
        title={t("templates.newCvConfirmTitle")}
      >
        <p className="text-sm leading-6 text-muted">
          {t("templates.newCvConfirmText")}
        </p>
        <div className="mt-6 flex justify-end gap-2.5">
          <Button variant="secondary" onClick={() => setNewCvConfirmOpen(false)}>
            {t("common.cancel")}
          </Button>
          <Button onClick={handleConfirmNewCv}>
            {t("templates.newCvConfirmAction")}
          </Button>
        </div>
      </Modal>

      <Modal
        open={importPending !== null}
        onClose={() => setImportPending(null)}
        title={t("templates.importConfirmTitle")}
      >
        <p className="text-sm leading-6 text-muted">
          {t("templates.importConfirmText")}
        </p>
        <div className="mt-6 flex justify-end gap-2.5">
          <Button variant="secondary" onClick={() => setImportPending(null)}>
            {t("common.cancel")}
          </Button>
          <Button
            onClick={() => {
              if (importPending) applyImport(importPending);
            }}
          >
            {t("templates.importConfirmAction")}
          </Button>
        </div>
      </Modal>

      {/* ====================== Print root (portal) ========================== */}
      {/* Rendered onto <body> outside the app shell; visible only in
          @media print (see globals.css). Same CvDocument as the preview,
          so the exported PDF is the preview with nothing else. */}
      {typeof document !== "undefined" &&
        createPortal(
          <div className="cv-print-root" aria-hidden="true">
            <CvDocumentSheet cv={cv} labels={cvLabels} />
          </div>,
          document.body,
        )}
    </div>
  );
}
