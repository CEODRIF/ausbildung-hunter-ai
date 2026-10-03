"use client";

/**
 * AI Deckblatt Generator — the full page component.
 *
 * Security & UX contracts (see the feature brief):
 *  - The browser NEVER calls Pollinations directly — everything goes through
 *    /api/deckblatt/generate, which enforces auth, the atomic 2/day quota
 *    (DB-side) and input validation.
 *  - The photo leaves the browser ONLY as the AI model's image input
 *    (GPT Image 2 portrait integration) — positioned/cropped/framed, never
 *    transformed (identity-preserving; the server-side prompt enforces it).
 *    Name/email/phone/address never leave the browser: the exact personal
 *    text is composited by the local renderer (render.ts) afterwards.
 *  - Generation states are REAL: "Profil wird vorbereitet" (client
 *    validation/normalization) → "Design wird generiert" (the actual
 *    provider round trip) → "Deckblatt wird finalisiert" (the design image
 *    is decoded before the result is shown). No fake progress bar, no
 *    numeric progress before the result exists.
 *  - One idempotency key per click (run_id): a retried request cannot be
 *    charged twice; the server maps it to "already_running".
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/lib/i18n";
import { Icon } from "@/components/icon";
import { Button, Card, ErrorState, Input } from "@/components/ui";
import { GlassCard } from "@/components/ui/surfaces";
import { useScaledSheet } from "@/lib/use-scaled-sheet";
import {
  DECKBLATT_STYLES,
  DECKBLATT_HEIGHT,
  DECKBLATT_WIDTH,
  type DeckblattStyleId,
} from "@/lib/deckblatt/styles";
import {
  renderDeckblattPng,
  type DeckblattData,
} from "@/lib/deckblatt/render";
import {
  bytesToBase64,
  detectDeckblattPhotoMime,
  validateDeckblattForm,
  validateDeckblattPhotoDataUrl,
  validateDeckblattPhotoDimensions,
  validateDeckblattPhotoFile,
  type DeckblattFieldErrors,
  type DeckblattFieldKey,
  type DeckblattPhotoFileError,
  type DeckblattPhotoMime,
} from "@/lib/deckblatt/validate";
import { DeckblattSheet } from "@/components/deckblatt-sheet";

// ---------------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------------

type GenPhase = "idle" | "preparing" | "generating" | "finalizing";

type GenError =
  | ""
  | "validation"
  | "photo"
  | "quota"
  | "already_running"
  | "rate_limited"
  | "provider"
  | "provider_rate"
  | "provider_content_blocked"
  | "provider_unconfigured"
  | "usage_unavailable"
  | "network"
  | "session"
  | "render";

interface PhotoState {
  /** Object URL — used for the <img> preview ONLY. Never fetched, never
   *  converted: fetching a blob: URL is not portable across browser
   *  contexts and used to surface as "photo could not be read". */
  url: string;
  name: string;
  /** The exact bytes that will be sent as the model's image input (the
   *  original file, or the JPEG re-encode). The data URL is built from
   *  THESE bytes at generation time. */
  blob: Blob;
}

interface GenerateResponse {
  code?: string;
  runId?: string;
  styleId?: string;
  design?: string;
  usage?: { used?: number; remaining?: number };
  fields?: Partial<Record<DeckblattFieldKey, string>>;
  photo?: "invalidFormat" | "tooLarge";
}

interface UsageState {
  used: number;
  remaining: number;
}

const STYLE_IDS = Object.keys(DECKBLATT_STYLES) as DeckblattStyleId[];
const DAILY_LIMIT = 2;

/** One client-side UUID v4 per click = the idempotency key for the quota
 *  reservation. crypto.randomUUID with a getRandomValues fallback. */
function newRunId(): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
    return cryptoObj.randomUUID();
  }
  const bytes = new Uint8Array(16);
  cryptoObj.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-");
}

function readUsage(payload: { used?: number; remaining?: number } | undefined): UsageState | null {
  if (
    payload &&
    typeof payload.used === "number" &&
    Number.isInteger(payload.used) &&
    typeof payload.remaining === "number" &&
    Number.isInteger(payload.remaining)
  ) {
    return { used: payload.used, remaining: payload.remaining };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Photo decode / downscale (browser only — the file never leaves the page)
// ---------------------------------------------------------------------------

async function decodePhotoFile(
  file: File,
): Promise<{ img: HTMLImageElement; url: string }> {
  const url = URL.createObjectURL(file);
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("photo decode failed"));
    img.src = url;
  });
  return { img, url };
}

/**
 * Downscale to a 2000px max edge (JPEG 0.92) for fast compositing AND keep
 * the AI image-input payload compact: the photo is sent to the provider as
 * a base64 data URL, so oversized originals and heavy PNG/WebP files are
 * re-encoded to JPEG. Small JPEGs keep their original quality (no
 * re-encode).
 *
 * `sourceMime` is the format DETECTED from the file's magic bytes — NOT
 * `sourceFile.type`, which is derived from the extension and can lie (a PNG
 * delivered as "Bewerbungsfoto.jpg" reports "image/jpeg").
 */
async function preparePhoto(
  img: HTMLImageElement,
  sourceUrl: string,
  sourceFile: File,
  sourceMime: string,
): Promise<{ url: string; blob: Blob }> {
  const MAX_EDGE = 2000;
  const REENCODE_BYTES = 1_500_000;
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const needsResize = Math.max(w, h) > MAX_EDGE;
  const needsReencode =
    !needsResize && (sourceFile.size > REENCODE_BYTES || sourceMime !== "image/jpeg");
  if (!needsResize && !needsReencode) return { url: sourceUrl, blob: sourceFile };
  const scale = needsResize ? MAX_EDGE / Math.max(w, h) : 1;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return { url: sourceUrl, blob: sourceFile };
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", 0.92),
  );
  // Re-encoding is best-effort: if the canvas fails, fall back to the
  // verified original bytes (still a valid, decodable image).
  if (!blob) return { url: sourceUrl, blob: sourceFile };
  return { url: URL.createObjectURL(blob), blob };
}

/**
 * Encode the prepared photo into the base64 data URL that the server
 * forwards to the model as image input.
 *
 * The bytes are read DIRECTLY from the stored Blob (`blob.arrayBuffer()`) —
 * never via `fetch()` on the object URL: fetching a `blob:` URL is not
 * reliably supported in every browser context, and its failure used to
 * surface as the misleading "photo could not be read" state.
 *
 * The MIME label comes from the bytes' magic signature (the extension can
 * lie), and the finished data URL is verified with the SAME rules the
 * server applies before anything is sent. Throws on undecodable content or
 * an over-cap payload — the caller maps that to the photo read error.
 */
async function photoBlobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const mime = detectDeckblattPhotoMime(bytes);
  if (!mime) throw new Error("photo content undecodable");
  const base64 = bytesToBase64(bytes);
  const dataUrl = `data:${mime};base64,${base64}`;
  const payloadError = validateDeckblattPhotoDataUrl(dataUrl);
  if (payloadError) throw new Error(`photo payload ${payloadError}`);
  return dataUrl;
}

function triggerDownload(dataUrl: string, filename: string) {
  const link = document.createElement("a");
  link.href = dataUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

// ---------------------------------------------------------------------------
// Generation overlay (real states — no fake progress)
// ---------------------------------------------------------------------------

function GenerationOverlay({ phase }: { phase: GenPhase }) {
  const { t } = useI18n();
  const phaseKey =
    phase === "preparing"
      ? "deckblatt.statePreparing"
      : phase === "generating"
        ? "deckblatt.stateGenerating"
        : "deckblatt.stateFinalizing";
  return (
    <div
      className="relative flex aspect-[210/297] w-full flex-col items-center justify-center gap-4 overflow-hidden p-6 text-center"
      role="status"
    >
      <div className="deckblatt-shimmer absolute inset-0" aria-hidden="true" />
      <div className="relative flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-soft text-accent">
        <Icon name="spark" size={26} className="animate-pulse" />
      </div>
      <div className="relative">
        <p className="text-sm font-bold text-ink">{t("deckblatt.stateWorking")}</p>
        <p className="mt-1.5 text-sm font-semibold text-accent">{t(phaseKey)}</p>
        <p className="mt-2 text-xs leading-5 text-faint">{t("deckblatt.stateNote")}</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function DeckblattGenerator() {
  const { t } = useI18n();

  const [form, setForm] = useState<DeckblattData>({
    firstName: "",
    lastName: "",
    profession: "",
    email: "",
    phone: "",
    address: "",
  });
  const [fieldErrors, setFieldErrors] = useState<DeckblattFieldErrors>({});
  const [photo, setPhoto] = useState<PhotoState | null>(null);
  const [photoError, setPhotoError] = useState<"" | DeckblattPhotoFileError | "missing">("");
  const [dragging, setDragging] = useState(false);
  const [styleChoice, setStyleChoice] = useState<DeckblattStyleId | "auto">("auto");
  const [usage, setUsage] = useState<UsageState | null>(null);
  const [phase, setPhase] = useState<GenPhase>("idle");
  const [error, setError] = useState<GenError>("");
  const [result, setResult] = useState<{ dataUrl: string; styleId: DeckblattStyleId } | null>(
    null,
  );
  const [exportingPng, setExportingPng] = useState(false);

  const photoInputRef = useRef<HTMLInputElement | null>(null);
  const previewOuterRef = useRef<HTMLDivElement | null>(null);
  const previewSheetRef = useRef<HTMLDivElement | null>(null);
  const photoUrlRef = useRef<string | null>(null);
  const preview = useScaledSheet(previewOuterRef, previewSheetRef, {
    sheetWidth: DECKBLATT_WIDTH,
    sheetMinHeight: DECKBLATT_HEIGHT,
    active: true,
  });

  // ---- Load today's quota (header indicator) -------------------------------
  useEffect(() => {
    let cancelled = false;
    fetch("/api/deckblatt/status", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (cancelled || !data || typeof data !== "object") return;
        const next = readUsage(data as { used?: number; remaining?: number });
        if (next) setUsage(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- Print scope (hidden on screen; visible only in @media print) --------
  useEffect(() => {
    document.body.classList.add("deckblatt-print-active");
    return () => document.body.classList.remove("deckblatt-print-active");
  }, []);

  // ---- Revoke the photo object URL on unmount ------------------------------
  useEffect(() => {
    return () => {
      if (photoUrlRef.current) URL.revokeObjectURL(photoUrlRef.current);
    };
  }, []);

  const setPhotoUrl = useCallback((url: string | null) => {
    if (photoUrlRef.current && photoUrlRef.current !== url) {
      URL.revokeObjectURL(photoUrlRef.current);
    }
    photoUrlRef.current = url;
  }, []);

  // ---- Form helpers ---------------------------------------------------------
  const setField = useCallback((key: DeckblattFieldKey, value: string) => {
    setForm((current) => ({ ...current, [key]: value }));
    setFieldErrors((current) => (current[key] ? { ...current, [key]: undefined } : current));
  }, []);

  const fieldErrorCopy = useCallback(
    (key: DeckblattFieldKey): string => {
      const code = fieldErrors[key];
      if (code === "invalidEmail") return t("deckblatt.errorEmail");
      if (code === "invalidPhone") return t("deckblatt.errorPhone");
      if (code === "required") return t("deckblatt.errorRequired");
      return "";
    },
    [fieldErrors, t],
  );

  // ---- Photo flow -----------------------------------------------------------
  const acceptPhoto = useCallback(
    async (file: File) => {
      setPhotoError("");
      const fileError = validateDeckblattPhotoFile(file);
      if (fileError) {
        setPhotoError(fileError);
        return;
      }
      // Verify the ACTUAL format from the file's magic bytes. `file.type`
      // is extension-derived and can lie (PNG content in a ".jpg" file);
      // undetectable bytes = corrupted/unsupported content → reject.
      let detectedMime: DeckblattPhotoMime;
      try {
        const header = new Uint8Array(await file.slice(0, 16).arrayBuffer());
        const detected = detectDeckblattPhotoMime(header);
        if (!detected) {
          setPhotoError("readError");
          return;
        }
        detectedMime = detected;
      } catch {
        setPhotoError("readError");
        return;
      }
      let img: HTMLImageElement;
      let url: string;
      try {
        ({ img, url } = await decodePhotoFile(file));
      } catch {
        setPhotoError("readError");
        return;
      }
      const dimensionError = validateDeckblattPhotoDimensions(
        img.naturalWidth,
        img.naturalHeight,
      );
      if (dimensionError) {
        URL.revokeObjectURL(url);
        setPhotoError(dimensionError);
        return;
      }
      try {
        const { url: readyUrl, blob } = await preparePhoto(img, url, file, detectedMime);
        setPhotoUrl(readyUrl);
        setPhoto({ url: readyUrl, name: file.name, blob });
      } catch {
        URL.revokeObjectURL(url);
        setPhotoError("readError");
      }
    },
    [setPhotoUrl],
  );

  const handlePhotoChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = ""; // allow re-selecting the same file
      if (file) void acceptPhoto(file);
    },
    [acceptPhoto],
  );

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setDragging(false);
      const file = event.dataTransfer.files?.[0];
      if (file) void acceptPhoto(file);
    },
    [acceptPhoto],
  );

  const removePhoto = useCallback(() => {
    setPhoto(null);
    setPhotoError("");
    setPhotoUrl(null);
  }, [setPhotoUrl]);

  // ---- Generation -----------------------------------------------------------
  const startGeneration = useCallback(async () => {
    // 1. Client validation (same rules the server re-applies).
    const formErrors = validateDeckblattForm(form);
    if (Object.keys(formErrors).length > 0) {
      setFieldErrors(formErrors);
      setError("validation");
      return;
    }
    setFieldErrors({});
    if (!photo) {
      setPhotoError("missing");
      setError("photo");
      return;
    }
    if (usage && usage.remaining <= 0) {
      setError("quota");
      return;
    }
    setError("");
    setPhase("preparing");

    // 2. Real step: normalize (trim) the data that will be composited.
    const data: DeckblattData = {
      firstName: form.firstName.trim(),
      lastName: form.lastName.trim(),
      profession: form.profession.trim(),
      email: form.email.trim(),
      phone: form.phone.trim(),
      address: form.address.trim(),
    };
    const runId = newRunId();

    // 2b. Real step: encode the prepared photo as the provider's image
    //     input (identity-preserving portrait; the exact text fields
    //     `email/phone/address/firstName/lastName` are NOT sent — the
    //     local renderer composites them afterwards). The bytes come from
    //     the stored Blob, and the data URL is verified before the request.
    let photoDataUrl: string;
    try {
      photoDataUrl = await photoBlobToDataUrl(photo.blob);
    } catch {
      setPhotoError("readError");
      setError("photo");
      setPhase("idle");
      return;
    }

    // 3. Real step: the actual server round trip (auth → quota → provider).
    setPhase("generating");
    try {
      const response = await fetch("/api/deckblatt/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...data,
          runId,
          styleId: styleChoice === "auto" ? undefined : styleChoice,
          photo: photoDataUrl,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as GenerateResponse;
      const freshUsage = readUsage(payload.usage);
      if (freshUsage) setUsage(freshUsage);

      if (response.ok) {
        // 4. Real step: decode the design BEFORE showing it — the "done"
        //    state only appears when the result actually exists.
        setPhase("finalizing");
        const design = typeof payload.design === "string" ? payload.design : "";
        let decodeOk = Boolean(design);
        if (decodeOk) {
          await new Promise<void>((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve();
            img.onerror = () => reject(new Error("design decode failed"));
            img.src = design;
          }).catch(() => {
            decodeOk = false;
          });
        }
        if (!decodeOk) {
          setError("provider");
          setPhase("idle");
          return;
        }
        const styleId: DeckblattStyleId =
          typeof payload.styleId === "string" && payload.styleId in DECKBLATT_STYLES
            ? (payload.styleId as DeckblattStyleId)
            : "modern";
        setResult({ dataUrl: design, styleId });
        setPhase("idle");
        return;
      }

      // Error mapping (server codes → translated messages).
      if (response.status === 401) {
        setError("session");
      } else if (response.status === 409) {
        setError("already_running");
      } else if (response.status === 429) {
        setError("rate_limited");
      } else if (response.status === 502) {
        if (payload.code === "provider_rate_limited") setError("provider_rate");
        else if (payload.code === "provider_unauthorized") setError("provider_unconfigured");
        else if (payload.code === "provider_content_blocked") setError("provider_content_blocked");
        else setError("provider");
      } else if (response.status === 503) {
        setError("usage_unavailable");
      } else if (response.status === 400 && payload.code === "validation") {
        if (payload.photo) {
          setPhotoError(payload.photo === "tooLarge" ? "tooLarge" : "invalidType");
          setError("photo");
        } else if (payload.fields) {
          setFieldErrors(payload.fields as DeckblattFieldErrors);
          setError("validation");
        } else {
          setError("validation");
        }
      } else if (response.status === 403) {
        setError("quota");
      } else {
        setError("provider");
      }
      setPhase("idle");
    } catch {
      // Network-level failure (offline, connection dropped).
      setError("network");
      setPhase("idle");
    }
  }, [form, photo, usage, styleChoice]);

  const handleGenerate = useCallback(() => {
    if (phase !== "idle") return;
    void startGeneration();
  }, [phase, startGeneration]);

  /** "Neu gestalten": a fresh design for the same data. The current result
   *  stays visible UNDER the generation overlay — a failed redesign never
   *  destroys the existing Deckblatt. Quota is enforced server-side. */
  const handleRedesign = useCallback(() => {
    if (phase !== "idle") return;
    void startGeneration();
  }, [phase, startGeneration]);

  // ---- Exports ----------------------------------------------------------------
  const handlePrint = useCallback(() => {
    window.print();
  }, []);

  const handleDownloadPng = useCallback(async () => {
    if (!result || !photo || exportingPng) return;
    setExportingPng(true);
    setError("");
    try {
      const dataUrl = await renderDeckblattPng({
        style: DECKBLATT_STYLES[result.styleId],
        data: {
          firstName: form.firstName.trim(),
          lastName: form.lastName.trim(),
          profession: form.profession.trim(),
          email: form.email.trim(),
          phone: form.phone.trim(),
          address: form.address.trim(),
        },
        backgroundUrl: result.dataUrl,
        photoUrl: photo.url,
      });
      const safeName = `${form.lastName.trim() || "deckblatt"}-${form.firstName.trim() || "ai"}`
        .toLowerCase()
        .replace(/[^a-z0-9äöüß-]+/gi, "-");
      triggerDownload(dataUrl, `deckblatt-${safeName}.png`);
    } catch {
      setError("render");
    } finally {
      setExportingPng(false);
    }
  }, [result, photo, exportingPng, form]);

  // ---- Derived UI ---------------------------------------------------------------
  const generating = phase !== "idle";
  const quotaExhausted = usage !== null && usage.remaining <= 0;

  const photoErrorCopy =
    photoError === ""
      ? ""
      : photoError === "missing"
        ? t("deckblatt.photoMissing")
        : photoError === "invalidType"
          ? t("deckblatt.photoInvalidType")
          : photoError === "tooLarge"
            ? t("deckblatt.photoTooLarge")
            : photoError === "tooSmall"
              ? t("deckblatt.photoTooSmall")
              : t("deckblatt.photoReadError");

  const errorCopy: Record<Exclude<GenError, "">, { title: string; description: string; retryable: boolean }> = {
    validation: {
      title: t("deckblatt.errorValidationTitle"),
      description: t("deckblatt.errorValidation"),
      retryable: false,
    },
    photo: {
      title: t("deckblatt.photoMissing"),
      description: photoErrorCopy,
      retryable: false,
    },
    quota: {
      title: t("deckblatt.errorQuota"),
      description: t("deckblatt.errorQuotaNote"),
      retryable: false,
    },
    already_running: {
      title: t("deckblatt.errorAlreadyRunning"),
      description: "",
      retryable: true,
    },
    rate_limited: {
      title: t("deckblatt.errorRateLimited"),
      description: "",
      retryable: true,
    },
    provider: {
      title: t("deckblatt.errorProvider"),
      description: t("deckblatt.errorProviderNote"),
      retryable: true,
    },
    provider_rate: {
      title: t("deckblatt.errorProviderRate"),
      description: t("deckblatt.errorProviderNote"),
      retryable: true,
    },
    provider_content_blocked: {
      title: t("deckblatt.errorProviderContentBlocked"),
      description: t("deckblatt.errorProviderNote"),
      retryable: true,
    },
    provider_unconfigured: {
      title: t("deckblatt.errorProviderUnconfigured"),
      description: "",
      retryable: true,
    },
    usage_unavailable: {
      title: t("deckblatt.errorUsage"),
      description: "",
      retryable: true,
    },
    network: {
      title: t("deckblatt.errorNetwork"),
      description: "",
      retryable: true,
    },
    session: {
      title: t("deckblatt.errorSession"),
      description: "",
      retryable: false,
    },
    render: {
      title: t("deckblatt.errorRender"),
      description: "",
      retryable: true,
    },
  };

  return (
    <div className="mx-auto w-full max-w-6xl space-y-8 pb-10">
      {/* ============================ Page header ============================ */}
      <header className="space-y-3 pt-2">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-accent-soft text-accent">
            <Icon name="spark" size={22} />
          </span>
          <h1 className="display-title text-2xl font-extrabold text-ink sm:text-3xl">
            {t("deckblatt.title")}
          </h1>
        </div>
        <p className="max-w-2xl text-sm leading-6 text-muted sm:text-base">
          {t("deckblatt.subtitle")}
        </p>
        {usage ? (
          <div className="flex flex-wrap items-center gap-3">
            <span className="inline-flex items-center gap-2 rounded-full border border-line bg-surface-2/70 px-3.5 py-1.5 text-xs font-bold text-ink-soft">
              <Icon name="spark" size={13} className="text-accent" />
              {t("deckblatt.usageAvailable", { n: usage.remaining })}
              <span className="flex gap-1" aria-hidden="true">
                {Array.from({ length: DAILY_LIMIT }, (_, i) => (
                  <span
                    key={i}
                    className={`h-1.5 w-1.5 rounded-full ${
                      i < usage.remaining ? "bg-accent" : "bg-line-strong"
                    }`}
                  />
                ))}
              </span>
            </span>
            {quotaExhausted && (
              <span className="text-xs text-faint">{t("deckblatt.usageReset")}</span>
            )}
          </div>
        ) : (
          <span className="inline-flex items-center gap-2 rounded-full border border-line bg-surface-2/70 px-3.5 py-1.5 text-xs font-bold text-faint">
            {t("deckblatt.usageLoading")}
          </span>
        )}
      </header>

      {/* ====================== Desktop 2-col / mobile 1-col ================== */}
      <div className="grid gap-8 lg:grid-cols-[minmax(0,460px)_minmax(0,1fr)] lg:items-start">
        {/* ----------------------------- Form column ----------------------------- */}
        <form
          noValidate
          className="min-w-0 space-y-6"
          onSubmit={(event) => {
            event.preventDefault();
            handleGenerate();
          }}
        >
          {/* Persönliche Daten */}
          <Card as="section" className="p-5 sm:p-6">
            <div className="mb-4 flex items-center gap-2.5">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
                <Icon name="user" size={15} />
              </span>
              <h2 className="text-sm font-bold text-ink">{t("deckblatt.formTitle")}</h2>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Input
                label={t("deckblatt.firstName")}
                placeholder={t("deckblatt.firstNamePlaceholder")}
                value={form.firstName}
                onChange={(e) => setField("firstName", e.target.value)}
                error={fieldErrorCopy("firstName") || undefined}
                maxLength={40}
                autoComplete="given-name"
              />
              <Input
                label={t("deckblatt.lastName")}
                placeholder={t("deckblatt.lastNamePlaceholder")}
                value={form.lastName}
                onChange={(e) => setField("lastName", e.target.value)}
                error={fieldErrorCopy("lastName") || undefined}
                maxLength={40}
                autoComplete="family-name"
              />
              <div className="sm:col-span-2">
                <Input
                  label={t("deckblatt.profession")}
                  placeholder={t("deckblatt.professionPlaceholder")}
                  value={form.profession}
                  onChange={(e) => setField("profession", e.target.value)}
                  error={fieldErrorCopy("profession") || undefined}
                  maxLength={80}
                />
              </div>
              <Input
                label={t("deckblatt.email")}
                placeholder={t("deckblatt.emailPlaceholder")}
                inputMode="email"
                type="email"
                value={form.email}
                onChange={(e) => setField("email", e.target.value)}
                error={fieldErrorCopy("email") || undefined}
                maxLength={120}
                autoComplete="email"
              />
              <Input
                label={t("deckblatt.phone")}
                placeholder={t("deckblatt.phonePlaceholder")}
                inputMode="tel"
                type="tel"
                value={form.phone}
                onChange={(e) => setField("phone", e.target.value)}
                error={fieldErrorCopy("phone") || undefined}
                maxLength={30}
                autoComplete="tel"
              />
              <div className="sm:col-span-2">
                <Input
                  label={t("deckblatt.address")}
                  placeholder={t("deckblatt.addressPlaceholder")}
                  value={form.address}
                  onChange={(e) => setField("address", e.target.value)}
                  error={fieldErrorCopy("address") || undefined}
                  maxLength={160}
                  autoComplete="street-address"
                />
              </div>
            </div>
          </Card>

          {/* Bewerbungsfoto */}
          <Card as="section" className="p-5 sm:p-6">
            <div className="mb-4 flex items-center gap-2.5">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
                <Icon name="image" size={15} />
              </span>
              <h2 className="text-sm font-bold text-ink">{t("deckblatt.photoTitle")}</h2>
            </div>

            {photo ? (
              <div className="flex items-center gap-4">
                {/* eslint-disable-next-line @next/next/no-img-element -- user photo object URL, fixed 80px frame */}
                <img
                  src={photo.url}
                  alt={t("deckblatt.photoTitle")}
                  className="h-20 w-20 shrink-0 rounded-full object-cover ring-2 ring-accent/40"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-ink">{photo.name}</p>
                  <div className="mt-2.5 flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => photoInputRef.current?.click()}
                    >
                      <Icon name="upload" size={13} strokeWidth={2.5} />
                      {t("deckblatt.photoReplace")}
                    </Button>
                    <Button type="button" variant="ghost" size="sm" onClick={removePhoto}>
                      <Icon name="trash" size={13} strokeWidth={2} />
                      {t("deckblatt.photoRemove")}
                    </Button>
                  </div>
                </div>
              </div>
            ) : (
              <div
                onDragOver={(event) => {
                  event.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={handleDrop}
              >
                <button
                  type="button"
                  onClick={() => photoInputRef.current?.click()}
                  className={`flex w-full flex-col items-center justify-center gap-2.5 rounded-2xl border-2 border-dashed px-4 py-8 transition-colors ${
                    dragging
                      ? "border-accent bg-accent-soft/40"
                      : photoError
                        ? "border-danger/50 bg-danger-soft/30 hover:border-danger"
                        : "border-line-strong bg-surface-2/40 hover:border-accent/60 hover:bg-accent-soft/20"
                  }`}
                >
                  <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-soft text-accent">
                    <Icon name="upload" size={18} />
                  </span>
                  <span className="text-sm font-bold text-ink">
                    {t("deckblatt.photoUpload")}
                  </span>
                  <span className="text-xs text-faint">{t("deckblatt.photoDrag")}</span>
                </button>
              </div>
            )}

            {photoErrorCopy && (
              <p className="mt-2 text-xs font-medium text-danger" role="alert">
                {photoErrorCopy}
              </p>
            )}
            <p className="mt-3 text-xs leading-5 text-faint">{t("deckblatt.photoHint")}</p>

            <input
              ref={photoInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={handlePhotoChange}
              aria-hidden="true"
              tabIndex={-1}
            />
          </Card>

          {/* Design */}
          <Card as="section" className="p-5 sm:p-6">
            <div className="mb-4 flex items-center gap-2.5">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
                <Icon name="grid" size={15} />
              </span>
              <h2 className="text-sm font-bold text-ink">{t("deckblatt.styleTitle")}</h2>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" role="radiogroup" aria-label={t("deckblatt.styleTitle")}>
              <button
                type="button"
                role="radio"
                aria-checked={styleChoice === "auto"}
                onClick={() => setStyleChoice("auto")}
                className={`flex items-center justify-center gap-1.5 rounded-xl border px-2 py-2.5 text-xs font-bold transition-colors ${
                  styleChoice === "auto"
                    ? "border-accent bg-accent-soft text-accent"
                    : "border-line bg-surface text-muted hover:border-line-strong hover:text-ink"
                }`}
              >
                {styleChoice === "auto" && <Icon name="spark" size={13} />}
                {t("deckblatt.styleAuto")}
              </button>
              {STYLE_IDS.map((id) => (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={styleChoice === id}
                  onClick={() => setStyleChoice(id)}
                  className={`flex items-center justify-center gap-1.5 rounded-xl border px-2 py-2.5 text-xs font-bold transition-colors ${
                    styleChoice === id
                      ? "border-accent bg-accent-soft text-accent"
                      : "border-line bg-surface text-muted hover:border-line-strong hover:text-ink"
                  }`}
                >
                  {styleChoice === id && <Icon name="check" size={13} />}
                  {t(DECKBLATT_STYLES[id].labelKey)}
                </button>
              ))}
            </div>
          </Card>

          {/* Generate */}
          <div className="space-y-3">
            <Button
              type="submit"
              size="lg"
              className="w-full"
              disabled={generating || quotaExhausted}
            >
              <Icon name="spark" size={17} strokeWidth={2} />
              {t("deckblatt.generate")}
            </Button>
            {quotaExhausted && (
              <p className="text-center text-xs leading-5 text-faint">
                {t("deckblatt.errorQuota")} {t("deckblatt.errorQuotaNote")}
              </p>
            )}
            {error !== "" && (
              <ErrorState
                title={errorCopy[error].title}
                description={errorCopy[error].description || undefined}
                onRetry={
                  errorCopy[error].retryable
                    ? () => {
                        setError("");
                        handleGenerate();
                      }
                    : undefined
                }
              />
            )}
          </div>
        </form>

        {/* ----------------------------- Preview column ----------------------------- */}
        {/* pb-24 keeps the bottom of the A4 sheet clear of the fixed mobile
            bottom nav (lg: the nav does not exist, so no padding). */}
        <div className="min-w-0 pb-24 lg:pb-0" dir="ltr">
          <GlassCard variant="surface-elevated" className="overflow-hidden p-0">
            {generating ? (
              <GenerationOverlay phase={phase} />
            ) : result && photo ? (
              /* Measured container: its own padding is SUBTRACTED from the
                 available width by useScaledSheet, so the frame below always
                 fits the content box (no side clipping). */
              <div
                ref={previewOuterRef}
                className="flex w-full justify-center overflow-x-clip p-4 sm:p-6"
              >
                {/* Tight FRAME: exactly the scaled dimensions, clipping, and
                    direction-pinned. `overflow-hidden` also makes its
                    automatic flex minimum size 0 — a browser can never clamp
                    it back to the sheet's 1240px min-content width (which is
                    what pushed a scaled sheet off-screen to one side). */}
                <div
                  className="relative overflow-hidden rounded-lg shadow-[var(--shadow-float)]"
                  style={{
                    direction: "ltr",
                    width: Math.round(DECKBLATT_WIDTH * preview.scale),
                    height: Math.round(DECKBLATT_HEIGHT * preview.scale),
                  }}
                >
                  {/* The sheet keeps its TRUE 1240px layout width; the uniform
                      transform only scales the paint, so the A4 ratio and all
                      render coordinates stay untouched. */}
                  <div
                    ref={previewSheetRef}
                    style={{
                      width: DECKBLATT_WIDTH,
                      transform: `scale(${preview.scale})`,
                      transformOrigin: "top left",
                    }}
                  >
                    <DeckblattSheet
                      style={DECKBLATT_STYLES[result.styleId]}
                      data={form}
                      backgroundImage={result.dataUrl}
                      photoUrl={photo.url}
                    />
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex aspect-[210/297] w-full flex-col items-center justify-center gap-3 p-6 text-center">
                <span className="flex h-16 w-16 items-center justify-center rounded-3xl bg-accent-soft text-accent">
                  <Icon name="image" size={28} />
                </span>
                <p className="text-sm font-bold text-ink">
                  {t("deckblatt.previewPlaceholderTitle")}
                </p>
                <p className="max-w-xs text-xs leading-5 text-faint">
                  {t("deckblatt.previewPlaceholderHint")}
                </p>
              </div>
            )}
          </GlassCard>

          {/* Downloads — only once a real result exists. */}
          {result && photo && !generating && (
            <div className="mt-4 flex flex-wrap gap-3">
              <Button onClick={handlePrint}>
                <Icon name="download" size={16} strokeWidth={2} />
                {t("deckblatt.downloadPdf")}
              </Button>
              <Button
                variant="secondary"
                onClick={() => void handleDownloadPng()}
                disabled={exportingPng}
              >
                <Icon name="download" size={16} strokeWidth={2} />
                {t("deckblatt.downloadPng")}
              </Button>
              <Button variant="ghost" onClick={handleRedesign}>
                <Icon name="spark" size={16} strokeWidth={2} />
                {t("deckblatt.redesign")}
              </Button>
            </div>
          )}
          {result && (
            <p className="mt-3 text-xs leading-5 text-faint">{t("deckblatt.printHint")}</p>
          )}
        </div>
      </div>

      {/* Privacy note */}
      <p className="flex items-start gap-2 text-xs leading-5 text-faint">
        <Icon name="lock" size={13} className="mt-0.5 shrink-0" />
        {t("deckblatt.privacy")}
      </p>

      {/* ====================== Print root (portal) ========================== */}
      {/* Rendered onto <body> outside the app shell; visible only in
          @media print (see globals.css). Same DeckblattSheet as the
          preview, so the exported PDF is exactly what is shown. */}
      {typeof document !== "undefined" &&
        result &&
        photo &&
        createPortal(
          <div className="deckblatt-print-root" aria-hidden="true">
            <DeckblattSheet
              style={DECKBLATT_STYLES[result.styleId]}
              data={form}
              backgroundImage={result.dataUrl}
              photoUrl={photo.url}
            />
          </div>,
          document.body,
        )}
    </div>
  );
}
