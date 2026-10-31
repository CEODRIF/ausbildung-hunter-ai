"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Loader2, PenLine, RefreshCw, Trash2 } from "lucide-react";
import { Button, Modal } from "@/components/ui";
import { useI18n } from "@/lib/i18n";
import { Note, SectionCard } from "./shared";

/**
 * Step 1 — the candidate's GENUINE handwritten signature (global, per user).
 *
 * Same UX as the Bewerbungsfoto card beside it (dashed upload box → preview +
 * replace/remove, client-side type+size pre-check that the server re-validates
 * from magic bytes). The image is the user's OWN handwriting, stored PRIVATE at
 * a fixed owner-scoped path (never a public URL), and is embedded into EVERY
 * cover letter — all companies, preview / export / send — between the closing
 * ("Mit freundlichen Grüßen") and the printed name.
 *
 * It is uploaded ONCE and shared across the whole workflow; it is NEVER
 * generated or invented and stays entirely optional (no signature → the
 * verified name line renders as usual).
 *
 * Presence + preview resolve against the owner's own session: GET streams the
 * stored image (200) or reports none (404). A nonce cache-buster re-arms the
 * preview after each upload/replace/remove (the route answers no-store).
 */

/** Client pre-check only — the server re-validates from magic bytes. */
const SIGNATURE_MAX_BYTES = 5 * 1024 * 1024;
const SIGNATURE_CLIENT_MIME = new Set(["image/png", "image/jpeg"]);
const SIGNATURE_ACCEPT = ".png,.jpg,.jpeg";

/** Same-origin, cookie-authenticated preview (private bucket, no public URL).
 *  `nonce` is the cache-buster — it changes on every upload/replace/remove, so
 *  a replaced signature can never render a stale cached image. */
const signaturePreviewUrl = (nonce: number) =>
  `/api/auto-bewerb/signature${nonce > 0 ? `?r=${nonce}` : ""}`;

export function SignatureUpload() {
  const { t } = useI18n();
  const addInput = useRef<HTMLInputElement>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  /** null = still determining whether the owner already has a signature. */
  const [has, setHas] = useState<boolean | null>(null);
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);

  // Presence check on mount: GET streams the image (200) or reports none (404).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(signaturePreviewUrl(0), { cache: "no-store" });
        if (!cancelled) setHas(res.status === 200);
      } catch {
        // A retrieval hiccup must never block the profile: degrade to "none".
        if (!cancelled) setHas(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onFile = async (file: File | undefined | null) => {
    if (!file) return;
    setError(null);
    setPreviewFailed(false);
    if (!SIGNATURE_CLIENT_MIME.has(file.type)) {
      setError(t("autoBewerb.signatureErrorType"));
      return;
    }
    if (file.size > SIGNATURE_MAX_BYTES) {
      setError(t("autoBewerb.signatureErrorSize"));
      return;
    }
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/auto-bewerb/signature", { method: "POST", body: fd });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? t("autoBewerb.signatureErrorUpload"));
      } else {
        setNonce((n) => n + 1); // fresh cache-buster → the preview re-arms
        setHas(true);
      }
    } catch {
      setError(t("autoBewerb.signatureErrorUpload"));
    } finally {
      setBusy(false);
      if (addInput.current) addInput.current.value = "";
      if (replaceInput.current) replaceInput.current.value = "";
    }
  };

  const onRemove = async () => {
    setRemoving(true);
    setError(null);
    try {
      const res = await fetch("/api/auto-bewerb/signature", { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? t("autoBewerb.signatureErrorRemove"));
        return;
      }
      setConfirmRemove(false);
      setNonce((n) => n + 1);
      setHas(false);
    } catch {
      setError(t("autoBewerb.signatureErrorRemove"));
    } finally {
      setRemoving(false);
    }
  };

  return (
    <SectionCard title={t("autoBewerb.signatureTitle")}>
      <input ref={addInput} type="file" accept={SIGNATURE_ACCEPT} className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} />
      <input ref={replaceInput} type="file" accept={SIGNATURE_ACCEPT} className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} />
      <p className="mb-4 text-sm leading-6 text-muted">{t("autoBewerb.signatureDesc")}</p>

      {has === null ? (
        <div className="flex items-center gap-2 text-sm text-muted">
          <Loader2 size={16} className="animate-spin" />
        </div>
      ) : has ? (
        <div className="flex items-start gap-4">
          {/* Preview — proportions preserved (object-contain on a white stage,
              since a signature is usually ink on a transparent/white field). */}
          <div className="flex h-32 w-48 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-line bg-white p-2">
            {previewFailed ? (
              <div className="flex flex-col items-center gap-2">
                <AlertTriangle size={18} className="text-danger" />
                <Button variant="secondary" size="sm" onClick={() => { setPreviewFailed(false); setNonce((n) => n + 1); }}>
                  <RefreshCw size={12} /> {t("autoBewerb.retry")}
                </Button>
              </div>
            ) : (
              // eslint-disable-next-line @next/next/no-img-element -- same-origin, cookie-authenticated preview of the owner's uploaded signature (no public URL; dynamic nonce cache-buster)
              <img
                key={nonce}
                src={signaturePreviewUrl(nonce)}
                alt={t("autoBewerb.signatureTitle")}
                onError={() => setPreviewFailed(true)}
                className="h-full w-full object-contain"
              />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-1.5 text-sm font-semibold text-success">
              <Check size={14} /> {t("autoBewerb.signaturePresent")}
            </p>
            <p className="mt-1 text-sm text-muted">{t("autoBewerb.signatureFormats")}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={() => replaceInput.current?.click()} disabled={busy}>
                <RefreshCw size={14} className={busy ? "animate-spin" : undefined} />
                {busy ? t("autoBewerb.signatureUploading") : t("autoBewerb.signatureReplace")}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmRemove(true)} disabled={busy || removing}>
                <Trash2 size={14} /> {t("autoBewerb.signatureRemove")}
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => addInput.current?.click()}
          disabled={busy}
          className="flex w-full flex-col items-center gap-3 rounded-3xl border-2 border-dashed border-line-strong bg-surface-2/50 px-6 py-10 text-center transition-colors hover:border-accent hover:bg-accent-soft/30 disabled:opacity-60"
        >
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-soft text-accent">
            {busy ? <Loader2 size={22} className="animate-spin" /> : <PenLine size={24} strokeWidth={1.6} />}
          </span>
          <span className="text-sm font-bold text-ink">
            {busy ? t("autoBewerb.signatureUploading") : t("autoBewerb.signatureUploadButton")}
          </span>
          <span className="text-xs text-muted">{t("autoBewerb.signatureFormats")}</span>
        </button>
      )}

      {error && (
        <div className="mt-3">
          <Note kind="error">{error}</Note>
        </div>
      )}

      <Modal open={confirmRemove} onClose={() => !removing && setConfirmRemove(false)} title={t("autoBewerb.signatureRemoveTitle")}>
        <p className="text-sm leading-6 text-muted">{t("autoBewerb.signatureRemoveBody")}</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setConfirmRemove(false)} disabled={removing}>
            {t("common.cancel")}
          </Button>
          <Button variant="secondary" className="border-danger/40 text-danger hover:bg-danger-soft" onClick={() => void onRemove()} disabled={removing}>
            <Trash2 size={14} /> {t("autoBewerb.signatureRemove")}
          </Button>
        </div>
      </Modal>
    </SectionCard>
  );
}
