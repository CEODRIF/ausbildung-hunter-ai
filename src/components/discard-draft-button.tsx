"use client";

import { useEffect, useState } from "react";

/** Phase 16 — two-step confirmation for draft discard (recipients and
 *  attachments can contain sensitive personal data, so a misclick must
 *  be easy to abort). First click arms the button for five seconds; the
 *  second click submits the surrounding form, whose server action
 *  re-validates ownership and cascades. UX only — no security decision
 *  is made in the browser. */
export function DiscardDraftButton() {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), 5000);
    return () => window.clearTimeout(timer);
  }, [armed]);
  return (
    <button
      className={
        armed
          ? "rounded-xl bg-danger px-4 py-2.5 text-sm font-semibold text-white hover:bg-danger"
          : "rounded-xl border border-danger/25 px-4 py-2.5 text-sm font-semibold text-danger hover:bg-danger-soft"
      }
      type="submit"
      onClick={(event) => {
        if (!armed) {
          event.preventDefault();
          setArmed(true);
        }
      }}
    >
      {armed
        ? "Confirm — delete draft, recipients & attachments"
        : "Discard this draft"}
    </button>
  );
}
