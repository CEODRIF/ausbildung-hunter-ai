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

  it("captures the e-mail from the 'Bewerbung an:' line (suggested)", () => {
    expect(p.companyEmail.value).toBe("karriere@kuehlo-gmbh.de");
    expect(p.companyEmail.status).toBe("suggested");
  });

  it("extracts the company from the legal form and leaves the role line as residual header", () => {
    expect(p.companyName.value).toBe("KÜHLO GmbH");
    expect(p.companyName.status).toBe("extracted");
  });

  it("does not invent a position title without a reliable signal", () => {
    expect(p.positionTitle.status).toBe("missing");
    expect(p.positionTitle.value).toBe("");
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
