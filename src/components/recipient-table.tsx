"use client";

import { resolveCompanyName } from "@/lib/personalization";

type Recipient = {
  email: string;
  companyName?: string;
  contactName?: string;
  status: "valid" | "invalid" | "duplicate";
};

/**
 * One editable column per personalization source:
 *
 *  - Company: the user's OVERRIDE. Empty = the name is inferred from the
 *    email domain when the campaign is sent (the inferred value is shown
 *    as a placeholder so the user sees what would happen and can correct
 *    it). Free-mail domains infer nothing (the personalization fallback
 *    applies) — that is why the placeholder is "—" there.
 *  - Contact: an explicitly provided person's name (the only trusted
 *    source for the personalized greeting). Leave empty for the general
 *    formal greeting. "Herr …" / "Frau …" enables the personalized one.
 */
const GRID =
  "grid grid-cols-[minmax(0,1fr)_minmax(84px,0.6fr)_minmax(84px,0.6fr)_72px_40px] items-center gap-2 px-3 py-3 text-xs";

const INPUT_CLASS =
  "w-full min-w-0 rounded-md bg-transparent px-1.5 py-1 text-xs text-ink-soft outline-none placeholder:text-faint focus:bg-accent-soft focus:text-accent-deep";

export function RecipientTable({
  recipients,
  onChange,
}: {
  recipients: Recipient[];
  onChange: (recipients: Recipient[]) => void;
}) {
  if (!recipients.length) return null;
  const update = (index: number, patch: Partial<Recipient>) =>
    onChange(
      recipients.map((item, itemIndex) =>
        itemIndex === index ? { ...item, ...patch } : item,
      ),
    );
  return (
    <div className="mt-5 overflow-hidden rounded-xl border border-line bg-surface">
      <div className={`${GRID} border-b border-line bg-surface-2 py-2.5 text-[10px] font-bold uppercase tracking-[0.08em] text-faint`}>
        <span>Email</span>
        <span>Company</span>
        <span>Contact</span>
        <span>Status</span>
        <span />
      </div>
      <div className="divide-y divide-line">
        {recipients.map((recipient, index) => {
          const inferred =
            recipient.status === "valid"
              ? resolveCompanyName(recipient.email).value
              : null;
          return (
            <div
              key={`${recipient.email}-${index}`}
              className={GRID}
            >
              <span className="min-w-0 truncate font-semibold text-ink-soft">
                {recipient.email}
              </span>
              <input
                aria-label={`Company for ${recipient.email}`}
                value={recipient.companyName ?? ""}
                placeholder={inferred ?? "—"}
                onChange={(event) =>
                  update(index, { companyName: event.target.value })
                }
                className={INPUT_CLASS}
              />
              <input
                aria-label={`Contact person for ${recipient.email}`}
                value={recipient.contactName ?? ""}
                placeholder="—"
                onChange={(event) =>
                  update(index, { contactName: event.target.value })
                }
                className={INPUT_CLASS}
              />
              <span
                className={`font-semibold ${recipient.status === "valid" ? "text-success" : recipient.status === "invalid" ? "text-danger" : "text-warning"}`}
              >
                {recipient.status[0].toUpperCase() + recipient.status.slice(1)}
              </span>
              <button
                type="button"
                aria-label={`Remove ${recipient.email}`}
                className="text-lg leading-none text-faint hover:text-danger"
                onClick={() =>
                  onChange(
                    recipients.filter(
                      (_, itemIndex) => itemIndex !== index,
                    ),
                  )
                }
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
