"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { AuthFeedback } from "@/components/auth-feedback";
import { Button, Input } from "@/components/ui";
import { login } from "@/app/login/actions";

const initialState = { error: "" };

export function LoginForm() {
  const [state, formAction, pending] = useActionState(login, initialState);
  const [showPassword, setShowPassword] = useState(false);

  return (
    <>
      <form action={formAction} className="space-y-5">
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
          <div className="mb-2 flex items-center justify-between">
            <label
              htmlFor="password"
              className="text-sm font-semibold text-[#1d3458]"
            >
              Password
            </label>
            <button
              type="button"
              className="text-xs font-semibold text-[#2f6fed] hover:text-[#255dcc]"
            >
              Forgot password?
            </button>
          </div>
          <div className="relative">
            <Input
              id="password"
              name="password"
              type={showPassword ? "text" : "password"}
              placeholder="Enter your password"
              autoComplete="current-password"
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
        <AuthFeedback state={state} />
        <Button type="submit" className="w-full" disabled={pending}>
          {pending ? (
            "Signing in…"
          ) : (
            <>
              Sign in <span>→</span>
            </>
          )}
        </Button>
      </form>
      <div className="my-7 flex items-center gap-3 text-xs text-[#a1adbd]">
        <span className="h-px flex-1 bg-[#e8edf3]" />
        or
        <span className="h-px flex-1 bg-[#e8edf3]" />
      </div>
      <Button variant="secondary" className="w-full" type="button" disabled>
        Continue with Google
      </Button>
      <p className="mt-8 text-center text-sm text-[#71819a]">
        New to Ausbildung Hunter AI?{" "}
        <Link
          href="/register"
          className="font-semibold text-[#2f6fed] hover:text-[#255dcc]"
        >
          Create an account
        </Link>
      </p>
      <p className="mt-10 text-center text-xs leading-5 text-[#9aa7b8]">
        By continuing, you agree to our Terms of Service and Privacy Policy.
      </p>
    </>
  );
}
