"use client";

type Recipient = {
  email: string;
  companyName?: string;
  status: "valid" | "invalid" | "duplicate";
};

export function RecipientTable({
  recipients,
  onChange,
}: {
  recipients: Recipient[];
  onChange: (recipients: Recipient[]) => void;
}) {
  if (!recipients.length) return null;
  return (
    <div className="mt-5 overflow-hidden rounded-xl border border-line bg-surface">
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(90px,0.55fr)_80px_42px] gap-3 border-b border-line bg-surface-2 px-3 py-2.5 text-[10px] font-bold uppercase tracking-[0.08em] text-faint">
        <span>Email</span>
        <span>Company</span>
        <span>Status</span>
        <span />
      </div>
      <div className="divide-y divide-line">
        {recipients.map((recipient, index) => (
          <div
            key={`${recipient.email}-${index}`}
            className="grid grid-cols-[minmax(0,1fr)_minmax(90px,0.55fr)_80px_42px] items-center gap-3 px-3 py-3 text-xs"
          >
            <span className="min-w-0 truncate font-semibold text-ink-soft">
              {recipient.email}
            </span>
            <span className="truncate text-muted">
              {recipient.companyName || "—"}
            </span>
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
                  recipients.filter((_, itemIndex) => itemIndex !== index),
                )
              }
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
