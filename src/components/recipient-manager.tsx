"use client";

import { useRef, useState } from "react";
import type { RecipientStatus } from "@/lib/application-drafts";
import {
  normalizeRecipientEmail,
  parseRecipientInput,
} from "@/lib/email-recipients";

type Recipient = {
  email: string;
  companyName?: string;
  status: RecipientStatus;
};

/** Longest echo kept for a line that contained no address at all. */
const MAX_INVALID_ECHO = 64;

/**
 * Pasted list → clean addresses.
 *
 * Delegates to the shared recipient layer, so the paste path behaves exactly
 * like the file import and the server validator: a line such as
 * "melvin.loinette@windstream.net:Lake2018" yields
 * "melvin.loinette@windstream.net" and the trailing secret is dropped.
 */
export function normalizeEmails(value: string) {
  return parseRecipientInput(value).emails;
}

export function validateRecipients(
  rawEmails: string[],
  existing: Recipient[] = [],
) {
  const seen = new Set(existing.map((item) => item.email));
  const out: Recipient[] = [];
  for (const raw of rawEmails) {
    // Re-normalize: a value can still carry a suffix when this is called
    // directly (CSV path, send payload).
    const email = normalizeRecipientEmail(raw);
    if (!email) {
      // Nothing address-like on this line: keep a short echo so the user can
      // see which entry failed (it is never sent — the sender only queues
      // "valid" recipients — and it is never logged).
      out.push({ email: (raw ?? "").trim().slice(0, MAX_INVALID_ECHO), status: "invalid" });
      continue;
    }
    if (seen.has(email)) {
      out.push({ email, status: "duplicate" });
      continue;
    }
    seen.add(email);
    out.push({ email, status: "valid" });
  }
  return out;
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
      // Shared normalization: an "email:password" cell (or a TXT line) keeps
      // only the address; a cell without an address is skipped entirely.
      const cell = row[emailIndex >= 0 ? emailIndex : 0] ?? "";
      const email = normalizeRecipientEmail(cell);
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
          <h2 className="font-bold text-ink-soft">Recipients</h2>
          <p className="mt-1 text-xs text-muted">
            Add one or many email addresses.
          </p>
        </div>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="rounded-lg border border-line-strong px-3 py-2 text-xs font-bold text-accent hover:bg-surface-2"
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
      <div className="mt-4 rounded-xl border border-line-strong bg-surface p-3 focus-within:border-accent focus-within:ring-4 focus-within:ring-accent/10">
        <div className="flex flex-wrap gap-2">
          {recipients.map((recipient, index) => (
            <span
              key={`${recipient.email}-${index}`}
              className={`inline-flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs font-semibold ${recipient.status === "valid" ? "bg-success-soft text-success" : recipient.status === "invalid" ? "bg-danger-soft text-danger" : "bg-warning-soft text-warning"}`}
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
            className="min-w-48 flex-1 border-0 bg-transparent px-1 py-1 text-sm text-ink-soft outline-none placeholder:text-faint"
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
        <span className="rounded-md bg-surface-2 px-2 py-1 text-muted">
          Total {counts.total}
        </span>
        <span className="rounded-md bg-success-soft px-2 py-1 text-success">
          Valid {counts.valid}
        </span>
        <span className="rounded-md bg-danger-soft px-2 py-1 text-danger">
          Invalid {counts.invalid}
        </span>
        <span className="rounded-md bg-warning-soft px-2 py-1 text-warning">
          Duplicate {counts.duplicate}
        </span>
        {counts.invalid > 0 && (
          <button
            type="button"
            className="ml-auto text-danger hover:underline"
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
            className="text-warning hover:underline"
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
            className="text-muted hover:underline"
            onClick={() => onChange([])}
          >
            Clear all
          </button>
        )}
      </div>
    </section>
  );
}
