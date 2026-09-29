"use client";

import { useActionState } from "react";
import { AuthFeedback } from "@/components/auth-feedback";
import { Button, Input } from "@/components/ui";
import { resendVerificationEmail } from "@/app/verify/actions";

export function ResendForm() {
  const [state, formAction, pending] = useActionState(
    resendVerificationEmail,
    {} as { error?: string; success?: string },
  );

  return (
    <form action={formAction} className="space-y-3">
      <Input
        id="resend-email"
        name="email"
        label="Email address"
        type="email"
        placeholder="you@example.com"
        autoComplete="email"
        required
      />
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Sending…" : "Request another verification link"}
      </Button>
      <AuthFeedback state={state} />
    </form>
  );
}
