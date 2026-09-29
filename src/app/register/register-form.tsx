"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { AuthFeedback } from "@/components/auth-feedback";
import { Button, Input } from "@/components/ui";
import { register } from "@/app/register/actions";

export function RegisterForm() {
  const [state, formAction, pending] = useActionState(
    register,
    {} as { error?: string; success?: string },
  );
  const [showPassword, setShowPassword] = useState(false);

  // After a successful sign-up the form is replaced by the "check your
  // email" confirmation (no 6-digit code is requested).
  if (state.success)
    return (
      <div className="space-y-4">
        <AuthFeedback state={state} />
        <p className="text-sm leading-6 text-[#71819a]">
          The link activates your account and takes you straight to setup. If it
          doesn&apos;t arrive within a few minutes, check your spam folder or
          request another link from the{" "}
          <Link
            href="/verify"
            className="font-semibold text-[#2f6fed] hover:text-[#255dcc]"
          >
            verification page
          </Link>
          .
        </p>
        <Link
          href="/login"
          className="block text-center text-sm font-semibold text-[#2f6fed] hover:text-[#255dcc]"
        >
          Go to sign in
        </Link>
      </div>
    );

  return (
    <>
      <form action={formAction} className="space-y-4">
        <Input
          id="name"
          name="fullName"
          label="Full name"
          placeholder="Your full name"
          autoComplete="name"
          required
        />
        <Input
          id="email"
          name="email"
          type="email"
          label="Email address"
          placeholder="you@example.com"
          autoComplete="email"
          required
        />
        <div>
          <label
            htmlFor="password"
            className="mb-2 block text-sm font-semibold text-[#1d3458]"
          >
            Password
          </label>
          <div className="relative">
            <Input
              id="password"
              name="password"
              type={showPassword ? "text" : "password"}
              placeholder="Create a password"
              autoComplete="new-password"
              hint="Use at least 8 characters."
              className="pr-20"
              required
            />
            <button
              type="button"
              onClick={() => setShowPassword((value) => !value)}
              className="absolute right-3.5 top-1/2 -translate-y-1/2 text-xs font-semibold text-[#7d8da5] hover:text-[#2f6fed]"
            >
              {showPassword ? "Hide" : "Show"}
            </button>
          </div>
        </div>
        <Input
          id="invitationCode"
          name="invitationCode"
          label="Invitation code"
          placeholder="Enter your invitation code"
          autoComplete="off"
          className="uppercase tracking-[0.12em]"
          required
        />
        <label className="flex items-start gap-2.5 pt-1 text-xs leading-5 text-[#71819a]">
          <input
            name="terms"
            type="checkbox"
            className="mt-0.5 h-4 w-4 rounded border-[#cfd9e7] accent-[#2f6fed]"
            required
          />
          I agree to the Terms of Service and Privacy Policy.
        </label>
        <AuthFeedback state={state} />
        <Button type="submit" className="mt-2 w-full" disabled={pending}>
          {pending ? (
            "Creating workspace…"
          ) : (
            <>
              Create workspace <span>→</span>
            </>
          )}
        </Button>
      </form>
      <p className="mt-8 text-center text-sm text-[#71819a]">
        Already have an account?{" "}
        <Link
          href="/login"
          className="font-semibold text-[#2f6fed] hover:text-[#255dcc]"
        >
          Sign in
        </Link>
      </p>
    </>
  );
}
