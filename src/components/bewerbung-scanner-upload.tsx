"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Profile } from "@/lib/auth";

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
      setError("You can upload up to 10 documents per scan.");
      return;
    }
    setStatus("uploading");
    try {
      const uploaded: ScanFile[] = [];
      for (const file of incoming) {
        if (!allowed.includes(file.type) || file.size > 10 * 1024 * 1024)
          throw new Error(
            "Only PDF, DOC, DOCX, PNG, and JPG files up to 10 MB are supported.",
          );
        const form = new FormData();
        form.set("file", file);
        const response = await fetch("/api/bewerbung-scanner/files", {
          method: "POST",
          body: form,
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Upload failed.");
        uploaded.push(result);
      }
      setFiles((items) => [...items, ...uploaded]);
      setStatus("idle");
    } catch (uploadError) {
      setError(
        uploadError instanceof Error ? uploadError.message : "Upload failed.",
      );
      setStatus("error");
    }
  };
  const scan = async () => {
    if (!files.length) {
      setError("Upload at least one document first.");
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
      if (!response.ok) throw new Error(result.error || "Scan failed.");
      router.push(`/bewerbung-scanner/${result.scanId}`);
    } catch (scanError) {
      setError(scanError instanceof Error ? scanError.message : "Scan failed.");
      setStatus("error");
    }
  };
  return (
    <main className="min-h-screen bg-[#f6f8fb] px-5 py-8 sm:px-8 lg:px-10">
      <div className="mx-auto max-w-5xl">
        <p className="text-sm font-semibold text-[#2f6fed]">Career profile</p>
        <h1 className="mt-2 text-3xl font-bold tracking-[-0.04em] text-[#10203b]">
          Bewerbung Scanner
        </h1>
        <p className="mt-2 max-w-xl text-sm leading-6 text-[#71819a]">
          Upload your documents and build a structured profile for your next
          step in Germany.
        </p>
        <div className="mt-8 grid gap-5 lg:grid-cols-[0.7fr_1.3fr]">
          <section className="rounded-2xl border border-[#e7ecf3] bg-white p-5 sm:p-6">
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-[#8b9ab0]">
              What are you looking for?
            </p>
            <div className="mt-4 grid gap-3">
              <button
                type="button"
                onClick={() => setGoal("ausbildung")}
                className={`rounded-2xl border p-5 text-left ${goal === "ausbildung" ? "border-[#2f6fed] bg-[#f3f7ff]" : "border-[#e3e9f1]"}`}
              >
                <p className="font-bold text-[#1d3458]">Ausbildung</p>
                <p className="mt-1 text-xs text-[#8290a4]">
                  Build a profile for training opportunities.
                </p>
              </button>
              <button
                type="button"
                onClick={() => setGoal("arbeit")}
                className={`rounded-2xl border p-5 text-left ${goal === "arbeit" ? "border-[#2f6fed] bg-[#f3f7ff]" : "border-[#e3e9f1]"}`}
              >
                <p className="font-bold text-[#1d3458]">Arbeit</p>
                <p className="mt-1 text-xs text-[#8290a4]">
                  Build a profile for work opportunities.
                </p>
              </button>
            </div>
            <div className="mt-6 rounded-xl bg-[#f7f9fc] p-4 text-xs leading-5 text-[#8290a4]">
              Your selection applies only to this scan and will not change your
              global profile goal.
            </div>
          </section>
          <section className="rounded-2xl border border-[#e7ecf3] bg-white p-5 sm:p-6">
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
              className={`rounded-2xl border-2 border-dashed p-8 text-center transition ${dragging ? "border-[#2f6fed] bg-[#f3f7ff]" : "border-[#dfe6f0] bg-[#fbfcfe]"}`}
            >
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-[#edf3ff] text-xl text-[#2f6fed]">
                ↑
              </div>
              <h2 className="mt-4 font-bold text-[#1d3458]">
                Drop your documents here
              </h2>
              <p className="mt-2 text-xs text-[#8290a4]">
                PDF, DOC, DOCX, PNG, JPG · up to 10 files · 10 MB each
              </p>
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                className="mt-5 h-10 rounded-xl bg-[#10203b] px-4 text-xs font-semibold text-white"
              >
                Choose files
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
                    className="flex items-center justify-between rounded-xl border border-[#edf0f4] px-3 py-3"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-xs font-bold text-[#1d3458]">
                        {file.filename}
                      </p>
                      <p className="mt-1 text-[10px] text-[#8290a4]">
                        {file.mime_type} ·{" "}
                        {(file.size_bytes / 1024 / 1024).toFixed(1)} MB
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        setFiles((items) =>
                          items.filter((item) => item.id !== file.id),
                        )
                      }
                      className="text-xs font-semibold text-[#b3444e]"
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}
            {error && (
              <p className="mt-4 rounded-xl border border-[#f5d7da] bg-[#fff8f8] px-3.5 py-3 text-sm text-[#a3404b]">
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
              className="mt-6 h-12 w-full rounded-xl bg-[#2f6fed] text-sm font-semibold text-white hover:bg-[#255dcc] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {status === "uploading"
                ? "Uploading..."
                : status === "analyzing"
                  ? "Analyzing your application..."
                  : "Scan Bewerbung"}
            </button>
          </section>
        </div>
      </div>
    </main>
  );
}
