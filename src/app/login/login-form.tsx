"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { AuthFeedback } from "@/components/auth-feedback";
import { Button, Input } from "@/components/ui";
import { login } from "@/app/login/actions";
import { useI18n } from "@/lib/i18n";

const initialState = { error: "" };

export function LoginForm() {
  const { t } = useI18n();
  const [state, formAction, pending] = useActionState(login, initialState);
  const [showPassword, setShowPassword] = useState(false);

  return (
    <>
      <form action={formAction} className="space-y-5">
        <Input
          id="email"
          name="email"
          type="email"
          label={t("auth.form.email")}
          placeholder="you@example.com"
          autoComplete="email"
          required
        />
        <div>
          <div className="mb-2 flex items-center justify-between">
            <label
              htmlFor="password"
              className="text-sm font-semibold text-ink-soft"
            >
              {t("auth.form.password")}
            </label>
            <button
              type="button"
              className="text-xs font-semibold text-accent hover:text-accent-deep"
            >
              {t("auth.form.forgotPassword")}
            </button>
          </div>
          <div className="relative">
            <Input
              id="password"
              name="password"
              type={showPassword ? "text" : "password"}
              placeholder={t("auth.form.passwordPlaceholder")}
              autoComplete="current-password"
              className="pr-20 rtl:pl-20 rtl:pr-4"
              required
            />
            <button
              type="button"
              onClick={() => setShowPassword((value) => !value)}
              className="absolute right-3.5 top-1/2 -translate-y-1/2 text-xs font-semibold text-muted hover:text-accent rtl:left-3.5 rtl:right-auto"
            >
              {showPassword
                ? t("auth.form.hide")
                : t("auth.form.show")}
            </button>
          </div>
        </div>
        <AuthFeedback state={state} />
        <Button type="submit" className="w-full" disabled={pending}>
          {pending ? (
            t("auth.form.signingIn")
          ) : (
            <>
              {t("auth.form.signIn")} <span>→</span>
            </>
          )}
        </Button>
      </form>
      <div className="my-7 flex items-center gap-3 text-xs text-faint">
        <span className="h-px flex-1 bg-line" />
        {t("auth.form.or")}
        <span className="h-px flex-1 bg-line" />
      </div>
      <Button variant="secondary" className="w-full" type="button" disabled>
        {t("auth.form.continueGoogle")}
      </Button>
      <p className="mt-8 text-center text-sm text-muted">
        {t("auth.form.newHere")}{" "}
        <Link
          href="/register"
          className="font-semibold text-accent hover:text-accent-deep"
        >
          {t("auth.form.createAccount")}
        </Link>
      </p>
      <p className="mt-10 text-center text-xs leading-5 text-faint">
        {t("auth.form.byContinuing")}
      </p>
    </>
  );
}
