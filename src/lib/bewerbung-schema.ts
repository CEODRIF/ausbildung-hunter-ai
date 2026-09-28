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
