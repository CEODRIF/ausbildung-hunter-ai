/**
 * Housing / "Wohnen" — scam indicators (Miet-Check).
 *
 * Two layers:
 *   1. Heuristic — a deterministic, offline keyword/regex pass that flags the
 *      classic German rental-scam tells (pay-before-viewing, cash-transfer
 *      services, urgency pressure, off-platform / no-contract, requests for
 *      sensitive documents). Always runs, never needs the network, and is the
 *      source of truth for the risk level.
 *   2. AI (optional) — a best-effort free-text summary from the configured AI
 *      provider. If the provider is unconfigured or fails, the result degrades
 *      gracefully to the heuristic-only answer (ai_assisted = false).
 *
 * This is a decision-support aid, NOT legal advice — the UI says so.
 */

import { provider } from "@/lib/ai-service";
import type { ScamCheckResult, ScamFinding, ScamRiskLevel } from "./types";

interface ScamRule {
  id: string;
  severity: ScamRiskLevel;
  /** Case-insensitive. */
  pattern: RegExp;
  /** German, UI-facing description of the warning sign. */
  message: string;
}

const RULES: ScamRule[] = [
  {
    id: "cash_transfer_service",
    severity: "high",
    pattern: /western\s?union|money\s?gram|geldsendung|geldtransfer|wire\s?transfer|money\s?penny/i,
    message:
      "Zahlung per Geldsendung (Western Union / Moneygram) – ein klassisches Betrugsmuster. Seriöse Vermieter verlangen kein Geld per Geldtransfer.",
  },
  {
    id: "pay_before_viewing",
    severity: "high",
    pattern: /(zahlung|kaution|miete|überweis)(ung)?\s+(vor|vorher|bevor|noch vor)\s+(der|deiner|eurer)?\s*(besichtigung|viewing)|überweise\s+(sofort|noch heute|heute)|pay\s+(before|first)/i,
    message:
      "Es wird verlangt, Geld VOR der Besichtigung zu überweisen. Bezahle nie, bevor du die Wohnung gesehen und einen Vertrag hast.",
  },
  {
    id: "urgent_pressure",
    severity: "medium",
    pattern: /(muss\s+sofort|sofort\s+(zahlen|überweisen|bescheid|antwort)|innerhalb\s+(von\s+)?(24|48)\s*(stunden|hours)|letzte\s+chance|nur\s+noch\s+bis|heute\s+noch|dringend\s+(heute|sofort))/i,
    message:
      "Starker Zeitdruck / „sofort“ – Betrüger drängen mit künstlicher Eile, damit du nicht nachdenkst.",
  },
  {
    id: "no_contract",
    severity: "medium",
    pattern: /(ohne|keinen|kein)\s+(miet)?vertrag|ohne\s+vertrag|vertragslos/i,
    message:
      "Es wird auf einen Mietvertrag verzichtet. Ohne schriftlichen Vertrag hast du keinerlei Rechte – ein Warnsignal.",
  },
  {
    id: "sensitive_documents",
    severity: "medium",
    pattern: /(ausweis|gehaltsnachweis|kontoauszug|bankdaten|schufa)\s+(kopie|nummern|daten|vorher|vorab)|sende\s+(mir|bitte)\s+(deinen|dein)\s+(ausweis|gehaltsnachweis|bankdaten)/i,
    message:
      "Es werden sensible Dokumente (Ausweis, Gehaltsnachweis, Bankdaten) vorab verlangt. Gib diese erst nach einem seriösen Kontakt weiter – oder gar nicht.",
  },
  {
    id: "off_platform_contact",
    severity: "low",
    pattern: /(per|über|nur)\s+(whatsapp|telegram|signal)\s+(zahlen|überweisen|kontakt|ausmachen)|besprechung\s+nur\s+per\s+(whatsapp|telegram)/i,
    message:
      "Kontakt/Zahlung wird bewusst außerhalb der Plattform gesteuert. Das ist nicht automatisch Betrug, erhöht aber das Risiko.",
  },
  {
    id: "too_good_to_be_true",
    severity: "low",
    pattern: /(unrealistisch|deutlich\s+unter|weit\s+unter|massiv\s+unter)\s+(markt|der\s+markt|dem\s+markt|markt\s+preis)|super\s+günstig|günstiger\s+als\s+irgendwo/i,
    message:
      "Der Preis wirkt auffällig unter dem Marktniveau – ein zu-gut-um-wahr-zu-sein-Angebot.",
  },
  {
    id: "abroad_trope",
    severity: "low",
    pattern: /(im\s+ausland|auslandsdienst|geschäftlich\s+im\s+ausland|bin\s+(gerade\s+)?im\s+ausland|möbel\s+(abholen|rücksenden))/i,
    message:
      "Der „Anbieter“ verweist auf Auslandsaufenthalt / Möbel-Rücksendung – ein häufiges Vorwende-Muster bei Mietbetrug.",
  },
];

const RISK_RANK: Record<ScamRiskLevel, number> = { low: 1, medium: 2, high: 3 };

/** Run the deterministic heuristic pass. Pure + offline. */
export function heuristicScamCheck(text: string): ScamCheckResult {
  const findings: ScamFinding[] = [];
  for (const rule of RULES) {
    if (rule.pattern.test(text)) {
      findings.push({ id: rule.id, severity: rule.severity, message: rule.message });
    }
  }
  // Highest-severity finding drives the overall level; none → low.
  const risk = findings.reduce<ScamRiskLevel>(
    (acc, f) => (RISK_RANK[f.severity] > RISK_RANK[acc] ? f.severity : acc),
    "low",
  );
  // Order: high → medium → low for readability.
  findings.sort((a, b) => RISK_RANK[b.severity] - RISK_RANK[a.severity]);
  return { risk, findings, ai_assisted: false, ai_summary: null };
}

const AI_SYSTEM =
  "Du bist eine sachliche Assistentin für Wohnungssuchen in Deutschland. " +
  "Analysiere den übergebenen Text (Anzeige oder Nachricht) auf typische " +
  "Betrugs- und Warnsignale. Antworte auf Deutsch, in max. 4 kurzen Punkten, " +
  "ohne Rechtsberatung, ohne moralische Wertungen, und erwähne, dass es keine " +
  "Rechtsberatung ist.";

/**
 * Full scam check: heuristics first, then an optional AI summary. The AI never
 * changes the risk level (that stays heuristic-driven and deterministic) — it
 * only adds a human-readable summary.
 */
export async function checkScam(
  text: string,
  options: { useAi?: boolean; timeoutMs?: number } = {},
): Promise<ScamCheckResult> {
  const base = heuristicScamCheck(text);
  if (!options.useAi || !text.trim()) return base;

  try {
    const summary = await provider().generateText(
      [
        { role: "system", content: AI_SYSTEM },
        { role: "user", content: text.slice(0, 6000) },
      ],
      options.timeoutMs ?? 45_000,
    );
    const cleaned = (summary ?? "").trim();
    if (!cleaned) return base;
    return { ...base, ai_assisted: true, ai_summary: cleaned };
  } catch {
    // AI unavailable → degrade to the deterministic result. Never a 500.
    return base;
  }
}
