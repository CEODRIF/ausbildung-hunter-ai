/**
 * Realistic German Lebenslauf (CV) fixture for the Bewerbung Scanner.
 *
 * The fixture is a real, multi-page PDF (built deterministically below —
 * no binary blob, no external generator) whose text contains every section
 * a German CV usually has, including all German characters:
 * ä ö ü Ä Ö Ü ß
 *
 * It is used by:
 *   - tests/pdf-german-cv.test.ts        (extraction regression)
 *   - tests/bewerbung-cv-pipeline.test.ts (extraction → prompt → mocked AI →
 *                                          normalization → schema)
 */

// ---------------------------------------------------------------------------
// CV content (source of truth). One entry per rendered line. `title` lines
// are rendered larger. The en-dash ranges mirror how real German CVs are
// written ("2023–2026").
// ---------------------------------------------------------------------------

type CvLine = { text: string; title?: boolean; sub?: boolean };

export const DE_CV_LINES: CvLine[] = [
  { text: "Lara Müller", title: true },
  { text: "Lebenslauf" },
  { text: "" },
  { text: "Persönliche Daten" },
  { text: "Name: Lara Müller" },
  { text: "Geburtsdatum: 14.03.2004" },
  { text: "Wohnort: Musterstraße 12, 50667 Köln, Deutschland" },
  { text: "E-Mail: lara.mueller@example.com" },
  { text: "Telefon: +49 151 23456789" },
  { text: "Staatsangehörigkeit: deutsch / marokkanisch" },
  { text: "" },
  { text: "Ausbildung" },
  {
    text: "2023–2026    Studium: English Studies, Bachelor of Arts (B.A.), Universität zu Köln",
  },
  { text: "2019–2022    Berthold-Schmidt-Gymnasium Köln, Abitur (Note 2,6)" },
  { text: "" },
  { text: "Berufserfahrung" },
  {
    text: "2025–2026    Werkstudentin Online-Marketing – Muster E-Commerce GmbH, Köln",
  },
  { text: "- Konzeption und Betreuung von SEO- und SEA-Kampagnen", sub: true },
  { text: "- Änderungen an Produkttexten und Kampagnen", sub: true },
  { text: "- Pflege des Online-Shops und Analyse der Shopkennzahlen", sub: true },
  {
    text: "2024         Aushilfe im Kundenservice – Muster E-Commerce GmbH, Köln",
  },
  { text: "- Bearbeitung von Kundenanfragen per E-Mail und Telefon", sub: true },
  { text: "- Öffentliche Kommunikation im Social-Media-Bereich", sub: true },
  { text: "" },
  { text: "Praktika" },
  {
    text: "07/2024–09/2024    Praktikum E-Commerce & Affiliate Marketing – Shopland GmbH, Bonn",
  },
  {
    text: "- Aufbau von Affiliate-Kampagnen und Partner-Kommunikation",
    sub: true,
  },
  { text: "- Erstellung von Produkttexten und Social-Media-Posts", sub: true },
  { text: "- Planung und Umsetzung von Marketing-Maßnahmen", sub: true },
  { text: "" },
  { text: "Sprachkenntnisse" },
  { text: "Arabisch    Muttersprache" },
  { text: "Englisch    B2 (Cambridge Certificate)" },
  { text: "Deutsch     B1 (Goethe-Zertifikat)" },
  { text: "" },
  { text: "IT-Kenntnisse" },
  { text: "MS Office: Excel, Word, PowerPoint" },
  { text: "SAP (Grundkenntnisse)" },
  { text: "Adobe Photoshop (Basiskenntnisse)" },
  { text: "" },
  { text: "Kenntnisse" },
  { text: "E-Commerce, Online-Marketing, SEO, SEA, Affiliate Marketing" },
  { text: "Onlinehandel, Social Media, Content Creation" },
  { text: "Übersetzungen Deutsch / Englisch / Arabisch" },
  { text: "" },
  { text: "Weiterbildungen" },
  { text: "2024    Zertifikat Online-Marketing – IHK Köln" },
  { text: "2025    Kurs Digital Commerce – Handelsakademie NRW" },
  { text: "" },
  { text: "Zertifikate" },
  { text: "Cambridge English: B2 First (2023)" },
  { text: "Goethe-Zertifikat B1 (2022)" },
  { text: "" },
  { text: "Interessen" },
  { text: "Fotografie, Reisen, Social Media" },
];

// Page break: the CV flows over two pages (like a real 2-page Lebenslauf).
const PAGE_BREAK_AFTER = "Englisch    B2 (Cambridge Certificate)";

/** Strings that MUST appear verbatim in the extracted text. */
export const DE_CV_EXPECTED_SNIPPETS: string[] = [
  // required sections
  "Persönliche Daten",
  "Ausbildung",
  "Berufserfahrung",
  "Praktika",
  "Sprachkenntnisse",
  "IT-Kenntnisse",
  "Kenntnisse",
  "Weiterbildungen",
  "Zertifikate",
  "Interessen",
  // personal data
  "Lara Müller",
  "Musterstraße 12",
  "Köln",
  "lara.mueller@example.com",
  "+49 151 23456789",
  // education
  "English Studies",
  "Bachelor of Arts",
  "Universität zu Köln",
  "Berthold-Schmidt-Gymnasium Köln",
  "Abitur",
  "2023–2026",
  "2019–2022",
  // experience
  "Werkstudentin Online-Marketing",
  "Muster E-Commerce GmbH",
  "Aushilfe im Kundenservice",
  "Praktikum E-Commerce & Affiliate Marketing",
  "Shopland GmbH",
  "07/2024–09/2024",
  "SEO- und SEA-Kampagnen",
  // languages
  "Muttersprache",
  "Cambridge Certificate",
  "Goethe-Zertifikat",
  // skills & tools
  "MS Office: Excel, Word, PowerPoint",
  "SAP (Grundkenntnisse)",
  "E-Commerce, Online-Marketing, SEO, SEA, Affiliate Marketing",
  "Onlinehandel, Social Media, Content Creation",
  // training / certificates / interests
  "Zertifikat Online-Marketing – IHK Köln",
  "Kurs Digital Commerce – Handelsakademie NRW",
  "Fotografie, Reisen, Social Media",
  // every German character, plus compound words that use them
  "Musterstraße", // ß
  "Änderungen", // Ä
  "Öffentliche Kommunikation", // Ö
  "Übersetzungen", // Ü
  "Maßnahmen", // ß
  "Kampagnen",
];

/** Every single German special character must survive extraction. */
export const DE_UMLAUTS = ["ä", "ö", "ü", "Ä", "Ö", "Ü", "ß"];

// ---------------------------------------------------------------------------
// PDF builder — deterministic, dependency-free (WinAnsi Helvetica).
// ---------------------------------------------------------------------------

/**
 * Map a handful of typographic characters onto their WinAnsi single-byte
 * values so the fixture PDF can be written as a latin1 buffer. Everything
 * else in the CV is plain latin1 (German umlauts are ≤ 0xFF by luck of
 * encoding).
 */
function toWinAnsi(text: string): string {
  return text
    .replace(/–/g, "\x96") // –
    .replace(/—/g, "\x97") // —
    .replace(/’/g, "\x92") // '
    .replace(/“/g, "\x93") // "
    .replace(/”/g, "\x94") // "
    .replace(/…/g, "\x85") // …
    .replace(/•/g, "\x95"); // •
}

function escapePdfString(line: string): string {
  return toWinAnsi(line).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function contentStream(lines: CvLine[]): string {
  const parts: string[] = ["BT", "/F1 16 Tf", "72 750 Td"];
  let y = 750;
  for (const line of lines) {
    if (y < 72) break; // page full (should not happen with this fixture)
    if (line.title) {
      if (parts.length > 3) parts.push("ET");
      parts.push("BT", "/F1 16 Tf", `72 ${y} Td`, `(${escapePdfString(line.text)}) Tj`);
      y -= 24;
    } else if (line.sub) {
      if (parts.length > 3) parts.push("ET");
      parts.push("BT", "/F1 10 Tf", `96 ${y} Td`, `(${escapePdfString(line.text)}) Tj`);
      y -= 14;
    } else {
      if (parts.length > 3) parts.push("ET");
      const font = line && !line.text.startsWith(" ") ? "/F1 11 Tf" : "/F1 11 Tf";
      parts.push("BT", font, `72 ${y} Td`, `(${escapePdfString(line.text)}) Tj`);
      y -= line.text === "" ? 10 : 16;
    }
  }
  parts.push("ET");
  return parts.join("\n");
}

/** Build a valid 2-page PDF (letter, Helvetica/WinAnsi) from DE_CV_LINES. */
export function buildGermanCvPdf(): Buffer {
  const pageIndex = DE_CV_LINES.findIndex(
    (l) => l.text === PAGE_BREAK_AFTER,
  );
  const page1 = DE_CV_LINES.slice(0, pageIndex + 1);
  const page2 = DE_CV_LINES.slice(pageIndex + 1);
  const pages = [page1, page2];

  const objects: string[] = [];
  // Object numbering: 1 Catalog, 2 Pages, 3 Font, then (4+2i) Page, (5+2i) Contents
  const pageObjNums = pages.map((_, i) => 4 + 2 * i);
  const kids = pageObjNums.map((n) => `${n} 0 R`).join(" ");
  objects.push(`1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj`);
  objects.push(`2 0 obj<</Type/Pages/Kids[${kids}]/Count ${pages.length}>>endobj`);
  // /WinAnsiEncoding is REQUIRED: without it pdf.js falls back to an
  // encoding where 8-bit German bytes (ö ü ß Ä …) are undefined and get
  // dropped during text extraction (ASCII is identical in all encodings,
  // which is why the minimal ASCII fixture never caught this).
  objects.push(
    `3 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>endobj`,
  );
  pages.forEach((lines, i) => {
    const pageObj = 4 + 2 * i;
    const contentObj = 5 + 2 * i;
    objects.push(
      `${pageObj} 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents ${contentObj} 0 R/Resources<</Font<</F1 3 0 R>>>>>>endobj`,
    );
    const stream = contentStream(lines);
    objects.push(
      `${contentObj} 0 obj<</Length ${Buffer.byteLength(stream, "latin1")}>>\nstream\n${stream}\nendstream\nendobj`,
    );
  });
  const trailerSize = objects.length + 1;
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += obj + "\n";
  }
  const xrefOffset = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${trailerSize}\n`;
  pdf += "0000000000 65535 f \n";
  for (let i = 1; i < trailerSize; i++) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer<</Root 1 0 R/Size ${trailerSize}>>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}

// ---------------------------------------------------------------------------
// "Mocked AI" responses — what a GOOD model answers for this CV.
// These stand in for the live model in pipeline tests (the live model is
// non-deterministic; these pin the CONTRACT the prompt must produce).
// ---------------------------------------------------------------------------

/** Canonical snake_case profile for the fixture CV (all major sections). */
export const REALISTIC_PROFILE = {
  candidate: {
    full_name: "Lara Müller",
    location: "Köln",
    country: "Deutschland",
    current_location: "Köln",
    target_location: ["Köln", "Bonn"],
    contact: {
      email: "lara.mueller@example.com",
      phone: "+49 151 23456789",
      linkedin: null,
    },
  },
  goal: "ausbildung",
  education: [
    {
      school: null,
      university: "Universität zu Köln",
      degree: "Bachelor of Arts (B.A.)",
      field_of_study: "English Studies",
      graduation_year: 2026,
      education_level: "Bachelor",
      source: "ai_extracted",
    },
    {
      school: "Berthold-Schmidt-Gymnasium Köln",
      university: null,
      degree: "Abitur",
      field_of_study: null,
      graduation_year: 2022,
      education_level: "Abitur",
      source: "ai_extracted",
    },
  ],
  training: [
    {
      name: "Zertifikat Online-Marketing",
      provider: "IHK Köln",
      year: "2024",
      source: "ai_extracted",
    },
    {
      name: "Kurs Digital Commerce",
      provider: "Handelsakademie NRW",
      year: "2025",
      source: "ai_extracted",
    },
  ],
  experience: [
    {
      job_title: "Werkstudentin Online-Marketing",
      company: "Muster E-Commerce GmbH, Köln",
      responsibilities: [
        "Konzeption und Betreuung von SEO- und SEA-Kampagnen",
        "Änderungen an Produkttexten und Kampagnen",
        "Pflege des Online-Shops und Analyse der Shopkennzahlen",
      ],
      start_date: "2025",
      end_date: "2026",
      type: "internship",
      source: "ai_extracted",
    },
    {
      job_title: "Praktikum E-Commerce & Affiliate Marketing",
      company: "Shopland GmbH, Bonn",
      responsibilities: [
        "Aufbau von Affiliate-Kampagnen und Partner-Kommunikation",
        "Erstellung von Produkttexten und Social-Media-Posts",
        "Planung und Umsetzung von Marketing-Maßnahmen",
      ],
      start_date: "07/2024",
      end_date: "09/2024",
      type: "internship",
      source: "ai_extracted",
    },
    {
      job_title: "Aushilfe im Kundenservice",
      company: "Muster E-Commerce GmbH, Köln",
      responsibilities: ["Bearbeitung von Kundenanfragen per E-Mail und Telefon"],
      start_date: "2024",
      end_date: null,
      type: "employment",
      source: "ai_extracted",
    },
  ],
  skills: {
    technical: ["E-Commerce", "SEO", "SEA", "Affiliate Marketing"],
    software_tools: ["MS Excel", "MS Word", "MS PowerPoint", "SAP", "Adobe Photoshop"],
    marketing: ["Online-Marketing", "Onlinehandel", "Social Media", "Content Creation"],
    it: ["SAP (Grundkenntnisse)"],
    soft: ["Kundenkommunikation", "Übersetzungen Deutsch / Englisch / Arabisch"],
  },
  languages: [
    { language: "Arabisch", level: "Muttersprache", level_is_inferred: false, source: "ai_extracted" },
    { language: "Englisch", level: "B2", level_is_inferred: false, source: "ai_extracted" },
    { language: "Deutsch", level: "B1", level_is_inferred: false, source: "ai_extracted" },
  ],
  preferences: {
    target: "ausbildung",
    preferred_job_titles: [],
    preferred_industries: ["E-Commerce"],
    preferred_locations: ["Köln", "Bonn"],
    willing_to_relocate: false,
    remote_hybrid_preference: null,
  },
  target_roles: [
    {
      role: "Kaufleute für E-Commerce (Ausbildung)",
      reason:
        "Praktikum im E-Commerce und Affiliate Marketing bei Shopland GmbH plus SEO/SEA-Kenntnisse.",
      source: "ai_extracted",
    },
    {
      role: "Online-Marketing-Fachkraft",
      reason:
        "Werkstudententätigkeit im Online-Marketing (SEO/SEA-Kampagnen) sowie IHK-Zertifikat Online-Marketing.",
      source: "ai_extracted",
    },
    {
      role: "Digital-Marketing-Assistenz",
      reason: "Social-Media-Content, Produkttexte sowie Kenntnisse in Onlinehandel und Content Creation.",
      source: "ai_extracted",
    },
  ],
  strengths: [
    "Praktische E-Commerce-Erfahrung: Praktikum bei Shopland GmbH und Werkstudentenstelle bei Muster E-Commerce GmbH.",
    "Konkrete Online-Marketing-Kenntnisse: SEO, SEA, Affiliate Marketing und Social Media.",
    "Mehrsprachig: Arabisch (Muttersprache), Englisch B2, Deutsch B1.",
    "Sicher in MS Office (Excel, Word, PowerPoint) mit SAP-Grundkenntnissen.",
  ],
  missing_information: [
    "Kein LinkedIn-Profil angegeben.",
    "Aushilfe im Kundenservice: kein Enddatum angegeben.",
  ],
  potential_concerns: [
    "Zeitraum der Aushilfstätigkeit (2024) ohne Enddatum ungenau.",
  ],
  keywords: [
    "E-Commerce",
    "Online-Marketing",
    "SEO",
    "SEA",
    "Affiliate Marketing",
    "Onlinehandel",
    "Social Media",
    "MS Office",
    "Excel",
    "SAP",
    "English Studies",
    "Bachelor",
    "Abitur",
    "Arabisch",
    "Englisch",
    "Deutsch",
    "Köln",
    "Content Creation",
    "Kundenservice",
    "Fotografie",
  ],
};

/**
 * The same profile, but as a slightly messy real-world model answer:
 * camelCase keys, wrapped in an object, responsibilities as comma-string,
 * one invalid experience type, numeric year, missing optional dates.
 * Normalization must turn this into the SAME profile as REALISTIC_PROFILE.
 */
export const MESSY_CAMEL_PROFILE = {
  candidateProfile: {
    candidate: {
      fullName: "Lara Müller",
      location: "Köln",
      country: "Deutschland",
      currentLocation: "Köln",
      targetLocation: "Köln, Bonn",
      contact: {
        email: "lara.mueller@example.com",
        phone: 4915123456789,
      },
    },
    goal: "arbeit",
    education: [
      {
        university: "Universität zu Köln",
        degree: "Bachelor of Arts (B.A.)",
        fieldOfStudy: "English Studies",
        graduationYear: "2026",
        educationLevel: "Bachelor",
      },
      {
        school: "Berthold-Schmidt-Gymnasium Köln",
        degree: "Abitur",
        graduationYear: 2022,
        educationLevel: "Abitur",
      },
    ],
    training: [
      { name: "Zertifikat Online-Marketing", provider: "IHK Köln", year: 2024 },
      { name: "Kurs Digital Commerce", provider: "Handelsakademie NRW", year: "2025" },
    ],
    experience: [
      {
        jobTitle: "Werkstudentin Online-Marketing",
        company: "Muster E-Commerce GmbH, Köln",
        responsibilities:
          "Konzeption und Betreuung von SEO- und SEA-Kampagnen, Änderungen an Produkttexten, Pflege des Online-Shops",
        startDate: "2025",
        endDate: "2026",
        type: "job",
      },
      {
        jobTitle: "Praktikum E-Commerce & Affiliate Marketing",
        company: "Shopland GmbH, Bonn",
        responsibilities: ["Aufbau von Affiliate-Kampagnen"],
        type: "internship",
      },
      {
        jobTitle: "Aushilfe im Kundenservice",
        company: "Muster E-Commerce GmbH, Köln",
        responsibilities: "Kundenanfragen per E-Mail und Telefon",
        type: "employment",
      },
    ],
    skills: {
      technical: "E-Commerce, SEO, SEA, Affiliate Marketing",
      softwareTools: ["MS Excel", "MS Word", "MS PowerPoint", "SAP", "Adobe Photoshop"],
      marketing: ["Online-Marketing", "Onlinehandel", "Social Media", "Content Creation"],
      it: ["SAP (Grundkenntnisse)"],
      soft: ["Kundenkommunikation", "Übersetzungen Deutsch / Englisch / Arabisch"],
    },
    languages: [
      { language: "Arabisch", level: "Muttersprache" },
      { language: "Englisch", level: "B2", levelIsInferred: 0 },
      { language: "Deutsch", level: "B1" },
    ],
    preferences: {
      target: "ausbildung",
      preferredIndustries: ["E-Commerce"],
      preferredLocations: ["Köln", "Bonn"],
      willingToRelocate: false,
    },
    targetRoles: [
      {
        role: "Kaufleute für E-Commerce (Ausbildung)",
        reason:
          "Praktikum im E-Commerce und Affiliate Marketing bei Shopland GmbH plus SEO/SEA-Kenntnisse.",
      },
      {
        // missing reason → backfilled from role (existing contract)
        role: "Online-Marketing-Fachkraft",
      },
    ],
    strengths: [
      "Praktische E-Commerce-Erfahrung: Praktikum bei Shopland GmbH und Werkstudentenstelle bei Muster E-Commerce GmbH.",
      "Konkrete Online-Marketing-Kenntnisse: SEO, SEA, Affiliate Marketing und Social Media.",
      "Mehrsprachig: Arabisch (Muttersprache), Englisch B2, Deutsch B1.",
    ],
    missingInformation: ["Kein LinkedIn-Profil angegeben."],
    potentialConcerns: [],
    keywords: ["E-Commerce", "Online-Marketing", "SEO", "SEA", "Köln"],
  },
};
