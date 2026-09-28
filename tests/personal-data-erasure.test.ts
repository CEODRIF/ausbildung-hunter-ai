import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getCurrentUserAndProfile: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { createClient } = await import("@/lib/supabase/server");
const { createAdminClient } = await import("@/lib/supabase/admin");
const { getCurrentUserAndProfile } = await import("@/lib/auth");
const { revalidatePath } = await import("next/cache");
const {
  AIFileInUseError,
  AIFileNotFoundError,
  deleteAIFile,
  deleteConversation,
} = await import("@/lib/ai-service");
const { deleteScan } = await import("@/lib/bewerbung-scanner");
const { DELETE: deleteAIFileRoute } = await import("@/app/api/ai/files/route");
const { DELETE: deleteGeneratedFileRoute } =
  await import("@/app/api/ai/generated/[id]/route");
const { DELETE: deleteScanRoute } =
  await import("@/app/api/bewerbung-scanner/[id]/route");
const { deleteScanAction } =
  await import("@/app/bewerbung-scanner/[id]/actions");
const { discardDraft } = await import("@/app/applications/new/actions");

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const FILE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FILE2_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SCAN_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SCAN2_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const CONV_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const MSG_ID = "ffffffff-ffff-4fff-8fff-ffffffffff";
const GEN_ID = "00000000-0000-4000-8000-000000000000";
const DRAFT_ID = "abababab-abab-4aba-8aba-abababababab";

type Row = Record<string, unknown>;

/** FK topology from the migrations (the erasure paths rely on it). */
const CASCADES: Record<string, Array<{ table: string; column: string }>> = {
  ai_conversations: [
    { table: "ai_messages", column: "conversation_id" },
    { table: "ai_generated_files", column: "conversation_id" },
  ],
  ai_messages: [{ table: "ai_message_files", column: "message_id" }],
  bewerbung_scans: [
    { table: "bewerbung_scan_files", column: "scan_id" },
    { table: "candidate_profiles", column: "scan_id" },
  ],
  application_drafts: [
    { table: "application_draft_recipients", column: "draft_id" },
    { table: "application_draft_attachments", column: "draft_id" },
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
  {
    table: "application_drafts",
    source: "email_campaigns",
    sourceColumn: "draft_id",
    targetColumn: "id",
  },
];

interface EngineOptions {
  deleteError?: (table: string) => string | null;
  storageRemoveError?: (bucket: string) => string | null;
}

/** In-memory, FK-faithful Supabase mock: real row filtering, cascades,
 *  RESTRICT violations, head-counts, and an event log for order proofs. */
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
  const storageCalls: Array<{ bucket: string; op: string; paths: string[] }> =
    [];

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
          if (
            prop === "order" ||
            prop === "limit" ||
            prop === "upsert" ||
            prop === "insert" ||
            prop === "update"
          )
            return () => chain;
          if (prop === "single" || prop === "maybeSingle")
            return async () => {
              calls.push({ table, op: prop, filters: { ...filters } });
              return { data: matches(table, filters)[0] ?? null, error: null };
            };
          if (prop === "then")
            return (onF?: unknown) => {
              if (deleteMode) {
                calls.push({ table, op: "delete", filters: { ...filters } });
                const injected = opts.deleteError?.(table);
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
    rpc: async () => ({ data: null, error: null }),
    storage: {
      from: (bucket: string) => ({
        remove: async (paths: string[]) => {
          storageCalls.push({ bucket, op: "remove", paths: [...paths] });
          events.push(`storage-remove:${bucket}`);
          const injected = opts.storageRemoveError?.(bucket);
          return injected ? { error: { message: injected } } : { error: null };
        },
      }),
    },
  };
  vi.mocked(createAdminClient).mockReturnValue(client as never);
  return { tables, events, calls, storageCalls };
}

function mockUser(userId: string | null) {
  vi.mocked(getCurrentUserAndProfile).mockResolvedValue({
    user: userId ? { id: userId } : null,
    profile: userId ? { id: userId, account_status: "active" } : null,
  } as never);
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
/** Server actions signal redirects by throwing; the URL is in the digest. */
async function redirectUrl(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return String((error as { digest?: string }).digest ?? "");
  }
  return "<no-redirect>";
}
const jsonDelete = (url: string, body: unknown) =>
  new Request(url, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("migration guards (existing FK topology)", () => {
  const sql = readFileSync(
    fileURLToPath(
      new URL(
        "../supabase/migrations/20260927050000_bewerbung_scanner.sql",
        import.meta.url,
      ),
    ),
    "utf8",
  );

  it("keeps the upload RESTRICT FK the 409 in-use guard relies on", () => {
    expect(sql).toMatch(
      /storage_file_id uuid not null references public\.ai_file_uploads\(id\) on delete restrict/i,
    );
  });
  it("cascades scan files + candidate profile with the scan row", () => {
    expect(sql).toMatch(
      /scan_id uuid not null references public\.bewerbung_scans\(id\) on delete cascade/i,
    );
  });
});

describe("deleteAIFile (lib)", () => {
  it("rejects without an active session", async () => {
    makeEngine();
    mockUser(null);
    await expect(deleteAIFile(FILE_ID)).rejects.toThrow("Not authorized.");
  });

  it("throws AIFileNotFoundError for a missing/foreign file, touching nothing", async () => {
    const engine = makeEngine({
      ai_file_uploads: [
        { id: FILE_ID, user_id: OTHER_ID, storage_path: `${OTHER_ID}/cv.pdf` },
      ],
    });
    mockUser(USER_ID);
    await expect(deleteAIFile(FILE_ID)).rejects.toThrow(AIFileNotFoundError);
    expect(engine.calls[0]?.filters["user_id"]).toBe(USER_ID);
    expect(engine.events).toEqual([]);
    expect(engine.storageCalls).toEqual([]);
  });

  it("refuses with AIFileInUseError while a scan references the upload", async () => {
    const engine = makeEngine({
      ai_file_uploads: [
        { id: FILE_ID, user_id: USER_ID, storage_path: `${USER_ID}/cv.pdf` },
      ],
      bewerbung_scan_files: [
        {
          id: "sf1",
          scan_id: SCAN_ID,
          user_id: USER_ID,
          storage_file_id: FILE_ID,
        },
      ],
    });
    mockUser(USER_ID);
    await expect(deleteAIFile(FILE_ID)).rejects.toThrow(AIFileInUseError);
    expect(engine.tables["ai_file_uploads"]).toHaveLength(1);
    expect(engine.events).toEqual([]);
    expect(engine.storageCalls).toEqual([]);
  });

  it("deletes the row first, then sweeps the storage object", async () => {
    const engine = makeEngine({
      ai_file_uploads: [
        { id: FILE_ID, user_id: USER_ID, storage_path: `${USER_ID}/cv.pdf` },
      ],
    });
    mockUser(USER_ID);
    await deleteAIFile(FILE_ID);
    expect(engine.tables["ai_file_uploads"]).toEqual([]);
    expect(engine.storageCalls).toEqual([
      { bucket: "ai-files", op: "remove", paths: [`${USER_ID}/cv.pdf`] },
    ]);
    expect(engine.events.indexOf("delete:ai_file_uploads")).toBeLessThan(
      engine.events.indexOf("storage-remove:ai-files"),
    );
  });

  it("survives a storage failure (the row erasure stands)", async () => {
    const engine = makeEngine(
      {
        ai_file_uploads: [
          { id: FILE_ID, user_id: USER_ID, storage_path: `${USER_ID}/cv.pdf` },
        ],
      },
      { storageRemoveError: () => "bucket down" },
    );
    mockUser(USER_ID);
    await expect(deleteAIFile(FILE_ID)).resolves.toBeUndefined();
    expect(engine.tables["ai_file_uploads"]).toEqual([]);
  });
});

describe("DELETE /api/ai/files", () => {
  const ownUpload = {
    ai_file_uploads: [
      { id: FILE_ID, user_id: USER_ID, storage_path: `${USER_ID}/cv.pdf` },
    ],
  };

  it("401 without a session", async () => {
    makeEngine(ownUpload);
    mockSession(null);
    mockUser(null);
    const res = await deleteAIFileRoute(
      jsonDelete("http://localhost/api/ai/files", { fileId: FILE_ID }),
    );
    expect(res.status).toBe(401);
  });

  it("400 on a non-UUID fileId (no DB access)", async () => {
    const engine = makeEngine(ownUpload);
    mockSession(USER_ID);
    mockUser(USER_ID);
    const res = await deleteAIFileRoute(
      jsonDelete("http://localhost/api/ai/files", { fileId: "not-a-uuid" }),
    );
    expect(res.status).toBe(400);
    expect(engine.calls).toEqual([]);
  });

  it("400 on extra fields (strict schema rejects user_id injection)", async () => {
    const engine = makeEngine(ownUpload);
    mockSession(USER_ID);
    mockUser(USER_ID);
    const res = await deleteAIFileRoute(
      jsonDelete("http://localhost/api/ai/files", {
        fileId: FILE_ID,
        user_id: OTHER_ID,
      }),
    );
    expect(res.status).toBe(400);
    expect(engine.calls).toEqual([]);
    expect(engine.tables["ai_file_uploads"]).toHaveLength(1);
  });

  it("400 on invalid JSON", async () => {
    const engine = makeEngine(ownUpload);
    mockSession(USER_ID);
    mockUser(USER_ID);
    const res = await deleteAIFileRoute(
      new Request("http://localhost/api/ai/files", {
        method: "DELETE",
        body: "{not json",
      }),
    );
    expect(res.status).toBe(400);
    expect(engine.calls).toEqual([]);
  });

  it("409 while the file backs a scan — nothing is deleted", async () => {
    const engine = makeEngine({
      ...ownUpload,
      bewerbung_scan_files: [
        {
          id: "sf1",
          scan_id: SCAN_ID,
          user_id: USER_ID,
          storage_file_id: FILE_ID,
        },
      ],
    });
    mockSession(USER_ID);
    mockUser(USER_ID);
    const res = await deleteAIFileRoute(
      jsonDelete("http://localhost/api/ai/files", { fileId: FILE_ID }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "This file is used by a scan. Delete the scan first.",
    });
    expect(engine.tables["ai_file_uploads"]).toHaveLength(1);
    expect(engine.storageCalls).toEqual([]);
  });

  it("404 for a foreign user's file (scoped lookup)", async () => {
    const engine = makeEngine({
      ai_file_uploads: [
        { id: FILE_ID, user_id: OTHER_ID, storage_path: `${OTHER_ID}/cv.pdf` },
      ],
    });
    mockSession(USER_ID);
    mockUser(USER_ID);
    const res = await deleteAIFileRoute(
      jsonDelete("http://localhost/api/ai/files", { fileId: FILE_ID }),
    );
    expect(res.status).toBe(404);
    expect(engine.tables["ai_file_uploads"]).toHaveLength(1);
    expect(engine.storageCalls).toEqual([]);
  });

  it("200 + row delete + storage sweep on the happy path", async () => {
    const engine = makeEngine(ownUpload);
    mockSession(USER_ID);
    mockUser(USER_ID);
    const res = await deleteAIFileRoute(
      jsonDelete("http://localhost/api/ai/files", { fileId: FILE_ID }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(engine.tables["ai_file_uploads"]).toEqual([]);
    expect(engine.storageCalls).toEqual([
      { bucket: "ai-files", op: "remove", paths: [`${USER_ID}/cv.pdf`] },
    ]);
  });

  it("500 when the row delete fails — storage stays untouched", async () => {
    const engine = makeEngine(ownUpload, {
      deleteError: (table) => (table === "ai_file_uploads" ? "db down" : null),
    });
    mockSession(USER_ID);
    mockUser(USER_ID);
    const res = await deleteAIFileRoute(
      jsonDelete("http://localhost/api/ai/files", { fileId: FILE_ID }),
    );
    expect(res.status).toBe(500);
    expect(engine.tables["ai_file_uploads"]).toHaveLength(1);
    expect(engine.storageCalls).toEqual([]);
  });
});

describe("DELETE /api/ai/generated/[id]", () => {
  const ownGenerated = {
    ai_generated_files: [
      {
        id: GEN_ID,
        user_id: USER_ID,
        conversation_id: CONV_ID,
        storage_path: `${USER_ID}/gen.pdf`,
      },
    ],
  };

  it("401 without a session", async () => {
    makeEngine(ownGenerated);
    mockSession(null);
    const res = await deleteGeneratedFileRoute(
      new Request("http://localhost/api/ai/generated/x", { method: "DELETE" }),
      { params: Promise.resolve({ id: GEN_ID }) },
    );
    expect(res.status).toBe(401);
  });

  it("404 on a malformed id without any DB access", async () => {
    const engine = makeEngine(ownGenerated);
    mockSession(USER_ID);
    const res = await deleteGeneratedFileRoute(
      new Request("http://localhost/api/ai/generated/x", { method: "DELETE" }),
      { params: Promise.resolve({ id: "../other-user" }) },
    );
    expect(res.status).toBe(404);
    expect(engine.calls).toEqual([]);
  });

  it("404 for a foreign user's generated file", async () => {
    const engine = makeEngine({
      ai_generated_files: [
        {
          id: GEN_ID,
          user_id: OTHER_ID,
          conversation_id: CONV_ID,
          storage_path: `${OTHER_ID}/gen.pdf`,
        },
      ],
    });
    mockSession(USER_ID);
    const res = await deleteGeneratedFileRoute(
      new Request("http://localhost/api/ai/generated/x", { method: "DELETE" }),
      { params: Promise.resolve({ id: GEN_ID }) },
    );
    expect(res.status).toBe(404);
    expect(engine.tables["ai_generated_files"]).toHaveLength(1);
    expect(engine.storageCalls).toEqual([]);
  });

  it("500 when the row delete fails", async () => {
    makeEngine(ownGenerated, {
      deleteError: (table) =>
        table === "ai_generated_files" ? "db down" : null,
    });
    mockSession(USER_ID);
    const res = await deleteGeneratedFileRoute(
      new Request("http://localhost/api/ai/generated/x", { method: "DELETE" }),
      { params: Promise.resolve({ id: GEN_ID }) },
    );
    expect(res.status).toBe(500);
  });

  it("200 + row delete before the storage sweep", async () => {
    const engine = makeEngine(ownGenerated);
    mockSession(USER_ID);
    const res = await deleteGeneratedFileRoute(
      new Request("http://localhost/api/ai/generated/x", { method: "DELETE" }),
      { params: Promise.resolve({ id: GEN_ID }) },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(engine.tables["ai_generated_files"]).toEqual([]);
    expect(engine.storageCalls).toEqual([
      { bucket: "ai-files", op: "remove", paths: [`${USER_ID}/gen.pdf`] },
    ]);
    expect(engine.events.indexOf("delete:ai_generated_files")).toBeLessThan(
      engine.events.indexOf("storage-remove:ai-files"),
    );
  });
});

describe("deleteScan (lib)", () => {
  const scanSeed = (userId = USER_ID) => ({
    bewerbung_scans: [
      { id: SCAN_ID, user_id: userId, goal: "arbeit", status: "completed" },
    ],
    candidate_profiles: [
      { id: "cp1", user_id: userId, scan_id: SCAN_ID, profile_json: {} },
    ],
    bewerbung_scan_files: [
      {
        id: "sf1",
        scan_id: SCAN_ID,
        user_id: userId,
        storage_file_id: FILE_ID,
      },
      {
        id: "sf2",
        scan_id: SCAN_ID,
        user_id: userId,
        storage_file_id: FILE2_ID,
      },
    ],
    ai_file_uploads: [
      { id: FILE_ID, user_id: userId, storage_path: `${userId}/cv.pdf` },
      { id: FILE2_ID, user_id: userId, storage_path: `${userId}/an.docx` },
    ],
  });

  it("rejects without an active session", async () => {
    makeEngine(scanSeed());
    mockUser(null);
    await expect(deleteScan(SCAN_ID)).rejects.toThrow("Not authorized.");
  });

  it("throws 'Scan not found.' for a missing scan", async () => {
    const engine = makeEngine(scanSeed());
    mockUser(USER_ID);
    await expect(deleteScan(SCAN2_ID)).rejects.toThrow("Scan not found.");
    expect(engine.events).toEqual([]);
  });

  it("never deletes another user's scan (scoped lookup)", async () => {
    const engine = makeEngine(scanSeed(OTHER_ID));
    mockUser(USER_ID);
    await expect(deleteScan(SCAN_ID)).rejects.toThrow("Scan not found.");
    expect(engine.tables["bewerbung_scans"]).toHaveLength(1);
    expect(engine.tables["ai_file_uploads"]).toHaveLength(2);
    expect(engine.events).toEqual([]);
  });

  it("cascades profile + scan files and erases both uploads", async () => {
    const engine = makeEngine(scanSeed());
    mockUser(USER_ID);
    const result = await deleteScan(SCAN_ID);
    expect(result).toEqual({ filesRemoved: 2 });
    expect(engine.tables["bewerbung_scans"]).toEqual([]);
    expect(engine.tables["candidate_profiles"]).toEqual([]);
    expect(engine.tables["bewerbung_scan_files"]).toEqual([]);
    expect(engine.tables["ai_file_uploads"]).toEqual([]);
    expect(engine.storageCalls).toEqual([
      { bucket: "ai-files", op: "remove", paths: [`${USER_ID}/cv.pdf`] },
      { bucket: "ai-files", op: "remove", paths: [`${USER_ID}/an.docx`] },
    ]);
  });

  it("keeps uploads still referenced by another scan (shared files)", async () => {
    const engine = makeEngine({
      ...scanSeed(),
      bewerbung_scans: [
        ...scanSeed().bewerbung_scans,
        { id: SCAN2_ID, user_id: USER_ID, goal: "arbeit", status: "uploading" },
      ],
      bewerbung_scan_files: [
        ...scanSeed().bewerbung_scan_files,
        {
          id: "sf3",
          scan_id: SCAN2_ID,
          user_id: USER_ID,
          storage_file_id: FILE_ID,
        },
      ],
    });
    mockUser(USER_ID);
    const result = await deleteScan(SCAN_ID);
    expect(result).toEqual({ filesRemoved: 1 });
    // FILE_ID is shared with SCAN2: row + object survive.
    expect(engine.tables["ai_file_uploads"]).toEqual([
      expect.objectContaining({ id: FILE_ID }),
    ]);
    expect(engine.tables["bewerbung_scans"]).toEqual([
      expect.objectContaining({ id: SCAN2_ID }),
    ]);
    expect(engine.storageCalls).toEqual([
      { bucket: "ai-files", op: "remove", paths: [`${USER_ID}/an.docx`] },
    ]);
  });

  it("treats a storage failure as best-effort (rows still erased)", async () => {
    const engine = makeEngine(scanSeed(), {
      storageRemoveError: () => "bucket down",
    });
    mockUser(USER_ID);
    const result = await deleteScan(SCAN_ID);
    expect(result).toEqual({ filesRemoved: 2 });
    expect(engine.tables["bewerbung_scans"]).toEqual([]);
    expect(engine.tables["ai_file_uploads"]).toEqual([]);
  });
});

describe("DELETE /api/bewerbung-scanner/[id]", () => {
  it("401 without a session", async () => {
    makeEngine();
    mockUser(null);
    const res = await deleteScanRoute(
      new Request("http://localhost/api/bewerbung-scanner/x", {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: SCAN_ID }) },
    );
    expect(res.status).toBe(401);
  });

  it("404 on a malformed id without any DB access", async () => {
    const engine = makeEngine();
    mockUser(USER_ID);
    const res = await deleteScanRoute(
      new Request("http://localhost/api/bewerbung-scanner/x", {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: "bogus" }) },
    );
    expect(res.status).toBe(404);
    expect(engine.calls).toEqual([]);
  });

  it("404 for a missing scan", async () => {
    makeEngine();
    mockUser(USER_ID);
    const res = await deleteScanRoute(
      new Request("http://localhost/api/bewerbung-scanner/x", {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: SCAN_ID }) },
    );
    expect(res.status).toBe(404);
  });

  it("500 when the scan row delete fails (no details leak)", async () => {
    const engine = makeEngine(
      {
        bewerbung_scans: [
          {
            id: SCAN_ID,
            user_id: USER_ID,
            goal: "arbeit",
            status: "completed",
          },
        ],
      },
      {
        deleteError: (table) =>
          table === "bewerbung_scans" ? "fk violation detail" : null,
      },
    );
    mockUser(USER_ID);
    const res = await deleteScanRoute(
      new Request("http://localhost/api/bewerbung-scanner/x", {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: SCAN_ID }) },
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Unable to delete scan." });
    expect(engine.tables["bewerbung_scans"]).toHaveLength(1);
  });

  it("200 + cascade on the happy path", async () => {
    const engine = makeEngine({
      bewerbung_scans: [
        { id: SCAN_ID, user_id: USER_ID, goal: "arbeit", status: "completed" },
      ],
    });
    mockUser(USER_ID);
    const res = await deleteScanRoute(
      new Request("http://localhost/api/bewerbung-scanner/x", {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: SCAN_ID }) },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, filesRemoved: 0 });
    expect(engine.tables["bewerbung_scans"]).toEqual([]);
  });
});

describe("deleteScanAction (server action)", () => {
  const form = (scanId: string) => {
    const fd = new FormData();
    fd.set("scanId", scanId);
    return fd;
  };

  it("redirects to the list on a malformed id without DB access", async () => {
    const engine = makeEngine();
    mockUser(USER_ID);
    const url = await redirectUrl(deleteScanAction(form("not-a-uuid")));
    expect(url).toContain("/bewerbung-scanner");
    expect(url).not.toContain("deleted=1");
    expect(engine.calls).toEqual([]);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("redirects back with deleted=1 after a successful erasure", async () => {
    const engine = makeEngine({
      bewerbung_scans: [
        { id: SCAN_ID, user_id: USER_ID, goal: "arbeit", status: "completed" },
      ],
    });
    mockUser(USER_ID);
    const url = await redirectUrl(deleteScanAction(form(SCAN_ID)));
    expect(url).toContain("/bewerbung-scanner?deleted=1");
    expect(revalidatePath).toHaveBeenCalledWith("/bewerbung-scanner");
    expect(engine.tables["bewerbung_scans"]).toEqual([]);
  });

  it("lands on the same redirect for a missing scan (no error leak)", async () => {
    makeEngine();
    mockUser(USER_ID);
    const url = await redirectUrl(deleteScanAction(form(SCAN2_ID)));
    expect(url).toContain("/bewerbung-scanner?deleted=1");
    expect(url).not.toContain("not found");
  });
});

describe("deleteConversation (lib, Phase 16 storage sweep)", () => {
  const conversationSeed = (userId = USER_ID) => ({
    ai_conversations: [
      {
        id: CONV_ID,
        user_id: userId,
        title: "t",
        created_at: "",
        updated_at: "",
      },
    ],
    ai_messages: [
      {
        id: MSG_ID,
        conversation_id: CONV_ID,
        user_id: userId,
        role: "user",
        content: "c",
      },
    ],
    ai_message_files: [
      {
        id: "mf1",
        message_id: MSG_ID,
        user_id: userId,
        storage_path: `${userId}/m1.pdf`,
      },
      {
        id: "mf2",
        message_id: MSG_ID,
        user_id: userId,
        storage_path: `${userId}/m2.pdf`,
      },
    ],
    ai_generated_files: [
      {
        id: GEN_ID,
        user_id: userId,
        conversation_id: CONV_ID,
        storage_path: `${userId}/g1.pdf`,
      },
    ],
  });

  it("throws 'Conversation not found.' for a missing conversation", async () => {
    makeEngine(conversationSeed());
    mockUser(USER_ID);
    await expect(deleteConversation("missing-id")).rejects.toThrow(
      "Conversation not found.",
    );
  });

  it("never touches another user's conversation (scoped)", async () => {
    const engine = makeEngine(conversationSeed(OTHER_ID));
    mockUser(USER_ID);
    await expect(deleteConversation(CONV_ID)).rejects.toThrow(
      "Conversation not found.",
    );
    expect(engine.tables["ai_conversations"]).toHaveLength(1);
    expect(engine.events).toEqual([]);
  });

  it("sweeps message + generated file objects after the cascade", async () => {
    const engine = makeEngine(conversationSeed());
    mockUser(USER_ID);
    await deleteConversation(CONV_ID);
    expect(engine.tables["ai_conversations"]).toEqual([]);
    expect(engine.tables["ai_messages"]).toEqual([]);
    expect(engine.tables["ai_message_files"]).toEqual([]);
    expect(engine.tables["ai_generated_files"]).toEqual([]);
    expect(engine.storageCalls).toEqual([
      {
        bucket: "ai-files",
        op: "remove",
        paths: [`${USER_ID}/m1.pdf`, `${USER_ID}/m2.pdf`, `${USER_ID}/g1.pdf`],
      },
    ]);
    expect(engine.events.indexOf("delete:ai_conversations")).toBeLessThan(
      engine.events.indexOf("storage-remove:ai-files"),
    );
  });

  it("makes no storage call when the conversation has no files", async () => {
    const engine = makeEngine({
      ai_conversations: [
        {
          id: CONV_ID,
          user_id: USER_ID,
          title: "t",
          created_at: "",
          updated_at: "",
        },
      ],
    });
    mockUser(USER_ID);
    await deleteConversation(CONV_ID);
    expect(engine.tables["ai_conversations"]).toEqual([]);
    expect(engine.storageCalls).toEqual([]);
  });

  it("treats a storage failure as best-effort (rows still erased)", async () => {
    const engine = makeEngine(conversationSeed(), {
      storageRemoveError: () => "bucket down",
    });
    mockUser(USER_ID);
    await expect(deleteConversation(CONV_ID)).resolves.toBeUndefined();
    expect(engine.tables["ai_conversations"]).toEqual([]);
    expect(engine.tables["ai_message_files"]).toEqual([]);
  });
});

describe("discardDraft (server action)", () => {
  const form = (draftId: string) => {
    const fd = new FormData();
    fd.set("draftId", draftId);
    return fd;
  };
  const draftSeed = (userId = USER_ID) => ({
    application_drafts: [
      { id: DRAFT_ID, user_id: userId, goal: "arbeit", subject: "s" },
    ],
    application_draft_recipients: [
      { id: "dr1", draft_id: DRAFT_ID, email: "x@y.z", user_id: userId },
    ],
    application_draft_attachments: [
      {
        id: "da1",
        draft_id: DRAFT_ID,
        storage_path: `${userId}/cv.pdf`,
        filename: "cv.pdf",
      },
      {
        id: "da2",
        draft_id: DRAFT_ID,
        storage_path: `${userId}/an.docx`,
        filename: "an.docx",
      },
    ],
  });

  it("rejects without an active session", async () => {
    makeEngine();
    mockUser(null);
    await expect(discardDraft(form(DRAFT_ID))).rejects.toThrow(
      "Not authorized.",
    );
  });

  it("invalidates on a malformed id without any DB access", async () => {
    const engine = makeEngine(draftSeed());
    mockUser(USER_ID);
    await discardDraft(form("not-a-uuid"));
    expect(engine.calls).toEqual([]);
    expect(revalidatePath).toHaveBeenCalledWith("/applications/new");
  });

  it("never deletes a foreign draft (no ownership detail leaks)", async () => {
    const engine = makeEngine(draftSeed(OTHER_ID));
    mockUser(USER_ID);
    await discardDraft(form(DRAFT_ID));
    expect(engine.tables["application_drafts"]).toHaveLength(1);
    expect(engine.tables["application_draft_attachments"]).toHaveLength(2);
    expect(engine.events).toEqual([]);
    expect(engine.storageCalls).toEqual([]);
    expect(revalidatePath).toHaveBeenCalledWith("/applications/new");
  });

  it("cascades recipients + attachments and sweeps storage on success", async () => {
    const engine = makeEngine(draftSeed());
    mockUser(USER_ID);
    await discardDraft(form(DRAFT_ID));
    expect(engine.tables["application_drafts"]).toEqual([]);
    expect(engine.tables["application_draft_recipients"]).toEqual([]);
    expect(engine.tables["application_draft_attachments"]).toEqual([]);
    expect(engine.storageCalls).toEqual([
      {
        bucket: "application-attachments",
        op: "remove",
        paths: [`${USER_ID}/cv.pdf`, `${USER_ID}/an.docx`],
      },
    ]);
    const deleteCall = engine.calls.find(
      (c) => c.table === "application_drafts" && c.op === "delete",
    );
    expect(deleteCall?.filters).toEqual({
      id: DRAFT_ID,
      user_id: USER_ID,
    });
    expect(revalidatePath).toHaveBeenCalledWith("/applications/new");
  });

  it("blocks (FK RESTRICT) while a campaign references the draft", async () => {
    const engine = makeEngine({
      ...draftSeed(),
      email_campaigns: [
        {
          id: "cam1",
          user_id: USER_ID,
          draft_id: DRAFT_ID,
          status: "completed",
        },
      ],
    });
    mockUser(USER_ID);
    await expect(discardDraft(form(DRAFT_ID))).rejects.toThrow(
      "Unable to delete draft.",
    );
    expect(engine.tables["application_drafts"]).toHaveLength(1);
    expect(engine.storageCalls).toEqual([]);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("throws a generic error when the delete fails (no revalidation)", async () => {
    const engine = makeEngine(draftSeed(), {
      deleteError: (table) =>
        table === "application_drafts" ? "db down" : null,
    });
    mockUser(USER_ID);
    await expect(discardDraft(form(DRAFT_ID))).rejects.toThrow(
      "Unable to delete draft.",
    );
    expect(engine.tables["application_drafts"]).toHaveLength(1);
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
