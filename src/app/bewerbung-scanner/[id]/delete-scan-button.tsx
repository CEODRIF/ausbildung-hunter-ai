"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";

/** Phase 16 — two-step confirmation for scan deletion (the scan's
 *  uploaded CVs and extracted profile are high-sensitivity data, so a
 *  misclick must be easy to abort). First click arms the button for
 *  five seconds; the second click submits the surrounding form, whose
 *  server action re-validates ownership and cascades. This component
 *  is UX only — no security decision is made in the browser. */
export function DeleteScanButton() {
  const { t } = useI18n();
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
      {armed ? t("profile.confirmDeleteScan") : t("profile.deleteScan")}
    </button>
  );
}
