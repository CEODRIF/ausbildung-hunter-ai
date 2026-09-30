/**
 * Pure normalization layer between the AI's raw JSON text and the strict
 * candidateProfileSchema (Bewerbung Scanner).
 *
 * Why: the scanner prompt requests an exact snake_case shape, but LLMs
 * deviate in harmless, structural ways — code fences, surrounding
 * commentary, wrapper objects (`profile`/`data`/`candidateProfile`),
 * camelCase keys, comma-strings instead of arrays, missing optional
 * fields, invalid enum values. The strict schema (which stays the final
 * security/type boundary) then rejects the WHOLE profile on any one of
 * these. This module coerces structure only:
 *
 *   - extracts the JSON object from fenced/surrounded text
 *   - unwraps common wrapper objects
 *   - maps camelCase keys to the schema's snake_case keys
 *   - converts malformed optional arrays to arrays/empty arrays
 *   - drops invalid array entries instead of failing the profile
 *   - normalizes invalid experience types to "employment"
 *   - coerces known booleans/years from common string forms
 *   - keeps the SCAN GOAL authoritative from the server row (never the AI)
 *   - NEVER invents personal facts (only truncation, nulling, dropping,
 *     and backfilling a value that already exists in the same entry)
 *   - NEVER interprets document content (the untrusted-reference-material
 *     security model in the prompt is unchanged)
 */

export type ProfileGoal = "ausbildung" | "arbeit";

type PlainObject = Record<string, unknown>;

const isPlainObject = (value: unknown): value is PlainObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

/** Trim + hard cap (preserves data, never invents). null for non-strings. */
const strOrNull = (value: unknown, max = 500): string | null => {
  if (isNonEmptyString(value)) return value.trim().slice(0, max);
  if (typeof value === "number" && Number.isFinite(value))
    return String(value).slice(0, max);
  return null;
};

/** Array of strings; a comma/semicolon string becomes one entry per part. */
const strArray = (value: unknown, max = 200): string[] => {
  const items: unknown[] = Array.isArray(value)
    ? value
    : isNonEmptyString(value)
      ? value.split(/[,;]/)
      : [];
  return items.filter(isNonEmptyString).map((s) => (s as string).trim().slice(0, max));
};

const boolOrNull = (value: unknown): boolean | null => {
  if (typeof value === "boolean") return value;
  if (value === "yes" || value === "true" || value === "ja" || value === 1)
    return true;
  if (value === "no" || value === "false" || value === "nein" || value === 0)
    return false;
  return null;
};

const boolOrFalse = (value: unknown): boolean =>
  value === true || value === "true" || value === 1;

const validSource = (value: unknown): "ai_extracted" | "user_provided" =>
  value === "user_provided" ? "user_provided" : "ai_extracted";

const EXPERIENCE_TYPES = new Set([
  "employment",
  "internship",
  "freelance",
  "other",
]);

const gradYear = (value: unknown): number | string | null => {
  if (typeof value === "number" && Number.isInteger(value))
    return value >= 1900 && value <= 2100 ? value : String(value);
  if (isNonEmptyString(value)) {
    const trimmed = value.trim();
    if (/^\d{4}$/.test(trimmed) && +trimmed >= 1900 && +trimmed <= 2100)
      return +trimmed;
    return trimmed.slice(0, 20);
  }
  return null;
};

/** 1) Extract the JSON object from fenced or commentary-surrounded text. */
export function extractJsonObject(raw: string): unknown {
  const text = String(raw ?? "");
  const candidates: string[] = [];
  const fence = text.match(/```[a-zA-Z0-9_-]*\s*([\s\S]*?)```/);
  if (fence) candidates.push(fence[1]);
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
  candidates.push(text.trim());
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (isPlainObject(value)) return value;
    } catch {
      /* try the next candidate */
    }
  }
  // Last resort: string-aware balanced-brace scan of the first object.
  const start = text.indexOf("{");
  if (start !== -1) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        try {
          const value = JSON.parse(text.slice(start, i + 1));
          if (isPlainObject(value)) return value;
        } catch {
          break;
        }
      }
    }
  }
  throw new Error("AI response contained no parseable JSON object");
}

const WRAPPER_KEYS = new Set([
  "candidateprofile",
  "candidate_profile",
  "profile",
  "data",
  "result",
  "response",
  "output",
]);

/** 2) Unwrap common single-key wrapper objects (max 3 levels). */
export function unwrapProfile(data: unknown): unknown {
  let current: unknown = data;
  for (let depth = 0; depth < 3; depth++) {
    if (!isPlainObject(current)) return current;
    const node: PlainObject = current;
    const key = Object.keys(node).find(
      (k) => WRAPPER_KEYS.has(k.toLowerCase()) && isPlainObject(node[k]),
    );
    if (!key) return current;
    current = node[key];
  }
  return current;
}

const KEY_ALIASES: Record<string, string> = { linked_in: "linkedin" };
const toSnake = (key: string) =>
  key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();

/** 3) Recursively map camelCase keys to the schema's snake_case keys. */
export function snakeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snakeKeys);
  if (!isPlainObject(value)) return value;
  const out: PlainObject = {};
  for (const [key, val] of Object.entries(value)) {
    const snake = toSnake(key);
    out[KEY_ALIASES[snake] ?? snake] = snakeKeys(val);
  }
  return out;
}

/** 4) Structural coercion toward the schema shape (see module header). */
export function normalizeProfile(
  raw: unknown,
  goal: ProfileGoal,
): unknown {
  // Fail loudly on non-objects: silently treating garbage as {} would let
  // an unparseable response masquerade as an (empty) profile.
  if (!isPlainObject(raw)) {
    throw new Error("AI profile is not a JSON object");
  }
  const data = raw;
  const p: PlainObject = {};

  const candidate = isPlainObject(data.candidate) ? data.candidate : null;
  if (candidate) {
    const contact = isPlainObject(candidate.contact)
      ? candidate.contact
      : null;
    const candidateOut: PlainObject = {
      full_name: strOrNull(candidate.full_name),
      location: strOrNull(candidate.location),
      country: strOrNull(candidate.country),
      current_location: strOrNull(candidate.current_location),
      target_location: strArray(candidate.target_location),
    };
    if (contact)
      candidateOut.contact = {
        email: strOrNull(contact.email),
        phone: strOrNull(contact.phone),
        linkedin: strOrNull(contact.linkedin),
      };
    p.candidate = candidateOut;
  }

  // The scan goal comes from the server row — never from the model.
  p.goal = goal;

  if (Array.isArray(data.education)) {
    p.education = data.education.filter(isPlainObject).map((e) => ({
      school: strOrNull(e.school),
      university: strOrNull(e.university),
      degree: strOrNull(e.degree),
      field_of_study: strOrNull(e.field_of_study),
      graduation_year: gradYear(e.graduation_year),
      education_level: strOrNull(e.education_level),
      source: validSource(e.source),
    }));
  }

  if (Array.isArray(data.training)) {
    p.training = data.training
      .filter(isPlainObject)
      .map((t) => ({
        name: isNonEmptyString(t.name) ? t.name.trim().slice(0, 300) : null,
        provider: strOrNull(t.provider),
        year: strOrNull(t.year),
        source: validSource(t.source),
      }))
      // `name` is required by the schema — entries without it are dropped.
      .filter((t) => t.name !== null);
  }

  if (Array.isArray(data.experience)) {
    p.experience = data.experience
      .filter(isPlainObject)
      .map((x) => ({
        job_title: isNonEmptyString(x.job_title)
          ? x.job_title.trim().slice(0, 300)
          : null,
        company: strOrNull(x.company),
        responsibilities: strArray(x.responsibilities),
        start_date: strOrNull(x.start_date),
        end_date: strOrNull(x.end_date),
        // Invalid/missing types normalize to "employment" (spec).
        type: EXPERIENCE_TYPES.has(x.type as string) ? x.type : "employment",
        source: validSource(x.source),
      }))
      // `job_title` is required by the schema — entries without it drop.
      .filter((x) => x.job_title !== null);
  }

  const skills = isPlainObject(data.skills) ? data.skills : {};
  p.skills = {
    technical: strArray(skills.technical),
    software_tools: strArray(skills.software_tools),
    marketing: strArray(skills.marketing),
    it: strArray(skills.it),
    soft: strArray(skills.soft),
  };

  if (Array.isArray(data.languages)) {
    p.languages = data.languages
      .filter(isPlainObject)
      .map((l) => ({
        language: isNonEmptyString(l.language)
          ? l.language.trim().slice(0, 100)
          : null,
        level: isNonEmptyString(l.level) ? l.level.trim().slice(0, 50) : null,
        level_is_inferred: boolOrFalse(l.level_is_inferred),
        source: validSource(l.source),
      }))
      // `language` is required by the schema.
      .filter((l) => l.language !== null);
  }

  const preferences = isPlainObject(data.preferences) ? data.preferences : null;
  if (preferences) {
    p.preferences = {
      target:
        preferences.target === "ausbildung" || preferences.target === "arbeit"
          ? preferences.target
          : null,
      preferred_job_titles: strArray(preferences.preferred_job_titles),
      preferred_industries: strArray(preferences.preferred_industries),
      preferred_locations: strArray(preferences.preferred_locations),
      willing_to_relocate: boolOrNull(preferences.willing_to_relocate),
      remote_hybrid_preference: strOrNull(preferences.remote_hybrid_preference),
    };
  }

  if (Array.isArray(data.target_roles)) {
    p.target_roles = data.target_roles
      .filter(isPlainObject)
      .map((r) => {
        const role = isNonEmptyString(r.role) ? r.role.trim().slice(0, 200) : null;
        // Backfill from a value that already exists in the same entry.
        const reason = isNonEmptyString(r.reason)
          ? r.reason.trim().slice(0, 500)
          : role;
        return { role, reason, source: validSource(r.source) };
      })
      .filter((r) => r.role !== null && r.reason !== null);
  }

  p.strengths = strArray(data.strengths);
  p.missing_information = strArray(data.missing_information);
  p.potential_concerns = strArray(data.potential_concerns);
  p.keywords = strArray(data.keywords);

  return p;
}

/** Full pipeline: raw AI text → schema-ready object (throws if no JSON). */
export function normalizeAiProfileResponse(
  raw: string,
  goal: ProfileGoal,
): unknown {
  const data = snakeKeys(unwrapProfile(extractJsonObject(raw)));
  return normalizeProfile(data, goal);
}
