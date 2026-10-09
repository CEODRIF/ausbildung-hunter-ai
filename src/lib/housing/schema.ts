import { z } from "zod";

/**
 * Housing / "Wohnen" — request schemas.
 *
 * Every body is `.strict()` so client-supplied fields that are not part of the
 * contract are rejected (mirrors the opportunities/save contract: the client
 * can send filter values and its OWN personal details, never listing data).
 */

export const housingSearchSchema = z
  .object({
    city: z.string().max(80).optional().default(""),
    postal_code: z
      .string()
      .regex(/^\d{0,5}$/, "Postal code must be up to 5 digits")
      .optional()
      .default(""),
    radius_km: z.number().int().min(0).max(100).optional().default(10),
    accommodation_type: z
      .enum(["all", "apartment", "wg_room", "furnished", "studio"])
      .optional()
      .default("all"),
    max_warm_rent: z
      .number()
      .nonnegative()
      .max(100000)
      .nullable()
      .optional()
      .default(null),
    rooms: z.union([z.number().int().min(1).max(10), z.literal("all")]).optional().default("all"),
    available_before: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be yyyy-mm-dd")
      .nullable()
      .optional()
      .default(null),
    min_area_sqm: z.number().nonnegative().max(5000).nullable().optional().default(null),
    furnished_only: z.boolean().optional().default(false),
    wg_suitable_only: z.boolean().optional().default(false),
    pets_allowed_only: z.boolean().optional().default(false),
    verified_only: z.boolean().optional().default(false),
    sort: z.enum(["newest", "price_asc", "price_desc"]).optional().default("newest"),
    // Pagination (server-side page fetch; the UI pages via Load-more).
    limit: z.number().int().min(1).max(100).optional().default(30),
    offset: z.number().int().min(0).max(10000).optional().default(0),
  })
  .strict();
export type HousingSearchInput = z.infer<typeof housingSearchSchema>;

// --- Saved listings + saved searches -----------------------------------------
// Both live under /api/housing/save, disambiguated by a `kind` literal so the
// approved 4-route surface stays intact.

export const saveListingBodySchema = z
  .object({
    kind: z.literal("listing"),
    provider: z.string().min(1).max(60),
    sourceId: z.string().min(1).max(120),
    notes: z.string().trim().max(500).nullish(),
  })
  .strict();
export type SaveListingBody = z.infer<typeof saveListingBodySchema>;

export const saveSearchBodySchema = z
  .object({
    kind: z.literal("search"),
    name: z.string().trim().max(80).nullish(),
    query: housingSearchSchema,
    lastCount: z.number().int().min(0).max(100000).optional().default(0),
  })
  .strict();
export type SaveSearchBody = z.infer<typeof saveSearchBodySchema>;

export const saveBodySchema = z.discriminatedUnion("kind", [
  saveListingBodySchema,
  saveSearchBodySchema,
]);
export type SaveBody = z.infer<typeof saveBodySchema>;

export const updateListingBodySchema = z
  .object({
    kind: z.literal("listing"),
    provider: z.string().min(1).max(60),
    sourceId: z.string().min(1).max(120),
    notes: z.string().trim().max(500).nullish(),
    status: z.enum(["saved", "applied", "viewing", "rejected", "closed"]).nullish(),
  })
  .strict()
  .refine((body) => body.notes !== undefined || body.status !== undefined, {
    message: "Provide notes and/or status to update.",
  });
export type UpdateListingBody = z.infer<typeof updateListingBodySchema>;

export const deleteListingBodySchema = z
  .object({
    kind: z.literal("listing"),
    provider: z.string().min(1).max(60),
    sourceId: z.string().min(1).max(120),
  })
  .strict();

export const deleteSearchBodySchema = z
  .object({
    kind: z.literal("search"),
    id: z.string().min(1).max(64),
  })
  .strict();

export const deleteBodySchema = z.discriminatedUnion("kind", [
  deleteListingBodySchema,
  deleteSearchBodySchema,
]);
export type DeleteBody = z.infer<typeof deleteBodySchema>;

// --- Applications -------------------------------------------------------------

export const applicationContextSchema = z
  .object({
    firstName: z.string().trim().min(1).max(80),
    lastName: z.string().trim().min(1).max(80),
    occupation: z.string().trim().max(120).nullish(),
    moveInDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be yyyy-mm-dd")
      .nullish(),
    note: z.string().trim().max(1000).nullish(),
  })
  .strict();

export const createApplicationBodySchema = z
  .object({
    provider: z.string().min(1).max(60),
    sourceId: z.string().min(1).max(120),
    title: z.string().trim().max(160).nullish(),
    context: applicationContextSchema,
  })
  .strict();
export type CreateApplicationBody = z.infer<typeof createApplicationBodySchema>;

export const updateApplicationBodySchema = z
  .object({
    id: z.string().min(1).max(64),
    status: z
      .enum(["draft", "prepared", "contacted", "viewing", "accepted", "declined"])
      .nullish(),
    draft: z.string().trim().min(1).max(10000).nullish(),
  })
  .strict()
  .refine((body) => body.status !== undefined || body.draft !== undefined, {
    message: "Provide status and/or draft to update.",
  });
export type UpdateApplicationBody = z.infer<typeof updateApplicationBodySchema>;

export const removeApplicationBodySchema = z
  .object({ id: z.string().min(1).max(64) })
  .strict();

// --- Scam check ---------------------------------------------------------------

export const scamCheckBodySchema = z
  .object({
    text: z.string().trim().min(1).max(8000),
    useAi: z.boolean().optional().default(false),
  })
  .strict();
export type ScamCheckBody = z.infer<typeof scamCheckBodySchema>;
