"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { AuthFeedback } from "@/components/auth-feedback";
import { Button, Input } from "@/components/ui";
import { register } from "@/app/register/actions";
import { useI18n } from "@/lib/i18n";

export function RegisterForm() {
  const { t } = useI18n();
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
        <p className="text-sm leading-6 text-muted">
          {t("auth.form.checkEmailBefore")}{" "}
          <Link
            href="/verify"
            className="font-semibold text-accent hover:text-accent-deep"
          >
            {t("auth.form.checkEmailLink")}
          </Link>{" "}
          {t("auth.form.checkEmailAfter")}
        </p>
        <Link
          href="/login"
          className="block text-center text-sm font-semibold text-accent hover:text-accent-deep"
        >
          {t("auth.form.goSignIn")}
        </Link>
      </div>
    );

  return (
    <>
      <form action={formAction} className="space-y-4">
        <Input
          id="name"
          name="fullName"
          label={t("auth.form.fullName")}
          placeholder={t("auth.form.fullNamePlaceholder")}
          autoComplete="name"
          required
        />
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
          <label
            htmlFor="password"
            className="mb-2 block text-sm font-semibold text-ink-soft"
          >
            {t("auth.form.password")}
          </label>
          <div className="relative">
            <Input
              id="password"
              name="password"
              type={showPassword ? "text" : "password"}
              placeholder={t("auth.form.createPassword")}
              autoComplete="new-password"
              hint={t("auth.form.passwordHint")}
              className="pr-20"
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
        <Input
          id="invitationCode"
          name="invitationCode"
          label={t("auth.form.invitationCode")}
          placeholder={t("auth.form.invitationPlaceholder")}
          autoComplete="off"
          className="uppercase tracking-[0.12em]"
          required
        />
        <label className="flex items-start gap-2.5 pt-1 text-xs leading-5 text-muted">
          <input
            name="terms"
            type="checkbox"
            className="mt-0.5 h-4 w-4 rounded border-line-strong accent-accent"
            required
          />
          {t("auth.form.terms")}
        </label>
        <AuthFeedback state={state} />
        <Button type="submit" className="mt-2 w-full" disabled={pending}>
          {pending ? (
            t("auth.form.creatingWorkspace")
          ) : (
            <>
              {t("auth.form.createWorkspace")} <span>→</span>
            </>
          )}
        </Button>
      </form>
      <p className="mt-8 text-center text-sm text-muted">
        {t("auth.form.haveAccount")}{" "}
        <Link
          href="/login"
          className="font-semibold text-accent hover:text-accent-deep"
        >
          {t("auth.form.signIn")}
        </Link>
      </p>
    </>
  );
}
