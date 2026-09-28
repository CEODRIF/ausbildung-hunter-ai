import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getCurrentUserAndProfile: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { createClient } = await import("@/lib/supabase/server");
const { createAdminClient } = await import("@/lib/supabase/admin");
const { getCurrentUserAndProfile } = await import("@/lib/auth");
const { revalidatePath } = await import("next/cache");
const { BULK_DELETE_MAX_SCANS } = await import("@/lib/bewerbung-scanner");
const { bulkDeleteScans } = await import("@/app/bewerbung-scanner/actions");
const { deleteScanAction } =
  await import("@/app/bewerbung-scanner/[id]/actions");

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const CUR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // current page scan
const S1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const S2 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const S3 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const F1 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const F2 = "ffffffff-ffff-4fff-8fff-ffffffffff";
const F3 = "00000000-0000-4000-8000-000000000000";

type Row = Record<string, unknown>;

const CASCADES: Record<string, Array<{ table: string; column: string }>> = {
  bewerbung_scans: [
    { table: "bewerbung_scan_files", column: "scan_id" },
    { table: "candidate_profiles", column: "scan_id" },
  ],
};
const RESTRICTS: Array<{
  table: string;
  source: string;
  sourceColumn: string;
  targetColumn: string;
}> = [
  {
    table: "ai_file_uploads",
    source: "bewerbung_scan_files",
    sourceColumn: "storage_file_id",
    targetColumn: "id",
  },
];

interface EngineOptions {
  deleteError?: (
    table: string,
    filters: Record<string, unknown>,
  ) => string | null;
  removeError?: (bucket: string) => string | null;
}

/** FK-faithful in-memory engine (cascades + RESTRICT) with an event log. */
function makeEngine(
  seed: Record<string, Row[]> = {},
  opts: EngineOptions = {},
) {
  const tables: Record<string, Row[]> = Object.fromEntries(
    Object.keys(seed).map((t) => [t, [...(seed[t] ?? [])]]),
  );
  const events: string[] = [];
  const calls: Array<{
    table: string;
    op: string;
    filters: Record<string, unknown>;
  }> = [];
  const storageCalls: Array<{ bucket: string; paths: string[] }> = [];

  const rows = (table: string) => tables[table] ?? [];
  const matches = (table: string, filters: Record<string, unknown>) =>
    rows(table).filter((row) =>
      Object.entries(filters).every(([k, v]) =>
        Array.isArray(v) ? v.includes(row[k]) : row[k] === v,
      ),
    );
  const cascade = (table: string, parentRows: Row[]) => {
    for (const child of CASCADES[table] ?? []) {
      const ids = parentRows.map((r) => String(r["id"] ?? "")).filter(Boolean);
      if (!ids.length) continue;
      const victims = rows(child.table).filter((r) =>
        ids.includes(String(r[child.column] ?? "")),
      );
      if (!victims.length) continue;
      tables[child.table] = rows(child.table).filter(
        (r) => !victims.includes(r),
      );
      events.push(`cascade:${child.table}`);
      cascade(child.table, victims);
    }
  };

  const from = (table: string) => {
    const filters: Record<string, unknown> = {};
    let head = false;
    let deleteMode = false;
    const chain: Record<string | symbol, unknown> = new Proxy(
      {},
      {
        get(_t, prop) {
          if (typeof prop !== "string") return undefined;
          if (prop === "select")
            return (_cols: string, o?: { count?: string; head?: boolean }) => {
              if (o?.count === "exact" && o?.head) head = true;
              return chain;
            };
          if (prop === "eq" || prop === "in")
            return (col: string, val: unknown) => {
              filters[col] = val;
              return chain;
            };
          if (prop === "delete")
            return () => {
              deleteMode = true;
              return chain;
            };
          if (prop === "order" || prop === "limit") return () => chain;
          if (prop === "single" || prop === "maybeSingle")
            return async () => {
              calls.push({ table, op: prop, filters: { ...filters } });
              return { data: matches(table, filters)[0] ?? null, error: null };
            };
          if (prop === "then")
            return (onF?: unknown) => {
              if (deleteMode) {
                calls.push({ table, op: "delete", filters: { ...filters } });
                const injected = opts.deleteError?.(table, { ...filters });
                let error: { message: string } | null = null;
                if (injected) error = { message: injected };
                else {
                  const targets = matches(table, filters);
                  const blocked = RESTRICTS.some(
                    (r) =>
                      r.table === table &&
                      targets.some((t) =>
                        rows(r.source).some(
                          (s) => s[r.sourceColumn] === t[r.targetColumn],
                        ),
                      ),
                  );
                  if (blocked) error = { message: "FK restrict violation" };
                  else if (targets.length) {
                    tables[table] = rows(table).filter(
                      (r) => !targets.includes(r),
                    );
                    events.push(`delete:${table}`);
                    cascade(table, targets);
                  }
                }
                return Promise.resolve({ data: null, error }).then(
                  onF as never,
                );
              }
              if (head) {
                calls.push({ table, op: "count", filters: { ...filters } });
                return Promise.resolve({
                  data: null,
                  count: matches(table, filters).length,
                  error: null,
                }).then(onF as never);
              }
              calls.push({ table, op: "list", filters: { ...filters } });
              return Promise.resolve({
                data: matches(table, filters),
                error: null,
              }).then(onF as never);
            };
          return () => chain;
        },
      },
    );
    return chain;
  };

  const client = {
    from,
    storage: {
      from: (bucket: string) => ({
        remove: async (paths: string[]) => {
          storageCalls.push({ bucket, paths: [...paths] });
          events.push(`storage-remove:${bucket}`);
          const injected = opts.removeError?.(bucket);
          return injected ? { error: { message: injected } } : { error: null };
        },
      }),
    },
  };
  vi.mocked(createAdminClient).mockReturnValue(client as never);
  return { tables, events, calls, storageCalls };
}

function mockSession(userId: string | null) {
  vi.mocked(createClient).mockResolvedValue({
    auth: {
      getUser: async () => ({
        data: { user: userId ? { id: userId } : null },
      }),
    },
  } as never);
}
function mockUser(userId: string | null) {
  vi.mocked(getCurrentUserAndProfile).mockResolvedValue({
    user: userId ? { id: userId } : null,
    profile: userId ? { id: userId, account_status: "active" } : null,
  } as never);
}

/** Server actions signal redirects by throwing; the URL is in the digest. */
async function redirectUrl(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return String((error as { digest?: string }).digest ?? "");
  }
  return "<no-redirect>";
}

const bulkForm = (currentScanId: string, ids: string[]) => {
  const fd = new FormData();
  fd.set("currentScanId", currentScanId);
  for (const id of ids) fd.append("scanId", id);
  return fd;
};

const scanSeed = (
  scanId: string,
  userId: string,
  uploads: string[],
): Record<string, Row[]> => ({
  bewerbung_scans: [
    { id: scanId, user_id: userId, goal: "arbeit", status: "completed" },
  ],
  candidate_profiles: [
    { id: `cp-${scanId}`, user_id: userId, scan_id: scanId, profile_json: {} },
  ],
  bewerbung_scan_files: uploads.map((fid, i) => ({
    id: `sf-${scanId}-${i}`,
    scan_id: scanId,
    user_id: userId,
    storage_file_id: fid,
  })),
});
/** Merges seed objects table-by-table (spreads would overwrite). */
const mergeSeeds = (...seeds: Record<string, Row[]>[]) =>
  seeds.reduce<Record<string, Row[]>>((acc, seed) => {
    for (const [table, rows] of Object.entries(seed))
      acc[table] = [...(acc[table] ?? []), ...rows];
    return acc;
  }, {});
const uploadRows = (ids: string[], userId = USER): Row[] =>
  ids.map((id) => ({
    id,
    user_id: userId,
    storage_path: `${userId}/${id}.pdf`,
  }));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("bulkDeleteScans — validation gates (zero destructive operations)", () => {
  const seed = makeEngine(
    mergeSeeds(scanSeed(S1, USER, [F1]), scanSeed(S2, USER, [F2]), {
      ai_file_uploads: uploadRows([F1, F2]),
    }),
  );

  it("unauthenticated request → /login, nothing touched", async () => {
    mockSession(null);
    mockUser(USER);
    const url = await redirectUrl(bulkDeleteScans(bulkForm(CUR, [S1])));
    expect(url).toContain("/login");
    expect(seed.calls).toEqual([]);
    expect(seed.events).toEqual([]);
    expect(seed.tables["bewerbung_scans"]).toHaveLength(2);
    expect(seed.storageCalls).toEqual([]);
  });

  it("empty selection → back to the page, zero DB access", async () => {
    mockSession(USER);
    mockUser(USER);
    const url = await redirectUrl(bulkDeleteScans(bulkForm(CUR, [])));
    expect(url).toContain(`/bewerbung-scanner/${CUR}`);
    expect(url).not.toContain("error=");
    expect(seed.calls).toEqual([]);
    expect(seed.events).toEqual([]);
  });

  it("invalid UUID (selection or current scan) → rejected before any DB access", async () => {
    mockSession(USER);
    mockUser(USER);
    const url = await redirectUrl(
      bulkDeleteScans(bulkForm(CUR, ["not-a-uuid"])),
    );
    expect(url).toContain("error=bulk_failed");
    expect(seed.calls).toEqual([]);
    const url2 = await redirectUrl(
      bulkDeleteScans(bulkForm("bogus-current", [S1])),
    );
    expect(url2).toContain("/bewerbung-scanner");
    expect(seed.calls).toEqual([]);
    expect(seed.events).toEqual([]);
  });

  it(`selections over ${BULK_DELETE_MAX_SCANS} (incl. id spam) are rejected with zero operations`, async () => {
    const many = Array.from(
      { length: BULK_DELETE_MAX_SCANS + 1 },
      (_, i) => `${String(i).padStart(8, "a")}-0000-4000-8000-000000000001`,
    );
    mockSession(USER);
    mockUser(USER);
    const url = await redirectUrl(bulkDeleteScans(bulkForm(CUR, many)));
    expect(url).toContain("error=bulk_failed");
    expect(seed.calls).toEqual([]);
    expect(seed.events).toEqual([]);
    // Spamming one owned id 30× still exceeds the raw-entry limit.
    const url2 = await redirectUrl(
      bulkDeleteScans(bulkForm(CUR, Array(30).fill(S1))),
    );
    expect(url2).toContain("error=bulk_failed");
    expect(seed.calls).toEqual([]);
    expect(seed.tables["bewerbung_scans"]).toHaveLength(2);
  });

  it("selecting the current page's own scan is rejected (zero operations)", async () => {
    mockSession(USER);
    mockUser(USER);
    const url = await redirectUrl(bulkDeleteScans(bulkForm(CUR, [CUR, S1])));
    expect(url).toContain("error=bulk_failed");
    expect(seed.calls).toEqual([]);
  });
});

describe("bulkDeleteScans — success & shared-file guarantees", () => {
  it("deletes multiple scans with full Phase 16 erasure per scan", async () => {
    const engine = makeEngine(
      mergeSeeds(scanSeed(S1, USER, [F1]), scanSeed(S2, USER, [F2]), {
        ai_file_uploads: uploadRows([F1, F2]),
      }),
    );
    mockSession(USER);
    mockUser(USER);
    const url = await redirectUrl(bulkDeleteScans(bulkForm(CUR, [S1, S2])));
    expect(url).toContain(`/bewerbung-scanner/${CUR}?bulk_deleted=2`);
    expect(engine.tables["bewerbung_scans"]).toEqual([]);
    expect(engine.tables["candidate_profiles"]).toEqual([]);
    expect(engine.tables["bewerbung_scan_files"]).toEqual([]);
    expect(engine.tables["ai_file_uploads"]).toEqual([]);
    // Unreferenced uploads removed — exactly the two, nothing else.
    expect(engine.storageCalls).toEqual([
      { bucket: "ai-files", paths: [`${USER}/${F1}.pdf`] },
      { bucket: "ai-files", paths: [`${USER}/${F2}.pdf`] },
    ]);
    expect(revalidatePath).toHaveBeenCalledWith(`/bewerbung-scanner/${CUR}`);
    expect(revalidatePath).toHaveBeenCalledWith("/bewerbung-scanner");
  });

  it("allows exactly the server-side limit (25 scans)", async () => {
    const ids = Array.from(
      { length: BULK_DELETE_MAX_SCANS },
      (_, i) => `${String(i).padStart(8, "a")}-0000-4000-8000-000000000001`,
    );
    const engine = makeEngine({
      bewerbung_scans: ids.map((id) => ({
        id,
        user_id: USER,
        goal: "arbeit",
        status: "completed",
      })),
    });
    mockSession(USER);
    mockUser(USER);
    const url = await redirectUrl(bulkDeleteScans(bulkForm(CUR, ids)));
    expect(url).toContain(`?bulk_deleted=${BULK_DELETE_MAX_SCANS}`);
    expect(engine.tables["bewerbung_scans"]).toEqual([]);
  });

  it("dedupes repeated ids (two copies → one deletion)", async () => {
    const engine = makeEngine({
      ...scanSeed(S1, USER, [F1]),
      ai_file_uploads: uploadRows([F1]),
    });
    mockSession(USER);
    mockUser(USER);
    const url = await redirectUrl(bulkDeleteScans(bulkForm(CUR, [S1, S1])));
    expect(url).toContain(`?bulk_deleted=1`);
    expect(engine.tables["bewerbung_scans"]).toEqual([]);
  });

  it("retains uploads still referenced by another (unselected) scan", async () => {
    // S1 and S3 share F1; S3 is NOT selected. S2 owns F2 alone.
    const engine = makeEngine(
      mergeSeeds(
        scanSeed(S1, USER, [F1]),
        scanSeed(S2, USER, [F2]),
        scanSeed(S3, USER, [F1]),
        { ai_file_uploads: uploadRows([F1, F2]) },
      ),
    );
    mockSession(USER);
    mockUser(USER);
    const url = await redirectUrl(bulkDeleteScans(bulkForm(CUR, [S1, S2])));
    expect(url).toContain("?bulk_deleted=2");
    // F1 survives (row + object) — S3 still references it.
    expect(engine.tables["ai_file_uploads"]).toEqual([
      expect.objectContaining({ id: F1 }),
    ]);
    expect(engine.tables["bewerbung_scans"]).toEqual([
      expect.objectContaining({ id: S3 }),
    ]);
    expect(engine.storageCalls).toEqual([
      { bucket: "ai-files", paths: [`${USER}/${F2}.pdf`] },
    ]);
  });

  it("storage failures stay best-effort (rows still erased, no throw)", async () => {
    const engine = makeEngine(
      mergeSeeds(scanSeed(S1, USER, [F1]), scanSeed(S2, USER, [F2]), {
        ai_file_uploads: uploadRows([F1, F2]),
      }),
      { removeError: () => "bucket down" },
    );
    mockSession(USER);
    mockUser(USER);
    const url = await redirectUrl(bulkDeleteScans(bulkForm(CUR, [S1, S2])));
    expect(url).toContain("?bulk_deleted=2");
    expect(engine.tables["bewerbung_scans"]).toEqual([]);
    expect(engine.tables["ai_file_uploads"]).toEqual([]);
    // Objects remain (reclaimed by the Phase 17 janitor later).
    expect(engine.storageCalls).toHaveLength(2);
  });
});

describe("bulkDeleteScans — cross-user safety (no partial execution)", () => {
  const seedWithForeign = () =>
    makeEngine(
      mergeSeeds(
        scanSeed(S1, USER, [F1]),
        scanSeed(S2, USER, [F2]),
        scanSeed(S3, OTHER, [F3]),
        {
          ai_file_uploads: [
            ...uploadRows([F1, F2]),
            ...uploadRows([F3], OTHER),
          ],
        },
      ),
    );

  it("a single foreign scan rejects the whole selection with zero mutation", async () => {
    const engine = seedWithForeign();
    mockSession(USER);
    mockUser(USER);
    const url = await redirectUrl(bulkDeleteScans(bulkForm(CUR, [S1, S3])));
    expect(url).toContain("error=bulk_failed");
    expect(engine.tables["bewerbung_scans"]).toHaveLength(3);
    expect(engine.tables["bewerbung_scan_files"]).toHaveLength(3);
    expect(engine.tables["ai_file_uploads"]).toHaveLength(3);
    expect(engine.events).toEqual([]);
    expect(engine.storageCalls).toEqual([]);
  });

  it("a mixed owned + foreign selection is rejected safely (nothing deleted)", async () => {
    const engine = seedWithForeign();
    mockSession(USER);
    mockUser(USER);
    const url = await redirectUrl(bulkDeleteScans(bulkForm(CUR, [S1, S2, S3])));
    expect(url).toContain("error=bulk_failed");
    // Both owned scans are untouched — no partial cross-user execution.
    expect(engine.tables["bewerbung_scans"]).toHaveLength(3);
    expect(engine.tables["ai_file_uploads"]).toHaveLength(3);
    expect(engine.storageCalls).toEqual([]);
    expect(engine.events).toEqual([]);
  });

  it("never leaks ownership or DB details into the redirect", async () => {
    const engine = seedWithForeign();
    mockSession(USER);
    mockUser(USER);
    const url = await redirectUrl(bulkDeleteScans(bulkForm(CUR, [S1, S3])));
    expect(url).toContain("/bewerbung-scanner/");
    expect(url).toContain("error=bulk_failed");
    expect(url).not.toContain("user_id");
    expect(url).not.toContain("OTHER");
    expect(url).not.toContain("not found");
    void engine;
  });
});

describe("bulkDeleteScans — database failure behavior", () => {
  it("a mid-bulk DB failure stops the loop; the failed scan (and its files) stay untouched", async () => {
    const engine = makeEngine(
      mergeSeeds(scanSeed(S1, USER, [F1]), scanSeed(S2, USER, [F2]), {
        ai_file_uploads: uploadRows([F1, F2]),
      }),
      {
        deleteError: (table, filters) =>
          table === "bewerbung_scans" && filters["id"] === S2
            ? "23503: foreign key constraint violated on bewerbung_scan_files"
            : null,
      },
    );
    mockSession(USER);
    mockUser(USER);
    const url = await redirectUrl(bulkDeleteScans(bulkForm(CUR, [S1, S2])));
    expect(url).toContain("error=bulk_failed");
    // S1 completed its full erasure before the failure…
    expect(engine.tables["bewerbung_scans"]).toEqual([
      expect.objectContaining({ id: S2 }),
    ]);
    expect(engine.tables["bewerbung_scan_files"]).toEqual([
      expect.objectContaining({ scan_id: S2 }),
    ]);
    expect(engine.tables["ai_file_uploads"]).toEqual([
      expect.objectContaining({ id: F2 }),
    ]);
    // …and the failed scan triggered NO storage deletion.
    expect(engine.storageCalls).toEqual([
      { bucket: "ai-files", paths: [`${USER}/${F1}.pdf`] },
    ]);
  });

  it("never exposes the DB error detail in the redirect", async () => {
    makeEngine(
      { ...scanSeed(S1, USER, [F1]), ai_file_uploads: uploadRows([F1]) },
      {
        deleteError: () => 'detail: relation "bewerbung_scans" does not exist',
      },
    );
    mockSession(USER);
    mockUser(USER);
    const url = await redirectUrl(bulkDeleteScans(bulkForm(CUR, [S1])));
    expect(url).toContain("error=bulk_failed");
    expect(url).not.toContain("relation");
    expect(url).not.toContain("does not exist");
  });
});

describe("single-scan deletion (Phase 16 regression)", () => {
  it("deleteScanAction still works exactly as before", async () => {
    const engine = makeEngine({
      ...scanSeed(S1, USER, [F1]),
      ai_file_uploads: uploadRows([F1]),
    });
    mockUser(USER);
    const form = new FormData();
    form.set("scanId", S1);
    const url = await redirectUrl(deleteScanAction(form));
    expect(url).toContain("/bewerbung-scanner?deleted=1");
    expect(engine.tables["bewerbung_scans"]).toEqual([]);
    expect(engine.tables["candidate_profiles"]).toEqual([]);
    expect(engine.tables["ai_file_uploads"]).toEqual([]);
    expect(engine.storageCalls).toEqual([
      { bucket: "ai-files", paths: [`${USER}/${F1}.pdf`] },
    ]);
  });

  it("a malformed single-scan id still redirects with no DB access", async () => {
    const engine = makeEngine({
      ...scanSeed(S1, USER, [F1]),
      ai_file_uploads: uploadRows([F1]),
    });
    mockUser(USER);
    const form = new FormData();
    form.set("scanId", "nope");
    const url = await redirectUrl(deleteScanAction(form));
    expect(url).toContain("/bewerbung-scanner");
    expect(url).not.toContain("deleted=1");
    expect(engine.calls).toEqual([]);
  });
});
