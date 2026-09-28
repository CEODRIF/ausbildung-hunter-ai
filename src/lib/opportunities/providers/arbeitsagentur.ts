import "server-only";

import {
  opportunitySchema,
  type Opportunity,
  type OpportunitySearchParams,
} from "@/lib/opportunities/types";

const SEARCH_URL =
  "https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v6/jobs";
const DETAILS_URL =
  "https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v4/jobdetails";
const SOURCE_NAME = "Bundesagentur für Arbeit Jobsuche";
const SOURCE_URL = "https://www.arbeitsagentur.de/jobsuche/";

function config() {
  const apiKey = process.env.ARBEITSAGENTUR_API_KEY || "jobboerse-jobsuche";
  return { apiKey };
}
function base64Ref(ref: string) {
  return Buffer.from(ref, "utf8").toString("base64");
}
function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function safeDate(value: unknown) {
  const result = text(value);
  return result && !Number.isNaN(Date.parse(result))
    ? new Date(result).toISOString()
    : null;
}

export type BAResult = { opportunity: Opportunity; rawRef: string };
export async function searchArbeitsagentur(
  params: OpportunitySearchParams,
): Promise<{ results: BAResult[]; total: number; warning?: string }> {
  const query = new URLSearchParams({
    page: String(params.page),
    size: String(params.pageSize),
    angebotsart: params.goal === "ausbildung" ? "4" : "1",
  });
  const keyword = [params.keyword, params.profession].filter(Boolean).join(" ");
  if (keyword) query.set("was", keyword);
  if (params.city) query.set("wo", params.city);
  if (params.bundesland) query.set("wo", params.bundesland);
  if (params.company) query.set("arbeitgeber", params.company);
  if (params.radius !== undefined) query.set("umkreis", String(params.radius));
  if (params.freshnessDays !== undefined)
    query.set("veroeffentlichtseit", String(params.freshnessDays));
  if (params.remoteType === "remote") query.set("arbeitszeit", "ho");
  try {
    const response = await fetch(`${SEARCH_URL}?${query.toString()}`, {
      headers: { "X-API-Key": config().apiKey, accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok)
      return {
        results: [],
        total: 0,
        warning: `The ${SOURCE_NAME} provider returned HTTP ${response.status}.`,
      };
    const raw = (await response.json()) as {
      ergebnisliste?: unknown[];
      stellenangebote?: unknown[];
      maxErgebnisse?: string | number;
    };
    const results = (raw.ergebnisliste ?? raw.stellenangebote ?? []).flatMap(
      (item) => normalizeSearchItem(item, params.goal),
    );
    return {
      results,
      total: Number(raw.maxErgebnisse || results.length) || results.length,
    };
  } catch {
    return {
      results: [],
      total: 0,
      warning: `${SOURCE_NAME} could not be reached right now.`,
    };
  }
}

function normalizeSearchItem(
  item: unknown,
  goal: "ausbildung" | "arbeit",
): BAResult[] {
  if (!item || typeof item !== "object") return [];
  const value = item as Record<string, unknown>;
  const ref = text(value.refnr) || text(value.referenznummer);
  const title = text(value.beruf) || text(value.stellenangebotsTitel);
  const sourceUrl =
    text(value.externeURL) ||
    text(value.externeUrl) ||
    (ref ? `${SOURCE_URL}jobdetail/${encodeURIComponent(ref)}` : null);
  if (!ref || !title || !sourceUrl) return [];
  const locationRoot = Array.isArray(value.stellenlokationen)
    ? value.stellenlokationen[0]
    : null;
  const location =
    locationRoot &&
    typeof locationRoot === "object" &&
    "adresse" in locationRoot &&
    locationRoot.adresse &&
    typeof locationRoot.adresse === "object"
      ? (locationRoot.adresse as Record<string, unknown>)
      : value.arbeitsort && typeof value.arbeitsort === "object"
        ? (value.arbeitsort as Record<string, unknown>)
        : {};
  const opportunity = opportunitySchema.parse({
    id: `arbeitsagentur:${ref}`,
    provider: "arbeitsagentur",
    source_url: sourceUrl,
    source_name: SOURCE_NAME,
    title,
    company_name: text(value.arbeitgeber) || text(value.firma),
    company_url: null,
    description: null,
    location:
      [text(location.ort), text(location.region)].filter(Boolean).join(", ") ||
      null,
    city: text(location.ort),
    postal_code: location.plz ? String(location.plz) : null,
    bundesland: text(location.region),
    country: text(location.land) || "Deutschland",
    employment_type: goal === "ausbildung" ? "Ausbildung" : "Arbeit",
    goal,
    profession: title,
    ausbildung_occupation: goal === "ausbildung" ? title : null,
    salary: null,
    salary_min: null,
    salary_max: null,
    currency: null,
    start_date:
      safeDate(value.eintrittsdatum) ||
      (value.eintrittszeitraum && typeof value.eintrittszeitraum === "object"
        ? safeDate((value.eintrittszeitraum as Record<string, unknown>).von)
        : null),
    application_deadline: null,
    posted_at:
      safeDate(value.aktuelleVeroeffentlichungsdatum) ||
      (value.veroeffentlichungszeitraum &&
      typeof value.veroeffentlichungszeitraum === "object"
        ? safeDate(
            (value.veroeffentlichungszeitraum as Record<string, unknown>).von,
          )
        : null) ||
      safeDate(value.datumErsteVeroeffentlichung),
    updated_at:
      safeDate(value.modifikationsTimestamp) || safeDate(value.aenderungsdatum),
    remote_type: value.homeofficemoeglich === true ? "remote_possible" : null,
    required_skills: [],
    preferred_skills: [],
    required_languages: [],
    education_requirements: [],
    experience_requirements: [],
    extracted_keywords: [],
    retrieved_at: new Date().toISOString(),
    provider_job_id: ref,
    match: null,
  });
  return [{ opportunity, rawRef: ref }];
}

export async function getArbeitsagenturDetails(
  ref: string,
  goal: "ausbildung" | "arbeit",
) {
  const response = await fetch(
    `${DETAILS_URL}/${encodeURIComponent(base64Ref(ref))}`,
    {
      headers: { "X-API-Key": config().apiKey, accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(12000),
    },
  );
  if (!response.ok) throw new Error("The vacancy details are unavailable.");
  const value = (await response.json()) as Record<string, unknown>;
  const location =
    value.arbeitsgeberAdresse && typeof value.arbeitsgeberAdresse === "object"
      ? (value.arbeitsgeberAdresse as Record<string, unknown>)
      : {};
  const opportunity = opportunitySchema.parse({
    id: `arbeitsagentur:${ref}`,
    provider: "arbeitsagentur",
    source_url: `${SOURCE_URL}jobdetail/${encodeURIComponent(ref)}`,
    source_name: SOURCE_NAME,
    title:
      text(value.stellenangebotsTitel) ||
      text(value.titel) ||
      text(value.beruf) ||
      "Untitled vacancy",
    company_name: text(value.arbeitgeber),
    company_url: text(value.arbeitgeberdarstellungUrl),
    description:
      text(value.stellenangebotsBeschreibung) ||
      text(value.stellenbeschreibung),
    location:
      [text(location.ort), text(location.region)].filter(Boolean).join(", ") ||
      null,
    city: text(location.ort),
    postal_code: text(location.plz),
    bundesland: text(location.region),
    country: text(location.land) || "Deutschland",
    employment_type: text(value.arbeitszeitmodelle) || null,
    goal,
    profession: text(value.beruf),
    ausbildung_occupation: goal === "ausbildung" ? text(value.beruf) : null,
    salary: text(value.verguetung),
    salary_min: null,
    salary_max: null,
    currency: "EUR",
    start_date: safeDate(value.eintrittsdatum),
    application_deadline: null,
    posted_at: safeDate(value.aktuelleVeroeffentlichungsdatum),
    updated_at: safeDate(value.modifikationsTimestamp),
    remote_type: null,
    required_skills: [],
    preferred_skills: [],
    required_languages: [],
    education_requirements: [],
    experience_requirements: [],
    extracted_keywords: [],
    retrieved_at: new Date().toISOString(),
    provider_job_id: ref,
    match: null,
  });
  return opportunity;
}
