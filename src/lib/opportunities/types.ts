import { z } from "zod";

export const searchParamsSchema = z.object({
  goal: z.enum(["ausbildung", "arbeit"]),
  keyword: z.string().trim().max(120).default(""),
  profession: z.string().trim().max(120).default(""),
  city: z.string().trim().max(120).default(""),
  bundesland: z.string().trim().max(120).default(""),
  remoteType: z.enum(["remote", "onsite", "hybrid"]).optional(),
  radius: z.coerce.number().int().min(0).max(200).optional(),
  freshnessDays: z.coerce.number().int().min(0).max(100).optional(),
  language: z.string().trim().max(80).default(""),
  company: z.string().trim().max(160).default(""),
  page: z.coerce.number().int().min(1).max(100).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
  match: z.coerce.boolean().default(false),
});
export type OpportunitySearchParams = z.infer<typeof searchParamsSchema>;

export const opportunitySchema = z.object({
  id: z.string(),
  provider: z.string(),
  source_url: z.string().url(),
  source_name: z.string(),
  title: z.string(),
  company_name: z.string().nullable(),
  company_url: z.string().url().nullable(),
  description: z.string().nullable(),
  location: z.string().nullable(),
  city: z.string().nullable(),
  postal_code: z.string().nullable(),
  bundesland: z.string().nullable(),
  country: z.string().nullable(),
  employment_type: z.string().nullable(),
  goal: z.enum(["ausbildung", "arbeit"]),
  profession: z.string().nullable(),
  ausbildung_occupation: z.string().nullable(),
  salary: z.string().nullable(),
  salary_min: z.number().nullable(),
  salary_max: z.number().nullable(),
  currency: z.string().nullable(),
  start_date: z.string().nullable(),
  application_deadline: z.string().nullable(),
  posted_at: z.string().nullable(),
  updated_at: z.string().nullable(),
  remote_type: z.string().nullable(),
  required_skills: z.array(z.string()),
  preferred_skills: z.array(z.string()),
  required_languages: z.array(z.string()),
  education_requirements: z.array(z.string()),
  experience_requirements: z.array(z.string()),
  extracted_keywords: z.array(z.string()),
  retrieved_at: z.string(),
  provider_job_id: z.string(),
  match: z
    .object({
      match_score: z.number().min(0).max(100),
      matching_skills: z.array(z.string()),
      missing_skills: z.array(z.string()),
      matching_languages: z.array(z.string()),
      missing_languages: z.array(z.string()),
      education_match: z.boolean().nullable(),
      experience_match: z.boolean().nullable(),
      location_match: z.boolean().nullable(),
      role_match: z.boolean().nullable(),
      explanation: z.array(z.string()),
    })
    .nullable(),
});
export type Opportunity = z.infer<typeof opportunitySchema>;
export type CandidateForMatch = {
  goal: "ausbildung" | "arbeit";
  target_roles: Array<{ role: string }>;
  education: Array<Record<string, unknown>>;
  training: Array<{ name: string }>;
  experience: Array<{ job_title: string; responsibilities: string[] }>;
  skills: {
    technical: string[];
    software_tools: string[];
    marketing: string[];
    it: string[];
    soft: string[];
  };
  languages: Array<{ language: string; level: string | null }>;
  preferences: {
    preferred_locations: string[];
    preferred_job_titles: string[];
  };
};
