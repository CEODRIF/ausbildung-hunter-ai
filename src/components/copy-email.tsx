"use client";

import { useState } from "react";
import { useI18n } from "@/lib/i18n";

/** Copies a real, displayed email address to the clipboard with transient
 *  "copied" feedback. Uses the async Clipboard API with a legacy
 *  execCommand fallback (insecure-context edge case). */
export function CopyEmailButton({ email }: { email: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    let ok = false;
    try {
      await navigator.clipboard.writeText(email);
      ok = true;
    } catch {
      try {
        const el = document.createElement("textarea");
        el.value = email;
        el.setAttribute("readonly", "");
        el.style.position = "fixed";
        el.style.opacity = "0";
        document.body.appendChild(el);
        el.select();
        ok = document.execCommand("copy");
        document.body.removeChild(el);
      } catch {
        ok = false;
      }
    }
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void copy()}
      className={`shrink-0 rounded-lg px-2.5 py-1 text-[11px] font-bold transition ${
        copied
          ? "bg-success-soft text-success"
          : "bg-surface text-accent hover:bg-accent-soft"
      }`}
      aria-label={t("account.emailCopy")}
    >
      {copied ? t("account.emailCopied") : t("account.emailCopy")}
    </button>
  );
}
