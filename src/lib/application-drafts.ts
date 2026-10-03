import "server-only";

import sanitizeHtml from "sanitize-html";
import { randomUUID } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { listEmailAccounts, type SafeEmailAccount } from "@/lib/email-oauth";
import type { Profile } from "@/lib/auth";

export type ApplicationGoal = "ausbildung" | "arbeit";
export type RecipientStatus = "valid" | "invalid" | "duplicate";
export type DraftRecipient = {
  id: string;
  email: string;
  company_name: string | null;
  validation_status: RecipientStatus;
};
export type DraftAttachment = {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  storage_path: string;
};
export type ApplicationDraft = {
  id: string;
  user_id: string;
  goal: ApplicationGoal;
  sender_email_account_id: string;
  subject: string;
  body_html: string;
  body_text: string;
  created_at: string;
  updated_at: string;
  /** Opportunity this draft was pre-filled from (server-derived snapshot;
   *  null for normal drafts). Context/display only — subject, body and
   *  recipients stay fully user-editable. */
  opportunity_key: string | null;
  opportunity_title: string | null;
  opportunity_company: string | null;
  opportunity_source_url: string | null;
  recipients: DraftRecipient[];
  attachments: DraftAttachment[];
};

export const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;
export const ALLOWED_ATTACHMENT_TYPES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "image/png",
  "image/jpeg",
]);

export function sanitizeEmailHtml(html: string) {
  return sanitizeHtml(html, {
    allowedTags: [
      "p",
      "br",
      "strong",
      "b",
      "em",
      "i",
      "u",
      "ul",
      "ol",
      "li",
      "a",
      "div",
      "span",
      "font",
    ],
    allowedAttributes: {
      a: ["href", "target", "rel"],
      span: ["style"],
      font: ["color", "size"],
    },
    allowedStyles: {
      span: {
        color: [/^#[0-9a-f]{3,8}$/i, /^rgb\(/i],
        "background-color": [/^#[0-9a-f]{3,8}$/i, /^rgb\(/i],
        "text-align": [/^(left|center|right|justify)$/],
      },
    },
    allowedSchemes: ["http", "https", "mailto"],
    transformTags: {
      a: (_tag, attribs) => ({
        tagName: "a",
        attribs: { ...attribs, target: "_blank", rel: "noopener noreferrer" },
      }),
    },
  });
}

export function htmlToText(html: string) {
  return sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} })
    .replace(/\s+/g, " ")
    .trim();
}

export async function getApplicationComposerData() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single<Profile>();
  if (!profile || profile.account_status !== "active") return null;
  const accounts = await listEmailAccounts(user.id);
  if (!accounts.length)
    return {
      userId: user.id,
      profile,
      accounts,
      draft: null as ApplicationDraft | null,
    };
  const { data: existing } = await supabase
    .from("application_drafts")
    .select("*")
    .eq("user_id", user.id)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle<ApplicationDraft>();
  if (!existing)
    return {
      userId: user.id,
      profile,
      accounts,
      draft: await createBlankDraft(
        user.id,
        profile.selected_goal ?? "ausbildung",
        accounts[0].id,
      ),
    };
  const [{ data: recipients }, { data: attachments }] = await Promise.all([
    supabase
      .from("application_draft_recipients")
      .select("id, email, company_name, validation_status")
      .eq("draft_id", existing.id)
      .order("created_at"),
    supabase
      .from("application_draft_attachments")
      .select("id, filename, mime_type, size_bytes, storage_path")
      .eq("draft_id", existing.id)
      .order("created_at"),
  ]);
  return {
    userId: user.id,
    profile,
    accounts,
    draft: {
      ...existing,
      recipients: (recipients ?? []) as DraftRecipient[],
      attachments: (attachments ?? []) as DraftAttachment[],
    },
  };
}

export async function createBlankDraft(
  userId: string,
  goal: ApplicationGoal,
  senderAccountId: string,
) {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("application_drafts")
    .insert({ user_id: userId, goal, sender_email_account_id: senderAccountId })
    .select("*")
    .single<ApplicationDraft>();
  // Controlled message only: this runs inside the composer server action, so a
  // raw Supabase insert error (FK/constraint/DB detail) must never reach the client.
  if (error) throw new Error("Unable to create a new application.");
  return { ...data, recipients: [], attachments: [] };
}

/**
 * Load ONE of the user's drafts (ownership-scoped server read) with its
 * recipients and attachments. Used by the composer to open a SPECIFIC draft
 * (?draft=<id> from the Applications list) instead of only the most recent
 * one. An unknown or foreign id resolves to null — the caller falls back
 * to the default draft rather than leaking ownership details.
 */
export async function loadOwnedDraft(
  userId: string,
  draftId: string,
): Promise<ApplicationDraft | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("application_drafts")
    .select("*")
    .eq("id", draftId)
    .eq("user_id", userId)
    .maybeSingle<ApplicationDraft>();
  if (error || !data) return null;
  const [{ data: recipients }, { data: attachments }] = await Promise.all([
    admin
      .from("application_draft_recipients")
      .select("id, email, company_name, validation_status")
      .eq("draft_id", data.id)
      .order("created_at"),
    admin
      .from("application_draft_attachments")
      .select("id, filename, mime_type, size_bytes, storage_path")
      .eq("draft_id", data.id)
      .order("created_at"),
  ]);
  return {
    ...data,
    // Defence in depth for the ONE place stored HTML is handed back to the
    // browser: the composer mounts it with `innerHTML` (RichEmailEditor).
    // Every write path already sanitizes, but sanitizing again on read means a
    // future write that forgets to cannot become stored XSS — and rows written
    // before the sanitizer existed are covered too.
    body_html: sanitizeEmailHtml(data.body_html ?? ""),
    recipients: (recipients ?? []) as DraftRecipient[],
    attachments: (attachments ?? []) as DraftAttachment[],
  };
}

export async function assertDraftOwnership(userId: string, draftId: string) {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("application_drafts")
    .select("id, user_id")
    .eq("id", draftId)
    .eq("user_id", userId)
    .single<{ id: string; user_id: string }>();
  if (error || !data) throw new Error("Draft not found.");
  return data;
}

export async function assertSenderOwnership(userId: string, accountId: string) {
  const accounts = await listEmailAccounts(userId);
  const account = accounts.find(
    (item) => item.id === accountId && item.is_active,
  );
  if (!account) throw new Error("Connected sender account not found.");
  return account;
}

/** Phase 18 — minimal safe view of the drafts currently using a sender
 *  account (the reassignment UI on the email settings page). Both
 *  `user_id` and `sender_email_account_id` are enforced server-side; only
 *  display fields are returned. */
export async function listDraftsBySender(
  userId: string,
  senderAccountId: string,
): Promise<Array<{ id: string; subject: string; goal: ApplicationGoal }>> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("application_drafts")
    .select("id, subject, goal")
    .eq("user_id", userId)
    .eq("sender_email_account_id", senderAccountId)
    .order("updated_at", { ascending: false })
    .limit(50);
  if (error) throw new Error("Unable to load drafts.");
  return (data ?? []) as Array<{
    id: string;
    subject: string;
    goal: ApplicationGoal;
  }>;
}

export function safeAccountList(accounts: SafeEmailAccount[]) {
  return accounts.map(
    ({
      id,
      provider,
      email,
      is_active,
      created_at,
      updated_at,
      last_used_at,
    }) => ({
      id,
      provider,
      email,
      is_active,
      created_at,
      updated_at,
      last_used_at,
    }),
  );
}
export function validateRecipientList(
  recipients: Array<{ email: string; companyName?: string | null }>,
) {
  const seen = new Set<string>();
  return recipients
    .filter((recipient) => recipient.email.trim())
    .map((recipient) => {
      const email = recipient.email.trim().toLowerCase();
      const status: RecipientStatus = !/^[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(email)
        ? "invalid"
        : seen.has(email)
          ? "duplicate"
          : "valid";
      if (status !== "invalid") seen.add(email);
      return {
        email,
        company_name: recipient.companyName?.trim().slice(0, 160) || null,
        validation_status: status,
      };
    });
}

export function createStoragePath(
  userId: string,
  draftId: string,
  filename: string,
) {
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120);
  return `${userId}/${draftId}/${randomUUID()}-${safeName}`;
}
