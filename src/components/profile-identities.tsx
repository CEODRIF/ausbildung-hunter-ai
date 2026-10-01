"use client";

import { useState } from "react";
import { Icon } from "@/components/icon";
import { Button } from "@/components/ui";
import { useI18n } from "@/lib/i18n";
import { createClient } from "@/lib/supabase/client";

/**
 * Phase 19 — link a sign-in identity to the CURRENT account.
 *
 * Uses the official Supabase identity-linking flow (`auth.linkIdentity`), not
 * the email-account OAuth in /api/email/*, which connects a mailbox for
 * sending. linkIdentity attaches the provider identity to the signed-in user
 * — it never creates a second account — and returns to /auth/callback, which
 * exchanges the PKCE code for the (unchanged) session and forwards back here.
 *
 * The provider list must be enabled in Supabase → Authentication → Providers;
 * otherwise Supabase returns an error and the row shows the generic failure
 * message (never a raw provider payload).
 */

// Supabase identifies the Microsoft provider as `azure`; the label shown to
// the user stays "Microsoft".
const PROVIDERS: Array<{ id: "google" | "azure"; label: string }> = [
  { id: "google", label: "Google" },
  { id: "azure", label: "Microsoft" },
];

export function ProfileIdentities({ linked }: { linked: string[] }) {
  const { t } = useI18n();
  const [working, setWorking] = useState("");
  const [error, setError] = useState("");
  const linkedSet = new Set(linked.map((value) => value.toLowerCase()));

  async function connect(provider: "google" | "azure") {
    if (working) return;
    setWorking(provider);
    setError("");
    try {
      const supabase = createClient();
      const next = `/settings/profile?linked=${provider}`;
      const { error: linkError } = await supabase.auth.linkIdentity({
        provider,
        options: {
          redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
        },
      });
      // On success the browser navigates to the provider, so only a failure
      // needs local state.
      if (linkError) {
        console.error(`[profile] identity link failed: "${linkError.message}"`);
        setError(t("profileSettings.linkFailed"));
        setWorking("");
      }
    } catch {
      setError(t("profileSettings.linkFailed"));
      setWorking("");
    }
  }

  return (
    <div className="divide-y divide-line">
      {PROVIDERS.map((provider) => {
        const connected = linkedSet.has(provider.id);
        return (
          <div
            key={provider.id}
            className="flex flex-wrap items-center justify-between gap-3 py-4 first:pt-0 last:pb-0"
          >
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-surface-2 text-muted">
                <Icon name="lock" size={17} />
              </span>
              <div>
                <p className="text-sm font-bold text-ink-soft">
                  {provider.label}
                </p>
                <p
                  className={`text-xs font-semibold ${
                    connected ? "text-success" : "text-muted"
                  }`}
                >
                  {connected
                    ? t("profileSettings.connected")
                    : t("profileSettings.notConnected")}
                </p>
              </div>
            </div>
            {connected ? (
              <span className="flex items-center gap-1.5 text-sm font-semibold text-success">
                <Icon name="check" size={16} />
                {t("profileSettings.connected")}
              </span>
            ) : (
              <Button
                type="button"
                variant="secondary"
                onClick={() => connect(provider.id)}
                disabled={Boolean(working)}
              >
                {working === provider.id
                  ? t("profileSettings.connecting")
                  : t("profileSettings.connect")}
              </Button>
            )}
          </div>
        );
      })}
      {error && (
        <p
          role="alert"
          className="pt-4 text-sm font-medium text-danger"
        >
          {error}
        </p>
      )}
    </div>
  );
}
