import { z } from "zod";

const stringOrNull = z.string().trim().max(500).nullable().default(null);
const stringArray = z.array(z.string().trim().min(1).max(200)).default([]);

export const candidateProfileSchema = z.object({
  candidate: z
    .object({
      full_name: stringOrNull,
      location: stringOrNull,
      country: stringOrNull,
      current_location: stringOrNull,
      target_location: stringArray,
      contact: z
        .object({
          email: stringOrNull,
          phone: stringOrNull,
          linkedin: stringOrNull,
        })
        .default({ email: null, phone: null, linkedin: null }),
    })
    .default({
      full_name: null,
      location: null,
      country: null,
      current_location: null,
      target_location: [],
      contact: { email: null, phone: null, linkedin: null },
    }),
  goal: z.enum(["ausbildung", "arbeit"]),
  education: z
    .array(
      z.object({
        school: stringOrNull,
        university: stringOrNull,
        degree: stringOrNull,
        field_of_study: stringOrNull,
        graduation_year: z
          .union([
            z.number().int().min(1900).max(2100),
            z.string().max(20),
            z.null(),
          ])
          .default(null),
        education_level: stringOrNull,
        source: z
          .enum(["ai_extracted", "user_provided"])
          .default("ai_extracted"),
      }),
    )
    .default([]),
  training: z
    .array(
      z.object({
        name: z.string().min(1).max(300),
        provider: stringOrNull,
        year: stringOrNull,
        source: z
          .enum(["ai_extracted", "user_provided"])
          .default("ai_extracted"),
      }),
    )
    .default([]),
  experience: z
    .array(
      z.object({
        job_title: z.string().min(1).max(300),
        company: stringOrNull,
        responsibilities: stringArray,
        start_date: stringOrNull,
        end_date: stringOrNull,
        type: z
          .enum(["employment", "internship", "freelance", "other"])
          .default("employment"),
        source: z
          .enum(["ai_extracted", "user_provided"])
          .default("ai_extracted"),
      }),
    )
    .default([]),
  skills: z
    .object({
      technical: stringArray,
      software_tools: stringArray,
      marketing: stringArray,
      it: stringArray,
      soft: stringArray,
    })
    .default({
      technical: [],
      software_tools: [],
      marketing: [],
      it: [],
      soft: [],
    }),
  languages: z
    .array(
      z.object({
        language: z.string().min(1).max(100),
        level: z.string().max(50).nullable().default(null),
        level_is_inferred: z.boolean().default(false),
        source: z
          .enum(["ai_extracted", "user_provided"])
          .default("ai_extracted"),
      }),
    )
    .default([]),
  preferences: z
    .object({
      target: z.enum(["ausbildung", "arbeit"]).nullable().default(null),
      preferred_job_titles: stringArray,
      preferred_industries: stringArray,
      preferred_locations: stringArray,
      willing_to_relocate: z.boolean().nullable().default(null),
      remote_hybrid_preference: stringOrNull,
    })
    .default({
      target: null,
      preferred_job_titles: [],
      preferred_industries: [],
      preferred_locations: [],
      willing_to_relocate: null,
      remote_hybrid_preference: null,
    }),
  target_roles: z
    .array(
      z.object({
        role: z.string().min(1).max(200),
        reason: z.string().min(1).max(500),
        source: z
          .enum(["ai_extracted", "user_provided"])
          .default("ai_extracted"),
      }),
    )
    .default([]),
  strengths: stringArray,
  missing_information: stringArray,
  potential_concerns: stringArray,
  keywords: stringArray,
});

export type CandidateProfile = z.infer<typeof candidateProfileSchema>;

/**
 * Request payload of POST /api/bewerbung-scanner/scan.
 *
 * The request is untrusted: only the three fields the scan API actually needs
 * are accepted (`storage_path` / `size_bytes` / `user_id` are NOT part of the
 * contract — runScan() re-reads the uploads scoped to the session user), every
 * string is bounded, and `.strict()` rejects unknown keys instead of silently
 * ignoring them.
 */
export const scanFileReferenceSchema = z
  .object({
    id: z.string().uuid(),
    filename: z.string().trim().min(1).max(255),
    mime_type: z.string().trim().min(1).max(120),
  })
  .strict();

export const scanRequestBodySchema = z
  .object({
    goal: z.enum(["ausbildung", "arbeit"]),
    files: z.array(scanFileReferenceSchema).min(1).max(10),
  })
  .strict();

export type ScanFileReference = z.infer<typeof scanFileReferenceSchema>;
export type ScanRequestBody = z.infer<typeof scanRequestBodySchema>;

/**
 * Request payload of POST /api/ai/generate-file.
 *
 * `mimeType` is an allowlist matching the `ai-files` bucket's
 * allowed_mime_types: a value outside it would make storage reject the object
 * AFTER the paid AI call had already run. `filename` may not contain path
 * separators or traversal segments (it is echoed into the storage object key).
 */
export const GENERATED_FILE_MIME_TYPES = [
  "text/plain",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
] as const;

export const generateFileRequestSchema = z
  .object({
    conversationId: z.string().uuid(),
    filename: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .refine((value) => !/[/\\]/.test(value) && !value.includes(".."), {
        message: "Invalid filename.",
      }),
    mimeType: z.enum(GENERATED_FILE_MIME_TYPES),
    prompt: z.string().trim().min(1).max(4000),
  })
  .strict();

export type GenerateFileRequest = z.infer<typeof generateFileRequestSchema>;
