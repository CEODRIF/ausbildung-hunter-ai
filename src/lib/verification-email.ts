import "server-only";

import { Resend } from "resend";

const APP_NAME = "Ausbildung Hunter AI";

/**
 * Transactional verification-code email (Resend).
 *
 * This is independent of the app's campaign "email" subsystem (IMAP/OAuth,
 * worker-driven): account verification is the one message the web process
 * sends directly, and only after `create_verification_code()` succeeded.
 *
 * Configuration (server-only, never exposed to the browser):
 *   RESEND_API_KEY     — Resend API key
 *   RESEND_FROM_EMAIL  — Resend-verified sender address
 *
 * Security rules:
 *  - The 6-digit code is used exactly as returned by
 *    `create_verification_code()`; the stored `code_hash` is never read or
 *    decoded.
 *  - Server logs record the destination and a scrubbed error, but never the
 *    API key, the sender address, or the code itself.
 *  - Every failure throws `VerificationEmailError`; callers must not report
 *    success when the email was not accepted by the provider.
 */
export class VerificationEmailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerificationEmailError";
  }
}

/** Scrub anything credential-like out of an error message before logging. */
function scrub(message: string): string {
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, "Bearer [redacted]")
    .replace(/x-api-key[=:]\s*[A-Za-z0-9._~-]+/gi, "x-api-key=[redacted]")
    .replace(/\b(?:re|resend)_[A-Za-z0-9]{8,}\b/g, "[redacted-key]")
    .replace(
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
      "[redacted-jwt]",
    );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Pure email content builder (unit-tested, no I/O). */
export function buildVerificationCodeEmail(code: string): {
  subject: string;
  html: string;
} {
  const safeCode = escapeHtml(code.trim());
  return {
    subject: `Your ${APP_NAME} verification code`,
    html: [
      "<!doctype html>",
      '<html><body style="margin:0;padding:0;background-color:#f4f6fb;">',
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f6fb;padding:32px 0;">',
      '<tr><td align="center">',
      '<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background-color:#ffffff;border-radius:12px;padding:32px;font-family:Arial,Helvetica,sans-serif;color:#1f2937;">',
      `<tr><td style="font-size:18px;font-weight:bold;">${APP_NAME}</td></tr>`,
      '<tr><td style="padding-top:16px;font-size:14px;line-height:20px;">Your verification code is</td></tr>',
      `<tr><td style="padding:16px 0;font-size:28px;font-weight:bold;letter-spacing:8px;text-align:center;">${safeCode}</td></tr>`,
      '<tr><td style="font-size:13px;line-height:20px;color:#4b5563;">This code is valid for 10 minutes. Do not share it with anyone — anyone with the code can activate your account.</td></tr>',
      '<tr><td style="padding-top:16px;font-size:12px;line-height:18px;color:#9aa7b8;">If you did not request this code, you can safely ignore this email.</td></tr>',
      "</table>",
      "</td></tr></table>",
      "</body></html>",
    ].join(""),
  };
}

/**
 * Send the verification-code email to a registered user.
 *
 * @throws {VerificationEmailError} when Resend is not configured, the
 *   provider rejects the message, or the send fails — callers must surface
 *   a "couldn't send, please try again" state, never a success state.
 */
export async function sendVerificationCodeEmail(params: {
  email: string;
  code: string;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.RESEND_FROM_EMAIL?.trim();
  if (!apiKey || !from) {
    console.error(
      "[verification-email] send failed: Resend is not configured (RESEND_API_KEY / RESEND_FROM_EMAIL missing)",
    );
    throw new VerificationEmailError("verification_email_not_configured");
  }
  const { subject, html } = buildVerificationCodeEmail(params.code);
  try {
    const resend = new Resend(apiKey);
    const { error } = await resend.emails.send({
      from,
      to: params.email,
      subject,
      html,
    });
    if (error) {
      console.error(
        `[verification-email] to="${params.email}" provider_error="${scrub(error.message)}"`,
      );
      throw new VerificationEmailError("verification_email_provider_rejected");
    }
  } catch (error) {
    if (error instanceof VerificationEmailError) throw error;
    console.error(
      `[verification-email] to="${params.email}" error="${scrub(
        error instanceof Error ? error.message : String(error),
      )}"`,
    );
    throw new VerificationEmailError("verification_email_send_failed");
  }
}
