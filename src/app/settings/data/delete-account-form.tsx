"use client";

import { useState, type FormEvent } from "react";

/** Phase 11 — typed-email confirmation for account deletion. The server
 *  re-validates the email against the session profile; this form only
 *  guards the UX. */
export function DeleteAccountForm({ email }: { email: string }) {
  const [confirmEmail, setConfirmEmail] = useState("");
  const [working, setWorking] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  const matches =
    confirmEmail.trim().toLowerCase() === email.trim().toLowerCase();

  async function onDelete(event: FormEvent) {
    event.preventDefault();
    if (working) return;
    setWorking(true);
    setError("");
    try {
      const response = await fetch("/api/account/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmEmail }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        setError(body.error ?? "Deletion failed. Please try again.");
        setWorking(false);
        return;
      }
      setDone(true);
    } catch {
      setError("Network error — your account was not deleted. Please retry.");
      setWorking(false);
    }
  }

  if (done)
    return (
      <div className="mt-5 rounded-xl border border-[#ccefe1] bg-[#f3fcf8] px-4 py-3 text-sm font-medium text-[#187e5b]">
        Your account and all related data have been permanently deleted. You can
        close this tab now.
      </div>
    );

  return (
    <>
      <form
        onSubmit={onDelete}
        className="mt-5 flex flex-col gap-3 sm:flex-row"
      >
        <input
          type="email"
          required
          value={confirmEmail}
          onChange={(event) => {
            setConfirmEmail(event.target.value);
            if (error) setError("");
          }}
          placeholder={email}
          aria-label="Type your account email to confirm deletion"
          className="h-11 flex-1 rounded-xl border border-[#dfe6f0] bg-white px-3.5 text-sm outline-none focus:border-[#b3444e]"
        />
        <button
          type="submit"
          disabled={working || !matches}
          className="h-11 rounded-xl bg-[#b3444e] px-5 text-sm font-semibold text-white hover:bg-[#9c3841] disabled:opacity-50"
        >
          {working ? "Deleting…" : "Permanently delete account"}
        </button>
      </form>
      {error && (
        <p className="mt-3 text-sm font-medium text-[#a3404b]">{error}</p>
      )}
      <p className="mt-3 text-xs text-[#8290a4]">
        Type <span className="font-semibold text-[#1d3458]">{email}</span> to
        enable deletion.
      </p>
    </>
  );
}
