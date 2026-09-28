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
    <div className="mt-5 overflow-hidden rounded-xl border border-[#e7ecf3] bg-white">
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(90px,0.55fr)_80px_42px] gap-3 border-b border-[#edf0f4] bg-[#fbfcfe] px-3 py-2.5 text-[10px] font-bold uppercase tracking-[0.08em] text-[#9aa7b8]">
        <span>Email</span>
        <span>Company</span>
        <span>Status</span>
        <span />
      </div>
      <div className="divide-y divide-[#edf0f4]">
        {recipients.map((recipient, index) => (
          <div
            key={`${recipient.email}-${index}`}
            className="grid grid-cols-[minmax(0,1fr)_minmax(90px,0.55fr)_80px_42px] items-center gap-3 px-3 py-3 text-xs"
          >
            <span className="min-w-0 truncate font-semibold text-[#1d3458]">
              {recipient.email}
            </span>
            <span className="truncate text-[#8290a4]">
              {recipient.companyName || "—"}
            </span>
            <span
              className={`font-semibold ${recipient.status === "valid" ? "text-[#1b9b70]" : recipient.status === "invalid" ? "text-[#b3444e]" : "text-[#a56a1e]"}`}
            >
              {recipient.status[0].toUpperCase() + recipient.status.slice(1)}
            </span>
            <button
              type="button"
              aria-label={`Remove ${recipient.email}`}
              className="text-lg leading-none text-[#9aa7b8] hover:text-[#b3444e]"
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
