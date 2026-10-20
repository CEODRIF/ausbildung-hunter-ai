import { describe, expect, it } from "vitest";

import {
  BEW_AD_INPUT_MAX,
  adAutoAddGate,
  parseAdvertisement,
} from "@/lib/bew-ad-parser";

/**
 * The complete German Kälte- und Klimatechnik Ausbildung advertisement from
 * the feature design (BA / career-page style paste). Verbatim structure:
 * contact block first, then labelled role metadata, then the description.
 */
const KAELTE_AD = [
  "Informationen zur Bewerbung",
  "Amberger Kühltechnik GmbH",
  "Frau Stefanie Bernklau",
  "Dr.-Aigner-Str. 15",
  "92224 Amberg, Oberpfalz",
  "Telefon: +49 9621 472983",
  "E-Mail: bernklaustefanie@amberger-kuehltechnik.de",
  "",
  "Ausbildung: Mechatroniker/in - Kältetechnik",
  "Beginn: 01.08.2027",
  "Ort: Amberg",
  "Anstellungsart: Vollzeit",
  "Schulabschluss: Mittlere Reife / Mittlerer Bildungsabschluss",
  "Beschreibung: Als Mechatroniker für Kältetechnik plant, montierst und wartest du Anlagen der Kälte- und Klimatechnik. Du sorgst dafür, dass die Kälteanlagen beim Kunden einwandfrei funktionieren.",
].join("\n");

describe("parseAdvertisement — complete German Kälte ad (test 1–3)", () => {
  const p = parseAdvertisement(KAELTE_AD);

  it("extracts the company name from the legal form line", () => {
    expect(p.companyName.value).toBe("Amberger Kühltechnik GmbH");
    expect(p.companyName.status).toBe("extracted");
  });

  it("extracts the contact person as a suggestion (Frau … line)", () => {
    expect(p.contactName.value).toBe("Frau Stefanie Bernklau");
    expect(p.contactName.status).toBe("suggested");
  });

  it("joins street + postal-code lines into one address", () => {
    expect(p.companyAddress.value).toBe("Dr.-Aigner-Str. 15, 92224 Amberg, Oberpfalz");
    expect(p.companyAddress.status).toBe("suggested");
  });

  it("extracts the labelled e-mail address", () => {
    expect(p.companyEmail.value).toBe("bernklaustefanie@amberger-kuehltechnik.de");
    expect(p.companyEmail.status).toBe("extracted");
  });

  it("extracts the position title SEPARATELY from the description", () => {
    expect(p.positionTitle.value).toBe("Mechatroniker/in - Kältetechnik");
    expect(p.positionTitle.status).toBe("extracted");
  });

  it("extracts the job description from the 'Beschreibung:' content", () => {
    expect(p.positionBrief.value).toBe(
      "Als Mechatroniker für Kältetechnik plant, montierst und wartest du Anlagen der Kälte- und Klimatechnik. Du sorgst dafür, dass die Kälteanlagen beim Kunden einwandfrei funktionieren.",
    );
    expect(p.positionBrief.status).toBe("extracted");
    // The title must not leak into the brief and vice versa.
    expect(p.positionBrief.value).not.toContain("Mechatroniker/in - Kältetechnik");
    expect(p.positionTitle.value).not.toContain("Als Mechatroniker");
  });

  it("does not treat 'Informationen zur Bewerbung' as company or contact", () => {
    expect(p.companyName.value).not.toBe("Informationen zur Bewerbung");
    expect(p.contactName.value).not.toBe("Informationen zur Bewerbung");
  });

  it("passes the auto-add gate (company + valid e-mail + within limits)", () => {
    expect(adAutoAddGate(p)).toEqual({ ok: true });
  });
});

describe("parseAdvertisement — sectioned ad with bullets (test 3–4)", () => {
  const SECTIONED_AD = [
    "KÜHLO GmbH",
    "Ausbildungsplatz Mechatronik (m/w/d)",
    "",
    "Wir suchen zum 01.09.2027 Verstärkung für unser Team.",
    "",
    "Stellenbeschreibung",
    "Als Mechatroniker (m/w/d) lernst du:",
    "- Anlagen der Kältetechnik warten",
    "- Fehler analysieren und beheben",
    "- Kunden betreuen",
    "",
    "Anforderungen",
    "- Teamfähigkeit",
    "- Technisches Verständnis",
    "- Freude am Handwerk",
    "",
    "Wir bieten",
    "- Übernahmemöglichkeit",
    "- Weiterbildung",
    "- Team Events",
    "",
    "Bewerbung an: karriere@kuehlo-gmbh.de",
  ].join("\n");

  const p = parseAdvertisement(SECTIONED_AD);

  it("preserves the COMPLETE description including all sections and bullets", () => {
    expect(p.positionBrief.value).toBe(
      [
        "Stellenbeschreibung",
        "Als Mechatroniker (m/w/d) lernst du:",
        "- Anlagen der Kältetechnik warten",
        "- Fehler analysieren und beheben",
        "- Kunden betreuen",
        "",
        "Anforderungen",
        "- Teamfähigkeit",
        "- Technisches Verständnis",
        "- Freude am Handwerk",
        "",
        "Wir bieten",
        "- Übernahmemöglichkeit",
        "- Weiterbildung",
        "- Team Events",
      ].join("\n"),
    );
    expect(p.positionBrief.status).toBe("extracted");
  });

  it("stops the brief at the 'Bewerbung an:' contact section", () => {
    expect(p.positionBrief.value).not.toContain("Bewerbung an");
  });

  it("captures the e-mail from the 'Bewerbung an:' line — the explicit application directive is the STRONG signal (extracted)", () => {
    // NORDSTERN contract (2026-10-20): an explicit "Bewerbung an:" address
    // outranks a generic "E-Mail:" label, whatever the line order.
    expect(p.companyEmail.value).toBe("karriere@kuehlo-gmbh.de");
    expect(p.companyEmail.status).toBe("extracted");
  });

  it("extracts the company from the legal form and leaves the role line as residual header", () => {
    expect(p.companyName.value).toBe("KÜHLO GmbH");
    expect(p.companyName.status).toBe("extracted");
  });

  it("the bare title heading line IS a reliable signal → suggested title (503-fallback gap)", () => {
    // The second line of this ad is the ad's own title heading. The old
    // fallback left the title empty for exactly this shape (no preposition,
    // no label) — the production 2026-10 stress test reported it; it is now
    // captured as "suggested" (explicit-looking, reviewable — not invented).
    expect(p.positionTitle.value).toBe("Ausbildungsplatz Mechatronik (m/w/d)");
    expect(p.positionTitle.status).toBe("suggested");
  });
});

describe("parseAdvertisement — missing optionals (test 5)", () => {
  it("keeps absent fields missing instead of guessing", () => {
    const p = parseAdvertisement("Simple Firma GmbH\njobs@simple-firma.de");
    expect(p.companyName.value).toBe("Simple Firma GmbH");
    expect(p.companyEmail.value).toBe("jobs@simple-firma.de");
    expect(p.contactName.status).toBe("missing");
    expect(p.companyAddress.status).toBe("missing");
    expect(p.positionTitle.status).toBe("missing");
    expect(p.positionBrief.status).toBe("missing");
  });

  it("returns all-missing for empty / whitespace-only input", () => {
    for (const text of ["", "   \n\t  \n"]) {
      const p = parseAdvertisement(text);
      expect(p.companyName.status).toBe("missing");
      expect(p.companyEmail.status).toBe("missing");
      expect(p.contactName.status).toBe("missing");
      expect(p.companyAddress.status).toBe("missing");
      expect(p.positionTitle.status).toBe("missing");
      expect(p.positionBrief.status).toBe("missing");
      expect(adAutoAddGate(p).ok).toBe(false);
    }
  });
});

describe("parseAdvertisement — invalid e-mail (test 6)", () => {
  it("flags a malformed labelled e-mail as invalid (never invents one)", () => {
    const p = parseAdvertisement("ABC GmbH\nE-Mail: info@abc");
    expect(p.companyEmail.status).toBe("invalid");
    expect(p.companyEmail.value).toBe("info@abc");
    expect(adAutoAddGate(p)).toEqual({ ok: false, code: "PARSE_INVALID_EMAIL" });
  });

  it("flags a malformed bare e-mail as invalid", () => {
    const p = parseAdvertisement("ABC GmbH\nschreib an: hallo(at)abc.de");
    // no real token → email stays missing
    expect(p.companyEmail.status).toBe("missing");
  });

  it("rejects an ad with no recognizable company (gate)", () => {
    const p = parseAdvertisement("hallo@nowhere.de");
    expect(p.companyName.status).toBe("missing");
    expect(adAutoAddGate(p)).toEqual({ ok: false, code: "PARSE_NO_COMPANY" });
  });

  it("rejects an ad with a company but no e-mail (gate)", () => {
    const p = parseAdvertisement("NoMail GmbH\nKeine E-Mail vorhanden.");
    expect(adAutoAddGate(p)).toEqual({ ok: false, code: "PARSE_NO_EMAIL" });
  });
});

describe("parseAdvertisement — misleading navigation labels (test 8)", () => {
  it("drops cookie/portal noise lines and never uses them as fields", () => {
    const p = parseAdvertisement(
      [
        "Impressum",
        "Datenschutz",
        "Cookies",
        "Zurück zur Liste",
        "Muster Software Solutions",
        "Kontakt: Dr. Anna Weber",
        "info@muster-software.com",
        "Referenz: 2027-441",
      ].join("\n"),
    );
    expect(p.companyName.value).toBe("Muster Software Solutions");
    expect(p.companyName.status).toBe("suggested");
    expect(p.contactName.value).toBe("Dr. Anna Weber");
    expect(p.contactName.status).toBe("extracted");
    expect(p.companyEmail.value).toBe("info@muster-software.com");
    // The short 'Referenz:' metadata line does not pollute the brief.
    expect(p.positionBrief.status).toBe("missing");
  });

  it("ignores a 'JETZT BEWERBEN' CTA line (noise) inside the text", () => {
    const p = parseAdvertisement(
      [
        "Beta GmbH",
        "Stellenbeschreibung",
        "Du lernst bei uns.",
        "JETZT BEWERBEN",
        "Mehr anzeigen",
      ].join("\n"),
    );
    expect(p.positionBrief.value).toBe("Stellenbeschreibung\nDu lernst bei uns.");
    expect(p.positionBrief.value).not.toContain("BEWERBEN");
  });
});

describe("parseAdvertisement — conservative extraction rules", () => {
  it("uses the all-caps role heading as a SUGGESTED title", () => {
    const p = parseAdvertisement(
      [
        "NORDWIND ELEKTRIK GMBH",
        "MECHATRONIKER KÄLTEREGELTECHNIK",
        "jobs@nordwind.de",
      ].join("\n"),
    );
    expect(p.companyName.value).toBe("NORDWIND ELEKTRIK GMBH");
    expect(p.positionTitle.value).toBe("MECHATRONIKER KÄLTEREGELTECHNIK");
    expect(p.positionTitle.status).toBe("suggested");
    expect(p.companyEmail.value).toBe("jobs@nordwind.de");
  });

  it("recognizes 'Ausbildung als …' title lines", () => {
    const p = parseAdvertisement(
      [
        "Gamma GmbH",
        "Ausbildung als Fachinformatiker (m/w/d)",
        "hr@gamma.de",
      ].join("\n"),
    );
    expect(p.positionTitle.value).toBe("Ausbildung als Fachinformatiker (m/w/d)");
    expect(p.positionTitle.status).toBe("extracted");
  });

  it("keeps long residual text as the brief (user's own paste, not invention)", () => {
    const p = parseAdvertisement(
      [
        "Delta GmbH",
        "info@delta.de",
        "Wir bilden aus und suchen motivierte Azubis, die Technik lieben und sich einbringen wollen.",
      ].join("\n"),
    );
    expect(p.positionBrief.status).toBe("extracted");
    expect(p.positionBrief.value).toContain("Wir bilden aus");
  });

  it("does not promote a short residual (e.g. 'HR') to a brief", () => {
    const p = parseAdvertisement("Epsilon GmbH\nHR\nhr@epsilon.de");
    expect(p.positionBrief.status).toBe("missing");
  });
});

describe("parseAdvertisement — DB-limit rules (no silent truncation)", () => {
  it("flags a > 4000-char brief as invalid/too_long and keeps the FULL value", () => {
    const longBrief = "x".repeat(4001);
    const p = parseAdvertisement(`Long GmbH\ntest@long.de\nBeschreibung: ${longBrief}`);
    expect(p.positionBrief.status).toBe("invalid");
    expect(p.positionBrief.problem).toBe("too_long");
    expect(p.positionBrief.value).toHaveLength(4001); // NOT truncated
    expect(adAutoAddGate(p)).toEqual({ ok: false, code: "POSITION_TOO_LONG" });
  });

  it("flags a > 160-char title as invalid/too_long and keeps the FULL value", () => {
    const longTitle =
      "Mechatroniker:in für Kälte- und Klimatechnik mit Schwerpunkt Industrieanlagenbau, Instandhaltung und Automatisierungstechnik und Wartung von Industrieanlagen in Vollzeit";
    expect(longTitle.length).toBeGreaterThan(160);
    const p = parseAdvertisement(`Long GmbH\ntest@long.de\nAusbildung: ${longTitle}`);
    expect(p.positionTitle.status).toBe("invalid");
    expect(p.positionTitle.problem).toBe("too_long");
    expect(p.positionTitle.value).toBe(longTitle); // NOT truncated
    expect(adAutoAddGate(p).ok).toBe(false);
  });

  it("accepts values exactly at the limit", () => {
    const atMax = "y".repeat(4000);
    const p = parseAdvertisement(`Max GmbH\ntest@max.de\nBeschreibung: ${atMax}`);
    expect(p.positionBrief.status).toBe("extracted");
    expect(adAutoAddGate(p)).toEqual({ ok: true });
  });
});

describe("parseAdvertisement — robustness", () => {
  it("sets tooLongInput for pastes beyond BEW_AD_INPUT_MAX", () => {
    const p = parseAdvertisement("A".repeat(BEW_AD_INPUT_MAX + 1));
    expect(p.tooLongInput).toBe(true);
  });

  it("strips zero-width characters injected by copy from portals", () => {
    const p = parseAdvertisement("Zeta\u200b GmbH\njobs@zeta\u200b.de");
    expect(p.companyName.value).toBe("Zeta GmbH");
    expect(p.companyEmail.value).toBe("jobs@zeta.de");
  });

  it("collapses runs of blank lines to single paragraph breaks", () => {
    const p = parseAdvertisement(
      [
        "Eta GmbH",
        "jobs@eta.de",
        "Stellenbeschreibung",
        "Erster Absatz.",
        "",
        "",
        "",
        "Zweiter Absatz.",
      ].join("\n"),
    );
    expect(p.positionBrief.value).toBe("Stellenbeschreibung\nErster Absatz.\n\nZweiter Absatz.");
  });

  it("normalizes CRLF input from Windows clipboard", () => {
    const p = parseAdvertisement("Theta GmbH\r\njobs@theta.de\r\nBeschreibung: Ein Satz hier.");
    expect(p.companyEmail.value).toBe("jobs@theta.de");
    expect(p.positionBrief.value).toBe("Ein Satz hier.");
  });
});

/* ------------------------------------------------------------------ *
 * Regression: the REAL Seco Kältetechnik GmbH advertisement.
 *
 * The reported failure: after pasting this ad and clicking "Auto-organize"
 * the UI showed the generic "Something went wrong" while the live preview
 * held a prefixed company name ("Unternehmensdarstellung: Seco …") and
 * "not found" contact/address. This block pins the exact extraction.
 * Keep the text verbatim (it mirrors the user's paste).
 * ------------------------------------------------------------------ */

const SECO_CONTACT_BLOCK = [
  "Kontaktadresse",
  "Seco Kältetechnik GmbH",
  "Frau Christina Brandenburg – Personalreferentin",
  "Herzogstr. 28",
  "44807 Bochum",
  "",
  "Telefon: +49 234 90437014",
  "E-Mail: christina.brandenburg@secokaelte.de",
].join("\n");

const SECO_FULL_AD = [
  "Mechatroniker:in Kältetechnik (m/w/d)",
  "",
  "Unternehmensdarstellung: Seco Kältetechnik GmbH",
  "",
  "Stellenbeschreibung",
  "Seco Kältetechnik sucht engagierte Auszubildende für das Handwerk der Kälte- und Klimatechnik.",
  "Du montierst, wartest und reparierst Kälteanlagen bei Kunden und im Außendienst.",
  "",
  "Wir bieten",
  "Rabatte für Mitarbeitende",
  "Weiterbildungen",
  "Betriebliche Altersvorsorge",
  "Dienstwagen",
  "Parkmöglichkeiten",
  "Gute Verkehrsanbindung",
  "Moderne technische Ausstattung",
  "Die aufgeführten Vorteile für Mitarbeitende können je nach Abteilung und Position variieren.",
  "Alle Stellen anzeigen in neuem Tab öffnen",
  "Webseiten",
  "Webpage",
  "Homepage",
  "Social Media Seiten",
  "",
  SECO_CONTACT_BLOCK,
].join("\n");

describe("parseAdvertisement — Seco Kältetechnik real advertisement (regression)", () => {
  it("full ad: company WITHOUT the Unternehmensdarstellung prefix, contact + combined address + exact e-mail", () => {
    const p = parseAdvertisement(SECO_FULL_AD);
    expect(p.companyName.value).toBe("Seco Kältetechnik GmbH");
    expect(p.companyName.status).toBe("extracted");
    expect(p.companyName.value).not.toContain("Unternehmensdarstellung");
    expect(p.contactName.value).toBe("Frau Christina Brandenburg – Personalreferentin");
    expect(p.contactName.status).toBe("suggested"); // conservative, never "verified"
    expect(p.companyAddress.value).toBe("Herzogstr. 28, 44807 Bochum");
    expect(p.companyAddress.status).toBe("suggested");
    expect(p.companyEmail.value).toBe("christina.brandenburg@secokaelte.de");
    expect(p.companyEmail.status).toBe("extracted");
  });

  it("full ad: the meaningful description (tasks + benefits) is preserved, navigation text is not", () => {
    const brief = parseAdvertisement(SECO_FULL_AD).positionBrief;
    expect(brief.status).toBe("extracted");
    // Preserved content:
    expect(brief.value).toContain("Stellenbeschreibung");
    expect(brief.value).toContain(
      "Seco Kältetechnik sucht engagierte Auszubildende für das Handwerk der Kälte- und Klimatechnik.",
    );
    expect(brief.value).toContain("Du montierst, wartest und reparierst Kälteanlagen bei Kunden und im Außendienst.");
    expect(brief.value).toContain("Wir bieten");
    expect(brief.value).toContain("Rabatte für Mitarbeitende");
    expect(brief.value).toContain("Betriebliche Altersvorsorge");
    expect(brief.value).toContain(
      "Die aufgeführten Vorteile für Mitarbeitende können je nach Abteilung und Position variieren.",
    );
    // Excluded: portal navigation + the contact block (it is metadata, not description):
    for (const forbidden of [
      "Alle Stellen anzeigen",
      "Webseiten",
      "Webpage",
      "Homepage",
      "Social Media",
      "Kontaktadresse",
      "Herzogstr",
      "44807",
      "christina.brandenburg@secokaelte.de",
      "Telefon:",
      "Frau Christina",
    ]) {
      expect(brief.value, `brief must not contain: ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("full ad: the auto-add gate PASSES (company + valid e-mail present)", () => {
    expect(adAutoAddGate(parseAdvertisement(SECO_FULL_AD))).toEqual({ ok: true });
  });

  it("contact block ALONE: all four fields extracted, no description invented", () => {
    const p = parseAdvertisement(SECO_CONTACT_BLOCK);
    expect(p.companyName.value).toBe("Seco Kältetechnik GmbH");
    expect(p.companyName.status).toBe("extracted");
    expect(p.contactName.value).toBe("Frau Christina Brandenburg – Personalreferentin");
    expect(p.companyAddress.value).toBe("Herzogstr. 28, 44807 Bochum");
    expect(p.companyEmail.value).toBe("christina.brandenburg@secokaelte.de");
    expect(p.companyEmail.status).toBe("extracted");
    expect(p.positionTitle.status).toBe("missing");
    expect(p.positionBrief.status).toBe("missing"); // nothing invented
    expect(adAutoAddGate(p)).toEqual({ ok: true });
  });

  it("strips company-profile label prefixes (Unternehmensdarstellung / -profil / Firmenprofil / -beschreibung)", () => {
    for (const label of [
      "Unternehmensdarstellung",
      "Unternehmensprofil",
      "Firmenprofil",
      "Unternehmensbeschreibung",
    ]) {
      const p = parseAdvertisement(`${label}: Seco Kältetechnik GmbH\ninfo@seco.de`);
      expect(p.companyName.value, label).toBe("Seco Kältetechnik GmbH");
      expect(p.companyName.status, label).toBe("extracted");
    }
  });

  it("a VALID e-mail that is only suggested (unverified) is NOT rejected by the gate", () => {
    const text = [
      "Seco Kältetechnik GmbH",
      "Beschreibung: Wir suchen Verstärkung im Außendienst für die Wartung von Kälteanlagen.",
      "Bewerbung per Mail an christina.brandenburg@secokaelte.de",
    ].join("\n");
    const p = parseAdvertisement(text);
    expect(p.companyEmail.value).toBe("christina.brandenburg@secokaelte.de");
    expect(p.companyEmail.status).toBe("suggested"); // found, not externally verified
    expect(adAutoAddGate(p)).toEqual({ ok: true }); // must NOT be auto-rejected
  });
});

/* ------------------------------------------------------------------ *
 * Advertisement dates (start / end / deadline) — labeled lines only
 * ------------------------------------------------------------------ */

describe("parseAdvertisement — advertisement dates (labeled, verbatim)", () => {
  const ad = (lines: string[]) =>
    parseAdvertisement(["Rheinblick Digital Solutions GmbH", "info@rheinblick.de", ...lines].join("\n"));

  it("extracts a labeled start date (Beginn: 01.08.2027)", () => {
    const p = ad(["Beginn: 01.08.2027"]);
    expect(p.startDate.value).toBe("01.08.2027");
    expect(p.startDate.status).toBe("extracted");
  });

  it("extracts Ausbildungsbeginn with a verbal date, verbatim", () => {
    const p = ad(["Ausbildungsbeginn: 01. September 2027"]);
    expect(p.startDate.value).toBe("01. September 2027");
    expect(p.startDate.status).toBe("extracted");
  });

  it("extracts the deadline (Bewerbungsschluss / Bewerbungsfrist / Frist)", () => {
    expect(ad(["Bewerbungsschluss: 30.06.2027"]).deadline.value).toBe("30.06.2027");
    expect(ad(["Bewerbungsfrist: 30.06.2027"]).deadline.value).toBe("30.06.2027");
    expect(ad(["Frist: 30.06.2027"]).deadline.value).toBe("30.06.2027");
  });

  it("extracts 'Bewerbung bis …' without a colon", () => {
    expect(ad(["Bewerbung bis 30.06.2027"]).deadline.value).toBe("30.06.2027");
    expect(ad(["Bewerbungen bis zum 30.06.2027"]).deadline.value).toBe("30.06.2027");
  });

  it("extracts the end date — 'Dauer: X bis Y' takes the SECOND date", () => {
    const p = ad(["Dauer: 01.09.2027 bis 31.08.2030"]);
    expect(p.endDate.value).toBe("31.08.2030");
    expect(p.endDate.status).toBe("extracted");
  });

  it("extracts 'Ende der Ausbildung: …'", () => {
    expect(ad(["Ende der Ausbildung: 31.08.2030"]).endDate.value).toBe("31.08.2030");
  });

  it("extracts a year-less deadline verbatim (30.06.)", () => {
    expect(ad(["Bewerbungsschluss: 30.06."]).deadline.value).toBe("30.06.");
  });

  it("a labeled line WITHOUT a parseable date is NOT assigned (never guessed)", () => {
    const p = ad(["Beginn: ab sofort", "Bewerbungsschluss: offen"]);
    expect(p.startDate.status).toBe("missing");
    expect(p.deadline.status).toBe("missing");
  });

  it("an UNLABELED bare date line is never assigned to any field", () => {
    const p = ad(["01.09.2027", "30.06.2027"]);
    expect(p.startDate.status).toBe("missing");
    expect(p.endDate.status).toBe("missing");
    expect(p.deadline.status).toBe("missing");
  });

  it("an ad without dates keeps all three missing (never invented)", () => {
    const p = parseAdvertisement(KAELTE_AD.split("\n").slice(0, 7).join("\n"));
    expect(p.startDate.status).toBe("missing");
    expect(p.endDate.status).toBe("missing");
    expect(p.deadline.status).toBe("missing");
  });

  it("the existing Kälte fixture: 'Beginn: 01.08.2027' is now the start date", () => {
    const p = parseAdvertisement(KAELTE_AD);
    expect(p.startDate.value).toBe("01.08.2027");
    expect(p.startDate.status).toBe("extracted");
  });

  it("labeled date lines do not leak into the residual brief", () => {
    const p = ad([
      "Beginn: 01.09.2027",
      "Bewerbungsschluss: 30.06.2027",
      "In unserem Team lernst du moderne Softwareentwicklung in einer kreativen Agentur.",
    ]);
    expect(p.positionBrief.value).not.toContain("01.09.2027");
    expect(p.positionBrief.value).not.toContain("30.06.2027");
    expect(p.positionBrief.value).toContain("moderne Softwareentwicklung");
  });

  it("a date value is never mistaken for a phone number", () => {
    const p = ad(["Beginn: 01.09.2027"]);
    expect(p.companyPhone.status).toBe("missing");
  });
});

/* ------------------------------------------------------------------ *
 * NORDSTERN production repro (2026-10-20, Smart Input preview) —
 * application e-mail ranking + applicant exclusion + dates/position.
 *
 * Reconstructed 1:1 (structure + visible content) from the preview
 * screenshot: the deterministic fallback had selected the GENERIC
 * info@ address although the ad explicitly directs applications to
 * ausbildung@…, and a former applicant's own e-mail/phone sits inside
 * the ad body.
 * ------------------------------------------------------------------ */

const NORDSTERN_LINES = [
  "Nordstern Digitalhandel GmbH",
  "Frau Miriam Schneider",
  "Spitalerstraße 12",
  "20095 Hamburg",
  "Telefon: +49 40 6382 7426",
  "E-Mail: info@nordstern-digital.example",
  "Bewerbungsschluss: 15.06.2027",
  "",
  "Aufgaben:",
  "- Pflege und Optimierung unseres Online-Shops",
  "- Unterstützung bei Online-Marketing-Kampagnen",
  "- Analyse von Verkaufszahlen und Kundenverhalten",
  "- Erstellung von Produkttexten und Social-Media-Posts",
  "",
  "Voraussetzungen:",
  "- Interesse an E-Commerce und digitalen Medien",
  "- Gute Kommunikationsfähigkeiten",
  "- Selbstständige und zuverlässige Arbeitsweise",
  "",
  "Hinweis: Daniel Fischer [daniel.fischer@applicant-mail.example, +49 151 2345 6789] ist ein ehemaliger Bewerber und kein Mitarbeiter oder Ansprechpartner des Unternehmens.",
  "",
  "Bewerbungen bitte an: ausbildung@nordstern-digital.example",
];

describe("NORDSTERN repro — application e-mail ranking, applicant exclusion, dates", () => {
  it("the explicit 'Bewerbungen bitte an:' address OVERRANKS the generic info@ (any line order)", () => {
    const p = parseAdvertisement(NORDSTERN_LINES.join("\n"));
    expect(p.companyEmail.value).toBe("ausbildung@nordstern-digital.example");
    expect(p.companyEmail.status).toBe("extracted");
    // The generic label is present in the source but never selected.
    expect(p.companyEmail.value).not.toBe("info@nordstern-digital.example");
    // …and the former applicant's own address is never a company contact.
    expect(p.companyEmail.value).not.toBe("daniel.fischer@applicant-mail.example");
  });

  it("the directive wins even when it sits BEFORE the generic E-Mail label", () => {
    const lines = [
      "Nordstern Digitalhandel GmbH",
      "E-Mail: info@nordstern-digital.example",
      "Bewerbungen bitte an: ausbildung@nordstern-digital.example",
    ];
    const p = parseAdvertisement(lines.join("\n"));
    expect(p.companyEmail.value).toBe("ausbildung@nordstern-digital.example");
  });

  it("WITHOUT any directive the generic labeled address is kept (old behavior)", () => {
    const lines = NORDSTERN_LINES.filter((l) => !l.startsWith("Bewerbungen bitte an"));
    const p = parseAdvertisement(lines.join("\n"));
    expect(p.companyEmail.value).toBe("info@nordstern-digital.example");
    expect(p.companyEmail.status).toBe("extracted");
  });

  it("extracts company / contact / address / HR phone exactly as the preview showed", () => {
    const p = parseAdvertisement(NORDSTERN_LINES.join("\n"));
    expect(p.companyName.value).toBe("Nordstern Digitalhandel GmbH");
    expect(p.contactName.value).toBe("Frau Miriam Schneider");
    expect(p.companyAddress.value).toBe("Spitalerstraße 12, 20095 Hamburg");
    // The HR phone — NOT the former applicant's mobile in the Hinweis line.
    expect(p.companyPhone.value).toBe("+49 40 6382 7426");
    expect(p.companyPhone.value).not.toBe("+49 151 2345 6789");
  });

  it("deadline extracted; start/end stay MISSING (no labeled lines — never invented)", () => {
    const p = parseAdvertisement(NORDSTERN_LINES.join("\n"));
    expect(p.deadline.value).toBe("15.06.2027");
    expect(p.deadline.status).toBe("extracted");
    expect(p.startDate.status).toBe("missing");
    expect(p.endDate.status).toBe("missing");
    // The position has no recognizable label in this ad → missing (labeled
    // variants are covered below). The industry floor now classifies from
    // the explicit term in the COMPANY NAME ("Digitalhandel") — closed
    // taxonomy + verbatim subcategory, "suggested" (reviewable).
    expect(p.positionTitle.status).toBe("missing");
    expect(p.companyIndustry.value).toBe("Retail & Wholesale — Digitalhandel");
    expect(p.companyIndustry.status).toBe("suggested");
  });

  it("labeled position + labeled start/end variants are extracted verbatim", () => {
    const p = parseAdvertisement(
      [
        "Nordstern Digitalhandel GmbH",
        "E-Mail: info@nordstern-digital.example",
        "Ausbildungsberuf: Kaufmann für E-Commerce (m/w/d)",
        "Ausbildungsbeginn: 01.09.2027",
        "Ausbildungsende: 31.08.2030",
        "Bewerbungsschluss: 15.06.2027",
      ].join("\n"),
    );
    expect(p.positionTitle.value).toBe("Kaufmann für E-Commerce (m/w/d)");
    expect(p.positionTitle.status).toBe("extracted");
    expect(p.startDate.value).toBe("01.09.2027");
    expect(p.endDate.value).toBe("31.08.2030");
    expect(p.deadline.value).toBe("15.06.2027");
  });

  it("an EXPLICITLY VERBED date in prose IS assigned (2nd-round contract: 'startet am' / 'endet am')", () => {
    // Round 1 kept these missing; the production follow-up (2026-10-20)
    // requires explicitly stated verb dates ("… startet am 01.09.2027 …")
    // to be extracted. A date with NO label/verb at all stays missing
    // (see the 'Termin' negative in the verb-form suite below).
    const p = parseAdvertisement(
      [
        "Nordstern Digitalhandel GmbH",
        "E-Mail: info@nordstern-digital.example",
        "Die Ausbildung startet am 01.09.2027 und endet am 31.08.2030.",
      ].join("\n"),
    );
    expect(p.startDate.value).toBe("01.09.2027");
    expect(p.endDate.value).toBe("31.08.2030");
  });

  it("an applicant-marked line is the ONLY e-mail → the field stays missing (never filed to a former applicant)", () => {
    const p = parseAdvertisement(
      [
        "Nordstern Digitalhandel GmbH",
        "Hinweis: Daniel Fischer [daniel.fischer@applicant-mail.example] ist ein ehemaliger Bewerber.",
      ].join("\n"),
    );
    expect(p.companyEmail.value).not.toBe("daniel.fischer@applicant-mail.example");
    expect(p.companyEmail.status).toBe("missing");
    expect(adAutoAddGate(p).ok).toBe(false); // PARSE_NO_EMAIL — actionable
  });

  it("the brief preserves the job content but NOT the application directive line", () => {
    const p = parseAdvertisement(NORDSTERN_LINES.join("\n"));
    expect(p.positionBrief.value).toContain("Pflege und Optimierung unseres Online-Shops");
    expect(p.positionBrief.value).toContain("Interesse an E-Commerce und digitalen Medien");
    expect(p.positionBrief.value).not.toContain("Bewerbungen bitte an");
    expect(p.positionBrief.value).not.toContain("ausbildung@nordstern-digital.example");
  });
});

/* ------------------------------------------------------------------ *
 * Production follow-up (2026-10-20, second round):
 *   - pasted MARKDOWN ads (bold labels, headings, links)
 *   - VERB-FORM date phrases ("beginnt am …", "endet am …", "zum …")
 * ------------------------------------------------------------------ */

describe("Markdown pastes are normalized before parsing", () => {
  const MD_AD = [
    "**Unternehmen:** Nordstern Digitalhandel GmbH",
    "### Kontakt",
    "**Ansprechpartner:** Frau Miriam Schneider",
    "**Adresse:** Spitalerstraße 12, 20095 Hamburg",
    "**Telefon:** +49 40 6382 7426",
    "**E-Mail:** info@nordstern-digital.example",
    "**Bewerbungen an:** ausbildung@nordstern-digital.example",
    "# Aufgaben",
    "- Pflege und Optimierung unseres Online-Shops",
    "- [Online-Marketing](https://nordstern-digital.example/marketing) unterstützen",
    "- Analyse von Verkaufszahlen und Kundenverhalten",
  ].join("\n");

  it("bold labels are recognized (company / contact / address / phone)", () => {
    const p = parseAdvertisement(MD_AD);
    expect(p.companyName.value).toBe("Nordstern Digitalhandel GmbH");
    expect(p.contactName.value).toBe("Frau Miriam Schneider");
    expect(p.companyAddress.value).toBe("Spitalerstraße 12, 20095 Hamburg");
    expect(p.companyPhone.value).toBe("+49 40 6382 7426");
  });

  it("the explicit application directive still outranks the generic label (Markdown form)", () => {
    const p = parseAdvertisement(MD_AD);
    expect(p.companyEmail.value).toBe("ausbildung@nordstern-digital.example");
    expect(p.companyEmail.status).toBe("extracted");
  });

  it("heading markers disappear; link LABELS are kept, link URLs are dropped", () => {
    const p = parseAdvertisement(MD_AD);
    expect(p.positionBrief.value).toContain("Pflege und Optimierung unseres Online-Shops");
    expect(p.positionBrief.value).toContain("Online-Marketing unterstützen");
    expect(p.positionBrief.value).not.toContain("nordstern-digital.example/marketing");
    expect(p.positionBrief.value).not.toContain("###");
    expect(p.positionBrief.value).not.toContain("# Aufgaben");
    expect(p.positionBrief.value).not.toContain("**");
  });

  it("lone underscores / asterisks in job titles are NOT touched (m/w_d stays)", () => {
    const p = parseAdvertisement(
      [
        "Nordstern GmbH",
        "info@nordstern.example",
        "Position: Mechatroniker:in (m/w_d)",
        "Stellenbeschreibung",
        "Wir suchen Teamplayer:innen.",
      ].join("\n"),
    );
    expect(p.positionTitle.value).toBe("Mechatroniker:in (m/w_d)");
  });
});

describe("verb-form date phrases (explicitly stated — never guessed)", () => {
  it("'beginnt am …' and 'endet am …' extract BOTH dates from one prose line in the body", () => {
    const p = parseAdvertisement(
      [
        "Nordstern Digitalhandel GmbH",
        "E-Mail: info@nordstern-digital.example",
        "Stellenbeschreibung",
        "Die Ausbildung beginnt am 01.09.2027 und endet am 31.08.2030.",
        "Bewerbungen bitte an: ausbildung@nordstern-digital.example",
      ].join("\n"),
    );
    expect(p.startDate.value).toBe("01.09.2027");
    expect(p.startDate.status).toBe("extracted");
    expect(p.endDate.value).toBe("31.08.2030");
    expect(p.endDate.status).toBe("extracted");
    // The line STAYS in the description (read-only claim, verbatim).
    expect(p.positionBrief.value).toContain(
      "Die Ausbildung beginnt am 01.09.2027 und endet am 31.08.2030.",
    );
  });

  it("'startet zum …' and 'Ende der Ausbildung: …' are both recognized", () => {
    const p = parseAdvertisement(
      [
        "Nordstern Digitalhandel GmbH",
        "E-Mail: info@nordstern-digital.example",
        "Die Ausbildung startet zum 01.09.2027.",
        "Ende der Ausbildung: 31.08.2030",
        "Stellenbeschreibung",
        "Text.",
      ].join("\n"),
    );
    expect(p.startDate.value).toBe("01.09.2027");
    expect(p.endDate.value).toBe("31.08.2030");
  });

  it("a date WITHOUT an explicit label/verb is still never assigned (no guessing)", () => {
    const p = parseAdvertisement(
      [
        "Nordstern Digitalhandel GmbH",
        "E-Mail: info@nordstern-digital.example",
        "Stellenbeschreibung",
        "Der Termin 01.09.2027 ist wichtig für uns.",
      ].join("\n"),
    );
    expect(p.startDate.status).toBe("missing");
    expect(p.endDate.status).toBe("missing");
    expect(p.deadline.status).toBe("missing");
  });

  it("'Ende.' (the ad end marker) is not a date label and stays harmless", () => {
    const p = parseAdvertisement(
      [
        "Nordstern Digitalhandel GmbH",
        "E-Mail: info@nordstern-digital.example",
        "Stellenbeschreibung",
        "Wir freuen uns auf dich.",
        "Ende.",
      ].join("\n"),
    );
    expect(p.endDate.status).toBe("missing");
  });
});
