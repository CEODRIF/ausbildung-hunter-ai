import type { CandidateProfile } from "@/lib/bewerbung-schema";
import type { OpportunitySearchParams } from "@/lib/opportunities/types";

/**
 * Phase 8 — deterministic dashboard intelligence.
 *
 * Everything here is a pure function of server-provided, schema-validated
 * data: no AI, no network, no randomness, no wall clock. Missing data is
 * reported as missing — never counted as completed, and never used to
 * fabricate a recommendation.
 */

// ---------------------------------------------------------------------------
// 1. Profile completeness
// ---------------------------------------------------------------------------

export const COMPLETENESS_SECTIONS = [
  "Name",
  "Location",
  "Education",
  "German language level",
  "Other languages",
  "Skills",
  "Experience",
  "Certifications",
  "Target roles",
  "Goal",
  "Location preferences",
  "Relocation preference",
] as const;

export type CompletenessSection = (typeof COMPLETENESS_SECTIONS)[number];

export interface ProfileCompleteness {
  /** Integer 0–100. Deterministic: completed sections / all sections. */
  percentage: number;
  completed: CompletenessSection[];
  missing: CompletenessSection[];
}

function normalizeLanguage(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue");
}

const GERMAN_ALIASES = new Set([
  "deutsch",
  "deutsche",
  "deutsche sprache",
  "german",
  "deutsch (muttersprache)",
]);

function hasGermanWithLevel(profile: CandidateProfile): boolean {
  return profile.languages.some(
    (language) =>
      GERMAN_ALIASES.has(normalizeLanguage(language.language)) &&
      typeof language.level === "string" &&
      language.level.trim().length > 0,
  );
}

function hasOtherLanguage(profile: CandidateProfile): boolean {
  return profile.languages.some(
    (language) => !GERMAN_ALIASES.has(normalizeLanguage(language.language)),
  );
}

function hasAnySkill(profile: CandidateProfile): boolean {
  const { technical, software_tools, marketing, it, soft } = profile.skills;
  return [technical, software_tools, marketing, it, soft].some(
    (list) => list.length > 0,
  );
}

function hasTargetRole(profile: CandidateProfile): boolean {
  return (
    profile.target_roles.length > 0 ||
    profile.preferences.preferred_job_titles.length > 0
  );
}

/** Deterministic 12-section completeness check over the VALIDATED profile.
 *  A section counts as completed only when the corresponding structured
 *  value is actually documented — null/empty never counts. */
export function evaluateProfileCompleteness(
  profile: CandidateProfile,
): ProfileCompleteness {
  const done = new Map<CompletenessSection, boolean>([
    ["Name", (profile.candidate.full_name ?? "").trim().length > 0],
    [
      "Location",
      (profile.candidate.location ?? "").trim().length > 0 ||
        (profile.candidate.current_location ?? "").trim().length > 0,
    ],
    ["Education", profile.education.length > 0],
    ["German language level", hasGermanWithLevel(profile)],
    ["Other languages", hasOtherLanguage(profile)],
    ["Skills", hasAnySkill(profile)],
    ["Experience", profile.experience.length > 0],
    ["Certifications", profile.training.length > 0],
    ["Target roles", hasTargetRole(profile)],
    // The schema makes goal mandatory, so this is always documented.
    ["Goal", profile.goal === "ausbildung" || profile.goal === "arbeit"],
    [
      "Location preferences",
      profile.preferences.preferred_locations.length > 0,
    ],
    ["Relocation preference", profile.preferences.willing_to_relocate !== null],
  ]);
  const completed: CompletenessSection[] = [];
  const missing: CompletenessSection[] = [];
  for (const section of COMPLETENESS_SECTIONS) {
    if (done.get(section)) completed.push(section);
    else missing.push(section);
  }
  return {
    percentage: Math.round(
      (100 * completed.length) / COMPLETENESS_SECTIONS.length,
    ),
    completed,
    missing,
  };
}

// ---------------------------------------------------------------------------
// 2. Next action (deterministic rule chain)
// ---------------------------------------------------------------------------

export interface NextActionInput {
  hasProfile: boolean;
  completeness: ProfileCompleteness | null;
  savedTotal: number;
  /** Saved opportunities whose stored snapshot is a complete match. */
  completeMatchCount: number;
  /** A prepared application draft exists (has content, not just a stub). */
  hasApplicationDraft: boolean;
  hasEmailAccount: boolean;
  /** Most relevant campaign for the user (server-read), or null. */
  campaign: { id: string; status: string } | null;
}

export interface NextAction {
  id:
    | "scan_profile"
    | "complete_profile"
    | "find_opportunities"
    | "review_matches"
    | "prepare_application"
    | "connect_email"
    | "review_send"
    | "track_sending"
    | "track_sent"
    | "explore";
  /** Short UI label (English dashboard shell). */
  label: string;
  /** Factual, data-derived reason (never marketing copy). */
  reason: string;
  href: string;
  ctaLabel: string;
}

/** Sections whose absence materially blocks the workflow. Used by rule 2. */
const IMPORTANT_SECTIONS: ReadonlySet<CompletenessSection> = new Set([
  "Name",
  "Education",
  "German language level",
  "Target roles",
]);

/** Deterministic priority chain. The first matching rule wins; identical
 *  inputs always produce identical outputs. */
export function resolveNextAction(input: NextActionInput): NextAction {
  if (!input.hasProfile) {
    return {
      id: "scan_profile",
      label: "Scan your Bewerbung",
      reason:
        "No candidate profile exists yet. Scanning a document builds the profile the matching engine compares against.",
      href: "/bewerbung-scanner",
      ctaLabel: "Scan now",
    };
  }
  const criticalMissing = (input.completeness?.missing ?? []).filter(
    (section) => IMPORTANT_SECTIONS.has(section),
  );
  if (criticalMissing.length > 0) {
    return {
      id: "complete_profile",
      label: "Complete your profile",
      reason: `Missing: ${criticalMissing.join(", ")}. The matcher only scores documented information.`,
      href: "/bewerbung-scanner",
      ctaLabel: "Complete profile",
    };
  }
  if (input.savedTotal === 0) {
    return {
      id: "find_opportunities",
      label: "Find suitable opportunities",
      reason: "Your profile is complete, but no opportunity is saved yet.",
      href: "/opportunities",
      ctaLabel: "Search opportunities",
    };
  }
  if (!input.hasApplicationDraft) {
    if (input.completeMatchCount > 0) {
      return {
        id: "prepare_application",
        label: "Prepare your application",
        reason:
          "You have saved matches, but no application has been prepared yet.",
        href: "/applications/new",
        ctaLabel: "Prepare application",
      };
    }
    return {
      id: "review_matches",
      label: "Review your matches",
      reason:
        "Saved opportunities do not have a complete match yet — review them or refine your profile.",
      href: "/opportunities",
      ctaLabel: "Review matches",
    };
  }
  if (!input.hasEmailAccount) {
    return {
      id: "connect_email",
      label: "Connect your email",
      reason:
        "An application is prepared, but no email account is connected for sending.",
      href: "/settings/email",
      ctaLabel: "Connect email",
    };
  }
  if (input.campaign) {
    const { id, status } = input.campaign;
    if (status === "draft") {
      return {
        id: "review_send",
        label: "Review and send your application",
        reason:
          "A campaign is ready in draft status — review the email before sending.",
        href: `/applications/campaign/${id}`,
        ctaLabel: "Review campaign",
      };
    }
    if (status === "queued" || status === "sending") {
      return {
        id: "track_sending",
        label: "Your application is being sent",
        reason: `Campaign status: ${status}. You can follow delivery on the campaign page.`,
        href: `/applications/campaign/${id}`,
        ctaLabel: "Track campaign",
      };
    }
    if (status === "completed" || status === "partially_failed") {
      return {
        id: "track_sent",
        label: "Track your sent application",
        reason:
          status === "completed"
            ? "The campaign finished sending. Watch for replies in your inbox."
            : "The campaign finished with at least one failed recipient — review the campaign.",
        href: `/applications/campaign/${id}`,
        ctaLabel: "Open campaign",
      };
    }
    if (status === "failed" || status === "cancelled") {
      return {
        id: "explore",
        label: "Find more opportunities",
        reason: `The last campaign ended as ${status}. Continue with another opportunity.`,
        href: "/opportunities",
        ctaLabel: "Search opportunities",
      };
    }
  }
  return {
    id: "explore",
    label: "Find more opportunities",
    reason:
      "Your application is prepared and your email is connected — look for the next opportunity.",
    href: "/opportunities",
    ctaLabel: "Search opportunities",
  };
}

// ---------------------------------------------------------------------------
// 3. Recommendation query (pure — the search itself runs server-side)
// ---------------------------------------------------------------------------

/**
 * Builds the server-side search query for the dashboard recommendation
 * layer from the validated profile ONLY. Returns null when the profile
 * documents no usable keyword — in that case the dashboard shows an empty
 * state instead of a broad, potentially misleading result set.
 * Ranking uses the existing matcher v2 (sort=match); no new scoring.
 */
export function buildRecommendationQuery(
  profile: CandidateProfile,
): OpportunitySearchParams | null {
  const keyword =
    profile.preferences.preferred_job_titles[0]?.trim() ||
    profile.target_roles[0]?.role?.trim() ||
    "";
  if (!keyword) return null;
  const location = profile.preferences.preferred_locations[0]?.trim() || "";
  return {
    goal: profile.goal,
    keyword,
    role: "",
    company: "",
    location,
    freshness: "any",
    sort: "match",
    employment: "any",
    training_type: "any",
    home_office: "any",
    salary_documented: false,
    page: 1,
    pageSize: 6,
    match: true,
  };
}
