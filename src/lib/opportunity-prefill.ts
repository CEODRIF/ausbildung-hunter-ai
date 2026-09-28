import "server-only";

import { z } from "zod";
import {
  htmlToText,
  sanitizeEmailHtml,
  validateRecipientList,
  type ApplicationDraft,
  type ApplicationGoal,
} from "@/lib/application-drafts";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  parseOpportunityKey,
  resolveOpportunity,
} from "@/lib/opportunities/providers/arbeitsagentur";
import type { Opportunity } from "@/lib/opportunities/types";

/**
 * Phase 6 — application prefill from an opportunity.
 *
 * Flow (server-side, never browser-derived):
 *   validated opportunity key → resolve from the authoritative source →
 *   build a prefill from DOCUMENTED fields only → apply to a draft:
 *     - the user's active draft is blank  → update it in place;
 *     - the active draft has content      → create a NEW pre-filled draft,
 *       the existing one stays untouched (never overwritten).
 *
 * Every interpolated source string is HTML-escaped; a contact email is only
 * used as a pre-filled recipient when it validates. Nothing is invented:
 * missing fields simply drop out of the subject/body.
 */

const prefillRecipientSchema = z.object({
  email: z.string().email().max(254),
  companyName: z.string().max(160).nullable(),
});

export const opportunityPrefillSchema = z.object({
  goal: z.enum(["ausbildung", "arbeit"]),
  subject: z.string().min(1).max(500),
  bodyHtml: z.string().min(1).max(20_000),
  recipient: prefillRecipientSchema.nullable(),
  context: z.object({
    title: z.string().min(1).max(200),
    company: z.string().max(200).nullable(),
    location: z.string().max(200).nullable(),
    sourceUrl: z.string().url().max(500),
    detailHref: z.string().max(300),
  }),
});
export type OpportunityPrefill = z.infer<typeof opportunityPrefillSchema>;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Pure + deterministic: build the prefill payload from documented fields. */
export function buildOpportunityPrefill(
  opportunity: Opportunity,
): OpportunityPrefill {
  const profession = opportunity.profession?.trim() || "";
  const company = opportunity.company_name?.trim() || null;
  const location = opportunity.location?.trim() || null;
  const reference = opportunity.external_id.trim() || null;

  const positionPhrase =
    profession ||
    (opportunity.goal === "ausbildung"
      ? "diesen Ausbildungsplatz"
      : "diese Position");

  const subjectBase =
    opportunity.goal === "ausbildung"
      ? profession
        ? `Bewerbung um einen Ausbildungsplatz als ${profession}`
        : "Bewerbung um einen Ausbildungsplatz"
      : profession
        ? `Bewerbung als ${profession}`
        : "Bewerbung auf Ihre Stellenausschreibung";
  const subject = reference
    ? `${subjectBase} (Referenz ${reference})`
    : subjectBase;

  const opening =
    opportunity.goal === "ausbildung"
      ? `hiermit bewerbe ich mich um einen Ausbildungsplatz${
          profession ? ` als ${escapeHtml(positionPhrase)}` : ""
        }${company ? ` bei ${escapeHtml(company)}` : ""}${
          location ? ` in ${escapeHtml(location)}` : ""
        }.`
      : `hiermit bewerbe ich mich um die Stelle${
          profession ? ` als ${escapeHtml(positionPhrase)}` : ""
        }${company ? ` bei ${escapeHtml(company)}` : ""}${
          location ? ` in ${escapeHtml(location)}` : ""
        }.`;
  const referenceLine = reference
    ? `<p>Ihre Ausschreibung mit der Referenz ${escapeHtml(
        reference,
      )} habe ich mit großem Interesse gelesen.</p>`
    : "";
  const bodyHtml = [
    "<p>Sehr geehrte Damen und Herren,</p>",
    `<p>${opening}</p>`,
    referenceLine,
    "<p>Über die Gelegenheit zu einem persönlichen Gespräch freue ich mich sehr.</p>",
    "<p>Mit freundlichen Grüßen</p>",
  ]
    .filter(Boolean)
    .join("");

  // A contact email is only pre-filled when the source documents one that
  // validates — otherwise the user adds the recipient manually.
  let recipient: OpportunityPrefill["recipient"] = null;
  if (opportunity.contact?.email) {
    const validated = validateRecipientList([
      { email: opportunity.contact.email, companyName: company },
    ])[0];
    if (validated && validated.validation_status !== "invalid") {
      recipient = {
        email: validated.email,
        companyName: validated.company_name,
      };
    }
  }

  return opportunityPrefillSchema.parse({
    goal: opportunity.goal,
    subject: subject.slice(0, 500),
    bodyHtml,
    recipient,
    context: {
      title: opportunity.title.trim().slice(0, 200),
      company: company ? company.slice(0, 200) : null,
      location: location ? location.slice(0, 200) : null,
      sourceUrl: opportunity.source_url,
      detailHref: `/opportunities/${encodeURIComponent(opportunity.id)}`,
    },
  });
}

// ---------------------------------------------------------------------------
// Server-side application to a draft
// ---------------------------------------------------------------------------

export interface PrefillComposerData {
  userId: string;
  accounts: Array<{ id: string }>;
  draft: ApplicationDraft;
}

export type PrefillOutcome =
  | {
      ok: true;
      draft: ApplicationDraft;
      context: OpportunityPrefill["context"];
      /** Set when a new draft had to be created (previous one kept). */
      notice: string | null;
      createdNewDraft: boolean;
    }
  | { ok: false; error: "invalid_key" | "unavailable" | "write_failed" };

function contextColumns(opportunity: Opportunity, prefill: OpportunityPrefill) {
  return {
    opportunity_key: opportunity.id,
    opportunity_title: prefill.context.title,
    opportunity_company: prefill.context.company,
    opportunity_source_url: prefill.context.sourceUrl,
  };
}

async function replaceDraftRecipient(
  admin: ReturnType<typeof createAdminClient>,
  draftId: string,
  recipient: NonNullable<OpportunityPrefill["recipient"]>,
) {
  const [validated] = validateRecipientList([
    { email: recipient.email, companyName: recipient.companyName },
  ]);
  if (!validated || validated.validation_status === "invalid") return;
  await admin
    .from("application_draft_recipients")
    .delete()
    .eq("draft_id", draftId);
  await admin
    .from("application_draft_recipients")
    .insert([{ draft_id: draftId, ...validated }]);
}

/**
 * Apply a server-derived prefill to the user's composer state.
 *
 * Draft strategy (documented, never destroys work):
 * - blank active draft (no subject/body, no recipients, no attachments) →
 *   the prefill is written into it in place;
 * - otherwise → a NEW draft is created with the prefill (it becomes the
 *   active one); the previous draft stays untouched in the database.
 */
export async function applyOpportunityPrefill(
  data: PrefillComposerData,
  opportunityKey: string,
): Promise<PrefillOutcome> {
  // Validate the key BEFORE any network call (malformed/foreign → reject).
  try {
    parseOpportunityKey(opportunityKey);
  } catch {
    return { ok: false, error: "invalid_key" };
  }
  // Always re-resolve from the authoritative source (never browser data).
  let opportunity: Opportunity;
  try {
    opportunity = await resolveOpportunity(opportunityKey);
  } catch {
    return { ok: false, error: "unavailable" };
  }
  const prefill = buildOpportunityPrefill(opportunity);

  const admin = createAdminClient();
  const draft = data.draft;
  const blank =
    draft.subject.trim() === "" &&
    draft.body_text.trim() === "" &&
    draft.recipients.length === 0 &&
    draft.attachments.length === 0;

  const bodyHtml = sanitizeEmailHtml(prefill.bodyHtml);
  const content = {
    goal: prefill.goal as ApplicationGoal,
    subject: prefill.subject.slice(0, 500),
    body_html: bodyHtml,
    body_text: htmlToText(bodyHtml),
    ...contextColumns(opportunity, prefill),
  };

  let resultDraft: ApplicationDraft;
  let createdNewDraft = false;
  if (blank) {
    const { error } = await admin
      .from("application_drafts")
      .update(content)
      .eq("id", draft.id)
      .eq("user_id", data.userId);
    if (error) return { ok: false, error: "write_failed" };
    if (prefill.recipient)
      await replaceDraftRecipient(admin, draft.id, prefill.recipient);
    resultDraft = {
      ...draft,
      ...content,
      recipients: prefill.recipient
        ? [
            {
              id: "prefill",
              email: prefill.recipient.email,
              company_name: prefill.recipient.companyName,
              validation_status: "valid" as const,
            },
          ]
        : [],
    };
  } else {
    const { data: created, error } = await admin
      .from("application_drafts")
      .insert({
        user_id: data.userId,
        sender_email_account_id: draft.sender_email_account_id,
        ...content,
      })
      .select("*")
      .single<ApplicationDraft>();
    if (error || !created) return { ok: false, error: "write_failed" };
    createdNewDraft = true;
    if (prefill.recipient)
      await replaceDraftRecipient(admin, created.id, prefill.recipient);
    resultDraft = {
      ...created,
      recipients: prefill.recipient
        ? [
            {
              id: "prefill",
              email: prefill.recipient.email,
              company_name: prefill.recipient.companyName,
              validation_status: "valid" as const,
            },
          ]
        : [],
      attachments: [],
    };
  }

  return {
    ok: true,
    draft: resultDraft,
    context: prefill.context,
    createdNewDraft,
    notice: createdNewDraft
      ? "Aus dem Stellenangebot wurde ein neuer Entwurf erstellt. Der vorherige Entwurf bleibt unverändert gespeichert."
      : null,
  };
}
