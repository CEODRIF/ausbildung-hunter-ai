"use client";

import { useRef, useState } from "react";
import type { RecipientStatus } from "@/lib/application-drafts";

type Recipient = {
  email: string;
  companyName?: string;
  status: RecipientStatus;
};
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;

export function normalizeEmails(value: string) {
  return value
    .split(/[\s,;]+/)
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}
export function validateRecipients(
  rawEmails: string[],
  existing: Recipient[] = [],
) {
  const seen = new Set(existing.map((item) => item.email));
  return rawEmails.map((email) => {
    if (!emailPattern.test(email)) return { email, status: "invalid" as const };
    if (seen.has(email)) return { email, status: "duplicate" as const };
    seen.add(email);
    return { email, status: "valid" as const };
  });
}

export function RecipientManager({
  recipients,
  onChange,
}: {
  recipients: Recipient[];
  onChange: (recipients: Recipient[]) => void;
}) {
  const [value, setValue] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const add = (raw: string) => {
    const incoming = validateRecipients(normalizeEmails(raw), recipients);
    if (incoming.length) onChange([...recipients, ...incoming]);
    setValue("");
  };
  const importFile = async (file: File) => {
    const text = await file.text();
    const lines = text.split(/\r?\n/).filter(Boolean);
    const rows = lines.map((line) =>
      line.split(",").map((cell) => cell.trim()),
    );
    const header = rows[0]?.map((cell) => cell.toLowerCase());
    const emailIndex =
      header?.findIndex((cell) => cell === "email" || cell.includes("email")) ??
      -1;
    const dataRows = emailIndex >= 0 ? rows.slice(1) : rows;
    const imported = dataRows.flatMap((row) => {
      const email = row[emailIndex >= 0 ? emailIndex : 0];
      const companyName = emailIndex > 0 ? row[0] : undefined;
      return email ? [{ email, companyName }] : [];
    });
    const validated = validateRecipients(
      imported.map((item) => item.email),
      recipients,
    ).map((item, index) => ({
      ...item,
      companyName: imported[index]?.companyName,
    }));
    onChange([...recipients, ...validated]);
  };
  const counts = {
    total: recipients.length,
    valid: recipients.filter((item) => item.status === "valid").length,
    invalid: recipients.filter((item) => item.status === "invalid").length,
    duplicate: recipients.filter((item) => item.status === "duplicate").length,
  };
  return (
    <section>
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-bold text-[#1d3458]">Recipients</h2>
          <p className="mt-1 text-xs text-[#8290a4]">
            Add one or many email addresses.
          </p>
        </div>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="rounded-lg border border-[#dbe3ef] px-3 py-2 text-xs font-bold text-[#2f6fed] hover:bg-[#f5f8ff]"
        >
          Import CSV/TXT
        </button>
        <input
          ref={fileRef}
          className="hidden"
          type="file"
          accept=".csv,.txt,text/csv,text/plain"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void importFile(file);
            event.target.value = "";
          }}
        />
      </div>
      <div className="mt-4 rounded-xl border border-[#dfe6f0] bg-white p-3 focus-within:border-[#2f6fed] focus-within:ring-4 focus-within:ring-[#2f6fed]/10">
        <div className="flex flex-wrap gap-2">
          {recipients.map((recipient, index) => (
            <span
              key={`${recipient.email}-${index}`}
              className={`inline-flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs font-semibold ${recipient.status === "valid" ? "bg-[#eaf8f3] text-[#187e5b]" : recipient.status === "invalid" ? "bg-[#fff0f0] text-[#b3444e]" : "bg-[#fff5df] text-[#a56a1e]"}`}
            >
              {recipient.email}
              <button
                type="button"
                aria-label={`Remove ${recipient.email}`}
                onClick={() =>
                  onChange(
                    recipients.filter((_, itemIndex) => itemIndex !== index),
                  )
                }
              >
                ×
              </button>
            </span>
          ))}
          <input
            className="min-w-48 flex-1 border-0 bg-transparent px-1 py-1 text-sm text-[#1d3458] outline-none placeholder:text-[#a0adbd]"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onPaste={(event) => {
              const pasted = event.clipboardData.getData("text");
              if (normalizeEmails(pasted).length > 1) {
                event.preventDefault();
                add(pasted);
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === ",") {
                event.preventDefault();
                add(value);
              }
            }}
            placeholder="Type an email and press Enter"
          />
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2 text-[11px] font-semibold">
        <span className="rounded-md bg-[#f1f4f8] px-2 py-1 text-[#71819a]">
          Total {counts.total}
        </span>
        <span className="rounded-md bg-[#eaf8f3] px-2 py-1 text-[#187e5b]">
          Valid {counts.valid}
        </span>
        <span className="rounded-md bg-[#fff0f0] px-2 py-1 text-[#b3444e]">
          Invalid {counts.invalid}
        </span>
        <span className="rounded-md bg-[#fff5df] px-2 py-1 text-[#a56a1e]">
          Duplicate {counts.duplicate}
        </span>
        {counts.invalid > 0 && (
          <button
            type="button"
            className="ml-auto text-[#b3444e] hover:underline"
            onClick={() =>
              onChange(recipients.filter((item) => item.status !== "invalid"))
            }
          >
            Remove invalid
          </button>
        )}
        {counts.duplicate > 0 && (
          <button
            type="button"
            className="text-[#a56a1e] hover:underline"
            onClick={() =>
              onChange(recipients.filter((item) => item.status !== "duplicate"))
            }
          >
            Remove duplicates
          </button>
        )}
        {counts.total > 0 && (
          <button
            type="button"
            className="text-[#71819a] hover:underline"
            onClick={() => onChange([])}
          >
            Clear all
          </button>
        )}
      </div>
    </section>
  );
}
