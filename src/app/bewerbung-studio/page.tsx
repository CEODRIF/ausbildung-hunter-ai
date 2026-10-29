import { redirect } from "next/navigation";
import { StudioClient, type StudioInitial } from "@/components/bewerbung-studio/studio-client";
import { getCurrentUserAndProfile } from "@/lib/auth";
import type { CandidateProfile } from "@/lib/bewerbung-schema";
import {
  getLatestCandidateProfile,
  getStudioApplication,
  getStudioMissingTables,
  listStudioApplications,
  listUserEmailAccounts,
} from "@/lib/studio";
import {
  adExtractSchema,
  studioEmailContentSchema,
  type StudioAttachmentRow,
  type StudioSendAttemptRow,
} from "@/lib/studio/schema";
import { sanitizeCvDocument, type CvDocument } from "@/lib/templates/cv";

export const dynamic = "force-dynamic";

/**
 * AI Bewerbung Studio — one page, one workflow.
 *
 * Server responsibilities (all ownership-scoped, service-role after checks):
 *  - probe the studio schema (graceful "setup pending" state before the
 *    manual migration is applied);
 *  - list the user's studio applications;
 *  - load the selected application bundle (`?app=<id>`): application row,
 *    latest document per type, attachments, send attempts;
 *  - list connected email accounts and the latest scanner profile.
 *
 * Everything else (editing, AI generation, sending) happens client-side
 * through the /api/bewerbung-studio/* routes and the server actions —
 * never through client-supplied user ids.
 */
export default async function StudioPage({
  searchParams,
}: {
  searchParams: Promise<{ app?: string | string[] }>;
}) {
  const { user, profile } = await getCurrentUserAndProfile();
  if (!user) redirect("/login");

  const params = await searchParams;
  const requestedId = typeof params.app === "string" ? params.app : null;

  // Probe ALL four studio tables — a partially applied migration must show
  // the exact missing prerequisites, not a generic error (PR #86 report).
  const missingTables = await getStudioMissingTables();
  const available = missingTables.length === 0;

  let bundle: StudioInitial["bundle"] = null;
  let appSummaries: StudioInitial["appSummaries"] = [];
  let emailAccounts: StudioInitial["emailAccounts"] = [];
  let candidateProfile: CandidateProfile | null = null;

  if (available) {
    const [apps, accounts, prof] = await Promise.all([
      listStudioApplications(user.id),
      listUserEmailAccounts(user.id),
      getLatestCandidateProfile(user.id),
    ]);
    appSummaries = apps.map((a) => {
      const extract = a.ad_extracted
        ? adExtractSchema.safeParse(a.ad_extracted)
        : null;
      return {
        id: a.id,
        company: extract?.success ? extract.data.company || "—" : "—",
        jobTitle: extract?.success ? extract.data.jobTitle || extract.data.occupation || "—" : "—",
        status: a.status,
        createdAt: a.created_at,
      };
    });
    emailAccounts = accounts.map((a) => ({
      id: a.id,
      provider: a.provider,
      email: a.email,
      is_active: a.is_active,
      requires_reconnect: a.requires_reconnect,
    }));
    candidateProfile = prof;

    if (requestedId) {
      const b = await getStudioApplication(user.id, requestedId);
      if (b) {
        const latestDoc = (type: "cv" | "cover_letter" | "email") =>
          b.documents.find((d) => d.doc_type === type) ?? null;
        const cvDoc = latestDoc("cv");
        const letterDoc = latestDoc("cover_letter");
        const emailDoc = latestDoc("email");
        const emailContent = emailDoc?.content
          ? studioEmailContentSchema.safeParse(emailDoc.content)
          : null;
        const cvContent = cvDoc?.content
          ? (sanitizeCvDocument(cvDoc.content) as CvDocument | null)
          : null;
        const letterContent = letterDoc?.content as
          | { text?: unknown; tone?: unknown }
          | null;
        bundle = {
          app: b.app,
          documents: {
            cv: cvContent,
            cover_letter:
              typeof letterContent?.text === "string" && letterContent.text.trim()
                ? {
                    text: letterContent.text,
                    tone:
                      letterContent.tone === "formal" || letterContent.tone === "engaged"
                        ? letterContent.tone
                        : "professional",
                  }
                : null,
            email: emailContent?.success ? emailContent.data : null,
          },
          attachments: b.attachments as unknown as StudioAttachmentRow[],
          attempts: b.attempts as unknown as StudioSendAttemptRow[],
        };
      }
    }
  }

  const initial: StudioInitial = {
    available,
    missingTables,
    userId: user.id,
    userFacts: {
      fullName: profile?.full_name ?? "",
      email: profile?.email ?? user.email ?? "",
      phone: profile?.phone ?? null,
      location: profile?.city ?? null,
      linkedin: candidateProfile?.candidate.contact.linkedin ?? null,
    },
    emailAccounts,
    appSummaries,
    bundle,
    profile: candidateProfile,
  };

  return <StudioClient initial={initial} />;
}
