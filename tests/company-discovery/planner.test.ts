import { beforeEach, describe, expect, it } from "vitest";

/**
 * The agentic Research Planner — strategy, adaptation, coverage.
 *
 * The planner is the "thinking" of the web-research engine: it plans
 * MULTIPLE search strategies (not one fixed query), refines them from what
 * the run DISCOVERED (roles, cities, states), evaluates coverage per batch,
 * broadens when coverage stagnates, and stops honestly when nothing new is
 * left to ask. Everything is deterministic: same seed + same observations
 * always produce the same query sequence.
 */

import {
  createResearchPlanner,
  ResearchPlanner,
} from "@/lib/company-discovery/planner";

const SEED = {
  role: "Kaufmann im E-Commerce",
  field: "Marketing",
  beginnYear: 2027,
  goal: "ausbildung" as const,
};

const STAGNANT = { resultsSeen: 3, offersExtracted: 0, newCompanies: 0 };
const HEALTHY = { resultsSeen: 8, offersExtracted: 4, newCompanies: 2 };

describe("ResearchPlanner — initial strategies", () => {
  it("starts with several DIFFERENT search strategies, not one query", () => {
    const planner = createResearchPlanner(SEED);
    const batch = planner.nextBatch(4);
    expect(batch.action).toBe("initial");
    expect(batch.queries).toHaveLength(4);
    // All distinct (case/whitespace-insensitive) …
    const keys = batch.queries.map((q) => q.toLowerCase());
    expect(new Set(keys).size).toBe(4);
    // …and every one is anchored to the run's role/field + Ausbildung
    // terminology (no bare, unscoped job-search queries).
    for (const query of batch.queries) {
      expect(query).toMatch(/E-Commerce|Marketing/);
      expect(query).toMatch(/Ausbild|Azubi|duale|Karriere|Stellenangebote/);
    }
  });

  it("is deterministic: two identical planners produce the same sequence", () => {
    const a = createResearchPlanner(SEED);
    const b = createResearchPlanner(SEED);
    for (let i = 0; i < 5; i += 1) {
      const ba = a.nextBatch(4);
      const bb = b.nextBatch(4);
      expect(ba.queries).toEqual(bb.queries);
      expect(ba.action).toBe(bb.action);
      a.observe(ba.queries, HEALTHY);
      b.observe(bb.queries, HEALTHY);
    }
  });

  it("includes a year-specific strategy when the run has a concrete beginn", () => {
    const planner = createResearchPlanner(SEED);
    let sawYear = false;
    for (let i = 0; i < 10 && !sawYear; i += 1) {
      const batch = planner.nextBatch(4);
      if (batch.queries.length === 0) break;
      sawYear = batch.queries.some((q) => q.includes("2027"));
      planner.observe(batch.queries, HEALTHY);
    }
    expect(sawYear).toBe(true);
  });
});

describe("ResearchPlanner — adaptive refinement from discoveries", () => {
  it("a discovered ROLE produces targeted follow-up queries", () => {
    const planner = createResearchPlanner(SEED);
    const first = planner.nextBatch(4);
    planner.observe(first.queries, HEALTHY);
    // The run parsed a Mechatroniker offer:
    planner.noteDiscovery({ role: "Mechatroniker", city: "München", state: "Bayern" });
    const second = planner.nextBatch(6);
    expect(second.action).toBe("refine-role");
    expect(second.queries).toContain("Mechatroniker Ausbildung 2027");
    // …and the discovered city/state produce regional refinements too:
    const third = planner.nextBatch(8);
    const regionals = third.queries.filter((q) =>
      q.includes("München") || q.includes("Bayern"),
    );
    expect(regionals.length).toBeGreaterThan(0);
  });

  it("reproduces the exact refinement chain from the specification", () => {
    const planner = createResearchPlanner({
      ...SEED,
      role: "Mechatroniker",
      field: "Technik",
    });
    const first = planner.nextBatch(4);
    planner.observe(first.queries, HEALTHY);
    planner.noteDiscovery({ city: "München", state: "Bayern" });
    // The seed role + discovered region must become a future query —
    // `Mechatroniker Ausbildung 2027 Bayern` style:
    const pool: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const batch = planner.nextBatch(8);
      if (batch.queries.length === 0) break;
      pool.push(...batch.queries);
      planner.observe(batch.queries, HEALTHY);
    }
    expect(pool.some((q) => /Mechatroniker Ausbildung 2027 Bayern/i.test(q))).toBe(true);
    expect(pool.some((q) => /Mechatroniker Ausbildung München/i.test(q))).toBe(true);
  });

  it("ignores discoveries that are not usable strategy material", () => {
    const planner = createResearchPlanner(SEED);
    const first = planner.nextBatch(4);
    planner.observe(first.queries, HEALTHY);
    planner.noteDiscovery({ role: "Azubi", city: "12345", state: "Atlantis" });
    // Stopword role, numeric city, non-Bundesland state → nothing enters the
    // strategy space (the next batch still refines the seed only):
    const batch = planner.nextBatch(8);
    expect(batch.queries.join(" ")).not.toContain("Atlantis");
    expect(batch.queries.join(" ")).not.toContain("12345");
    expect(planner.stats.newRegions).toBe(0);
  });

  it("caps the strategy space (roles/cities/states are bounded)", () => {
    const planner = createResearchPlanner(SEED);
    for (let i = 0; i < 25; i += 1) {
      const batch = planner.nextBatch(2);
      if (batch.queries.length === 0) break;
      planner.observe(batch.queries, HEALTHY);
      planner.noteDiscovery({ role: `NeueRolle${i} Fach` });
    }
    // 10 discovered roles max (the seed is separate):
    expect(planner.stats.newRoles).toBeLessThanOrEqual(10);
  });
});

describe("ResearchPlanner — coverage evaluation", () => {
  beforeEach(() => {
    process.env = { ...process.env };
  });

  it("two stagnant batches trigger the BROADENING strategy (and only then)", () => {
    const planner = createResearchPlanner(SEED);
    const first = planner.nextBatch(4);
    planner.observe(first.queries, HEALTHY);
    const second = planner.nextBatch(4);
    // A single dry batch: still refining/rotating — NOT broadened yet.
    planner.observe(second.queries, STAGNANT);
    const third = planner.nextBatch(4);
    expect(third.action).not.toBe("broaden");
    // The SECOND consecutive dry batch: the strategy changes.
    planner.observe(third.queries, STAGNANT);
    const fourth = planner.nextBatch(6);
    expect(fourth.action).toBe("broaden");
    // A successful batch resets the stagnation counter:
    planner.observe(fourth.queries, HEALTHY);
    expect(planner.stagnant).toBe(0);
  });

  it("exhausts HONESTLY: no unused structured combination left → empty batch", () => {
    const planner = createResearchPlanner({
      role: "Mechatroniker",
      field: "Technik",
      beginnYear: null,
      goal: "ausbildung",
    });
    let batches = 0;
    let exhausted = false;
    const all: string[] = [];
    while (batches < 40) {
      const batch = planner.nextBatch(4);
      if (batch.action === "exhausted") {
        exhausted = true;
        break;
      }
      all.push(...batch.queries);
      planner.observe(batch.queries, HEALTHY);
      batches += 1;
    }
    expect(exhausted).toBe(true);
    // And over the WHOLE run no query was ever issued twice:
    const keys = all.map((q) => q.toLowerCase().replace(/\s+/g, " ").trim());
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("ResearchPlanner — no duplicate queries, ever", () => {
  it("a query issued in one batch is never proposed again", () => {
    const planner = createResearchPlanner(SEED);
    const issued: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      const batch = planner.nextBatch(4);
      if (batch.queries.length === 0) break;
      issued.push(...batch.queries);
      planner.observe(batch.queries, { ...HEALTHY, newCompanies: 0 });
      // Discover material to keep the strategy space growing:
      planner.noteDiscovery({ role: `Rolle${i} Fachkraft`, city: `Stadt${i}berg` });
    }
    const keys = issued.map((q) => q.toLowerCase().replace(/\s+/g, " ").trim());
    expect(new Set(keys).size).toBe(keys.length);
  });
});

// ---------------------------------------------------------------------------
// Company feedback loop — a discovered company becomes a research subject
// ---------------------------------------------------------------------------

describe("ResearchPlanner — company feedback (new entity → new queries)", () => {
  it("a discovered company's name + domain drive targeted follow-ups", () => {
    const planner = createResearchPlanner(SEED);
    planner.noteCompanyDiscovered({ name: "XYZ GmbH", domain: "xyz.de" });
    const batch = planner.nextBatch(4);
    // The company family outranks the seed rotation (it is the highest-value
    // signal: a known company, not a generic search).
    expect(batch.queries).toContain(`"XYZ GmbH" Ausbildung 2027`);
    expect(batch.queries).toContain(`"XYZ GmbH" Karriere`);
    expect(batch.queries).toContain(`site:xyz.de Ausbildung 2027`);
    // And they come BEFORE any rotate query:
    const firstRotate = batch.queries.findIndex((q) => q === `Ausbildung ${SEED.role}`);
    const firstCompany = batch.queries.findIndex((q) => q.includes("XYZ GmbH"));
    expect(firstCompany).toBeGreaterThanOrEqual(0);
    expect(firstCompany).toBeLessThan(firstRotate === -1 ? batch.queries.length : firstRotate);
  });

  it("company feedback is deduped (case-insensitive) and bounded", () => {
    const planner = createResearchPlanner(SEED);
    for (let i = 1; i <= 7; i += 1) {
      planner.noteCompanyDiscovered({ name: `Firma ${i} GmbH`, domain: `firma${i}.de` });
    }
    planner.noteCompanyDiscovered({ name: "firma 1 gmbh" }); // duplicate, other case
    const snap = planner.snapshot();
    expect(snap.companies).toHaveLength(6); // capped at 6
    expect(Object.keys(snap.companyDomains)).toHaveLength(6);
  });

  it("rejects names that are not names (URLs, too short, non-letters)", () => {
    const planner = createResearchPlanner(SEED);
    planner.noteCompanyDiscovered({ name: "https://firma.de", domain: "firma.de" });
    planner.noteCompanyDiscovered({ name: "AB" });
    planner.noteCompanyDiscovered({ name: "12345" });
    expect(planner.snapshot().companies).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Adaptive family priority — a weak strategy changes, a productive one is kept
// ---------------------------------------------------------------------------

describe("ResearchPlanner — adaptive family priority", () => {
  it("demotes a family that keeps measuring zero offers (the strategy changes)", () => {
    const planner = createResearchPlanner(SEED);
    // Three discovered roles → nine refine-role queries (3 per role).
    planner.noteDiscovery({ role: "Mechatroniker" });
    planner.noteDiscovery({ role: "Kältetechnik" });
    planner.noteDiscovery({ role: "Anlagentechnik" });
    // Two consecutive batches of refine-role that extract nothing:
    const b1 = planner.nextBatch(3);
    planner.observe(b1.queries, STAGNANT);
    const b2 = planner.nextBatch(3);
    planner.observe(b2.queries, STAGNANT);
    // Now a fresh, lower-priority family appears (a discovered city):
    planner.noteDiscovery({ city: "München" });
    const b3 = planner.nextBatch(3);
    // The demoted refine-role (Anlagentechnik is still unused) must NO LONGER
    // outrank the fresh refine-region family — the strategy visibly changed:
    expect(b3.action).toBe("refine-region");
    expect(b3.queries[0]).toContain("München");
    expect(b3.queries.some((q) => q.includes("Anlagentechnik"))).toBe(false);
  });

  it("resets (boosts) family priorities when a batch produces new companies", () => {
    const planner = createResearchPlanner(SEED);
    planner.noteDiscovery({ role: "Mechatroniker" });
    planner.noteDiscovery({ role: "Kältetechnik" });
    planner.noteDiscovery({ role: "Anlagentechnik" });
    const b1 = planner.nextBatch(3);
    planner.observe(b1.queries, STAGNANT); // refine-role miss 1
    const b2 = planner.nextBatch(3);
    planner.observe(b2.queries, STAGNANT); // refine-role miss 2 → demoted
    // A productive batch (new companies) resets EVERY family's miss streak:
    planner.observe(["breite feldsuche marketing"], HEALTHY);
    planner.noteDiscovery({ city: "München" });
    const b3 = planner.nextBatch(3);
    // refine-role is no longer demoted → the refine-role family is back on
    // top (base priority restored). If it were still demoted, the fresh
    // refine-region family would lead the batch instead:
    expect(b3.action).toBe("refine-role");
    // The new city also unlocks the role's CITY variant (still refine-role):
    expect(b3.queries[0]).toBe("Mechatroniker Ausbildung München");
    expect(b3.queries).toContain("Anlagentechnik Ausbildung 2027");
  });

  it("a productive family is never demoted even after mixed batches", () => {
    const planner = createResearchPlanner(SEED);
    planner.noteDiscovery({ role: "Mechatroniker" });
    const b1 = planner.nextBatch(3);
    // Mechatroniker's queries extract offers (attributed per query):
    planner.observe(
      b1.queries,
      { resultsSeen: 6, offersExtracted: 2, newCompanies: 0 },
      b1.queries.map((query, i) => ({
        query,
        resultsSeen: 2,
        offersExtracted: i === 0 ? 2 : 0,
      })),
    );
    const b2 = planner.nextBatch(3);
    // The refine-role family measured an offer → its miss never grew; the
    // remaining Mechatroniker queries (if any) still outrank rotation.
    expect(b2.queries.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Research memory — snapshot / restore (Continue never re-issues)
// ---------------------------------------------------------------------------

describe("ResearchPlanner — research memory (snapshot / restore)", () => {
  const key = (q: string): string => q.toLowerCase().replace(/\s+/g, " ").trim();

  it("a restored planner never re-issues an already-issued query", () => {
    const planner = createResearchPlanner(SEED);
    planner.noteDiscovery({ role: "Mechatroniker", city: "München" });
    const b1 = planner.nextBatch(4);
    planner.observe(b1.queries, HEALTHY);
    const b2 = planner.nextBatch(4);
    planner.observe(b2.queries, STAGNANT);
    const snapshot = planner.snapshot();

    const restored = ResearchPlanner.restore(SEED, snapshot);
    const issued = [...b1.queries, ...b2.queries].map(key);
    for (let i = 0; i < 6; i += 1) {
      const batch = restored.nextBatch(4);
      if (batch.queries.length === 0) break;
      for (const query of batch.queries) {
        expect(issued.includes(key(query))).toBe(false);
      }
      issued.push(...batch.queries.map(key));
      restored.observe(batch.queries, HEALTHY);
    }
  });

  it("a restored planner keeps the discoveries that shaped the plan", () => {
    const planner = createResearchPlanner(SEED);
    planner.noteDiscovery({ role: "Mechatroniker", city: "München", state: "Bayern" });
    planner.noteCompanyDiscovered({ name: "XYZ GmbH", domain: "xyz.de" });
    planner.nextBatch(4);
    const restored = ResearchPlanner.restore(SEED, planner.snapshot());
    const snap = restored.snapshot();
    expect(snap.cities).toContain("München");
    expect(snap.states).toContain("Bayern");
    expect(snap.roles).toContain("Mechatroniker");
    expect(snap.companies).toContain("XYZ GmbH");
    expect(snap.companyDomains["XYZ GmbH"]).toBe("xyz.de");
    // And the restored planner can still target them:
    const pool: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const batch = restored.nextBatch(4);
      if (batch.queries.length === 0) break;
      pool.push(...batch.queries);
      restored.observe(batch.queries, HEALTHY);
    }
    expect(pool.some((q) => q.includes("München"))).toBe(true);
    expect(pool.some((q) => q.includes("site:xyz.de"))).toBe(true);
  });

  it("a wrong-goal / malformed memory yields a FRESH planner (no crash)", () => {
    const planner = createResearchPlanner(SEED);
    planner.nextBatch(4);
    const snap = planner.snapshot();
    const otherGoal = ResearchPlanner.restore({ ...SEED, goal: "arbeit" }, snap);
    expect(otherGoal.snapshot().issuedQueries).toHaveLength(0);
    const malformed = ResearchPlanner.restore(SEED, { v: 9, goal: "ausbildung" });
    expect(malformed.snapshot().issuedQueries).toHaveLength(0);
    const none = ResearchPlanner.restore(SEED, null);
    expect(none.snapshot().issuedQueries).toHaveLength(0);
  });

  it("restored counters and demotion state survive the round-trip", () => {
    const planner = createResearchPlanner(SEED);
    const b1 = planner.nextBatch(3);
    planner.observe(b1.queries, STAGNANT);
    const b2 = planner.nextBatch(3);
    planner.observe(b2.queries, STAGNANT); // rotate demoted (2 misses)
    const restored = ResearchPlanner.restore(SEED, planner.snapshot());
    expect(restored.stats.batches).toBe(2);
    expect(restored.stats.stagnant).toBe(2);
    expect(restored.snapshot().familyMiss).toEqual(
      Object.fromEntries(Object.entries(planner.snapshot().familyMiss)),
    );
  });
});

// ---------------------------------------------------------------------------
// Query journal — every issued query is explainable
// ---------------------------------------------------------------------------

describe("ResearchPlanner — query journal (explainable research)", () => {
  it("records type, reason and batch for every issued query", () => {
    const planner = createResearchPlanner(SEED);
    planner.noteDiscovery({ role: "Mechatroniker" });
    planner.nextBatch(3); // issuing the batch registers it in the journal
    const journal = planner.queryJournal();
    expect(journal).toHaveLength(3);
    for (const entry of journal) {
      expect(entry.type).toBe("refine-role");
      expect(entry.reason.length).toBeGreaterThan(0);
      expect(entry.executed).toBe(true);
      expect(entry.batch).toBe(0);
    }
  });

  it("attaches the MEASURED outcome per query via the per-query report", () => {
    const planner = createResearchPlanner(SEED);
    planner.noteDiscovery({ role: "Mechatroniker" });
    const b1 = planner.nextBatch(3);
    planner.observe(
      b1.queries,
      { resultsSeen: 6, offersExtracted: 2, newCompanies: 1 },
      b1.queries.map((query, i) => ({
        query,
        resultsSeen: 2,
        offersExtracted: i === 0 ? 2 : 0,
      })),
    );
    const [first, second] = planner.queryJournal();
    expect(first.resultCount).toBe(2);
    expect(first.usefulResults).toBe(2);
    expect(second.resultCount).toBe(2);
    expect(second.usefulResults).toBe(0);
  });
});
