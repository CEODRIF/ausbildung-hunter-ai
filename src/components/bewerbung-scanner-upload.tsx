"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Profile } from "@/lib/auth";
import { useI18n } from "@/lib/i18n";

type Goal = "ausbildung" | "arbeit";
type ScanFile = {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
};
const allowed = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "image/png",
  "image/jpeg",
];

export function BewerbungScannerUpload({ profile }: { profile: Profile }) {
  const router = useRouter();
  const { t } = useI18n();
  const [goal, setGoal] = useState<Goal>(profile.selected_goal ?? "ausbildung");
  const [files, setFiles] = useState<ScanFile[]>([]);
  const [dragging, setDragging] = useState(false);
  const [status, setStatus] = useState<
    "idle" | "uploading" | "analyzing" | "error"
  >("idle");
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const addFiles = async (incoming: File[]) => {
    setError("");
    if (files.length + incoming.length > 10) {
      setError(t("account.scannerMaxFiles"));
      return;
    }
    setStatus("uploading");
    try {
      const uploaded: ScanFile[] = [];
      for (const file of incoming) {
        if (!allowed.includes(file.type) || file.size > 10 * 1024 * 1024)
          throw new Error(t("account.scannerFileTypes"));
        const form = new FormData();
        form.set("file", file);
        const response = await fetch("/api/bewerbung-scanner/files", {
          method: "POST",
          body: form,
        });
        const result = await response.json();
        if (!response.ok)
          throw new Error(result.error || t("account.scannerUploadFailed"));
        uploaded.push(result);
      }
      setFiles((items) => [...items, ...uploaded]);
      setStatus("idle");
    } catch (uploadError) {
      setError(
        uploadError instanceof Error
          ? uploadError.message
          : t("account.scannerUploadFailed"),
      );
      setStatus("error");
    }
  };
  const scan = async () => {
    if (!files.length) {
      setError(t("account.scannerUploadHint"));
      return;
    }
    setError("");
    setStatus("analyzing");
    try {
      const response = await fetch("/api/bewerbung-scanner/scan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ goal, files }),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error || t("account.scannerScanFailed"));
      router.push(`/bewerbung-scanner/${result.scanId}`);
    } catch (scanError) {
      setError(
        scanError instanceof Error
          ? scanError.message
          : t("account.scannerScanFailed"),
      );
      setStatus("error");
    }
  };
  return (
    <div className="px-4 py-6 sm:px-6 lg:px-10">
      <div className="mx-auto max-w-5xl">
        <p className="mt-2 max-w-xl text-sm leading-6 text-muted">
          {t("account.scannerIntro")}
        </p>
        <div className="mt-8 grid gap-5 lg:grid-cols-[0.7fr_1.3fr]">
          <section className="rounded-2xl border border-line bg-surface p-5 sm:p-6">
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-faint">
              {t("account.scannerGoalQuestion")}
            </p>
            <div className="mt-4 grid gap-3">
              <button
                type="button"
                onClick={() => setGoal("ausbildung")}
                className={`rounded-2xl border p-5 text-start ${goal === "ausbildung" ? "border-accent bg-accent-soft" : "border-line"}`}
              >
                <p className="font-bold text-ink-soft">
                  {t("dash.goalAusbildung")}
                </p>
                <p className="mt-1 text-xs text-muted">
                  {t("account.scannerGoalAusbildungBody")}
                </p>
              </button>
              <button
                type="button"
                onClick={() => setGoal("arbeit")}
                className={`rounded-2xl border p-5 text-start ${goal === "arbeit" ? "border-accent bg-accent-soft" : "border-line"}`}
              >
                <p className="font-bold text-ink-soft">
                  {t("dash.goalArbeit")}
                </p>
                <p className="mt-1 text-xs text-muted">
                  {t("account.scannerGoalArbeitBody")}
                </p>
              </button>
            </div>
            <div className="mt-6 rounded-xl bg-surface-2 p-4 text-xs leading-5 text-muted">
              {t("account.scannerGoalNote")}
            </div>
          </section>
          <section className="rounded-2xl border border-line bg-surface p-5 sm:p-6">
            <div
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragging(false);
                void addFiles(Array.from(event.dataTransfer.files));
              }}
              className={`rounded-2xl border-2 border-dashed p-8 text-center transition ${dragging ? "border-accent bg-accent-soft" : "border-line-strong bg-surface-2"}`}
            >
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-soft text-xl text-accent">
                ↑
              </div>
              <h2 className="mt-4 font-bold text-ink-soft">
                {t("account.scannerDropTitle")}
              </h2>
              <p className="mt-2 text-xs text-muted">
                {t("account.scannerDropHint")}
              </p>
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                className="mt-5 h-10 rounded-xl bg-navy px-4 text-xs font-semibold text-white"
              >
                {t("account.scannerChooseFiles")}
              </button>
              <input
                ref={inputRef}
                className="hidden"
                type="file"
                multiple
                accept=".pdf,.doc,.docx,.png,.jpg,.jpeg"
                onChange={(event) => {
                  void addFiles(Array.from(event.target.files ?? []));
                  event.target.value = "";
                }}
              />
            </div>
            {files.length > 0 && (
              <div className="mt-5 space-y-2">
                {files.map((file) => (
                  <div
                    key={file.id}
                    className="flex items-center justify-between rounded-xl border border-line px-3 py-3"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-xs font-bold text-ink-soft">
                        {file.filename}
                      </p>
                      <p className="mt-1 text-[10px] text-muted">
                        {file.mime_type} ·{" "}
                        {(file.size_bytes / 1024 / 1024).toFixed(1)} MB
                      </p>
                    </div>
                    <button
                      type="button"
                      aria-label={t("account.scannerRemove")}
                      onClick={() =>
                        setFiles((items) =>
                          items.filter((item) => item.id !== file.id),
                        )
                      }
                      className="text-xs font-semibold text-danger"
                    >
                      {t("account.scannerRemove")}
                    </button>
                  </div>
                ))}
              </div>
            )}
            {error && (
              <p className="mt-4 rounded-xl border border-danger/25 bg-danger-soft px-3.5 py-3 text-sm text-danger">
                {error}
              </p>
            )}
            <button
              type="button"
              onClick={() => void scan()}
              disabled={
                status === "uploading" ||
                status === "analyzing" ||
                !files.length
              }
              className="mt-6 h-12 w-full rounded-xl bg-accent text-sm font-semibold text-white hover:bg-accent-deep disabled:cursor-not-allowed disabled:opacity-50"
            >
              {status === "uploading"
                ? t("account.scannerUploading")
                : status === "analyzing"
                  ? t("account.scannerAnalyzing")
                  : t("account.scannerStart")}
            </button>
          </section>
        </div>
      </div>
    </div>
  );
}
