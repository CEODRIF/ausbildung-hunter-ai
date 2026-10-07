"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { updateCommunityIdentity } from "@/app/community/actions";
import { useI18n } from "@/lib/i18n";

/**
 * The platform admin's Community display name. The validation EXCEPTION
 * lives in the SERVER ACTION (updateCommunityIdentity → requirePlatformAdmin
 * bypass of the strict username regex) — this form is a plain input; what
 * the client allows or blocks is cosmetic, never security.
 */
export function AdminIdentityForm({ currentName }: { currentName: string }) {
  const { t } = useI18n();
  const router = useRouter();
  const [name, setName] = useState(currentName);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<"ok" | "error" | null>(null);

  const submit = async () => {
    const trimmed = name.trim();
    if (busy || trimmed.length === 0 || trimmed.length > 40) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await updateCommunityIdentity({ displayName: trimmed });
      if (res.ok) {
        setResult("ok");
        router.refresh();
      } else {
        setResult("error");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4">
      <label className="block text-xs font-semibold uppercase tracking-[0.08em] text-faint">
        {t("admin.nameLabel")}
      </label>
      <div className="mt-2 flex flex-wrap gap-2">
        <input
          type="text"
          value={name}
          maxLength={40}
          onChange={(e) => {
            setName(e.target.value);
            setResult(null);
          }}
          placeholder={t("admin.namePlaceholder")}
          aria-label={t("admin.nameLabel")}
          className="w-64 rounded-xl border border-line-strong bg-surface px-3 py-2 text-sm"
        />
        <button
          type="button"
          onClick={submit}
          disabled={busy}
          className="rounded-xl bg-accent px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
        >
          {t("admin.saveName")}
        </button>
      </div>
      <p className="mt-2 text-xs text-muted">{t("admin.nameRules")}</p>
      {result === "ok" && (
        <p className="mt-2 text-sm font-semibold text-success">
          {t("admin.nameSaved")}
        </p>
      )}
      {result === "error" && (
        <p className="mt-2 text-sm font-semibold text-danger">
          {t("admin.nameSaveFailed")}
        </p>
      )}
    </div>
  );
}
