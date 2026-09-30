"use client";

/**
 * Anschreiben Builder — the single cover-letter document.
 *
 *  - LEFT: accordion of eight clean sections (Absender, Datum, Empfänger,
 *    Betreff, Anrede, Anschreiben, Grußformel, Unterschrift). Each card
 *    shows a useful summary when collapsed and expands into an editor with
 *    a "Fertig" action — the reference interaction from the mockups.
 *  - RIGHT: live A4 preview rendered by the pure <CoverLetterDocument> —
 *    the exact same component is portalled onto <body> for print, so the
 *    exported PDF is byte-for-byte the preview.
 *  - Persistence: per-user localStorage (aha:cover-letter:<userId>),
 *    debounced autosave, defensive sanitization on load.
 *  - Data: "Profil übernehmen" imports the latest scanner candidate
 *    profile, "Aus Lebenslauf übernehmen" copies the user's CV sender
 *    data. Both fill EMPTY fields only — nothing is ever invented.
 *  - AI: optional "Mit KI erstellen" / "Text verbessern" (server route
 *    /api/ai/cover-letter) grounded exclusively in the user's real
 *    profile, CV and supplied target info.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { createClient } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n";
import { Icon, type IconName } from "@/components/icon";
import {
  Button,
  Card,
  Input,
  LoadingState,
  Textarea,
} from "@/components/ui";
import {
  CoverLetterDocument,
  CL_SHEET_MIN_HEIGHT,
  CL_SHEET_WIDTH,
} from "@/components/cover-letter-document";
import { candidateProfileSchema } from "@/lib/bewerbung-schema";
import { cvHasContent, sanitizeCvDocument } from "@/lib/templates/cv";
import {
  clEmpty,
  clHasContent,
  copyCvToCl,
  formatGermanDate,
  GREETING_PRESETS,
  importCandidateProfileToCl,
  isValidIsoDate,
  parseAiBody,
  recipientSummary,
  sanitizeClDocument,
  senderSummary,
  type ClAiLanguage,
  type ClAiSettings,
  type ClDocument,
  type ClRecipient,
  type ClSender,
  type ClSignature,
  type ClTone,
} from "@/lib/templates/cover-letter";

interface CoverLetterBuilderProps {
  userId: string;
}

const clStorageKey = (userId: string) => `aha:cover-letter:${userId}`;
const clStartedKey = (userId: string) => `aha:cover-letter-started:${userId}`;
/** The CV builder's storage contract (its source of truth for "copy from CV"). */
const cvStorageKey = (userId: string) => `aha:cv:${userId}`;

type ClSectionKey =
  | "sender"
  | "date"
  | "recipient"
  | "subject"
  | "greeting"
  | "body"
  | "closing"
  | "signature";
type ClSectionIcon = Record<ClSectionKey, IconName>;

const SECTION_ICONS: ClSectionIcon = {
  sender: "user",
  date: "clock",
  recipient: "briefcase",
  subject: "file",
  greeting: "mail",
  body: "edit",
  closing: "send",
  signature: "image",
};

const TONES: readonly ClTone[] = ["professional", "formal", "engaged"];
const AI_LANGUAGES: readonly ClAiLanguage[] = ["de", "en"];

// ---------------------------------------------------------------------------
// Preview scaling (ResizeObserver; no `zoom` — print/RTL stay predictable)
// ---------------------------------------------------------------------------

function useScaledSheet(
  outerRef: RefObject<HTMLDivElement | null>,
  sheetRef: RefObject<HTMLDivElement | null>,
) {
  const [scale, setScale] = useState(1);
  const [sheetHeight, setSheetHeight] = useState(CL_SHEET_MIN_HEIGHT);

  useEffect(() => {
    const outer = outerRef.current;
    const sheet = sheetRef.current;
    if (!outer || !sheet) return;
    const update = () => {
      setScale(Math.min(1, outer.clientWidth / (CL_SHEET_WIDTH + 28)));
      setSheetHeight(Math.max(sheet.offsetHeight, CL_SHEET_MIN_HEIGHT));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(outer);
    observer.observe(sheet);
    return () => observer.disconnect();
  }, [outerRef, sheetRef]);

  return { scale, sheetHeight };
}

// ---------------------------------------------------------------------------
// Collapsible section card (reference interaction: summary → expand → done)
// ---------------------------------------------------------------------------

function ClSection({
  section,
  title,
  summary,
  open,
  onToggle,
  children,
}: {
  section: ClSectionKey;
  title: string;
  summary: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  return (
    <Card className="overflow-hidden">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-3 p-4 text-start transition-colors hover:bg-surface-2/50 sm:px-5"
      >
        <span className="flex min-w-0 items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
            <Icon name={SECTION_ICONS[section]} size={16} />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-bold text-ink">{title}</span>
            <span
              className={`mt-0.5 block truncate text-xs ${summary ? "text-ink-soft" : "text-faint"}`}
            >
              {summary || t("coverLetter.notAdded")}
            </span>
          </span>
        </span>
        <Icon
          name="chevronRight"
          size={16}
          className={`shrink-0 text-faint transition-transform ${open ? "rotate-90" : ""}`}
        />
      </button>
      {open && (
        <div className="border-t border-line p-4 sm:p-5">
          {children}
          <Button className="mt-4 w-full" onClick={onToggle}>
            <Icon name="check" size={15} strokeWidth={2.5} />
            {t("coverLetter.done")}
          </Button>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// AI generation modal (settings persist with the document)
// ---------------------------------------------------------------------------

/**
 * Mounted conditionally by the builder (remounts per open), so the form
 * state is seeded from `initial` at mount — no state-seeding effect needed.
 */
function AiLetterModal({
  onClose,
  initial,
  companySuggestion,
  hasBody,
  busy,
  onGenerate,
}: {
  onClose: () => void;
  initial: ClAiSettings;
  companySuggestion: string;
  hasBody: boolean;
  busy: boolean;
  onGenerate: (settings: ClAiSettings) => void;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState(initial.position);
  const [company, setCompany] = useState(
    initial.company || companySuggestion,
  );
  const [jobDescription, setJobDescription] = useState(initial.jobDescription);
  const [tone, setTone] = useState<ClTone>(initial.tone);
  const [language, setLanguage] = useState<ClAiLanguage>(initial.language);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) =>
      event.key === "Escape" && onClose();
    document.addEventListener("keydown", onKeyDown);
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  const selectClass =
    "h-12 w-full rounded-xl border border-line-strong bg-surface px-3.5 text-sm text-ink outline-none transition focus:border-accent focus:ring-4 focus:ring-accent/10";

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
        aria-label={t("coverLetter.aiModalTitle")}
        className="relative z-10 max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-line bg-surface p-5 shadow-2xl outline-none sm:p-7"
      >
        <div className="mb-5 flex items-start justify-between gap-4">
          <h2 className="text-lg font-bold text-ink sm:text-xl">
            {t("coverLetter.aiModalTitle")}
          </h2>
          <button
            className="rounded-lg p-1.5 text-faint transition-colors hover:bg-surface-2 hover:text-ink"
            onClick={onClose}
            aria-label={t("common.close")}
          >
            <Icon name="x" size={17} strokeWidth={2} />
          </button>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Input
              label={t("coverLetter.aiPosition")}
              placeholder={t("coverLetter.aiPositionPlaceholder")}
              value={position}
              onChange={(e) => setPosition(e.target.value)}
            />
          </div>
          <Input
            label={t("coverLetter.aiCompany")}
            placeholder={t("coverLetter.aiCompanyPlaceholder")}
            value={company}
            onChange={(e) => setCompany(e.target.value)}
          />
          <div>
            <span className="mb-2 block text-sm font-semibold text-ink-soft">
              {t("coverLetter.aiTone")}
            </span>
            <select
              className={selectClass}
              value={tone}
              onChange={(e) => setTone(e.target.value as ClTone)}
              aria-label={t("coverLetter.aiTone")}
            >
              {TONES.map((value) => (
                <option key={value} value={value}>
                  {t(`coverLetter.aiTone${value[0].toUpperCase()}${value.slice(1)}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="sm:col-span-2">
            <Textarea
              label={`${t("coverLetter.aiJobDescription")}`}
              hint={t("coverLetter.aiJobDescriptionHint")}
              placeholder=""
              value={jobDescription}
              onChange={(e) => setJobDescription(e.target.value)}
              className="min-h-28"
            />
          </div>
          <div>
            <span className="mb-2 block text-sm font-semibold text-ink-soft">
              {t("coverLetter.aiLanguage")}
            </span>
            <select
              className={selectClass}
              value={language}
              onChange={(e) => setLanguage(e.target.value as ClAiLanguage)}
              aria-label={t("coverLetter.aiLanguage")}
            >
              {AI_LANGUAGES.map((value) => (
                <option key={value} value={value}>
                  {value === "de"
                    ? t("coverLetter.aiLanguageDe")
                    : t("coverLetter.aiLanguageEn")}
                </option>
              ))}
            </select>
          </div>
        </div>

        <p className="mt-4 rounded-xl bg-accent-soft/50 p-3 text-xs leading-5 text-ink-soft">
          {t("coverLetter.aiNote")}
        </p>
        {hasBody && (
          <p className="mt-3 text-xs font-medium text-amber-700 dark:text-amber-400">
            {t("coverLetter.aiReplaceWarning")}
          </p>
        )}

        <div className="mt-6 flex justify-end gap-2.5">
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            onClick={() =>
              onGenerate({ position, company, jobDescription, tone, language })
            }
            disabled={busy}
          >
            <Icon name="spark" size={15} />
            {t("coverLetter.aiGenerate")}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function CoverLetterBuilder({ userId }: CoverLetterBuilderProps) {
  const { t } = useI18n();

  const [doc, setDocState] = useState<ClDocument>(clEmpty);
  const [ready, setReady] = useState(false);
  const [started, setStarted] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [mobileView, setMobileView] = useState<"edit" | "preview">("edit");
  const [openSection, setOpenSection] = useState<ClSectionKey | null>(null);
  const [aiModalOpen, setAiModalOpen] = useState(false);
  const [aiBusy, setAiBusy] = useState<"" | "generate" | "improve">("");
  const [aiError, setAiError] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [importNotice, setImportNotice] = useState<"" | "notfound" | "error" | "cvenotfound">("");
  const [sigError, setSigError] = useState<"" | "large" | "invalid">("");

  const previewOuterRef = useRef<HTMLDivElement | null>(null);
  const previewSheetRef = useRef<HTMLDivElement | null>(null);
  const signatureFileRef = useRef<HTMLInputElement | null>(null);
  const preview = useScaledSheet(previewOuterRef, previewSheetRef);

  // ---- Load persisted document (post-hydration; server render stays empty) --
  useEffect(() => {
    let loaded = clEmpty();
    let hadStored = false;
    try {
      const raw = window.localStorage.getItem(clStorageKey(userId));
      hadStored = Boolean(raw);
      if (raw) loaded = sanitizeClDocument(raw) ?? clEmpty();
    } catch {
      /* corrupt storage — start fresh */
    }
    const initialStarted =
      clHasContent(loaded) ||
      (hadStored && window.localStorage.getItem(clStartedKey(userId)) === "true");
    // Intentional post-hydration restore (localStorage); the server render
    // uses the empty document on purpose (no mismatch).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDocState(loaded);
    setStarted(initialStarted);
    setReady(true);
  }, [userId]);

  // ---- Autosave (debounced) + save indicator --------------------------------
  useEffect(() => {
    if (!ready) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSaveState("saving");
    const timer = window.setTimeout(() => {
      try {
        window.localStorage.setItem(clStorageKey(userId), JSON.stringify(doc));
        window.localStorage.setItem(clStartedKey(userId), started ? "true" : "false");
      } catch {
        /* storage full/unavailable — in-memory doc still works */
      }
      setSaveState("saved");
    }, 400);
    return () => window.clearTimeout(timer);
  }, [doc, started, ready, userId]);

  // ---- Body class for the print scope ---------------------------------------
  useEffect(() => {
    document.body.classList.add("cl-builder-active");
    return () => document.body.classList.remove("cl-builder-active");
  }, []);

  const hasContent = clHasContent(doc);
  const showWorkspace = ready && (started || hasContent);

  // ---- Update helpers --------------------------------------------------------
  const setSender = useCallback(
    (patch: Partial<ClSender>) =>
      setDocState((d) => ({ ...d, sender: { ...d.sender, ...patch } })),
    [],
  );
  const setRecipient = useCallback(
    (patch: Partial<ClRecipient>) =>
      setDocState((d) => ({ ...d, recipient: { ...d.recipient, ...patch } })),
    [],
  );
  const setSignature = useCallback(
    (patch: Partial<ClSignature>) =>
      setDocState((d) => ({ ...d, signature: { ...d.signature, ...patch } })),
    [],
  );
  const setDate = useCallback(
    (value: string) => {
      if (!isValidIsoDate(value)) return;
      setDocState((d) => ({ ...d, date: value }));
    },
    [],
  );
  const setField =
    (key: "subject" | "greeting" | "closing") =>
    (value: string) =>
      setDocState((d) => ({ ...d, [key]: value }));

  const setParagraph = useCallback((index: number, value: string) => {
    setDocState((d) => {
      const next = d.body.length ? d.body.slice() : [""];
      next[index] = value;
      return { ...d, body: next };
    });
  }, []);
  const addParagraph = useCallback(() => {
    setDocState((d) => ({ ...d, body: [...(d.body.length ? d.body : [""]), ""] }));
  }, []);
  const removeParagraph = useCallback((index: number) => {
    setDocState((d) =>
      d.body.length > 1
        ? { ...d, body: d.body.filter((_, j) => j !== index) }
        : d,
    );
  }, []);

  // ---- Imports (never invent, never overwrite) --------------------------------
  const fetchLatestProfile = useCallback(async () => {
    const supabase = createClient();
    // Owner-scoped read via the existing RLS policy on candidate_profiles
    // (same contract the CV builder uses).
    const { data, error } = await supabase
      .from("candidate_profiles")
      .select("profile_json, updated_at")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const parsed = candidateProfileSchema.safeParse(
      (data as { profile_json: unknown } | null)?.profile_json,
    );
    return parsed.success ? parsed.data : null;
  }, []);

  const runProfileImport = useCallback(async () => {
    setImportBusy(true);
    setImportNotice("");
    try {
      const profile = await fetchLatestProfile();
      if (!profile) {
        setImportNotice("notfound");
        return;
      }
      // Fills empty sender fields only; a successful import always means the
      // user is working on a letter, so the workspace opens.
      setDocState((d) => importCandidateProfileToCl(profile, d));
      setStarted(true);
    } catch {
      setImportNotice("error");
    } finally {
      setImportBusy(false);
    }
  }, [fetchLatestProfile]);

  const runCvCopy = useCallback(() => {
    setImportNotice("");
    let cv: ReturnType<typeof sanitizeCvDocument> = null;
    try {
      const raw = window.localStorage.getItem(cvStorageKey(userId));
      if (raw) cv = sanitizeCvDocument(JSON.parse(raw));
    } catch {
      cv = null;
    }
    if (!cv || !cvHasContent(cv)) {
      setImportNotice("cvenotfound");
      return;
    }
    setDocState((d) => copyCvToCl(cv, d));
    setStarted(true);
  }, [userId]);

  // ---- AI ----------------------------------------------------------------------
  const callAi = useCallback(
    async (mode: "generate" | "improve", settings: ClAiSettings) => {
      setAiBusy(mode);
      setAiError("");
      try {
        let cvRaw: unknown;
        try {
          cvRaw = JSON.parse(window.localStorage.getItem(cvStorageKey(userId)) ?? "null");
        } catch {
          cvRaw = null;
        }
        const response = await fetch("/api/ai/cover-letter", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            mode,
            position: settings.position,
            company: settings.company,
            jobDescription: settings.jobDescription,
            tone: settings.tone,
            language: settings.language,
            body:
              mode === "improve"
                ? doc.body.map((p) => p.trim()).filter(Boolean).join("\n\n")
                : undefined,
            cv: cvRaw,
          }),
        });
        const json = (await response.json().catch(() => ({}))) as {
          text?: string;
          error?: string;
        };
        if (!response.ok || !json.text) throw new Error(json.error || "AI failed");
        const paragraphs = parseAiBody(json.text);
        if (paragraphs.length === 0) throw new Error("empty AI response");
        setDocState((d) => ({ ...d, ai: settings, body: paragraphs }));
        setStarted(true);
        setAiModalOpen(false);
      } catch {
        setAiError(t("coverLetter.aiFailed"));
      } finally {
        setAiBusy("");
      }
    },
    [doc.body, setDocState, t, userId],
  );

  const improveText = useCallback(async () => {
    setAiError("");
    await callAi("improve", doc.ai);
  }, [callAi, doc.ai]);

  // ---- Signature image -----------------------------------------------------------
  const handleSignatureFile = useCallback((file: File) => {
    if (file.type !== "image/jpeg" && file.type !== "image/png") {
      setSigError("invalid");
      return;
    }
    if (file.size > 1_000_000) {
      setSigError("large");
      return;
    }
    setSigError("");
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string")
        setSignature({ kind: "image", image: reader.result });
    };
    reader.readAsDataURL(file);
  }, [setSignature]);

  // ---- Empty state actions ---------------------------------------------------------
  const handleCreate = useCallback(() => {
    try {
      window.localStorage.setItem(clStartedKey(userId), "true");
    } catch {
      /* ignore */
    }
    setStarted(true);
    setOpenSection("sender");
  }, [userId]);

  const handlePrint = useCallback(() => {
    window.print();
  }, []);

  // ---- Collapsed-card summaries ------------------------------------------------------
  const paragraphsCount = doc.body.filter((p) => p.trim()).length;
  const summaryFor = useCallback(
    (key: ClSectionKey): string => {
      switch (key) {
        case "sender":
          return senderSummary(doc);
        case "date":
          return formatGermanDate(doc.date);
        case "recipient":
          return recipientSummary(doc);
        case "subject":
          return doc.subject.trim();
        case "greeting":
          return doc.greeting.trim();
        case "body":
          return paragraphsCount === 0
            ? ""
            : paragraphsCount === 1
              ? t("coverLetter.paragraphsOne")
              : t("coverLetter.paragraphsMany", { n: paragraphsCount });
        case "closing":
          return doc.closing.trim();
        case "signature":
          if (doc.signature.kind === "text" && doc.signature.text.trim())
            return doc.signature.text.trim();
          if (doc.signature.kind === "image" && doc.signature.image)
            return t("coverLetter.signatureImage");
          return "";
      }
    },
    [doc, paragraphsCount, t],
  );

  const titleFor = (key: ClSectionKey): string =>
    t(`coverLetter.section${key[0].toUpperCase()}${key.slice(1)}`);

  const toggleSection = (key: ClSectionKey) =>
    setOpenSection((current) => (current === key ? null : key));

  const greetingIsPreset = GREETING_PRESETS.includes(doc.greeting);

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

  const paragraphs = doc.body.length ? doc.body : [""];

  return (
    <div>
      {/* ============================== Top bar ============================== */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <h2 className="text-xl font-bold tracking-tight text-ink">
            {t("coverLetter.builderTitle")}
          </h2>
          <p className="mt-1 text-sm text-muted">
            {t("coverLetter.builderSubtitle")}
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          {saveState !== "idle" && started && (
            <span
              role="status"
              className="hidden items-center gap-1.5 text-xs font-semibold text-muted sm:inline-flex"
            >
              <Icon name={saveState === "saved" ? "check" : "clock"} size={13} />
              {saveState === "saved"
                ? t("coverLetter.saved")
                : t("coverLetter.saving")}
            </span>
          )}
          {started && (
            <div className="flex rounded-xl border border-line-strong bg-surface p-1 lg:hidden">
              <button
                type="button"
                aria-pressed={mobileView === "edit"}
                onClick={() => setMobileView("edit")}
                className={`rounded-lg px-3.5 py-1.5 text-xs font-bold transition-colors ${
                  mobileView === "edit"
                    ? "bg-accent text-white"
                    : "text-muted hover:text-ink"
                }`}
              >
                {t("coverLetter.tabEdit")}
              </button>
              <button
                type="button"
                aria-pressed={mobileView === "preview"}
                onClick={() => setMobileView("preview")}
                className={`rounded-lg px-3.5 py-1.5 text-xs font-bold transition-colors ${
                  mobileView === "preview"
                    ? "bg-accent text-white"
                    : "text-muted hover:text-ink"
                }`}
              >
                {t("coverLetter.tabPreview")}
              </button>
            </div>
          )}
          <Button variant="dark" onClick={handlePrint} disabled={!hasContent}>
            <Icon name="download" size={15} />
            {t("coverLetter.downloadPdf")}
          </Button>
        </div>
      </div>

      {/* ============================= Empty state ============================ */}
      {!showWorkspace ? (
        <Card className="mx-auto mt-8 flex min-h-[55vh] max-w-xl flex-col items-center justify-center p-8 text-center sm:mt-12">
          <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-accent-soft text-accent">
            <Icon name="send" size={28} />
          </span>
          <h3 className="mt-6 text-2xl font-bold text-ink">
            {t("coverLetter.emptyTitle")}
          </h3>
          <p className="mt-2 max-w-sm text-sm leading-6 text-muted">
            {t("coverLetter.emptyText")}
          </p>
          <div className="mt-7 flex flex-col gap-3 sm:flex-row">
            <Button size="lg" onClick={handleCreate}>
              {t("coverLetter.createLetter")}
            </Button>
            <Button
              size="lg"
              variant="secondary"
              onClick={() => void runProfileImport()}
              disabled={importBusy}
            >
              {importBusy ? t("coverLetter.importing") : t("coverLetter.takeOverProfile")}
            </Button>
          </div>
          {importNotice === "notfound" && (
            <p role="status" className="mt-5 text-xs font-medium text-muted">
              {t("coverLetter.importNotFound")}
            </p>
          )}
          {importNotice === "error" && (
            <p role="alert" className="mt-5 text-xs font-medium text-danger">
              {t("coverLetter.importFailed")}
            </p>
          )}
        </Card>
      ) : (
        /* ============================ Workspace ============================ */
        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:items-start">
          {/* ------------------------------ Editor ----------------------------- */}
          <div className={`min-w-0 ${mobileView === "edit" ? "" : "hidden lg:block"}`}>
            <div className="space-y-3.5">
              {/* Absender */}
              <ClSection
                section="sender"
                title={titleFor("sender")}
                summary={summaryFor("sender")}
                open={openSection === "sender"}
                onToggle={() => toggleSection("sender")}
              >
                <div className="mb-4 flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={runCvCopy}
                    disabled={importBusy}
                  >
                    <Icon name="file" size={14} />
                    {t("coverLetter.copyFromCv")}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void runProfileImport()}
                    disabled={importBusy}
                  >
                    <Icon name="upload" size={14} />
                    {importBusy ? t("coverLetter.importing") : t("coverLetter.takeOverProfile")}
                  </Button>
                </div>
                {importNotice && (
                  <p
                    role={importNotice === "error" || importNotice === "cvenotfound" ? "alert" : "status"}
                    className={`mb-4 -mt-1 text-xs font-medium ${importNotice === "notfound" ? "text-muted" : "text-danger"}`}
                  >
                    {importNotice === "cvenotfound"
                      ? t("coverLetter.cvNotFound")
                      : importNotice === "notfound"
                        ? t("coverLetter.importNotFound")
                        : t("coverLetter.importFailed")}
                  </p>
                )}
                <div className="grid gap-3.5 sm:grid-cols-2">
                  <div className="sm:col-span-2">
                    <Input
                      label={t("coverLetter.fullName")}
                      value={doc.sender.fullName}
                      onChange={(e) => setSender({ fullName: e.target.value })}
                    />
                  </div>
                  <Input
                    label={t("coverLetter.street")}
                    value={doc.sender.street}
                    onChange={(e) => setSender({ street: e.target.value })}
                  />
                  <div className="grid grid-cols-2 gap-3">
                    <Input
                      label={t("coverLetter.postalCode")}
                      value={doc.sender.postalCode}
                      onChange={(e) => setSender({ postalCode: e.target.value })}
                    />
                    <Input
                      label={t("coverLetter.city")}
                      value={doc.sender.city}
                      onChange={(e) => setSender({ city: e.target.value })}
                    />
                  </div>
                  <Input
                    label={t("coverLetter.country")}
                    value={doc.sender.country}
                    onChange={(e) => setSender({ country: e.target.value })}
                  />
                  <Input
                    label={t("coverLetter.email")}
                    type="email"
                    value={doc.sender.email}
                    onChange={(e) => setSender({ email: e.target.value })}
                  />
                  <Input
                    label={t("coverLetter.phone")}
                    type="tel"
                    value={doc.sender.phone}
                    onChange={(e) => setSender({ phone: e.target.value })}
                  />
                  <Input
                    label={t("coverLetter.linkedin")}
                    labelSuffix={t("coverLetter.optional")}
                    value={doc.sender.linkedin}
                    onChange={(e) => setSender({ linkedin: e.target.value })}
                  />
                  <Input
                    label={t("coverLetter.website")}
                    labelSuffix={t("coverLetter.optional")}
                    value={doc.sender.website}
                    onChange={(e) => setSender({ website: e.target.value })}
                  />
                </div>
              </ClSection>

              {/* Datum */}
              <ClSection
                section="date"
                title={titleFor("date")}
                summary={summaryFor("date")}
                open={openSection === "date"}
                onToggle={() => toggleSection("date")}
              >
                <div className="flex flex-wrap items-end gap-4">
                  <div className="min-w-52 flex-1">
                    <span className="mb-2 block text-sm font-semibold text-ink-soft">
                      {t("coverLetter.sectionDate")}
                    </span>
                    <input
                      type="date"
                      value={doc.date}
                      onChange={(e) => setDate(e.target.value)}
                      aria-label={t("coverLetter.sectionDate")}
                      className="h-12 w-full rounded-xl border border-line-strong bg-surface px-3.5 text-sm text-ink outline-none transition focus:border-accent focus:ring-4 focus:ring-accent/10"
                    />
                  </div>
                  <div className="pb-3">
                    <p className="text-xs text-muted">{t("coverLetter.dateHint")}</p>
                    <p className="mt-1 text-sm font-bold text-ink">
                      {formatGermanDate(doc.date)}
                    </p>
                  </div>
                </div>
              </ClSection>

              {/* Empfänger */}
              <ClSection
                section="recipient"
                title={titleFor("recipient")}
                summary={summaryFor("recipient")}
                open={openSection === "recipient"}
                onToggle={() => toggleSection("recipient")}
              >
                <div className="grid gap-3.5 sm:grid-cols-2">
                  <div className="sm:col-span-2">
                    <Input
                      label={t("coverLetter.company")}
                      value={doc.recipient.company}
                      onChange={(e) => setRecipient({ company: e.target.value })}
                    />
                  </div>
                  <Input
                    label={t("coverLetter.contactPerson")}
                    labelSuffix={t("coverLetter.optional")}
                    value={doc.recipient.contactPerson}
                    onChange={(e) => setRecipient({ contactPerson: e.target.value })}
                  />
                  <Input
                    label={t("coverLetter.department")}
                    labelSuffix={t("coverLetter.optional")}
                    value={doc.recipient.department}
                    onChange={(e) => setRecipient({ department: e.target.value })}
                  />
                  <Input
                    label={t("coverLetter.street")}
                    value={doc.recipient.street}
                    onChange={(e) => setRecipient({ street: e.target.value })}
                  />
                  <div className="grid grid-cols-2 gap-3">
                    <Input
                      label={t("coverLetter.postalCode")}
                      value={doc.recipient.postalCode}
                      onChange={(e) => setRecipient({ postalCode: e.target.value })}
                    />
                    <Input
                      label={t("coverLetter.city")}
                      value={doc.recipient.city}
                      onChange={(e) => setRecipient({ city: e.target.value })}
                    />
                  </div>
                  <Input
                    label={t("coverLetter.country")}
                    value={doc.recipient.country}
                    onChange={(e) => setRecipient({ country: e.target.value })}
                  />
                </div>
              </ClSection>

              {/* Betreff */}
              <ClSection
                section="subject"
                title={titleFor("subject")}
                summary={summaryFor("subject")}
                open={openSection === "subject"}
                onToggle={() => toggleSection("subject")}
              >
                <Input
                  label={t("coverLetter.sectionSubject")}
                  placeholder={t("coverLetter.subjectPlaceholder")}
                  value={doc.subject}
                  onChange={(e) => setField("subject")(e.target.value)}
                />
              </ClSection>

              {/* Anrede */}
              <ClSection
                section="greeting"
                title={titleFor("greeting")}
                summary={summaryFor("greeting")}
                open={openSection === "greeting"}
                onToggle={() => toggleSection("greeting")}
              >
                <div className="space-y-4">
                  <div>
                    <span className="mb-2 block text-sm font-semibold text-ink-soft">
                      {t("coverLetter.greetingSelect")}
                    </span>
                    <select
                      value={greetingIsPreset ? doc.greeting : "__custom__"}
                      onChange={(e) => {
                        const value = e.target.value;
                        if (value !== "__custom__") setField("greeting")(value);
                      }}
                      aria-label={t("coverLetter.greetingSelect")}
                      className="h-12 w-full rounded-xl border border-line-strong bg-surface px-3.5 text-sm text-ink outline-none transition focus:border-accent focus:ring-4 focus:ring-accent/10"
                    >
                      {GREETING_PRESETS.map((preset) => (
                        <option key={preset} value={preset}>
                          {preset}
                        </option>
                      ))}
                      <option value="__custom__">{t("coverLetter.greetingCustom")}</option>
                    </select>
                  </div>
                  <Input
                    label={t("coverLetter.sectionGreeting")}
                    hint={t("coverLetter.greetingHint")}
                    value={doc.greeting}
                    onChange={(e) => setField("greeting")(e.target.value)}
                  />
                </div>
              </ClSection>

              {/* Anschreiben (body) */}
              <ClSection
                section="body"
                title={titleFor("body")}
                summary={summaryFor("body")}
                open={openSection === "body"}
                onToggle={() => toggleSection("body")}
              >
                <div className="mb-4 flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setAiModalOpen(true)}
                    disabled={aiBusy !== ""}
                  >
                    <Icon name="spark" size={14} />
                    {aiBusy === "generate"
                      ? t("coverLetter.aiGenerating")
                      : t("coverLetter.aiCreate")}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void improveText()}
                    disabled={aiBusy !== "" || paragraphsCount === 0}
                  >
                    <Icon name="edit" size={14} />
                    {aiBusy === "improve"
                      ? t("coverLetter.aiImproving")
                      : t("coverLetter.aiImprove")}
                  </Button>
                </div>
                {aiError && (
                  <p role="alert" className="mb-4 text-xs font-medium text-danger">
                    {aiError}
                  </p>
                )}
                <p className="mb-3 text-xs text-muted">{t("coverLetter.bodyHint")}</p>
                <div className="space-y-3">
                  {paragraphs.map((paragraph, index) => (
                    <div key={index} className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <Textarea
                          value={paragraph}
                          onChange={(e) => setParagraph(index, e.target.value)}
                          placeholder={
                            index === 0
                              ? t("coverLetter.bodyPlaceholder")
                              : ""
                          }
                          aria-label={`${t("coverLetter.sectionBody")} ${index + 1}`}
                        />
                      </div>
                      {paragraphs.length > 1 && (
                        <button
                          type="button"
                          onClick={() => removeParagraph(index)}
                          aria-label={`${t("coverLetter.removeParagraph")} ${index + 1}`}
                          className="mt-2.5 rounded-lg p-2 text-faint transition-colors hover:bg-surface-2 hover:text-danger"
                        >
                          <Icon name="x" size={14} strokeWidth={2} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={addParagraph}
                  className="mt-3 inline-flex items-center gap-1.5 rounded-lg px-1 py-0.5 text-xs font-bold text-accent transition-colors hover:text-accent-deep"
                >
                  <Icon name="plus" size={13} strokeWidth={2.5} />
                  {t("coverLetter.addParagraph")}
                </button>
              </ClSection>

              {/* Grußformel */}
              <ClSection
                section="closing"
                title={titleFor("closing")}
                summary={summaryFor("closing")}
                open={openSection === "closing"}
                onToggle={() => toggleSection("closing")}
              >
                <Input
                  label={t("coverLetter.sectionClosing")}
                  hint={t("coverLetter.closingHint")}
                  value={doc.closing}
                  onChange={(e) => setField("closing")(e.target.value)}
                />
              </ClSection>

              {/* Unterschrift */}
              <ClSection
                section="signature"
                title={titleFor("signature")}
                summary={summaryFor("signature")}
                open={openSection === "signature"}
                onToggle={() => toggleSection("signature")}
              >
                <div className="space-y-4">
                  <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t("coverLetter.sectionSignature")}>
                    {(
                      [
                        ["none", t("coverLetter.signatureNone")],
                        ["text", t("coverLetter.signatureText")],
                        ["image", t("coverLetter.signatureImage")],
                      ] as const
                    ).map(([kind, label]) => (
                      <button
                        key={kind}
                        type="button"
                        role="radio"
                        aria-checked={doc.signature.kind === kind}
                        onClick={() => {
                          setSignature({ kind });
                          setSigError("");
                          if (kind === "text" && !doc.signature.text.trim() && doc.sender.fullName.trim()) {
                            setSignature({ text: doc.sender.fullName.trim() });
                          }
                          if (kind === "image" && !doc.signature.image) {
                            window.setTimeout(() => signatureFileRef.current?.click(), 50);
                          }
                        }}
                        className={`rounded-full border px-3.5 py-1.5 text-xs font-bold transition-colors ${
                          doc.signature.kind === kind
                            ? "border-accent bg-accent-soft text-accent-deep"
                            : "border-line-strong bg-surface text-muted hover:text-ink"
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>

                  {doc.signature.kind === "text" && (
                    <Input
                      label={t("coverLetter.signatureText")}
                      placeholder={t("coverLetter.signatureTextPlaceholder")}
                      value={doc.signature.text}
                      onChange={(e) => setSignature({ text: e.target.value })}
                    />
                  )}

                  {doc.signature.kind === "image" && (
                    <div>
                      <span className="mb-2 block text-sm font-semibold text-ink-soft">
                        {t("coverLetter.signatureImage")}
                      </span>
                      <div className="flex items-center gap-4">
                        {doc.signature.image ? (
                          // eslint-disable-next-line @next/next/no-img-element -- user signature data URL, bounded size
                          <img
                            src={doc.signature.image}
                            alt={t("coverLetter.signatureImage")}
                            className="h-20 max-w-56 rounded-lg border border-line bg-surface object-contain p-1.5"
                          />
                        ) : (
                          <div className="flex h-20 w-44 items-center justify-center rounded-lg border border-dashed border-line-strong text-xs text-faint">
                            {t("coverLetter.signatureHint")}
                          </div>
                        )}
                        <div className="flex flex-col gap-2">
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => signatureFileRef.current?.click()}
                          >
                            <Icon name="upload" size={14} />
                            {doc.signature.image
                              ? t("coverLetter.replaceSignature")
                              : t("coverLetter.uploadSignature")}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-danger hover:bg-danger-soft hover:text-danger"
                            onClick={() =>
                              setSignature({ image: null, kind: "none" })
                            }
                          >
                            {t("coverLetter.removeSignature")}
                          </Button>
                        </div>
                      </div>
                      {sigError ? (
                        <p className="mt-2 text-xs font-medium text-danger">
                          {sigError === "large"
                            ? t("coverLetter.signatureTooLarge")
                            : t("coverLetter.signatureInvalid")}
                        </p>
                      ) : (
                        <p className="mt-2 text-xs text-muted">{t("coverLetter.signatureHint")}</p>
                      )}
                      <input
                        ref={signatureFileRef}
                        type="file"
                        accept="image/png,image/jpeg"
                        className="sr-only"
                        aria-label={t("coverLetter.uploadSignature")}
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) handleSignatureFile(file);
                          e.target.value = "";
                        }}
                      />
                    </div>
                  )}
                </div>
              </ClSection>
            </div>
          </div>

          {/* ----------------------------- Preview ----------------------------- */}
          <div
            className={`min-w-0 ${mobileView === "preview" ? "" : "hidden lg:block"}`}
          >
            <div ref={previewOuterRef} className="w-full">
              <div
                className="mx-auto overflow-hidden rounded-[6px]"
                style={{
                  width: CL_SHEET_WIDTH * preview.scale,
                  height: preview.sheetHeight * preview.scale,
                }}
              >
                <div
                  ref={previewSheetRef}
                  className="shadow-[0_16px_48px_rgba(16,32,59,0.16)] dark:shadow-[0_16px_48px_rgba(0,0,0,0.5)]"
                  style={{
                    width: CL_SHEET_WIDTH,
                    transform: `scale(${preview.scale})`,
                    transformOrigin: "top left",
                  }}
                >
                  <CoverLetterDocument doc={doc} />
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* =============================== Modals =============================== */}
      {aiModalOpen && (
        <AiLetterModal
          onClose={() => setAiModalOpen(false)}
          initial={doc.ai}
          companySuggestion={doc.recipient.company.trim()}
          hasBody={paragraphsCount > 0}
          busy={aiBusy === "generate"}
          onGenerate={(settings) => void callAi("generate", settings)}
        />
      )}

      {/* ======================= Print root (portal) ========================= */}
      {/* Rendered onto <body> outside the app shell; visible only in
          @media print (see globals.css). Same component as the preview,
          so the exported PDF is the letter with nothing else. */}
      {typeof document !== "undefined" &&
        createPortal(
          <div className="cl-print-root" aria-hidden="true">
            <CoverLetterDocument doc={doc} />
          </div>,
          document.body,
        )}
    </div>
  );
}
