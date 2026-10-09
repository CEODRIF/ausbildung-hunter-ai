import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The AI pass is best-effort; mock it so the heuristic stays the source of
// truth for the risk level and we can assert graceful degradation.
const { mockGenerate } = vi.hoisted(() => ({ mockGenerate: vi.fn() }));
vi.mock("@/lib/ai-service", () => ({
  provider: () => ({ generateText: mockGenerate }),
}));

const { heuristicScamCheck, checkScam } = await import("@/lib/housing/scam-check");

beforeEach(() => {
  mockGenerate.mockReset();
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("heuristic scam check (deterministic, offline)", () => {
  it("flags cash-transfer services as HIGH risk", () => {
    const r = heuristicScamCheck("Überweise die Kaution per Western Union, danke.");
    expect(r.risk).toBe("high");
    expect(r.findings.some((f) => f.id === "cash_transfer_service")).toBe(true);
  });

  it("flags pay-before-viewing pressure", () => {
    const r = heuristicScamCheck("Bitte überweise die Miete vor der Besichtigung.");
    expect(r.findings.some((f) => f.id === "pay_before_viewing")).toBe(true);
  });

  it("flags urgency pressure as medium", () => {
    const r = heuristicScamCheck("Muss sofort bezahlt werden, letzte Chance!");
    expect(r.findings.some((f) => f.id === "urgent_pressure")).toBe(true);
    expect(r.risk).toBe("medium");
  });

  it("returns low risk and no findings for a clean listing", () => {
    const r = heuristicScamCheck(
      "Schöne 2-Zimmer-Wohnung mit Balkon, Besichtigung nach Vereinbarung, Mietvertrag wird gestellt.",
    );
    expect(r.risk).toBe("low");
    expect(r.findings).toEqual([]);
  });

  it("the highest-severity finding drives the overall level", () => {
    const r = heuristicScamCheck(
      "Muss sofort bezahlt werden und die Kaution geht per Moneygram, ohne Vertrag.",
    );
    expect(r.risk).toBe("high");
  });

  it("orders findings high → medium → low", () => {
    const r = heuristicScamCheck(
      "Letzte Chance, sofort per Moneygram, und kontaktiere mich nur per WhatsApp.",
    );
    const rank = { high: 3, medium: 2, low: 1 };
    const severities = r.findings.map((f) => rank[f.severity]);
    expect([...severities].sort((a, b) => b - a)).toEqual(severities);
  });
});

describe("checkScam (heuristic + optional AI)", () => {
  it("useAi=false never calls the provider", async () => {
    const r = await checkScam("Western Union bitte", { useAi: false });
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(r.ai_assisted).toBe(false);
    expect(r.ai_summary).toBeNull();
    expect(r.risk).toBe("high");
  });

  it("useAi=true adds an AI summary on top of the heuristic", async () => {
    mockGenerate.mockResolvedValue("Hinweis: auffällige Zahlungsaufforderung.");
    const r = await checkScam("Überweise sofort per Western Union", { useAi: true });
    expect(mockGenerate).toHaveBeenCalledTimes(1);
    expect(r.ai_assisted).toBe(true);
    expect(r.ai_summary).toBe("Hinweis: auffällige Zahlungsaufforderung.");
    expect(r.risk).toBe("high");
  });

  it("degrades gracefully to the heuristic result when the AI fails", async () => {
    mockGenerate.mockRejectedValue(new Error("AI unavailable"));
    const r = await checkScam("Western Union", { useAi: true });
    expect(r.ai_assisted).toBe(false);
    expect(r.ai_summary).toBeNull();
    expect(r.risk).toBe("high");
  });

  it("the AI can NEVER lower or raise the heuristic risk level", async () => {
    mockGenerate.mockResolvedValue("Alles sieht völlig in Ordnung aus.");
    const r = await checkScam("Überweise die Kaution per Moneygram", { useAi: true });
    // Heuristic says high; the AI's "all fine" must not change it.
    expect(r.risk).toBe("high");
  });
});
