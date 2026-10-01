import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { decryptEmailToken, encryptEmailToken } from "@/lib/email-crypto";
import { createAdminClient } from "@/lib/supabase/admin";

export type ProviderAccount = {
  id: string;
  user_id: string;
  provider: "gmail" | "outlook";
  email: string;
  access_token_encrypted: string;
  refresh_token_encrypted: string | null;
  token_expires_at: string | null;
  requires_reconnect: boolean;
};
export type EmailAttachment = {
  filename: string;
  mimeType: string;
  content: Buffer;
};
export type SendEmailInput = {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments: EmailAttachment[];
};
export type SendEmailResult = { providerMessageId: string | null };
export type ProviderFailure = {
  code: string;
  message: string;
  temporary: boolean;
  reconnect: boolean;
  uncertain?: boolean;
};
export type EmailProvider = {
  sendEmail(input: Omit<SendEmailInput, "from">): Promise<SendEmailResult>;
};

function failure(
  code: string,
  message: string,
  temporary: boolean,
  reconnect = false,
): ProviderFailure {
  return { code, message, temporary, reconnect };
}
function isTokenFailure(status: number) {
  return status === 401 || status === 403;
}
function encodeBase64Url(value: string | Buffer) {
  return Buffer.from(value).toString("base64url");
}
function escapeHeader(value: string) {
  return value.replace(/[\r\n]/g, " ");
}

function buildMime(input: SendEmailInput) {
  const boundary = `mixed_${randomBytes(12).toString("hex")}`;
  const alternative = `alt_${randomBytes(12).toString("hex")}`;
  const lines = [
    `From: ${escapeHeader(input.from)}`,
    `To: ${escapeHeader(input.to)}`,
    `Subject: ${escapeHeader(input.subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    `Content-Type: multipart/alternative; boundary="${alternative}"`,
    "",
    `--${alternative}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    input.text,
    `--${alternative}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    input.html,
    `--${alternative}--`,
  ];
  for (const attachment of input.attachments)
    lines.push(
      `--${boundary}`,
      `Content-Type: ${attachment.mimeType}; name="${escapeHeader(attachment.filename)}"`,
      `Content-Disposition: attachment; filename="${escapeHeader(attachment.filename)}"`,
      "Content-Transfer-Encoding: base64",
      "",
      attachment.content
        .toString("base64")
        .match(/.{1,76}/g)
        ?.join("\r\n") ?? "",
    );
  lines.push(`--${boundary}--`);
  return lines.join("\r\n");
}

async function getProviderAccount(userId: string, accountId: string) {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("email_accounts")
    .select(
      "id, user_id, provider, email, access_token_encrypted, refresh_token_encrypted, token_expires_at, requires_reconnect",
    )
    .eq("id", accountId)
    .eq("user_id", userId)
    .eq("is_active", true)
    .single<ProviderAccount>();
  if (error || !data || data.requires_reconnect)
    throw failure(
      "reconnect_required",
      "Reconnect your email account before sending.",
      false,
      true,
    );
  return data;
}

async function markReconnect(
  userId: string,
  accountId: string,
  reason: string,
) {
  const admin = createAdminClient();
  await admin
    .from("email_accounts")
    .update({
      requires_reconnect: true,
      reconnect_reason: reason,
      is_active: false,
    })
    .eq("id", accountId)
    .eq("user_id", userId);
  await admin.from("activity_logs").insert({
    user_id: userId,
    activity_type: "provider_authorization_failure",
    title: "Email account requires reconnection",
    description: "Reconnect your email account before sending again.",
    metadata: { account_id: accountId, reason },
  });
}

async function refreshToken(account: ProviderAccount) {
  if (!account.refresh_token_encrypted) {
    await markReconnect(account.user_id, account.id, "refresh_token_missing");
    throw failure(
      "reconnect_required",
      "Reconnect your email account before sending.",
      false,
      true,
    );
  }
  const refreshTokenValue = decryptEmailToken(account.refresh_token_encrypted);
  const isGoogle = account.provider === "gmail";
  const clientId = isGoogle
    ? process.env.GOOGLE_CLIENT_ID
    : process.env.MICROSOFT_CLIENT_ID;
  const clientSecret = isGoogle
    ? process.env.GOOGLE_CLIENT_SECRET
    : process.env.MICROSOFT_CLIENT_SECRET;
  if (!clientId || !clientSecret)
    throw failure(
      "provider_not_configured",
      "Email provider is not configured.",
      false,
    );
  const response = await fetch(
    isGoogle
      ? "https://oauth2.googleapis.com/token"
      : "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshTokenValue,
        grant_type: "refresh_token",
        ...(isGoogle
          ? {}
          : {
              scope:
                "openid email offline_access https://graph.microsoft.com/Mail.Send",
            }),
      }),
      cache: "no-store",
    },
  );
  if (!response.ok) {
    logSend("token_refresh", "refresh_rejected", response.status);
    await markReconnect(account.user_id, account.id, "refresh_token_invalid");
    throw failure(
      "reconnect_required",
      "Reconnect your email account before sending.",
      false,
      true,
    );
  }
  const result = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!result.access_token) {
    await markReconnect(
      account.user_id,
      account.id,
      "refresh_response_invalid",
    );
    throw failure(
      "reconnect_required",
      "Reconnect your email account before sending.",
      false,
      true,
    );
  }
  const admin = createAdminClient();
  await admin
    .from("email_accounts")
    .update({
      access_token_encrypted: encryptEmailToken(result.access_token),
      refresh_token_encrypted: result.refresh_token
        ? encryptEmailToken(result.refresh_token)
        : account.refresh_token_encrypted,
      token_expires_at: result.expires_in
        ? new Date(Date.now() + result.expires_in * 1000).toISOString()
        : null,
      requires_reconnect: false,
      is_active: true,
    })
    .eq("id", account.id);
  return result.access_token;
}

async function accessTokenFor(account: ProviderAccount) {
  const expiresAt = account.token_expires_at
    ? Date.parse(account.token_expires_at)
    : Number.NaN;
  // Refresh when the expiry is missing/unknown or within 60 s of expiry — as
  // long as a refresh token exists. Sending a token we cannot vouch for is
  // what produced the Gmail 401 the user saw.
  const needsRefresh =
    !account.token_expires_at ||
    Number.isNaN(expiresAt) ||
    expiresAt < Date.now() + 60_000;
  if (needsRefresh && account.refresh_token_encrypted)
    return refreshToken(account);
  return decryptEmailToken(account.access_token_encrypted);
}

/**
 * Google's OWN error reason (safe codes only — never a token or a secret).
 * Gmail answers with { error: { status, errors: [{ reason }] } }, and the
 * reason is what separates "the permission was never granted" from "the
 * token expired" from "the API is not enabled" — the app used to collapse
 * all of them into one misleading "reconnect" message.
 */
async function gmailErrorReason(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as {
      error?: {
        status?: unknown;
        errors?: Array<{ reason?: unknown }>;
      };
    };
    const reason = body.error?.errors?.[0]?.reason;
    if (typeof reason === "string" && reason.length > 0) return reason;
    const status = body.error?.status;
    return typeof status === "string" && status.length > 0 ? status : null;
  } catch {
    return null;
  }
}

/** Safe diagnostic line: codes and stages only. */
function logSend(
  stage: string,
  reason: string,
  httpStatus: number | null,
): void {
  // Single readable line, codes only (never a token, code or secret).
  console.info(
    `[EMAIL_SEND] provider=gmail stage=${stage} reason=${reason} httpStatus=${
      httpStatus ?? "n/a"
    }`,
  );
}

/**
 * Classify a rejected Gmail send. Every branch carries a message the user can
 * act on — and only the branches that genuinely need a user action ask for a
 * reconnect.
 */
function gmailSendFailure(
  status: number,
  reason: string | null,
  hasRefreshToken: boolean,
): ProviderFailure {
  if (status === 401 || status === 403) {
    if (
      reason === "insufficientPermissions" ||
      reason === "insufficient_scope"
    )
      return failure(
        "gmail_scope_missing",
        "Gmail permission for sending was not granted. Reconnect the account to grant it.",
        false,
        true,
      );
    if (reason === "accessNotConfigured")
      return failure(
        "provider_not_configured",
        "The Gmail API is not enabled for this Google Cloud project.",
        false,
      );
    if (reason === "rateLimitExceeded" || reason === "userRateLimitExceeded")
      return failure(
        "provider_rate_limited",
        "Gmail quota or rate limit reached. It will be retried later.",
        true,
      );
    if (hasRefreshToken)
      // Recoverable: refresh and retry before bothering the user.
      return failure(
        "token_invalid",
        "Gmail rejected the access token; refreshing and retrying.",
        true,
      );
    return failure(
      "reconnect_required",
      "Gmail authentication expired. Reconnecting is required.",
      false,
      true,
    );
  }
  if (status === 429 || status >= 500)
    return failure(
      "provider_temporary",
      "Gmail is temporarily unavailable. It will be retried later.",
      true,
    );
  return failure(
    "provider_rejected",
    `Gmail rejected this message${reason ? ` (${reason})` : ""}.`,
    false,
  );
}

async function fetchAttachmentContents(
  userId: string,
  attachmentPaths: Array<{
    filename: string;
    mimeType: string;
    storagePath: string;
  }>,
) {
  const admin = createAdminClient();
  const results: EmailAttachment[] = [];
  for (const item of attachmentPaths) {
    const { data, error } = await admin.storage
      .from("application-attachments")
      .download(item.storagePath);
    if (error || !data)
      throw failure(
        "attachment_unavailable",
        "An attachment could not be retrieved.",
        false,
      );
    results.push({
      filename: item.filename,
      mimeType: item.mimeType,
      content: Buffer.from(await data.arrayBuffer()),
    });
  }
  return results;
}

export async function createEmailProvider(
  userId: string,
  accountId: string,
  attachmentPaths: Array<{
    filename: string;
    mimeType: string;
    storagePath: string;
  }>,
): Promise<EmailProvider> {
  const account = await getProviderAccount(userId, accountId);
  const attachments = await fetchAttachmentContents(userId, attachmentPaths);
  const send = async (input: Omit<SendEmailInput, "attachments" | "from">) => {
    try {
      const token = await accessTokenFor(account);
      return account.provider === "gmail"
        ? await sendGmail(token, { ...input, from: account.email, attachments }, Boolean(account.refresh_token_encrypted))
        : sendOutlook(token, { ...input, from: account.email, attachments });
    } catch (error) {
      const info = error as Partial<ProviderFailure>;
      // A rejected access token is recoverable while a refresh token exists:
      // refresh ONCE and resend instead of asking the user to reconnect.
      if (
        account.provider === "gmail" &&
        info.code === "token_invalid" &&
        account.refresh_token_encrypted
      ) {
        try {
          const fresh = await refreshToken(account);
          logSend("retry_after_refresh", "refreshed", null);
          return await sendGmail(
            fresh,
            { ...input, from: account.email, attachments },
            true,
          );
        } catch (retryError) {
          if ((retryError as Partial<ProviderFailure>).reconnect)
            await markReconnect(
              account.user_id,
              account.id,
              "provider_authorization_failure",
            );
          throw retryError;
        }
      }
      if (info.reconnect)
        await markReconnect(
          account.user_id,
          account.id,
          "provider_authorization_failure",
        );
      throw error;
    }
  };
  return { sendEmail: send };
}

async function sendGmail(
  token: string,
  input: SendEmailInput,
  hasRefresh: boolean,
): Promise<SendEmailResult> {
  const response = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ raw: encodeBase64Url(buildMime(input)) }),
      cache: "no-store",
    },
  );
  if (!response.ok) {
    const reason = await gmailErrorReason(response);
    const classified = gmailSendFailure(response.status, reason, hasRefresh);
    logSend("send", classified.code, response.status);
    throw classified;
  }
  const result = (await response.json()) as { id?: string };
  return { providerMessageId: result.id ?? null };
}

async function sendOutlook(
  token: string,
  input: SendEmailInput,
): Promise<SendEmailResult> {
  const body = {
    message: {
      subject: input.subject,
      body: { contentType: "HTML", content: input.html },
      toRecipients: [{ emailAddress: { address: input.to } }],
      attachments: input.attachments.map((attachment) => ({
        "@odata.type": "#microsoft.graph.fileAttachment",
        name: attachment.filename,
        contentType: attachment.mimeType,
        contentBytes: attachment.content.toString("base64"),
      })),
    },
    saveToSentItems: true,
  };
  const response = await fetch("https://graph.microsoft.com/v1.0/me/sendMail", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "Idempotency-Key": createHash("sha256")
        .update(`${input.from}:${input.to}:${input.subject}:${input.text}`)
        .digest("hex"),
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!response.ok) {
    const temporary = response.status === 429 || response.status >= 500;
    if (isTokenFailure(response.status))
      throw failure(
        "reconnect_required",
        "Reconnect your Outlook account before sending.",
        false,
        true,
      );
    if (temporary)
      throw failure(
        "provider_temporary",
        "Outlook is temporarily unavailable.",
        true,
      );
    throw failure("provider_rejected", "Outlook rejected this message.", false);
  }
  return { providerMessageId: response.headers.get("request-id") };
}

export { failure, fetchAttachmentContents };
