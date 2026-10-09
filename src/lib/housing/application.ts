import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { provider } from "@/lib/ai-service";
import type {
  HousingApplication,
  HousingApplicationStatus,
  HousingListing,
} from "./types";

/**
 * Housing / "Wohnen" — application assistant (Bewerbungs-Assistent).
 *
 * Prepares a professional German message for a landlord/property manager about
 * a specific listing, then persists it to `housing_applications` with a status
 * lifecycle (draft → prepared → contacted → viewing → accepted/declined) and an
 * append-only timeline. The listing data is re-derived server-side from the
 * source (provider + source_id); only the applicant's OWN details come from the
 * client.
 */

export interface ApplicationContext {
  firstName: string;
  lastName: string;
  occupation: string | null;
  moveInDate: string | null;
  note: string | null;
}

/** Column list of public.housing_applications. Keep in sync with the migration. */
const APPS_SELECT =
  "id, user_id, listing_ref, title, message_draft, status, timeline, created_at, updated_at";

const STATUSES: HousingApplicationStatus[] = [
  "draft",
  "prepared",
  "contacted",
  "viewing",
  "accepted",
  "declined",
];

export function isApplicationStatus(value: string): value is HousingApplicationStatus {
  return (STATUSES as string[]).includes(value);
}

/**
 * Deterministic German draft — always works, no network. Used as the AI
 * fallback so the feature degrades gracefully when no AI provider is set.
 */
export function fallbackApplicationDraft(
  listing: HousingListing,
  ctx: ApplicationContext,
): string {
  const location = [listing.city, listing.address].filter(Boolean).join(", ");
  const moveIn = ctx.moveInDate ? ` zum ${ctx.moveInDate}` : "";
  const occupation = ctx.occupation ? `, ${ctx.occupation}` : "";
  const note = ctx.note?.trim() ? `\n\n${ctx.note.trim()}` : "";
  return [
    `Betreff: Anfrage zur Wohnung „${listing.title}“`,
    "",
    "Sehr geehrte Damen und Herren,",
    "",
    `mit großem Interesse habe ich Ihre Anzeige für die Wohnung in ${location || "Deutschland"} gelesen und würde mich sehr über die Möglichkeit freuen, diese zu besichtigen.`,
    "",
    `Mein Name ist ${ctx.firstName} ${ctx.lastName}${occupation}. Ich bin zuverlässig, pünktlich mit der Miete und suche${moveIn} ein neues Zuhause.${note}`,
    "",
    "Für Rückfragen stehe ich Ihnen jederzeit gerne zur Verfügung. Über eine positive Rückmeldung würde ich mich sehr freuen.",
    "",
    "Mit freundlichen Grüßen",
    `${ctx.firstName} ${ctx.lastName}`,
  ].join("\n");
}

const DRAFT_SYSTEM =
  "Du verfasst höfliche, professionelle Mietanfragen auf Deutsch für " +
  "Wohnungssuchende in Deutschland. Schreibe eine konkrete, freundliche " +
  "Nachricht an den Vermieter/Verwalter. Nutze NUR die übergebenen Fakten, " +
  "erfinde nichts hinzu, bleibe sachlich und auf max. 150 Wörter. Kein " +
  "Rechtstext, keine Anrede-Erfindung jenseits der übergebenen Namen.";

export interface GeneratedDraft {
  text: string;
  ai_assisted: boolean;
}

/**
 * Generate the draft: try the configured AI provider; on any failure fall back
 * to the deterministic template so the user always gets a usable message.
 */
export async function generateApplicationDraft(
  listing: HousingListing,
  ctx: ApplicationContext,
  timeoutMs = 60_000,
): Promise<GeneratedDraft> {
  const fallback = fallbackApplicationDraft(listing, ctx);
  try {
    const userPrompt = [
      `Wohnungsanzeige: ${listing.title}`,
      `Ort: ${[listing.city, listing.address].filter(Boolean).join(", ") || "Deutschland"}`,
      listing.rent_warm_eur != null ? `Warmmiete: ${listing.rent_warm_eur} €/Monat` : null,
      `Anmeldender: ${ctx.firstName} ${ctx.lastName}`,
      ctx.occupation ? `Beruf: ${ctx.occupation}` : null,
      ctx.moveInDate ? `Wunsch-Einzugsdatum: ${ctx.moveInDate}` : null,
      ctx.note?.trim() ? `Zusatz vom Nutzer: ${ctx.note.trim()}` : null,
    ]
      .filter((line): line is string => line != null)
      .join("\n");
    const text = await provider().generateText(
      [
        { role: "system", content: DRAFT_SYSTEM },
        { role: "user", content: userPrompt },
      ],
      timeoutMs,
    );
    const cleaned = (text ?? "").trim();
    if (!cleaned) return { text: fallback, ai_assisted: false };
    return { text: cleaned, ai_assisted: true };
  } catch {
    return { text: fallback, ai_assisted: false };
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function rowToApplication(row: Record<string, unknown>): HousingApplication {
  return {
    id: row.id as string,
    user_id: row.user_id as string,
    listing_ref: (row.listing_ref as HousingApplication["listing_ref"]) ?? {
      provider: "",
      source_id: "",
      title: null,
      url: null,
    },
    title: (row.title as string | null) ?? null,
    message_draft: (row.message_draft as string | null) ?? null,
    status: (row.status as HousingApplicationStatus) ?? "draft",
    timeline: (row.timeline as HousingApplication["timeline"]) ?? [],
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

/** Create a prepared application for a listing (server-derived listing_ref). */
export async function createApplication(
  userId: string,
  listing: HousingListing,
  messageDraft: string,
  title: string,
): Promise<HousingApplication> {
  const admin = createAdminClient();
  const ts = nowIso();
  const { data, error } = await admin
    .from("housing_applications")
    .insert({
      user_id: userId,
      listing_ref: {
        provider: listing.provider,
        source_id: listing.source_id,
        title: listing.title,
        url: listing.listing_url,
      },
      title,
      message_draft: messageDraft,
      status: "prepared",
      timeline: [{ status: "prepared", at: ts }],
      created_at: ts,
      updated_at: ts,
    })
    .select(APPS_SELECT)
    .single();
  if (error || !data) {
    throw new Error(error?.message ?? "Could not create application.");
  }
  return rowToApplication(data as Record<string, unknown>);
}

export async function listApplications(userId: string): Promise<HousingApplication[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("housing_applications")
    .select(APPS_SELECT)
    .eq("user_id", userId)
    .order("updated_at", { ascending: false });
  if (error) throw new Error(error.message);
  return ((data ?? []) as Record<string, unknown>[]).map(rowToApplication);
}

export async function getApplication(
  userId: string,
  applicationId: string,
): Promise<HousingApplication | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("housing_applications")
    .select(APPS_SELECT)
    .eq("user_id", userId)
    .eq("id", applicationId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  return rowToApplication(data as Record<string, unknown>);
}

/** Update the status and append to the timeline (scoped to the user). */
export async function updateApplicationStatus(
  userId: string,
  applicationId: string,
  status: HousingApplicationStatus,
): Promise<HousingApplication> {
  const admin = createAdminClient();
  const existing = await getApplication(userId, applicationId);
  if (!existing) throw new Error("Application not found.");
  const ts = nowIso();
  const timeline = [...existing.timeline, { status, at: ts }];
  const { data, error } = await admin
    .from("housing_applications")
    .update({ status, timeline, updated_at: ts })
    .eq("user_id", userId)
    .eq("id", applicationId)
    .select(APPS_SELECT)
    .single();
  if (error || !data) {
    throw new Error(error?.message ?? "Could not update application.");
  }
  return rowToApplication(data as Record<string, unknown>);
}

/** Edit the draft message for a not-yet-sent application (scoped to the user). */
export async function updateApplicationDraft(
  userId: string,
  applicationId: string,
  messageDraft: string,
): Promise<HousingApplication> {
  const admin = createAdminClient();
  const existing = await getApplication(userId, applicationId);
  if (!existing) throw new Error("Application not found.");
  const ts = nowIso();
  const { data, error } = await admin
    .from("housing_applications")
    .update({ message_draft: messageDraft, updated_at: ts })
    .eq("user_id", userId)
    .eq("id", applicationId)
    .select(APPS_SELECT)
    .single();
  if (error || !data) {
    throw new Error(error?.message ?? "Could not update application draft.");
  }
  return rowToApplication(data as Record<string, unknown>);
}

/** Delete an application (scoped to the user). */
export async function deleteApplication(
  userId: string,
  applicationId: string,
): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin
    .from("housing_applications")
    .delete()
    .eq("user_id", userId)
    .eq("id", applicationId);
  if (error) throw new Error(error.message);
}
