"use client";

import { useActionState } from "react";
import { AuthFeedback } from "@/components/auth-feedback";
import { Button, Input } from "@/components/ui";
import {
  requestVerificationCode,
  submitVerificationCode,
} from "@/app/verify/actions";

const initialState = { error: "", success: "" };

export function VerifyForm() {
  const [state, verifyAction, verifying] = useActionState(
    submitVerificationCode,
    initialState,
  );
  const [requestState, requestAction, requesting] = useActionState(
    requestVerificationCode,
    initialState,
  );
  return (
    <>
      <form action={verifyAction} className="space-y-5">
        <Input
          id="code"
          name="code"
          label="Verification code"
          inputMode="numeric"
          pattern="[0-9]{6}"
          maxLength={6}
          placeholder="000000"
          autoComplete="one-time-code"
          required
        />
        <AuthFeedback state={state} />
        <Button type="submit" className="w-full" disabled={verifying}>
          {verifying ? (
            "Verifying…"
          ) : (
            <>
              Verify account <span>→</span>
            </>
          )}
        </Button>
      </form>
      <form action={requestAction} className="mt-4">
        <AuthFeedback state={requestState} />
        <Button
          type="submit"
          variant="secondary"
          className="w-full"
          disabled={requesting}
        >
          {requesting ? "Generating code…" : "Request a new code"}
        </Button>
      </form>
      <p className="mt-7 text-center text-xs leading-5 text-[#9aa7b8]">
        Codes expire after 10 minutes. Verification attempts are limited for
        your security.
      </p>
    </>
  );
}
