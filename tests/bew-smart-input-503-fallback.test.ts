/**
 * Smart Input — production 2026-10 stress-test regression (Gemini 503).
 *
 * The stress test observed:
 *   - Gemini answered HTTP 503 UNAVAILABLE (high model demand);
 *   - the deterministic fallback extracted company / application e-mail /
 *     dates correctly — but left ADDRESS, PHONE, POSITION TITLE and
 *     INDUSTRY empty although all of them were explicitly stated in the ad.
 *
 * Pins both halves of the fix (no paid calls — fetch is mocked):
 *
 *   A. Bounded retry (bew-ad-ai.ts):
 *      - a transient 429/500/503 gets EXACTLY ONE retry after a short
 *        backoff, then falls back (never a retry loop, never a long wait);
 *      - a 503-then-200 sequence finishes with the AI extraction
 *        (source "ai" — the retry earned it, and is reported as AI);
 *      - non-transient errors (401/400) and first-attempt successes make
 *        exactly ONE request (no gratuitous retries);
 *      - HONESTY: a 503 fallback reports source "deterministic" +
 *        diagnostic "http-503" — never "ai".
 *
 *   B. Deterministic fallback floor (bew-ad-parser.ts):
 *      - explicit German titles: "Ausbildung zum/zur …", bare H1 headings
 *        ("Ausbildungsplatz Kfz-Mechatroniker"), slogans stay missing;
 *      - training location labels ("Arbeitsort: …") fill the address only
 *        when no postal address exists — an explicit Adresse/PLZ block
 *        always outranks the training location;
 *      - explicitly LABELED phones in mid-ad contact blocks are captured
 *        (read-only: the line stays in the brief); unlabeled prose numbers
 *        are never guessed;
 *      - industry floor: only an explicit term in the EMPLOYER'S IDENTITY
 *        (company line / company-description labels) maps to the closed
 *        taxonomy (verbatim subcategory, "suggested"); job-title words are
 *        never evidence; no term → missing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  extractSmartAd,
  BEW_INDUSTRY_LABELS,
  resetSmartInputDiagnostics,
} from "@/lib/bew-ad-ai";
import {
  classifyIndustryFromEvidence,
  parseAdvertisement,
} from "@/lib/bew-ad-parser";

/* ---------------------------- fixtures ---------------------------- */

/**
 * A stress-test-shaped advertisement: H1 title with "zum", company with an
 * explicit industry term, a TRAINING location label (no postal address
 * block anywhere), labeled dates, a LABELED phone sitting in the mid-ad
 * description region (no trailing contact heading for it), and an explicit
 * application directive plus a generic info@ address.
 */
const FALLBACK_STRESS_AD = [
  "Ausbildung zum Mechatroniker (m/w/d)",
  "",
  "Amberger Kühltechnik GmbH",
  "Wir suchen Verstärkung für unser Team.",
  "",
  "Arbeitsort: 92224 Amberg, Oberpfalz",
  "Ausbildungsbeginn: 01.09.2027",
  "Ausbildungsende: 31.08.2030",
  "Bewerbungsschluss: 30.06.2027",
  "",
  "Stellenbeschreibung",
  "Als Mechatroniker für Kältetechnik planst und wartest du Anlagen.",
  "Du arbeitest im Team und hast technisches Verständnis.",
  "Telefon: 09621/472983",
  "",
  "Wir bieten",
  "Eine faire Vergütung und ein freundliches Team.",
  "",
  "Kontakt",
  "E-Mail: info@amberger-kuehltechnik.de",
  "Bewerbungen (bitte) an: ausbildung@amberger-kuehltechnik.de",
].join("\n");

/** A valid (minimal) AI payload for the stress ad — grounded values only. */
const STRESS_AI = {
  company_name: "Amberger Kühltechnik GmbH",
  contact_name: null,
  contact_role: null,
  company_address: null,
  emails: [{ value: "ausbildung@amberger-kuehltechnik.de", context: "employer" }],
  phones: [{ value: "09621/472983", context: "employer" }],
  position_title: "Ausbildung zum Mechatroniker (m/w/d)",
  position_brief: null,
  start_date: "01.09.2027",
  end_date: "31.08.2030",
  application_deadline: "30.06.2027",
  industry: null,
};

function geminiEnvelope(payload: unknown): Response {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  return new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function gemini503(): Response {
  return new Response(
    JSON.stringify({
      error: { status: "UNAVAILABLE", message: "High demand, please retry later." },
    }),
    { status: 503, headers: { "content-type": "application/json" } },
  );
}

function withKey(): void {
  process.env.GEMINI_SMART_INPUT_API_KEY = "test-dedicated-key-0123456789";
}

beforeEach(() => {
  resetSmartInputDiagnostics();
  delete process.env.GEMINI_SMART_INPUT_API_KEY;
  delete process.env.GEMINI_SMART_INPUT_MODEL;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ---------------- A. bounded retry (mocked, no paid calls) ---------------- */

describe("transient 503 — bounded retry + honest fallback reporting", () => {
  it("persistent 503: EXACTLY two requests, then the deterministic floor with diagnostic http-503 (never 'ai')", async () => {
    withKey();
    const fetchMock = vi.fn(async () => gemini503());
    vi.stubGlobal("fetch", fetchMock);

    const out = await extractSmartAd(FALLBACK_STRESS_AD);

    expect(fetchMock).toHaveBeenCalledTimes(2); // initial + ONE retry — bounded
    expect(out.source).toBe("deterministic"); // honesty: the AI call did NOT succeed
    expect(out.diagnostic).toBe("http-503");
    expect(out.diagnosticDetail ?? "").toContain("UNAVAILABLE");
    // The floor still extracts EVERY explicitly stated field:
    expect(out.parsed.positionTitle.value).toBe("Ausbildung zum Mechatroniker (m/w/d)");
    expect(out.parsed.companyName.value).toBe("Amberger Kühltechnik GmbH");
    expect(out.parsed.companyEmail.value).toBe("ausbildung@amberger-kuehltechnik.de");
    expect(out.parsed.companyAddress.value).toBe("92224 Amberg, Oberpfalz");
    expect(out.parsed.companyPhone.value).toBe("09621/472983");
    expect(out.parsed.companyIndustry.value).toBe("HVAC & Refrigeration — Kühltechnik");
    expect(out.parsed.startDate.value).toBe("01.09.2027");
    expect(out.parsed.endDate.value).toBe("31.08.2030");
    expect(out.parsed.deadline.value).toBe("30.06.2027");
  });

  it("503 then 200: the single retry earns the AI result (source 'ai')", async () => {
    withKey();
    const responses = [gemini503(), geminiEnvelope(STRESS_AI)];
    let i = 0;
    const fetchMock = vi.fn(async () => responses[i++]);
    vi.stubGlobal("fetch", fetchMock);

    const out = await extractSmartAd(FALLBACK_STRESS_AD);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out.source).toBe("ai");
    expect(out.diagnostic).toBe("ai");
    expect(out.parsed.positionTitle.value).toBe("Ausbildung zum Mechatroniker (m/w/d)");
  });

  it("503 then 503: still bounded at two requests (no retry loop, no long wait)", async () => {
    withKey();
    const fetchMock = vi.fn(async () => gemini503());
    vi.stubGlobal("fetch", fetchMock);
    const started = Date.now();
    const out = await extractSmartAd(FALLBACK_STRESS_AD);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out.source).toBe("deterministic");
    // One short backoff only (the test keeps this coarse on purpose):
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it("400 (non-transient): exactly ONE request — never retried", async () => {
    withKey();
    const fetchMock = vi.fn(async () => new Response("bad", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await extractSmartAd(FALLBACK_STRESS_AD);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.source).toBe("deterministic");
    expect(out.diagnostic).toBe("http-400");
  });

  it("first-attempt success: exactly ONE request (no gratuitous retry)", async () => {
    withKey();
    const fetchMock = vi.fn(async () => geminiEnvelope(STRESS_AI));
    vi.stubGlobal("fetch", fetchMock);
    const out = await extractSmartAd(FALLBACK_STRESS_AD);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.source).toBe("ai");
  });
});

/* ---------------- B. deterministic fallback floor ---------------- */

describe("fallback floor — German titles (explicit, never slogans)", () => {
  const t = (lines: string[]) => parseAdvertisement(lines.join("\n"));

  it("'Ausbildung zum …' / 'Ausbildung zur …' preposition forms are extracted", () => {
    expect(
      t(["Firma A GmbH", "Ausbildung zum Mechatroniker (m/w/d)", "a@a.de"]).positionTitle,
    ).toMatchObject({ value: "Ausbildung zum Mechatroniker (m/w/d)", status: "extracted" });
    expect(
      t(["Firma A GmbH", "Ausbildung zur Fachkraft für Lagerlogistik", "a@a.de"]).positionTitle,
    ).toMatchObject({ value: "Ausbildung zur Fachkraft für Lagerlogistik", status: "extracted" });
  });

  it("a BARE H1 heading ('Ausbildungsplatz Kfz-Mechatroniker') is a suggested title", () => {
    const p = t(["Firma A GmbH", "Ausbildungsplatz Kfz-Mechatroniker", "a@a.de"]);
    expect(p.positionTitle.value).toBe("Ausbildungsplatz Kfz-Mechatroniker");
    expect(p.positionTitle.status).toBe("suggested");
  });

  it("slogons and years are NOT titles (never invented)", () => {
    expect(t(["Firma A GmbH", "Ausbildung mit Zukunft", "a@a.de"]).positionTitle.status).toBe(
      "missing",
    );
    expect(t(["Firma A GmbH", "Ausbildung 2027", "a@a.de"]).positionTitle.status).toBe("missing");
  });

  it("a labeled title still outranks the bare heading", () => {
    const p = t([
      "Firma A GmbH",
      "Ausbildungsplatz Kfz-Mechatroniker",
      "Ausbildung: Industriemechaniker",
      "a@a.de",
    ]);
    expect(p.positionTitle.value).toBe("Industriemechaniker");
    expect(p.positionTitle.status).toBe("extracted");
  });
});

describe("fallback floor — training location vs. postal address", () => {
  const t = (lines: string[]) => parseAdvertisement(lines.join("\n"));

  it("'Arbeitsort: …' fills the address (suggested) when no postal address exists", () => {
    const p = t(["Firma A GmbH", "Arbeitsort: 92224 Amberg, Oberpfalz", "a@a.de"]);
    expect(p.companyAddress.value).toBe("92224 Amberg, Oberpfalz");
    expect(p.companyAddress.status).toBe("suggested");
  });

  it("'Ausbildungsort: …' and 'Standort: …' are recognized too", () => {
    expect(t(["Firma A GmbH", "Ausbildungsort: Berlin", "a@a.de"]).companyAddress.value).toBe(
      "Berlin",
    );
    expect(t(["Firma A GmbH", "Standort: Köln-Nord", "a@a.de"]).companyAddress.value).toBe(
      "Köln-Nord",
    );
  });

  it("an explicit Adresse label always outranks the training location (both orders)", () => {
    const p1 = t([
      "Firma A GmbH",
      "Adresse: Hauptstr. 1, 12345 Musterstadt",
      "Arbeitsort: Andere Stadt",
      "a@a.de",
    ]);
    expect(p1.companyAddress.value).toBe("Hauptstr. 1, 12345 Musterstadt");
    expect(p1.companyAddress.status).toBe("extracted");
    const p2 = t([
      "Firma A GmbH",
      "Arbeitsort: Andere Stadt",
      "Adresse: Hauptstr. 1, 12345 Musterstadt",
      "a@a.de",
    ]);
    expect(p2.companyAddress.value).toBe("Hauptstr. 1, 12345 Musterstadt");
  });

  it("a street + PLZ block outranks the training location", () => {
    const p = t([
      "Firma A GmbH",
      "Arbeitsort: Andere Stadt",
      "Hauptstr. 1",
      "12345 Musterstadt",
      "a@a.de",
    ]);
    expect(p.companyAddress.value).toBe("Hauptstr. 1, 12345 Musterstadt");
  });
});

describe("fallback floor — explicitly labeled phones", () => {
  const t = (lines: string[]) => parseAdvertisement(lines.join("\n"));

  it("a labeled phone in the MID-AD description region is captured (read-only: the line stays in the brief)", () => {
    const p = t([
      "Firma A GmbH",
      "a@a.de",
      "Stellenbeschreibung",
      "Du lernst bei uns.",
      "Telefon: 09621/472983",
    ]);
    expect(p.companyPhone.value).toBe("09621/472983");
    expect(p.companyPhone.status).toBe("extracted");
    expect(p.positionBrief.value).toContain("Telefon: 09621/472983");
  });

  it("'Kontakt: <phone>' is a phone, never an invalid e-mail", () => {
    const p = t(["Firma A GmbH", "Kontakt: 09621/472983", "a@a.de"]);
    expect(p.companyPhone.value).toBe("09621/472983");
    expect(p.companyPhone.status).toBe("extracted");
    expect(p.companyEmail.value).toBe("a@a.de"); // not polluted by the digits
    expect(p.companyEmail.status).not.toBe("invalid");
  });

  it("an UNLABELED number in description prose is never a phone (no guessing)", () => {
    const p = t([
      "Firma A GmbH",
      "a@a.de",
      "Stellenbeschreibung",
      "Erreichbar unter 09621/472983 an Werktagen.",
    ]);
    expect(p.companyPhone.status).toBe("missing");
  });

  it("FAX is still consumed but never captured", () => {
    const p = t(["Firma A GmbH", "a@a.de", "Telefon: +49 30 123456", "Fax: 030 999888"]);
    expect(p.companyPhone.value).toBe("+49 30 123456");
    expect(p.companyPhone.value).not.toContain("999888");
  });
});

describe("fallback floor — industry (explicit employer evidence only)", () => {
  const t = (lines: string[]) => parseAdvertisement(lines.join("\n"));

  it("a term in the COMPANY NAME classifies (suggested, verbatim subcategory)", () => {
    const p = t(["Amberger Kühltechnik GmbH", "a@a.de"]);
    expect(p.companyIndustry.value).toBe("HVAC & Refrigeration — Kühltechnik");
    expect(p.companyIndustry.status).toBe("suggested");
  });

  it("a term in a company-DESCRIPTION label classifies", () => {
    const p = t([
      "Muster GmbH",
      "Unternehmensbeschreibung: Wir sind ein mittelständisches Kältetechnik-Unternehmen.",
      "a@muster.de",
    ]);
    expect(p.companyIndustry.value).toBe("HVAC & Refrigeration — Kältetechnik");
    expect(p.companyIndustry.status).toBe("suggested");
  });

  it("a JOB TITLE word alone is NEVER evidence (activity, not role)", () => {
    const p = t(["Muster GmbH", "Ausbildung Chemielaborant (m/w/d)", "a@muster.de"]);
    expect(p.positionTitle.value).toBe("Ausbildung Chemielaborant (m/w/d)");
    expect(p.companyIndustry.status).toBe("missing"); // never a guess
  });

  it("no explicit term → missing (never fabricated)", () => {
    expect(t(["Muster GmbH", "a@muster.de"]).companyIndustry.status).toBe("missing");
    expect(classifyIndustryFromEvidence([])).toBeNull();
    expect(classifyIndustryFromEvidence(["Mechatroniker"])).toBeNull();
  });

  it("every table category stays inside the closed BEW_INDUSTRY_LABELS taxonomy (verbatim subcategory grounds in the source)", () => {
    const samples: Array<[string, string]> = [
      ["Kältetechnik", "HVAC & Refrigeration"],
      ["Maschinenbau", "Machinery & Equipment"],
      ["Werkzeugbau", "Manufacturing"],
      ["Kfz-Technik", "Automotive"],
      ["Sanitär", "Skilled Trades"],
      ["Hochbau", "Construction & Real Estate"],
      ["Bau", "Construction & Real Estate"],
      ["Solartechnik", "Energy & Environment"],
      ["Chemie", "Chemical & Pharmaceutical"],
      ["Logistik", "Logistics & Transport"],
      ["Einzelhandel", "Retail & Wholesale"],
      ["Bäckerei", "Food & Beverage"],
      ["Hotel", "Hospitality & Tourism"],
      ["Pflege", "Health & Care"],
      ["Bank", "Finance & Insurance"],
      ["Berufsschule", "Education & Research"],
      ["Software", "IT & Software"],
      ["Telekommunikation", "Telecommunications"],
      ["Druckerei", "Media & Creative"],
      ["Steuerberatung", "Legal & Consulting"],
      ["öffentliche Hand", "Public Sector"],
      ["Zeitarbeit", "Staffing & Recruiting"],
    ];
    for (const [term, category] of samples) {
      const out = classifyIndustryFromEvidence([`Firma ${term} GmbH`]);
      expect(out, term).not.toBeNull();
      const [cat, sub] = out!.split(" — ");
      expect(BEW_INDUSTRY_LABELS, `${term}: ${cat}`).toContain(cat);
      expect(cat, term).toBe(category);
      // Grounded: the subcategory is a verbatim (case-insensitive) substring
      // of the source — nothing invented.
      expect(`Firma ${term} GmbH`.toLowerCase()).toContain(sub!.toLowerCase());
    }
  });
});

describe("fallback floor — application e-mail precedence (regression guard)", () => {
  it("the explicit application directive outranks the generic info@ even in the fallback", () => {
    const p = parseAdvertisement(FALLBACK_STRESS_AD);
    expect(p.companyEmail.value).toBe("ausbildung@amberger-kuehltechnik.de");
    expect(p.companyEmail.status).toBe("extracted");
    expect(p.companyEmail.value).not.toBe("info@amberger-kuehltechnik.de");
  });
});

/* ---------------- the EXACT production stress-test ad ---------------- */

/**
 * The EXACT advertisement from the 2026-10 production stress test (the paste
 * that hit Gemini HTTP 503 and degraded to the deterministic fallback).
 * Verbatim — it is a trap-rich ad on purpose (and in fact):
 *   - two distinct addresses (Betriebsanschrift vs. Postanschrift der
 *     Personalabteilung) plus a TRAINING location ("Standort der Ausbildung")
 *     that must NOT become the stored address;
 *   - two phones (Personalabteilung vs. Zentrale) — the HR one wins;
 *   - three e-mails (application / info / support) — the application one
 *     wins via the MULTI-LINE directive ("…ausschließlich per E-Mail an:" +
 *     address on the next line);
 *   - a decoy internal date (15.05.2027, explicitly NOT the deadline) plus
 *     the real labeled dates;
 *   - an all-caps title line ("AUSBILDUNG ZUM KAUFMANN / ZUR KAUFFRAU …");
 *   - the industry term in the company name ("Digital Commerce").
 */
const EXACT_STRESS_AD = [
  "Stellenangebot / Ausbildungsplatz 2027 – Bitte vollständig lesen!",
  "",
  "Unternehmen: Rhein-Main Digital Commerce GmbH",
  "Standort der Ausbildung: Köln, Nordrhein-Westfalen",
  "Betriebsanschrift: Aachener Straße 184, 50931 Köln",
  "Postanschrift der Personalabteilung: Musterallee 12, 50667 Köln",
  "",
  "Wir sind ein wachsendes Unternehmen im Bereich digitaler Handel, E-Commerce und Online-Marketing. Zum Ausbildungsbeginn im Sommer 2027 suchen wir eine motivierte Person für die",
  "",
  "AUSBILDUNG ZUM KAUFMANN / ZUR KAUFFRAU IM E-COMMERCE (m/w/d)",
  "",
  "Ausbildungsbeginn: 01.08.2027",
  "Reguläre Ausbildungsdauer: 3 Jahre",
  "Voraussichtliches Ausbildungsende: 31.07.2030",
  "",
  "WICHTIG: Das Datum 15.05.2027 ist das Datum unserer internen Vorauswahl und NICHT der offizielle Bewerbungsschluss.",
  "",
  "Bewerbungsschluss: 30.06.2027",
  "Frühester möglicher Vorstellungstermin: 10.07.2027",
  "",
  "Deine Aufgaben:",
  "- Pflege und Optimierung unseres Onlineshops",
  "- Erstellung und Aktualisierung von Produktbeschreibungen",
  "- Unterstützung bei SEO- und SEA-Kampagnen",
  "- Analyse von Conversion Rate, Warenkorbabbrüchen und Umsatzdaten",
  "- Mitarbeit bei Newsletter- und E-Mail-Marketing-Kampagnen",
  "- Koordination mit Vertrieb, Kundenservice und Logistik",
  "- Unterstützung bei der Planung von Social-Media-Aktivitäten",
  "",
  "Dein Profil:",
  "- Mittlerer Schulabschluss oder höher",
  "- Interesse an digitalen Geschäftsmodellen und Onlinehandel",
  "- Sorgfältige und strukturierte Arbeitsweise",
  "- Gute Deutschkenntnisse in Wort und Schrift",
  "- Grundkenntnisse in MS Office",
  "- Erste Erfahrungen mit Onlineshops sind willkommen, aber keine Voraussetzung",
  "",
  "Wir bieten:",
  "- Eine strukturierte, praxisorientierte Ausbildung",
  "- Betreuung durch ein erfahrenes Team",
  "- Einblicke in E-Commerce, Performance Marketing und Datenanalyse",
  "- Entwicklungsmöglichkeiten nach erfolgreichem Abschluss",
  "",
  "Ansprechpartnerin für Bewerbungen:",
  "Frau Dr. Lena Hoffmann",
  "Personalabteilung",
  "",
  "Bitte richten Sie Ihre vollständigen Bewerbungsunterlagen ausschließlich per E-Mail an:",
  "bewerbung-ausbildung@rheinmain-digital.example",
  "",
  "Für allgemeine Unternehmensanfragen:",
  "info@rheinmain-digital.example",
  "",
  "Für technische Fragen zum Onlineshop:",
  "support@rheinmain-digital.example",
  "",
  "Telefon Personalabteilung: +49 221 76543210",
  "Telefon Zentrale: +49 221 76543200",
  "",
  "Bitte beachten Sie:",
  "- Verwenden Sie für Ihre Bewerbung ausschließlich die Adresse bewerbung-ausbildung@rheinmain-digital.example.",
  "- Die allgemeine Info-Adresse ist nicht für Bewerbungen vorgesehen.",
  "- Die Support-Adresse ist ausschließlich für technische Kundenanfragen vorgesehen.",
  "- Die Personalabteilung befindet sich an der Postanschrift Musterallee 12, 50667 Köln. Der Ausbildungsbetrieb selbst befindet sich in der Aachener Straße 184, 50931 Köln.",
  "- Bitte verwechseln Sie den internen Vorauswahltermin nicht mit dem offiziellen Bewerbungsschluss.",
  "",
  "Wir freuen uns auf Ihre Bewerbung.",
  "",
  "Kontakt: Frau Dr. Lena Hoffmann, Personalabteilung.",
].join("\n");

describe("the EXACT production stress-test ad (2026-10, Gemini 503)", () => {
  it("mocked 503: the deterministic fallback extracts EVERY explicitly stated field (the reported regression)", async () => {
    withKey();
    const fetchMock = vi.fn(async () => gemini503());
    vi.stubGlobal("fetch", fetchMock);

    const out = await extractSmartAd(EXACT_STRESS_AD);

    // Honesty + bounded retry:
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out.source).toBe("deterministic"); // NOT "ai" — the AI call failed
    expect(out.diagnostic).toBe("http-503");
    expect(out.diagnosticDetail ?? "").toContain("UNAVAILABLE");

    const p = out.parsed;
    // The reported gaps — all explicitly stated in the ad, all extracted:
    expect(p.positionTitle.value).toBe("AUSBILDUNG ZUM KAUFMANN / ZUR KAUFFRAU IM E-COMMERCE (m/w/d)");
    expect(p.positionTitle.status).toBe("extracted");
    expect(p.companyAddress.value).toBe("Musterallee 12, 50667 Köln");
    expect(p.companyAddress.status).toBe("extracted");
    expect(p.companyPhone.value).toBe("+49 221 76543210"); // HR — NOT the Zentrale
    expect(p.companyPhone.value).not.toBe("+49 221 76543200");
    expect(p.companyIndustry.value).toBe("Retail & Wholesale — Commerce");
    expect(p.companyIndustry.status).toBe("suggested"); // explicit company-name term, reviewable
    // The already-working fields stay correct:
    expect(p.companyName.value).toBe("Rhein-Main Digital Commerce GmbH");
    expect(p.contactName.value).toBe("Frau Dr. Lena Hoffmann, Personalabteilung.");
    expect(p.startDate.value).toBe("01.08.2027");
    expect(p.endDate.value).toBe("31.07.2030");
    expect(p.deadline.value).toBe("30.06.2027"); // the REAL deadline
    expect(p.positionBrief.status).toBe("extracted");
    expect(p.positionBrief.value).toContain("Pflege und Optimierung unseres Onlineshops");
  });

  it("training location is distinguished from the stored postal address (never becomes it)", () => {
    const p = parseAdvertisement(EXACT_STRESS_AD);
    // "Standort der Ausbildung: Köln, Nordrhein-Westfalen" is the TRAINING
    // location — the stored address is the explicit HR postal address.
    expect(p.companyAddress.value).toBe("Musterallee 12, 50667 Köln");
    expect(p.companyAddress.value).not.toBe("Köln, Nordrhein-Westfalen");
    expect(p.companyAddress.value).not.toBe("Aachener Straße 184, 50931 Köln");
  });

  it("application e-mail outranks the generic info@ and support@ (multi-line directive)", () => {
    const p = parseAdvertisement(EXACT_STRESS_AD);
    expect(p.companyEmail.value).toBe("bewerbung-ausbildung@rheinmain-digital.example");
    expect(p.companyEmail.status).toBe("extracted");
    expect(p.companyEmail.value).not.toBe("info@rheinmain-digital.example");
    expect(p.companyEmail.value).not.toBe("support@rheinmain-digital.example");
  });

  it("the decoy internal date (15.05.2027) is never assigned to a field", () => {
    const p = parseAdvertisement(EXACT_STRESS_AD);
    for (const field of [p.startDate, p.endDate, p.deadline]) {
      expect(field.value).not.toBe("15.05.2027");
    }
  });

  it("the job content (tasks/profile/benefits) is preserved in the brief", () => {
    const p = parseAdvertisement(EXACT_STRESS_AD);
    expect(p.positionBrief.value).toContain("Erstellung und Aktualisierung von Produktbeschreibungen");
    expect(p.positionBrief.value).toContain("Mittlerer Schulabschluss oder höher");
    expect(p.positionBrief.value).toContain("Betreuung durch ein erfahrenes Team");
    // The labeled phone line stays verbatim in the brief (read-only claim):
    expect(p.positionBrief.value).toContain("Telefon Personalabteilung: +49 221 76543210");
  });
});
