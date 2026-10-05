/**
 * The agentic Research Planner — the planning brain of the web-research
 * engine.
 *
 * The engine does NOT run one fixed query list. It runs a loop:
 *
 *   Plan → Search → Inspect → Extract → Verify → Discover → Refine → Plan…
 *
 * and the PLAN adapts to what the run MEASURED:
 *
 *  - every accepted/rejected offer feeds its role, city and Bundesland back
 *    into the strategy space, so discovering `Mechatroniker` in München
 *    produces the follow-up queries `Mechatroniker Ausbildung 2027`,
 *    `Mechatroniker Ausbildung München`, `Ausbildungsplätze Mechatroniker`
 *    — a search the run would never have issued from the seed alone;
 *  - every DISCOVERED COMPANY becomes a research subject: its name and its
 *    official domain drive targeted follow-ups (`"XYZ GmbH" Ausbildung 2027`,
 *    `"XYZ GmbH" Karriere`, `site:xyz.de Ausbildung`) — new information
 *    changes the next search;
 *  - coverage is evaluated per batch AND per strategy family: two consecutive
 *    batches without offers trigger BROADENING, and a family whose queries
 *    keep measuring zero offers is demoted below the productive ones instead
 *    of grinding on a dead end;
 *  - the run's research memory (issued queries, discovered entities,
 *    counters) snapshots on every batch, so a Continue batch restores the
 *    SAME strategy space and never re-issues a query it already paid for;
 *  - the phase ends when no unused structured combination remains (an honest
 *    exhaustion), or when the orchestrator's budget/target gate closes.
 *
 * Hard rules (the same discipline as the legacy query generator):
 *  - deterministic: same seed + same observations → same query sequence
 *    (no shuffling, no randomness — reproducible runs and stable tests);
 *  - no bare, unanchored queries: every query carries an Ausbildung/Job
 *    anchor plus the run's role or field, so results stay scoped to real
 *    offers (anything else is filtered by the downstream gates);
 *  - a query is never issued twice (case/whitespace-insensitive dedupe);
 *  - discovered roles/regions are capped, so the strategy space stays
 *    bounded no matter how long the run runs.
 */

import { GERMAN_STATES, isGermanState } from "./queries";

export type PlannerGoal = "ausbildung" | "arbeit";

/** The run's seed — what the planner knows before it searches. */
export interface PlannerSeed {
  /** The run's profession (e.g. "Kaufmann im E-Commerce"). */
  role: string;
  /** The run's field (e.g. "Marketing"). */
  field: string;
  /** The run's concrete beginn year, when the user chose one. */
  beginnYear: number | null;
  goal: PlannerGoal;
}

/** One offer's geography/role facts, as discovered from a parsed page. */
export interface PlannerDiscovery {
  role?: string | null;
  city?: string | null;
  state?: string | null;
}

/** What a completed batch MEASURED (adapter report + orchestrator diff). */
export interface BatchObservation {
  /** Provider results returned in the batch (before any filtering). */
  resultsSeen: number;
  /** JobPosting offers actually extracted from fetched pages. */
  offersExtracted: number;
  /** Unique companies the batch added to the run (verified + counted). */
  newCompanies: number;
}

/**
 * The MEASURED outcome of one issued query (per-query feedback). The adapter
 * reports it for every query of the batch; the planner attributes it to the
 * query's family (its `action`) to decide which strategies are working.
 */
export interface PerQueryObservation {
  query: string;
  /** Provider results returned for this query. */
  resultsSeen: number;
  /** Offers actually extracted from pages fetched for this query. */
  offersExtracted: number;
}

export type PlannerAction =
  | "initial"
  | "refine-role"
  | "company"
  | "refine-region"
  | "rotate"
  | "broaden"
  | "exhausted";

/**
 * One journal line per issued query — the query's identity record: what it
 * was, which family (strategy) issued it, why, in which batch, and what it
 * MEASURED. This is what makes the run's research auditable: every query the
 * run ever issued is explainable after the fact.
 */
export interface QueryJournalEntry {
  query: string;
  /** The strategy family that issued it (its type). */
  type: PlannerAction;
  /** Why the planner issued it (the family's note). */
  reason: string;
  /** The batch index (0-based) the query was issued in. */
  batch: number;
  /** True once the provider was actually asked. */
  executed: true;
  /** Provider results returned (0 until measured). */
  resultCount: number;
  /** Offers extracted from pages fetched for it (0 until measured). */
  usefulResults: number;
}

/**
 * The run's research memory — what a Continue batch restores so it keeps
 * working in the SAME strategy space instead of starting over:
 *  - `issuedQueries`  every query already paid for (never re-issued);
 *  - the discovered entities (roles / cities / states / companies) that
 *    shaped the plan;
 *  - the measured counters and the per-family miss streaks.
 * Deterministic + bounded, so it fits a jsonb column.
 */
export interface ResearchMemorySnapshot {
  v: 1;
  goal: PlannerGoal;
  /** Keys of every query already issued (normalized, capped at 500). */
  issuedQueries: string[];
  /** Result URLs already visited (capped at 500 — never re-fetched). */
  visitedUrls: string[];
  roles: string[];
  cities: string[];
  states: string[];
  /** Companies that became query subjects (bounded). */
  companies: string[];
  companyDomains: Record<string, string>;
  counts: PlannerStats;
  /** Consecutive zero-offer observations per family (the demotion state). */
  familyMiss: Record<string, number>;
}

/**
 * The whole run's research memory — one snapshot per goal pass (a `both`
 * goal runs two independent planners; each continues from its own space).
 * This is what the `discovery_runs.research_memory` column stores.
 */
export type ResearchMemoryStore = Partial<
  Record<PlannerGoal, ResearchMemorySnapshot>
>;

export interface PlannerBatch {
  /** The exact provider queries of this batch (≤ size, all unused). */
  queries: string[];
  /** What the planner decided — rendered live, never invented later. */
  action: PlannerAction;
  note: string;
}

export interface PlannerStats {
  queriesIssued: number;
  batches: number;
  totalResults: number;
  totalOffers: number;
  newRoles: number;
  newRegions: number;
  /** Consecutive batches without a single extracted offer or new company. */
  stagnant: number;
}

/** Strategy-space caps (bounded growth, bounded cost). */
const MAX_DISCOVERED_ROLES = 10;
const MAX_DISCOVERED_CITIES = 10;
const MAX_DISCOVERED_STATES = 4;
/** Companies that may become query SUBJECTS (each costs ≤ 3 provider
 *  queries; the run's query budget still bounds what is actually issued). */
const MAX_DISCOVERED_COMPANIES = 6;
const MAX_ROLE_LENGTH = 60;
const MAX_COMPANY_NAME_LENGTH = 60;
/** A batch without offers AND without new companies, this many in a row,
 *  triggers the broadening strategy. */
const STAGNATION_THRESHOLD = 2;
/** A family whose queries keep measuring zero offers (this many observations
 *  in a row) is demoted below every still-productive family — the strategy
 *  visibly changes instead of grinding on a dead end. */
const FAMILY_DEMOTION_THRESHOLD = 2;
/** The research memory keeps at most this many issued queries (a run's
 *  query budget is far smaller; the cap only bounds the stored jsonb). */
const MAX_REMEMBERED_QUERIES = 500;
/** The research memory keeps at most this many visited URLs. */
const MAX_REMEMBERED_URLS = 500;

/** Role strings too generic to anchor a query. */
const ROLE_STOPWORDS = new Set([
  "ausbildung",
  "ausbildung 2026",
  "ausbildung 2027",
  "azubi",
  "auszubildende",
  "auszubildender",
  "auszubildenden",
  "job",
  "jobs",
  "arbeit",
  "stelle",
  "stellen",
  "karriere",
  "praktikum",
  "bewerbung",
  "vertrieb",
  "sales",
]);

const AUSBILDUNG_ANCHORS: readonly string[] = [
  "Ausbildung",
  "Ausbildungsplätze",
  "Azubi",
  "Ausbildungsbetrieb",
  "Ausbildungsangebot",
  "duale Ausbildung",
  "Ausbildungsstelle",
  "Auszubildende",
];

const ARBEIT_ANCHORS: readonly string[] = [
  "Ausbildung",
  "Ausbildungsplatz",
  "Job",
  "Berufseinstieg",
  "Karriere",
  "Stellenangebote",
];

/**
 * Major German city → its Bundesland. A CLOSED, curated list that powers the
 * planner's GEOGRAPHIC EXPANSION: when the run discovers offers in a city but
 * the city-level queries stagnate, the state level is a documented widening
 * (München → Bayern) — a logged decision, never an unexplained jump. Keys are
 * normalized (lowercase, umlauts in both spellings where they differ).
 */
const CITY_STATE: Record<string, string> = {
  aachen: "Nordrhein-Westfalen",
  augsburg: "Bayern",
  bielefeld: "Nordrhein-Westfalen",
  bochum: "Nordrhein-Westfalen",
  braunschweig: "Niedersachsen",
  bremerhaven: "Bremen",
  chemnitz: "Sachsen",
  darmstadt: "Hessen",
  dortmund: "Nordrhein-Westfalen",
  dresden: "Sachsen",
  duesseldorf: "Nordrhein-Westfalen",
  "düsseldorf": "Nordrhein-Westfalen",
  erfurt: "Thüringen",
  essen: "Nordrhein-Westfalen",
  frankfurt: "Hessen",
  "frankfurt am main": "Hessen",
  "freiburg im breisgau": "Baden-Württemberg",
  friedrichshafen: "Baden-Württemberg",
  gelsenkirchen: "Nordrhein-Westfalen",
  goettingen: "Niedersachsen",
  "göttingen": "Niedersachsen",
  hagen: "Nordrhein-Westfalen",
  hamburg: "Hamburg",
  hannover: "Niedersachsen",
  heilbronn: "Baden-Württemberg",
  herne: "Nordrhein-Westfalen",
  ingolstadt: "Bayern",
  jena: "Thüringen",
  kaiserslautern: "Rheinland-Pfalz",
  kassel: "Hessen",
  kiel: "Schleswig-Holstein",
  koeln: "Nordrhein-Westfalen",
  "köln": "Nordrhein-Westfalen",
  krefeld: "Nordrhein-Westfalen",
  "ludwigshafen am rhein": "Rheinland-Pfalz",
  luebeck: "Schleswig-Holstein",
  "lübeck": "Schleswig-Holstein",
  magdeburg: "Sachsen-Anhalt",
  mainz: "Rheinland-Pfalz",
  mannheim: "Baden-Württemberg",
  "mönchengladbach": "Nordrhein-Westfalen",
  muenchen: "Bayern",
  münchen: "Bayern",
  muenster: "Nordrhein-Westfalen",
  münster: "Nordrhein-Westfalen",
  nuernberg: "Bayern",
  nürnberg: "Bayern",
  "offenbach am main": "Hessen",
  oldenburg: "Niedersachsen",
  osnabrueck: "Niedersachsen",
  "osnabrück": "Niedersachsen",
  paderborn: "Nordrhein-Westfalen",
  passau: "Bayern",
  potsdam: "Brandenburg",
  regensburg: "Bayern",
  rostock: "Mecklenburg-Vorpommern",
  "saarbrücken": "Saarland",
  saarbruecken: "Saarland",
  stuttgart: "Baden-Württemberg",
  ulm: "Baden-Württemberg",
  wiesbaden: "Hessen",
  wuppertal: "Nordrhein-Westfalen",
  zwickau: "Sachsen",
};

/** The state a known city implies (null when the city is not in the list). */
function stateForCity(city: string): string | null {
  const key = clean(city).toLowerCase();
  return CITY_STATE[key] ?? null;
}

function clean(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function isUsableCity(value: string): boolean {
  const v = clean(value).toLowerCase();
  if (v.length < 2 || v.length > 40) return false;
  if (/^\d+$/.test(v)) return false;
  if (isGermanState(v)) return false; // states are handled in their own list
  return true;
}

/**
 * One planner instance = one goal pass of one run. A continue-batch restores
 * its planner from the run's persisted research memory
 * ({@link ResearchPlanner.restore}): the strategy space (discovered roles /
 * regions / companies), the measured counters and — decisively — every query
 * already paid for, so the engine continues where it stopped instead of
 * re-issuing its own past.
 */
export class ResearchPlanner {
  private readonly seed: PlannerSeed;
  private readonly used = new Set<string>();
  private readonly roles: string[] = [];
  private readonly cities: string[] = [];
  private readonly states: string[] = [];
  /** Companies that became query SUBJECTS (name → official domain, or ""). */
  private readonly companies = new Map<string, string>();
  /** Result URLs already visited (capped; never re-fetched on continue). */
  private readonly visitedUrls = new Set<string>();
  /** One line per issued query (its family, reason, measured outcome). */
  private readonly journal = new Map<string, QueryJournalEntry>();
  /** Consecutive zero-offer observations per family (the demotion state). */
  private readonly familyMiss = new Map<PlannerAction, number>();
  private counts: PlannerStats = {
    queriesIssued: 0,
    batches: 0,
    totalResults: 0,
    totalOffers: 0,
    newRoles: 0,
    newRegions: 0,
    stagnant: 0,
  };

  constructor(seed: PlannerSeed) {
    this.seed = {
      role: clean(seed.role),
      field: clean(seed.field),
      beginnYear:
        typeof seed.beginnYear === "number" &&
        seed.beginnYear >= 2000 &&
        seed.beginnYear <= 2100
          ? seed.beginnYear
          : null,
      goal: seed.goal,
    };
    if (this.seed.role) this.roles.push(this.seed.role);
  }

  /**
   * Restore a planner for a CONTINUE batch from the run's persisted research
   * memory (null / wrong goal / malformed → a fresh planner; the run's
   * identity index still prevents double counting).
   */
  static restore(seed: PlannerSeed, memory: unknown): ResearchPlanner {
    const planner = new ResearchPlanner(seed);
    if (!memory || typeof memory !== "object") return planner;
    const snap = memory as Partial<ResearchMemorySnapshot>;
    if (snap.v !== 1 || snap.goal !== planner.seed.goal) return planner;
    if (Array.isArray(snap.issuedQueries)) {
      for (const query of snap.issuedQueries) {
        if (typeof query === "string" && query.length > 0) {
          planner.used.add(planner.key(query));
        }
      }
    }
    if (Array.isArray(snap.visitedUrls)) {
      for (const url of snap.visitedUrls) {
        if (typeof url === "string" && url.length > 0) {
          if (planner.visitedUrls.size >= MAX_REMEMBERED_URLS) break;
          planner.visitedUrls.add(url);
        }
      }
    }
    const pushUnique = (
      list: string[],
      values: unknown,
      is: (value: string) => boolean,
      cap: number,
    ): void => {
      if (!Array.isArray(values)) return;
      for (const value of values) {
        if (typeof value !== "string") continue;
        const v = clean(value);
        if (!v || !is(v)) continue;
        if (list.some((existing) => existing.toLowerCase() === v.toLowerCase()))
          continue;
        if (list.length < cap) list.push(v);
      }
    };
    pushUnique(planner.roles, snap.roles, (v) => v.length >= 4 && v.length <= MAX_ROLE_LENGTH, MAX_DISCOVERED_ROLES + 1);
    pushUnique(planner.cities, snap.cities, isUsableCity, MAX_DISCOVERED_CITIES);
    pushUnique(planner.states, snap.states, isGermanState, MAX_DISCOVERED_STATES);
    if (Array.isArray(snap.companies)) {
      for (const name of snap.companies) {
        if (typeof name !== "string") continue;
        const n = clean(name);
        if (!n || planner.companies.size >= MAX_DISCOVERED_COMPANIES) continue;
        if ([...planner.companies.keys()].some((existing) => existing.toLowerCase() === n.toLowerCase())) continue;
        const domain =
          typeof snap.companyDomains === "object" && snap.companyDomains
            ? ((snap.companyDomains as Record<string, unknown>)[n] as string | undefined) ?? ""
            : "";
        planner.companies.set(n, typeof domain === "string" ? domain : "");
      }
    }
    if (snap.counts && typeof snap.counts === "object") {
      const c = snap.counts as unknown as Record<string, unknown>;
      for (const field of Object.keys(planner.counts) as Array<keyof PlannerStats>) {
        if (typeof c[field] === "number" && Number.isFinite(c[field]) && c[field] >= 0) {
          planner.counts[field] = c[field];
        }
      }
    }
    if (snap.familyMiss && typeof snap.familyMiss === "object") {
      for (const [family, misses] of Object.entries(snap.familyMiss)) {
        if (typeof misses === "number" && Number.isFinite(misses) && misses >= 0) {
          planner.familyMiss.set(family as PlannerAction, misses);
        }
      }
    }
    return planner;
  }

  /**
   * THE run's research memory — persisted on every batch checkpoint so a
   * continue-batch can {@link restore} the exact strategy space.
   */
  snapshot(): ResearchMemorySnapshot {
    return {
      v: 1,
      goal: this.seed.goal,
      issuedQueries: [...this.used].slice(-MAX_REMEMBERED_QUERIES),
      visitedUrls: [...this.visitedUrls].slice(-MAX_REMEMBERED_URLS),
      roles: [...this.roles],
      cities: [...this.cities],
      states: [...this.states],
      companies: [...this.companies.keys()],
      companyDomains: Object.fromEntries(this.companies),
      counts: { ...this.counts },
      familyMiss: Object.fromEntries(this.familyMiss),
    };
  }

  /** The full query journal — one explainable line per issued query. */
  queryJournal(): QueryJournalEntry[] {
    return [...this.journal.values()];
  }

  /** The note of the last batch (the live "current strategy" label). */
  lastNote: string | null = null;

  get stagnant(): number {
    return this.counts.stagnant;
  }

  get queriesIssued(): number {
    return this.counts.queriesIssued;
  }

  get stats(): Readonly<PlannerStats> {
    return { ...this.counts };
  }

  /**
   * Feed back what a completed batch MEASURED (called once per batch, with
   * the adapter's report + the orchestrator's new-companies diff). Drives
   * the coverage evaluation:
   *  - batch level: stagnation → the BROADENING strategy;
   *  - family level: each strategy family's queries are attributed their
   *    measured offers. A family that keeps measuring zero offers is
   *    DEMOTED below the productive ones (the strategy visibly changes);
   *    a batch that produced new companies resets every family (boost).
   */
  observe(
    issuedQueries: string[],
    observation: BatchObservation,
    perQuery?: PerQueryObservation[],
  ): void {
    for (const query of issuedQueries) this.used.add(this.key(query));
    this.counts.queriesIssued += issuedQueries.length;
    this.counts.batches += 1;
    this.counts.totalResults += observation.resultsSeen;
    this.counts.totalOffers += observation.offersExtracted;
    this.counts.stagnant =
      observation.offersExtracted === 0 && observation.newCompanies === 0
        ? this.counts.stagnant + 1
        : 0;

    // ---- per-query attribution → family priorities ----------------------
    const perQueryByKey = new Map<string, PerQueryObservation>();
    for (const entry of perQuery ?? []) perQueryByKey.set(this.key(entry.query), entry);
    const familiesInBatch = new Set<PlannerAction>();
    const productiveFamilies = new Set<PlannerAction>();
    for (const query of issuedQueries) {
      const entry = this.journal.get(this.key(query));
      if (!entry) continue; // legacy batch (issued before this engine) — no family
      familiesInBatch.add(entry.type);
      entry.executed = true;
      const measured = perQueryByKey.get(this.key(query));
      if (measured) {
        entry.resultCount = measured.resultsSeen;
        entry.usefulResults = measured.offersExtracted;
        if (measured.offersExtracted > 0) productiveFamilies.add(entry.type);
      }
    }
    if (observation.newCompanies > 0) {
      // The batch produced real companies: the strategies that carried it
      // are BOOSTED — every family's miss streak resets.
      for (const family of this.familyMiss.keys()) this.familyMiss.set(family, 0);
    } else {
      for (const family of familiesInBatch) {
        this.familyMiss.set(
          family,
          productiveFamilies.has(family)
            ? 0
            : (this.familyMiss.get(family) ?? 0) + 1,
        );
      }
    }
  }

  /**
   * Feed back facts DISCOVERED from one parsed offer (the adaptive part of
   * the engine): a new role or region enters the strategy space and will be
   * targeted by a future batch.
   */
  noteDiscovery(discovery: PlannerDiscovery): void {
    const role = clean(discovery.role);
    if (
      role.length >= 4 &&
      role.length <= MAX_ROLE_LENGTH &&
      !ROLE_STOPWORDS.has(role.toLowerCase()) &&
      !this.roles.some((existing) => existing.toLowerCase() === role.toLowerCase())
    ) {
      if (this.roles.length - 1 < MAX_DISCOVERED_ROLES) {
        this.roles.push(role);
        this.counts.newRoles += 1;
      }
    }
    const city = clean(discovery.city);
    if (
      isUsableCity(city) &&
      !this.cities.some((existing) => existing.toLowerCase() === city.toLowerCase())
    ) {
      if (this.cities.length < MAX_DISCOVERED_CITIES) {
        this.cities.push(city);
        this.counts.newRegions += 1;
      }
      // GEOGRAPHIC EXPANSION (logged): a discovered city implies its
      // Bundesland — the state enters the strategy space, so the refine-
      // region family can widen city-level searches to state level
      // (München → „Mechatroniker Ausbildung Bayern") instead of grinding
      // on a small city. A documented, deterministic widening.
      this.inferStateForCity(city);
    }
    const state = clean(discovery.state);
    if (
      isGermanState(state) &&
      !this.states.some((existing) => existing.toLowerCase() === state.toLowerCase())
    ) {
      if (this.states.length < MAX_DISCOVERED_STATES) {
        this.states.push(state);
        this.counts.newRegions += 1;
      }
    }
  }

  /**
   * Widen a discovered city to its Bundesland (the documented geographic
   * expansion). Deterministic: the same city always implies the same state;
   * unknown cities imply nothing (no guessing). The state cap still applies.
   */
  private inferStateForCity(city: string): void {
    const state = stateForCity(city);
    if (!state || !isGermanState(state)) return;
    if (this.states.some((existing) => existing.toLowerCase() === state.toLowerCase())) {
      return;
    }
    if (this.states.length < MAX_DISCOVERED_STATES) {
      this.states.push(state);
      this.counts.newRegions += 1;
    }
  }

  /**
   * Feed back a company DISCOVERED by the run (the highest-value feedback:
   * a known company is a research SUBJECT). The company's name — and its
   * official domain, when identified — enter the strategy space as the
   * `company` query family:
   *   "XYZ GmbH" Ausbildung 2027 · "XYZ GmbH" Karriere · site:xyz.de Ausbildung
   * Bounded: at most {@link MAX_DISCOVERED_COMPANIES} companies per pass.
   */
  noteCompanyDiscovered(company: { name: string; domain?: string | null }): void {
    const name = clean(company.name);
    if (name.length < 4 || name.length > MAX_COMPANY_NAME_LENGTH) return;
    if (!/[a-zäöüß]/i.test(name)) return; // not a name
    if (name.includes("://") || name.includes("/")) return; // not a name
    if (this.companies.size >= MAX_DISCOVERED_COMPANIES) return;
    const known = [...this.companies.keys()].some(
      (existing) => existing.toLowerCase() === name.toLowerCase(),
    );
    if (known) return;
    const domain = (company.domain ?? "").trim().toLowerCase();
    this.companies.set(name, domain && domain.length <= 80 && !domain.includes(" ") ? domain : "");
  }

  /**
   * Feed back the result URLs the batch visited (the research memory's URL
   * state, capped). On a continue batch these are never re-fetched.
   */
  noteVisitedUrls(urls: readonly string[]): void {
    for (const url of urls) {
      if (typeof url !== "string" || url.length === 0) continue;
      if (this.visitedUrls.size >= MAX_REMEMBERED_URLS) break;
      this.visitedUrls.add(url);
    }
  }

  /**
   * THE planning step: the next query batch, in priority order, built only
   * from UNUSED structured combinations:
   *   1. refine-role     — newly discovered roles, targeted follow-ups
   *   2. company         — discovered COMPANIES become query subjects
   *                        ("XYZ GmbH" Ausbildung · site:xyz.de …)
   *   3. refine-region   — newly discovered cities/states × known roles
   *   4. broaden         — ONLY after measured stagnation: region dropped,
   *                        field-level queries; while active it OVERTAKES the
   *                        rotation (the strategy visibly changes)
   *   5. rotate          — the seed role/field through the anchor families
   *                        (incl. contact-oriented + `site:.de`)
   *   6. exhausted       — no unused combination remains (honest stop)
   *
   * Adaptive priority: a strategy family whose queries kept MEASURING zero
   * offers (≥ {@link FAMILY_DEMOTION_THRESHOLD} observations in a row) is
   * demoted below every still-productive family — the engine changes
   * strategy instead of grinding on a dead end. A batch that produced new
   * companies resets all families (boost).
   *
   * Every issued query is written to the journal (type, reason, batch) so
   * the run's research stays explainable after the fact.
   */
    nextBatch(size: number): PlannerBatch {
    const year = this.seed.beginnYear ? String(this.seed.beginnYear) : null;
    const seedRole = this.roles[0] ?? this.seed.field;
    const anchors =
      this.seed.goal === "arbeit" ? ARBEIT_ANCHORS : AUSBILDUNG_ANCHORS;
    /** The goal's career anchor (company queries use it too). */
    const careerAnchor = this.seed.goal === "arbeit" ? "Karriere" : "Ausbildung";
    /** Measured stagnation — the BROADENING strategy takes over. */
    const broadening = this.counts.stagnant >= STAGNATION_THRESHOLD;

    type Candidate = { query: string; action: PlannerAction; note: string };
    // The strategy families in base priority order (lower rank = earlier).
    const buckets: Array<{ action: PlannerAction; items: Candidate[] }> = [
      { action: "refine-role", items: [] },
      { action: "company", items: [] },
      { action: "refine-region", items: [] },
      { action: "broaden", items: [] },
      { action: "rotate", items: [] },
    ];
    const byAction = new Map(buckets.map((bucket) => [bucket.action, bucket.items]));
    const refineRole = byAction.get("refine-role")!;
    const company = byAction.get("company")!;
    const refineRegion = byAction.get("refine-region")!;
    const broaden = byAction.get("broaden")!;
    const rotate = byAction.get("rotate")!;
    const seenKeys = new Set<string>(this.used);
    const add = (
      bucket: Candidate[],
      query: string,
      action: PlannerAction,
      note: string,
    ): void => {
      const cleanQuery = clean(query);
      if (cleanQuery.length < 6) return;
      const key = this.key(cleanQuery);
      if (seenKeys.has(key)) return;
      seenKeys.add(key);
      bucket.push({ query: cleanQuery, action, note });
    };

    // 1. REFINE ROLE — a discovered profession gets its own targeted queries.
    for (const role of this.roles.slice(1)) {
      const city = this.cities[0] ?? null;
      add(refineRole, `${role} Ausbildung ${year ?? ""}`.trim(), "refine-role", `Neue Rolle gefunden: „${role}“ — gezielte Nachfragen`);
      if (year) add(refineRole, `${role} Ausbildung ${year} Deutschland`, "refine-role", `${role} ${year} (Deutschland)`);
      if (city) add(refineRole, `${role} Ausbildung ${city}`, "refine-role", `Rolle „${role}“ vertiefen in ${city}`);
      add(refineRole, `Ausbildungsplätze ${role}`, "refine-role", `Ausbildungsplätze für „${role}“`);
    }

    // 2. COMPANY — a discovered company becomes a RESEARCH SUBJECT: its name
    //    and its official domain drive targeted follow-ups, and the answers
    //    (more locations, more roles, careers pages) feed the loop again.
    for (const [name, domain] of this.companies) {
      const quoted = name.replace(/"/g, "");
      add(company, `"${quoted}" ${careerAnchor} ${year ?? ""}`.trim(), "company", `Unternehmen entdeckt: „${name}“ — gezielte Nachfragen`);
      add(company, `"${quoted}" Karriere`, "company", `Karriereseite: „${name}“`);
      if (domain) add(company, `site:${domain} ${careerAnchor} ${year ?? ""}`.trim(), "company", `Offizielle Domain durchsuchen: ${domain}`);
    }

    // 3. REFINE REGION — EVERY discovered city/state (the first one included)
    //    is searched with the roles the run already knows (seed role first).
    for (const region of [...this.cities, ...this.states]) {
      for (const role of this.roles.slice(0, 3)) {
        add(refineRegion, `${role} Ausbildung ${region}`, "refine-region", `Neue Region gefunden: ${region} — Suche dort vertiefen`);
        if (year) add(refineRegion, `${role} Ausbildung ${year} ${region}`, "refine-region", `${role} ${year} in ${region}`);
        add(refineRegion, `${role} Ausbildung Kontakt ${region}`, "refine-region", `Kontaktseiten: ${role} in ${region}`);
      }
    }

    // 4. BROADEN — only after MEASURED stagnation (never as a default); while
    //    active it OVERTAKES the rotation, so the strategy visibly changes
    //    instead of grinding on a dead end.
    if (broadening) {
      if (year) add(broaden, `Ausbildung ${year} ${this.seed.field}`, "broaden", "Ergebnisqualität sinkt — Suche breiter aufstellen");
      add(broaden, `Ausbildungsplätze ${this.seed.field} ${year ?? ""}`.trim(), "broaden", "Feldweite Ausbildungsplatzsuche");
      add(broaden, `Ausbildung ${this.seed.field}`, "broaden", "Breite Feldsuche");
      const state = this.states[0] ?? null;
      if (state) add(broaden, `Ausbildung ${state} ${this.seed.field}`, "broaden", `Bundesland ${state} · breit`);
    }

    // 5. ROTATE — the seed role/field through the closed anchor families.
    for (const anchor of anchors) {
      add(rotate, `${anchor} ${seedRole}`, "rotate", "Nächste Begriffsfamilie (Suchstrategie rotieren)");
      if (year) add(rotate, `${seedRole} ${anchor} ${year}`, "rotate", `${seedRole} · ${anchor} ${year}`);
      const city = this.cities[0] ?? null;
      if (city) add(rotate, `${anchor} ${seedRole} ${city}`, "rotate", `${anchor} ${seedRole} ${city}`);
      if (this.seed.field && this.seed.field !== seedRole) {
        add(rotate, `${anchor} ${this.seed.field}`, "rotate", `Feld „${this.seed.field}“ · ${anchor}`);
      }
    }
    // Contact-oriented strategies (rank the pages that publish an address).
    add(rotate, `${seedRole} Ausbildung Kontakt E-Mail`, "rotate", "Kontaktorientierte Suche");
    add(rotate, `${seedRole} Ausbildungsbetrieb Impressum`, "rotate", "Ausbildungsbetriebe mit Impressum");
    add(rotate, `site:.de ${seedRole} Ausbildung`, "rotate", "Deutsche Seiten (site:.de)");

    // Adaptive priority: demoted families (≥ FAMILY_DEMOTION_THRESHOLD
    // consecutive zero-offer observations) are sorted BELOW every
    // still-productive family — the strategy visibly changes.
    const isDemoted = (action: PlannerAction): boolean =>
      (this.familyMiss.get(action) ?? 0) >= FAMILY_DEMOTION_THRESHOLD;
    const candidates: Candidate[] = [];
    for (const pass of [0, 1] as const) {
      for (const bucket of buckets) {
        if (isDemoted(bucket.action) === (pass === 1)) {
          candidates.push(...bucket.items);
        }
      }
    }

    if (candidates.length === 0) {
      this.lastNote = "Keine weiteren strukturierten Suchen möglich — Phase abgeschlossen";
      return { queries: [], action: "exhausted", note: this.lastNote };
    }

    const batch = candidates.slice(0, Math.max(1, Math.min(size, candidates.length)));
    const action: PlannerAction =
      this.counts.batches === 0
        ? "initial"
        : batch[0].action;
    const note =
      this.counts.batches === 0
        ? "Startstrategie: Rolle + Berufsfeld + Jahr (mehrere Suchstrategien)"
        : batch[0].note;
    // The journal: every issued query becomes explainable NOW (type, reason,
    // batch); its measured outcome arrives via `observe`.
    for (const candidate of batch) {
      this.journal.set(this.key(candidate.query), {
        query: candidate.query,
        type: candidate.action,
        reason: candidate.note,
        batch: this.counts.batches,
        executed: true,
        resultCount: 0,
        usefulResults: 0,
      });
    }
    this.lastNote = note;
    return { queries: batch.map((candidate) => candidate.query), action, note };
  }

  private key(query: string): string {
    return query.toLowerCase().replace(/\s+/g, " ").trim();
  }
}

/** A plain factory for dependency-injected use. */
export function createResearchPlanner(seed: PlannerSeed): ResearchPlanner {
  return new ResearchPlanner(seed);
}

// Re-exported for planner tests (the closed 16-state list lives in queries).
export { GERMAN_STATES };
