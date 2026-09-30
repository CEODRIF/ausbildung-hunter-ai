import { describe, expect, it } from "vitest";
import { extractPdfText } from "@/lib/pdf-extract";
import {
  DE_CV_EXPECTED_SNIPPETS,
  DE_CV_LINES,
  DE_UMLAUTS,
  buildGermanCvPdf,
} from "./fixtures/de-cv";

/**
 * Regression test (FIRST gate of the scanner pipeline): a realistic German
 * Lebenslauf must be extracted COMPLETELY — every section, every German
 * word, every umlaut — before anything AI-related happens.
 *
 * If this fails, the fix belongs in PDF extraction, NOT in the AI prompt.
 */

let cachedText: string | null = null;
async function extractGermanCvText(): Promise<string> {
  if (cachedText === null) {
    cachedText = await extractPdfText(buildGermanCvPdf());
  }
  return cachedText;
}

describe("PDF extraction — realistic German Lebenslauf", () => {
  it("extracts a substantial amount of text (not a stub)", async () => {
    const text = await extractGermanCvText();
    const lineCount = DE_CV_LINES.filter((l) => l.text).length;
    expect(text.length).toBeGreaterThan(1200);
    // A real CV is far below the 50k per-file context cap → no truncation.
    expect(text.length).toBeLessThan(50_000);
    expect(text.length / lineCount).toBeGreaterThan(8);
  }, 30000);

  it("preserves every required CV section", async () => {
    const text = await extractGermanCvText();
    for (const section of [
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
    ]) {
      expect(text, `section "${section}" must be present`).toContain(section);
    }
  }, 30000);

  it("preserves all key values (names, dates, companies, contacts)", async () => {
    const text = await extractGermanCvText();
    for (const snippet of DE_CV_EXPECTED_SNIPPETS) {
      expect(text, `snippet "${snippet}" must be present`).toContain(snippet);
    }
  }, 30000);

  it("preserves every German character: ä ö ü Ä Ö Ü ß", async () => {
    const text = await extractGermanCvText();
    for (const umlaut of DE_UMLAUTS) {
      expect(text, `umlaut "${umlaut}" must survive extraction`).toContain(
        umlaut,
      );
    }
    // Spot-check whole words — byte-level corruption (e.g. 0x3F) would show
    // up as "Muster?ra?e" / "K?ln" and fail these assertions.
    for (const word of [
      "Müller",
      "Musterstraße",
      "Köln",
      "Änderungen",
      "Öffentliche",
      "Übersetzungen",
      "Maßnahmen",
      "Sprachkenntnisse",
      "Persönliche",
    ]) {
      expect(text, `word "${word}" must survive extraction`).toContain(word);
    }
  }, 30000);

  it("preserves date ranges with en-dashes", async () => {
    const text = await extractGermanCvText();
    for (const range of ["2023–2026", "2019–2022", "07/2024–09/2024"]) {
      expect(text, `range "${range}" must survive extraction`).toContain(range);
    }
  }, 30000);
});
