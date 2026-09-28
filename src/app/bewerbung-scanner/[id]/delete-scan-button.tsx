"use client";

import { useEffect, useState } from "react";

/** Phase 16 — two-step confirmation for scan deletion (the scan's
 *  uploaded CVs and extracted profile are high-sensitivity data, so a
 *  misclick must be easy to abort). First click arms the button for
 *  five seconds; the second click submits the surrounding form, whose
 *  server action re-validates ownership and cascades. This component
 *  is UX only — no security decision is made in the browser. */
export function DeleteScanButton() {
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
          ? "rounded-xl bg-[#b3444e] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#9c3841]"
          : "rounded-xl border border-[#f0d9da] px-4 py-2.5 text-sm font-semibold text-[#c24c55] hover:bg-[#fff7f7]"
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
        ? "Confirm — delete scan, profile & uploaded files"
        : "Delete this scan"}
    </button>
  );
}
