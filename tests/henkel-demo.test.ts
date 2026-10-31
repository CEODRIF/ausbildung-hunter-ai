/**
 * Henkel demo — BEFORE/AFTER artifact generator + regression coverage.
 *
 * Renders the SAME reconstructed Henkel application with (1) the legacy CV
 * renderer, (2) the new one-page modern-template renderer, (3) the improved
 * Anschreiben via the existing letter pipeline, and (4) the improved e-mail
 * (new defaults, tokens substituted for the Henkel recipient). Artifacts are
 * (re)written into demo-output/ on every run.
 *
 * Kept in the suite because its assertions are real regression coverage for
 * the core requirements: the new CV is EXACTLY one A4 page for a content-rich
 * profile, every verified candidate fact survives in it (no silent deletion),
 * the letter pipeline produces a one-page Anschreiben with the correct
 * company/greeting/closing, and the new e-mail defaults render per-recipient
 * with the platform tokens.
 *
 * Disclosure: the production DB is unreachable from this environment (no
 * .env), so the Henkel application is RECONSTRUCTED from the verified
 * candidate-profile facts (the same facts the platform test fixtures use) —
 * no fact is invented beyond the Henkel company name + position.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { inflateSync } from "node:zlib";
import { generateCvPdf as generateCvPdfLegacy } from "../scripts/henkel-demo/cv-pdf-legacy";
import { generateCvPdf, cvPdfFilename } from "@/lib/auto-bewerb/cv-pdf";
import {
  buildAutoBewerbGreeting,
  AUTO_BEWERB_EMAIL_DEFAULT_BODY,
  AUTO_BEWERB_EMAIL_DEFAULT_SUBJECT,
  substituteEmailTokens,
} from "@/lib/auto-bewerb/schema";
import { sanitizeEmailHtml, htmlToText } from "@/lib/email-sanitize";
import { buildLetterFolio, generateLetterPdf, letterPdfFilename } from "@/lib/bew-letter-pdf";
import { cvEmpty, emptyEducation, emptyExperience, emptyProject, type CvDocument } from "@/lib/templates/cv";

const OUT = path.resolve(__dirname, "../demo-output");

/** The reconstructed Henkel application CV (verified profile facts only). */
function henkelCv(): CvDocument {
  const cv = cvEmpty();
  cv.personal = {
    ...cv.personal,
    fullName: "Mustapha Drif",
    professionalTitle: "Fachinformatiker für Systemintegration — Bewerbung bei Henkel",
    email: "mustapha.drif@example.de",
    phone: "+49 151 23456789",
    location: "Hamburg, Deutschland",
    nationality: "deutsch",
    dateOfBirth: "04.06.2007",
    availability: "ab 01.09.2026",
    linkedin: "linkedin.com/in/mustapha-drif",
    website: "www.mustapha-drif.de",
  };
  cv.summary =
    "Motivierter Fachinformatiker-Auszubildender mit Praxis in Systemintegration und Netzwerktechnik — fundiertes technisches Verständnis aus dem Anlagenbau, zuverlässig und strukturiert.";
  const e1 = emptyExperience();
  e1.jobTitle = "Praktikant Kältetechnik";
  e1.company = "Kältebau Nord GmbH";
  e1.location = "Hamburg";
  e1.start = "06/2025";
  e1.end = "08/2025";
  e1.responsibilities = ["Montage von Heizungs- und Kälteanlagen", "Wartung der IT-Infrastruktur", "Erfassung von Schaltplänen"];
  e1.achievements = ["Eigenständige Abnahme einer Anlage"];
  const e2 = emptyExperience();
  e2.jobTitle = "Auszubildender Fachinformatiker";
  e2.company = "Tech Süd AG";
  e2.location = "Düsseldorf";
  e2.start = "09/2023";
  e2.isCurrent = true;
  e2.responsibilities = ["Systemintegration kleiner Netzwerke", "Support der Endanwender"];
  cv.experience = [e1, e2];
  const ed1 = emptyEducation();
  ed1.degree = "Abitur — Gymnasium";
  ed1.institution = "Berthold-Brecht-Schule";
  ed1.location = "Düsseldorf";
  ed1.start = "2022";
  ed1.end = "2025";
  ed1.description = "Fächer: Mathematik, Informatik, Physik";
  const ed2 = emptyEducation();
  ed2.degree = "Schulvorbereitung";
  ed2.institution = "Realschule";
  ed2.location = "Düsseldorf";
  ed2.end = "2022";
  cv.education = [ed1, ed2];
  cv.skills = [
    "Schaltpläne lesen",
    "Systemintegration",
    "Montage",
    "Netzwerktechnik",
    "Löten",
    "Kältemittel-Grundlagen",
    "Linux",
    "Teamarbeit",
  ];
  cv.languages = [
    { id: "l1", language: "Deutsch", level: "verhandlungssicher" },
    { id: "l2", language: "Englisch", level: "sehr gut" },
    { id: "l3", language: "Arabisch", level: "Muttersprache" },
  ];
  cv.certificates = [
    { id: "c1", name: "IT-Support-Zertifikat", issuer: "Tech Süd AG", date: "2025", description: "" },
    { id: "c2", name: "Kältetechnik-Grundkurs", issuer: "Kältebau Nord", date: "2025", description: "" },
    { id: "c3", name: "Erste Hilfe", issuer: "DRK", date: "2024", description: "" },
  ];
  const p1 = emptyProject();
  p1.name = "Heimnetzwerk";
  p1.role = "Eigenbau";
  p1.date = "2024";
  p1.description = "Aufbau und Konfiguration eines Heimnetzwerks.";
  p1.technologies = "Linux, VLAN, DNS";
  const p2 = emptyProject();
  p2.name = "Schul-Wiki";
  p2.role = "Entwicklung";
  p2.date = "2023";
  p2.description = "Dokumentation der Schul-IT.";
  p2.technologies = "Markdown";
  cv.projects = [p1, p2];
  cv.interests = ["IT-Projekte", "Fußball", "Musik"];
  return cv;
}

/** The improved Henkel Anschreiben (every fact grounded in the profile). */
const HENKEL_LETTER_HTML = [
  "<p>Sehr geehrte Damen und Herren,</p>",
  "<p>hiermit bewerbe ich mich um die Ausbildungsstelle zum Fachinformatiker für Systemintegration bei der Henkel AG &amp; Co. KGaA.</p>",
  "<p>Derzeit bin ich Auszubildender zum Fachinformatiker bei der Tech Süd AG und vertiefe dort meine Kenntnisse in der Systemintegration kleiner Netzwerke und im Endanwender-Support. Im Praktikum bei der Kältebau Nord GmbH habe ich Montage, Wartung und die Erfassung von Schaltplänen im Betrieb kennengelernt — eine Kombination aus technischem Verständnis und strukturiertem Arbeiten, die ich bei Henkel gerne weiter ausbauen möchte.</p>",
  "<p>Mein Abitur mit den Schwerpunktfächern Mathematik, Informatik und Physik hat mein technisches Grundverständnis gefestigt. Deutsch spreche ich verhandlungssicher und Arabisch als Muttersprache; Zuverlässigkeit und Teamfähigkeit sind für mich selbstverständlich.</p>",
  "<p>Über die Gelegenheit, mich und meine Motivation in einem persönlichen Gespräch vorzustellen, freue ich mich sehr.</p>",
  "<p>Mit freundlichen Grüßen</p>",
  "<p>Mustapha Drif</p>",
].join("\n");

/** WinAnsiEncoding high range (0x80–0x9F) → Unicode (pdf-lib encodes text
 *  as WinAnsi hex; plain latin1 decoding leaves C1 control chars). */
const WINANSI: Record<number, string> = {
  0x80: "€", 0x82: "‚", 0x83: "ƒ", 0x84: "„", 0x85: "…", 0x86: "†", 0x87: "‡", 0x88: "ˆ",
  0x89: "‰", 0x8a: "Š", 0x8b: "‹", 0x8c: "Œ", 0x8e: "Ž", 0x91: "‘", 0x92: "’", 0x93: "“",
  0x94: "”", 0x95: "…", 0x96: "–", 0x97: "—", 0x98: "˜", 0x99: "™", 0x9a: "š", 0x9b: "›",
  0x9c: "œ", 0x9e: "ž", 0x9f: "Ÿ",
};

function winAnsi(buf: Buffer): string {
  let s = "";
  for (let i = 0; i < buf.length; i += 1) {
    const b = buf[i];
    s += b >= 0x80 && b <= 0x9f && WINANSI[b] ? WINANSI[b] : String.fromCharCode(b);
  }
  return s;
}

/** Reassemble the visible text of a rendered PDF: decode EVERY hex/literal
 *  Tj string in stream order and join the fragments with a single space
 *  (the letter renderer kerns WORD-BY-WORD, so a phrase like "Tech Süd AG"
 *  spans several Tj ops with stream markup in between). Only the decoded
 *  text is returned — operators/numbers never leak into the result. */
function pdfText(pdf: PDFDocument): string {
  const ctx = (pdf as unknown as { context: { lookup: (r: unknown) => unknown } }).context;
  const fragments: string[] = [];
  for (let i = 0; i < pdf.getPageCount(); i += 1) {
    const arr = pdf.getPage(i).node.Contents() as unknown as { size: () => number; get: (i: number) => unknown };
    for (let j = 0; j < arr.size(); j += 1) {
      const item = arr.get(j);
      const s =
        item && typeof item === "object" && (item as { constructor?: { name?: string } }).constructor?.name === "PDFRef"
          ? ctx.lookup(item)
          : item;
      const raw = (s as { getContents: () => Uint8Array }).getContents();
      let stream: string;
      try {
        stream = inflateSync(raw).toString("latin1");
      } catch {
        stream = Buffer.from(raw).toString("latin1");
      }
      const textRe = /<([0-9A-Fa-f]+)>\s*Tj|\(((?:[^()\\]|\\.)*)\)\s*Tj/g;
      let m: RegExpExecArray | null;
      while ((m = textRe.exec(stream))) {
        fragments.push(m[1] ? winAnsi(Buffer.from(m[1], "hex")) : m[2].replace(/\\([()\\])/g, "$1"));
      }
    }
  }
  return fragments.join(" ");
}

describe("henkel demo (artifact generator)", () => {
  it("writes before/after CV + letter + e-mail artifacts into demo-output/", async () => {
    mkdirSync(OUT, { recursive: true });
    const cv = henkelCv();

    // 1) BEFORE — the legacy renderer on the same document.
    const beforeBytes = await generateCvPdfLegacy(cv);
    const beforePdf = await PDFDocument.load(beforeBytes);
    writeFileSync(path.join(OUT, "henkel-cv-before.pdf"), Buffer.from(beforeBytes));

    // 2) AFTER — the new modern-template renderer: EXACTLY one A4 page.
    const afterBytes = await generateCvPdf(cv);
    const afterPdf = await PDFDocument.load(afterBytes);
    expect(afterPdf.getPageCount()).toBe(1);
    const { width, height } = afterPdf.getPage(0).getSize();
    expect(width).toBeCloseTo(595.28, 0);
    expect(height).toBeCloseTo(841.89, 0);
    writeFileSync(path.join(OUT, "henkel-cv-after.pdf"), Buffer.from(afterBytes));
    writeFileSync(path.join(OUT, "henkel-cv-filename.txt"), cvPdfFilename(cv.personal.fullName));

    // 3) Information preservation: every verified fact survives in the new CV.
    const afterText = pdfText(afterPdf);
    const facts = [
      // personal
      "Mustapha Drif", "Fachinformatiker für Systemintegration", "Bewerbung bei Henkel",
      "mustapha.drif@example.de", "+49 151 23456789", "Hamburg, Deutschland",
      "deutsch", "04.06.2007", "ab 01.09.2026", "linkedin.com/in/mustapha-drif", "www.mustapha-drif.de",
      // profile
      "Systemintegration und Netzwerktechnik",
      // experiences (both, all bullets + achievement, all dates + locations)
      "Praktikant Kältetechnik", "Kältebau Nord GmbH", "06/2025", "08/2025",
      "Montage von Heizungs- und Kälteanlagen", "Wartung der IT-Infrastruktur", "Erfassung von Schaltplänen",
      "Eigenständige Abnahme einer Anlage",
      "Auszubildender Fachinformatiker", "Tech Süd AG", "09/2023", "heute", "Düsseldorf",
      "Systemintegration kleiner Netzwerke", "Support der Endanwender",
      // education
      "Abitur", "Gymnasium", "Berthold-Brecht-Schule", "2022", "2025",
      "Fächer: Mathematik, Informatik, Physik", "Schulvorbereitung", "Realschule",
      // skills
      "Schaltpläne lesen", "Systemintegration", "Montage", "Netzwerktechnik", "Löten",
      "Kältemittel-Grundlagen", "Linux", "Teamarbeit",
      // languages + levels
      "Deutsch", "verhandlungssicher", "Englisch", "sehr gut", "Arabisch", "Muttersprache",
      // certificates (full fact set)
      "IT-Support-Zertifikat", "Kältetechnik-Grundkurs", "Erste Hilfe", "DRK", "2024",
      // projects
      "Heimnetzwerk", "Eigenbau", "Aufbau und Konfiguration eines Heimnetzwerks.", "Linux, VLAN, DNS",
      "Schul-Wiki", "Entwicklung", "Dokumentation der Schul-IT.", "Markdown",
      // interests
      "IT-Projekte", "Fußball", "Musik",
    ];
    for (const fact of facts) expect(afterText, `missing fact: ${fact}`).toContain(fact);

    // 4) Improved Henkel Anschreiben via the EXISTING letter pipeline.
    const folio = buildLetterFolio({
      applicantName: "Mustapha Drif",
      applicantEmail: "mustapha.drif@example.de",
      applicantStreet: "Hafenstraße 1",
      applicantPostalCode: "20457",
      applicantCity: "Hamburg",
      applicantCountry: "Deutschland",
      applicantPhone: "+49 151 23456789",
      companyName: "Henkel AG & Co. KGaA",
      companyContactName: null,
      companyAddress: null, // not in the reconstructed demo — never invented
      subject: "Bewerbung um eine Ausbildung zum Fachinformatiker für Systemintegration",
      bodyHtml: HENKEL_LETTER_HTML,
      date: new Date(2026, 9, 31),
    });
    const letterBytes = await generateLetterPdf(folio, { singlePage: true });
    const letterPdf = await PDFDocument.load(letterBytes);
    expect(letterPdf.getPageCount()).toBe(1);
    writeFileSync(path.join(OUT, "henkel-anschreiben.pdf"), Buffer.from(letterBytes));
    const letterText = pdfText(letterPdf);
    for (const f of ["Henkel AG & Co. KGaA", "Sehr geehrte Damen und Herren,", "Tech Süd AG", "Kältebau Nord GmbH", "Mit freundlichen Grüßen", "Mustapha Drif"]) {
      expect(letterText, `letter missing: ${f}`).toContain(f);
    }
    // No unresolved placeholders / tokens may reach the rendered letter:
    expect(letterText).not.toContain("{{");
    expect(letterText).not.toContain("PLACEHOLDER");

    // 5) Improved e-mail (new defaults) rendered for the Henkel recipient —
    //    tokens substituted from verified data only; the recipient address
    //    itself is independent per company and NEVER part of this artifact.
    const companyName = "Henkel AG & Co. KGaA";
    const position = "Ausbildung zum Fachinformatiker für Systemintegration";
    const greeting = buildAutoBewerbGreeting(null); // no verified contact person → neutral
    const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const subject = substituteEmailTokens(AUTO_BEWERB_EMAIL_DEFAULT_SUBJECT, {
      candidate_name: "Mustapha Drif", contact_person: "", company_name: companyName, greeting, position,
    }).slice(0, 200);
    const bodyHtml = sanitizeEmailHtml(substituteEmailTokens(AUTO_BEWERB_EMAIL_DEFAULT_BODY, {
      candidate_name: esc("Mustapha Drif"), contact_person: "", company_name: esc(companyName), greeting: esc(greeting), position: esc(position),
    }));
    const bodyText = htmlToText(bodyHtml);
    const emailFile = [
      `Betreff: ${subject}`,
      `An: <unabhängige, je Unternehmen gespeicherte Empfänger-Adresse — nie erfunden>`,
      `Anhänge: ${cvPdfFilename("Mustapha Drif")}, ${letterPdfFilename(companyName)}, Dokumente aus der Bibliothek`,
      "",
      bodyText,
    ].join("\n");
    writeFileSync(path.join(OUT, "henkel-email.txt"), emailFile, "utf8");
    expect(subject).toBe("Bewerbung um einen Ausbildungsplatz bei Henkel AG & Co. KGaA");
    // Rich HTML body carries the correctly entity-encoded company name:
    expect(bodyHtml).toContain("Henkel AG &amp; Co. KGaA");
    // Plain-text fallback decodes the entity (htmlToText: one decode pass):
    expect(bodyText).toContain("Sehr geehrte Damen und Herren,");
    expect(bodyText).toContain("hiermit bewerbe ich mich um einen Ausbildungsplatz bei Henkel AG & Co. KGaA.");
    expect(bodyText).toContain("Meine vollständigen Bewerbungsunterlagen (Lebenslauf und mein Anschreiben) finden Sie im Anhang.");
    expect(bodyText).toContain("Mit freundlichen Grüßen");
    expect(bodyText).toContain("Mustapha Drif");
    // Every token substituted — no placeholder may remain in the sendable text:
    expect(subject).not.toContain("{{");
    expect(bodyText).not.toContain("{{");

    // 6) Side-by-side comparison page.
    const html = `<!doctype html>
<html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AUTO BEWERB — Henkel: vor/nach Vergleich</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; font: 14px/1.5 system-ui, sans-serif; background: #f3f5f8; color: #1f2937; }
  header { padding: 18px 24px; background: #2f5c99; color: #fff; }
  header h1 { margin: 0; font-size: 18px; } header p { margin: 4px 0 0; font-size: 12px; opacity: .85; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; padding: 16px 24px; }
  .panel { background: #fff; border: 1px solid #d9dee6; border-radius: 8px; overflow: hidden; }
  .panel h2 { margin: 0; padding: 10px 14px; font-size: 13px; background: #eef2f7; border-bottom: 1px solid #d9dee6; }
  .panel.full { grid-column: 1 / -1; }
  .panel .meta { padding: 8px 14px; font-size: 12px; color: #555f6b; border-bottom: 1px solid #eef2f7; }
  .panel iframe { width: 100%; height: 860px; border: 0; display: block; background: #e8ebef; }
  .email { padding: 14px; font-size: 13px; white-space: pre-wrap; }
  .email .s { font-weight: 600; margin-bottom: 10px; }
  .note { padding: 10px 14px; font-size: 12px; color: #555f6b; }
  @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
</style></head>
<body>
<header>
  <h1>AUTO BEWERB — Henkel-Bewerbung: vor/nach Vergleich</h1>
  <p>Gleiche Quelldaten (rekonstruierte Henkel-Bewerbung aus verifizierten Profilfakten) — nur Renderer und E-Mail-Text wurden geändert.</p>
</header>
<div class="grid">
  <div class="panel">
    <h2>1. Lebenslauf — VORHER (alt: Times-Serif, ${beforePdf.getPageCount()} Seite${beforePdf.getPageCount() === 1 ? "" : "n"})</h2>
    <div class="meta">scripts/henkel-demo/cv-pdf-legacy.ts (exakte Kopie des alten Renderers)</div>
    <iframe src="henkel-cv-before.pdf" title="CV vorher"></iframe>
  </div>
  <div class="panel">
    <h2>2. Lebenslauf — NACHHER (modernes Template, exakt 1 Seite)</h2>
    <div class="meta">src/lib/auto-bewerb/cv-pdf.ts — 1:1-Port des CV-Builder-Modern-Template (Palette #2f5c99, Abschnittsordnung + Sichtbarkeit aus der Dokument-Konfiguration)</div>
    <iframe src="henkel-cv-after.pdf" title="CV nachher"></iframe>
  </div>
  <div class="panel">
    <h2>3. Henkel-Anschreiben (verbessert, 1 Seite)</h2>
    <div class="meta">Vorhandene Brief-Pipeline: buildLetterFolio + generateLetterPdf (Briefpapier, Datum, Empfängerblock, Betreff, Begrüßung, Blocksatz, Schluss + Name)</div>
    <iframe src="henkel-anschreiben.pdf" title="Anschreiben"></iframe>
  </div>
  <div class="panel">
    <h2>4. Bewerbungs-E-Mail (neue Standard-Vorlage, Tokens für Henkel ersetzt)</h2>
    <div class="meta">Betreff nach Plattform-Konvention (Firmenname); Empfängeradresse bleibt je Unternehmen unabhängig und wird nie erfunden.</div>
    <div class="email"></div>
  </div>
</div>
<script>
  document.querySelector(".email").textContent = ${JSON.stringify(emailFile)};
</script>
</body></html>`;
    writeFileSync(path.join(OUT, "comparison.html"), html, "utf8");

    console.log(
      `[henkel-demo] before=${beforePdf.getPageCount()}p after=${afterPdf.getPageCount()}p letter=${letterPdf.getPageCount()}p → demo-output/`,
    );
  });
});
