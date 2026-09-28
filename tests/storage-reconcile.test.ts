import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getCurrentUserAndProfile: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { createAdminClient } = await import("@/lib/supabase/admin");
const { getCurrentUserAndProfile } = await import("@/lib/auth");
const { reconcileStorage, MAX_MAX_DELETES } =
  await import("@/lib/storage-reconcile");
const { POST: reconcileRoute } =
  await import("@/app/api/internal/storage-reconcile/route");
const { removeAttachment } = await import("@/app/applications/new/actions");

const SECRET = "test-reconcile-secret-1a2b3c4d";
const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";

const NOW = new Date("2026-09-29T12:00:00.000Z");
const OLD = new Date(NOW.getTime() - 48 * 3600 * 1000).toISOString();
const YOUNG = new Date(NOW.getTime() - 2 * 3600 * 1000).toISOString();

type Row = Record<string, unknown>;
interface StoredObject {
  name: string;
  created_at: string | null;
}

interface ReconcileEngineOptions {
  /** Rows that only exist from the 2nd reference-collection pass on —
   *  simulates a row appearing between the scan and the delete. */
  revealOnFinalCheck?: Array<{ table: string; row: Row }>;
  referenceReadError?: (table: string) => string | null;
  listError?: (bucket: string) => string | null;
  removeError?: (bucket: string) => string | null;
  deleteError?: (table: string) => string | null;
}

/** In-memory engine: paginated table reads (range + single + delete) and a
 *  storage mock (list with search/offset/limit + remove), with an event log
 *  for order proofs. Reference-collection passes are tracked so the
 *  double-check race can be simulated. */
function makeEngine(
  seed: {
    tables?: Record<string, Row[]>;
    objects?: Record<string, StoredObject[]>;
    users?: string[];
  } = {},
  opts: ReconcileEngineOptions = {},
) {
  const tables: Record<string, Row[]> = {
    profiles: (seed.users ?? []).map((id) => ({ id })),
    ...(seed.tables ?? {}),
  };
  const objectsSeed = seed.objects ?? {};
  const objects: Record<string, StoredObject[]> = Object.fromEntries(
    Object.keys(objectsSeed).map((b) => [b, [...(objectsSeed[b] ?? [])]]),
  );
  const events: string[] = [];
  let passIndex = 0;
  let passTables = new Set<string>();

  const matches = (table: string, filters: Record<string, unknown>) =>
    (tables[table] ?? []).filter((row) =>
      Object.entries(filters).every(([k, v]) =>
        Array.isArray(v) ? v.includes(row[k]) : row[k] === v,
      ),
    );

  const from = (table: string) => {
    const filters: Record<string, unknown> = {};
    let deleteMode = false;
    const chain: Record<string | symbol, unknown> = new Proxy(
      {},
      {
        get(_t, prop) {
          if (typeof prop !== "string") return undefined;
          if (prop === "select") return () => chain;
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
          if (prop === "range")
            return (a: number, b: number) => {
              // A fresh collection pass starts at page 0 when either nothing
              // has been read yet, or the first table of the sequence is
              // re-queried (each table is read at most once per pass).
              if (a === 0) {
                if (passTables.size > 0 && passTables.has(table)) {
                  passIndex += 1;
                  passTables = new Set();
                } else if (passTables.size === 0) {
                  passIndex += 1;
                }
              }
              passTables.add(table);
              const injected = opts.referenceReadError?.(table);
              const extra =
                passIndex >= 2
                  ? (opts.revealOnFinalCheck ?? [])
                      .filter((r) => r.table === table)
                      .map((r) => r.row)
                  : [];
              const all = [...(tables[table] ?? []), ...extra];
              const rows = all.slice(a, b + 1);
              return {
                then: (onF?: unknown) =>
                  Promise.resolve(
                    injected
                      ? { data: null, error: { message: injected } }
                      : { data: rows, error: null },
                  ).then(onF as never),
              };
            };
          if (prop === "single" || prop === "maybeSingle")
            return async () => ({
              data: matches(table, filters)[0] ?? null,
              error: null,
            });
          if (prop === "then")
            return (onF?: unknown) => {
              if (deleteMode) {
                const injected = opts.deleteError?.(table);
                let error: { message: string } | null = null;
                if (injected) error = { message: injected };
                else {
                  const targets = matches(table, filters);
                  if (targets.length) {
                    tables[table] = (tables[table] ?? []).filter(
                      (r) => !targets.includes(r),
                    );
                    events.push(`delete:${table}`);
                  }
                }
                return Promise.resolve({ data: null, error }).then(
                  onF as never,
                );
              }
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
        list: async (
          _path: string,
          o?: { limit?: number; offset?: number; search?: string },
        ) => {
          if (opts.listError?.(bucket))
            return { data: null, error: { message: "list down" } };
          const all = (objects[bucket] ?? []).filter((obj) =>
            o?.search ? obj.name.includes(o.search) : true,
          );
          const offset = o?.offset ?? 0;
          const limit = o?.limit ?? 100;
          return {
            data: all
              .slice(offset, offset + limit)
              .map((obj) => ({ name: obj.name, created_at: obj.created_at })),
            error: null,
          };
        },
        remove: async (paths: string[]) => {
          if (opts.removeError?.(bucket))
            return { error: { message: "remove down" } };
          for (const p of paths) {
            objects[bucket] = (objects[bucket] ?? []).filter(
              (o) => o.name !== p,
            );
            events.push(`storage-remove:${bucket}:${p}`);
          }
          return { error: null };
        },
      }),
    },
  };
  vi.mocked(createAdminClient).mockReturnValue(client as never);
  return { tables, objects, events };
}

function mockUser(userId: string | null) {
  vi.mocked(getCurrentUserAndProfile).mockResolvedValue({
    user: userId ? { id: userId } : null,
    profile: userId ? { id: userId, account_status: "active" } : null,
  } as never);
}

function reconcileRequest(body: unknown, secret: string | null = SECRET) {
  return new Request("http://localhost/api/internal/storage-reconcile", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(secret === null ? {} : { "x-email-worker-secret": secret }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const aiFiles = (objects: StoredObject[]) => ({
  objects: { "ai-files": objects },
});

describe("reconcileStorage (lib)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("dry run (default) reports orphans and deletes nothing", async () => {
    const engine = makeEngine({
      users: [USER_A],
      ...aiFiles([
        { name: `${USER_A}/live.pdf`, created_at: OLD },
        { name: `${USER_A}/orphan.pdf`, created_at: OLD },
      ]),
      tables: {
        ai_file_uploads: [
          { id: "u1", user_id: USER_A, storage_path: `${USER_A}/live.pdf` },
        ],
      },
    });
    const report = await reconcileStorage({ now: NOW });
    expect(report.dryRun).toBe(true);
    const ai = report.buckets.find((b) => b.bucket === "ai-files");
    expect(ai).toEqual(
      expect.objectContaining({
        scanned: 2,
        referenced: 1,
        orphans: 1,
        tooYoung: 0,
        unknownPrefix: 0,
        deleted: 0,
        wouldDelete: [`${USER_A}/orphan.pdf`],
      }),
    );
    expect(engine.events).toEqual([]);
    expect(engine.objects["ai-files"]).toHaveLength(2);
  });

  it("execute mode deletes only up to the maxDeletes budget", async () => {
    const engine = makeEngine({
      users: [USER_A],
      ...aiFiles([
        { name: `${USER_A}/o1.pdf`, created_at: OLD },
        { name: `${USER_A}/o2.pdf`, created_at: OLD },
        { name: `${USER_A}/o3.pdf`, created_at: OLD },
        { name: `${USER_A}/live.pdf`, created_at: OLD },
      ]),
      tables: {
        ai_file_uploads: [
          { id: "u1", user_id: USER_A, storage_path: `${USER_A}/live.pdf` },
        ],
      },
    });
    const report = await reconcileStorage({
      execute: true,
      maxDeletes: 2,
      now: NOW,
    });
    const ai = report.buckets.find((b) => b.bucket === "ai-files");
    expect(ai?.orphans).toBe(3);
    expect(ai?.deleted).toBe(2);
    expect(engine.objects["ai-files"]).toHaveLength(2);
    expect(engine.events).toHaveLength(2);
  });

  it("collects references across pages (>1000 rows — no silent row cap)", async () => {
    // 2500 live message-file references: a 1000-row cap would "delete" 1500
    // live CVs. The reference collection must be fully paginated.
    const messageFiles: Row[] = [];
    const fileObjects: StoredObject[] = [];
    for (let i = 0; i < 2500; i++) {
      const path = `${USER_A}/cv-${i}.pdf`;
      messageFiles.push({
        id: `mf${i}`,
        message_id: "m1",
        user_id: USER_A,
        storage_path: path,
      });
      fileObjects.push({ name: path, created_at: OLD });
    }
    const engine = makeEngine({
      users: [USER_A],
      ...aiFiles(fileObjects),
      tables: { ai_message_files: messageFiles },
    });
    const report = await reconcileStorage({
      execute: true,
      maxDeletes: 100,
      now: NOW,
    });
    const ai = report.buckets.find((b) => b.bucket === "ai-files");
    expect(ai?.referenced).toBe(2500);
    expect(ai?.orphans).toBe(0);
    expect(ai?.deleted).toBe(0);
    expect(engine.objects["ai-files"]).toHaveLength(2500);
    expect(engine.events).toEqual([]);
  });

  it("never deletes objects inside the 24h grace period", async () => {
    const engine = makeEngine({
      users: [USER_A],
      ...aiFiles([{ name: `${USER_A}/young.pdf`, created_at: YOUNG }]),
    });
    const report = await reconcileStorage({ execute: true, now: NOW });
    const ai = report.buckets.find((b) => b.bucket === "ai-files");
    expect(ai?.tooYoung).toBe(1);
    expect(ai?.orphans).toBe(0);
    expect(ai?.deleted).toBe(0);
    expect(engine.events).toEqual([]);
  });

  it("never deletes objects with an unknown age (defensive)", async () => {
    const engine = makeEngine({
      users: [USER_A],
      ...aiFiles([{ name: `${USER_A}/undated.pdf`, created_at: null }]),
    });
    const report = await reconcileStorage({ execute: true, now: NOW });
    const ai = report.buckets.find((b) => b.bucket === "ai-files");
    expect(ai?.tooYoung).toBe(1);
    expect(ai?.deleted).toBe(0);
    expect(engine.events).toEqual([]);
    expect(engine.objects["ai-files"]).toHaveLength(1);
  });

  it("never deletes objects outside a {user-uuid}/ prefix (reported only)", async () => {
    // A profile id that is not a UUID: objects under its prefix are listed
    // but must be reported, never deleted (defensive gate).
    const engine = makeEngine({
      users: ["shared"],
      ...aiFiles([{ name: "shared/stray.pdf", created_at: OLD }]),
    });
    const report = await reconcileStorage({ execute: true, now: NOW });
    const ai = report.buckets.find((b) => b.bucket === "ai-files");
    expect(ai?.unknownPrefix).toBe(1);
    expect(ai?.orphans).toBe(0);
    expect(ai?.deleted).toBe(0);
    expect(engine.objects["ai-files"]).toHaveLength(1);
  });

  it("double-check wins: a row appearing between scan and delete is kept", async () => {
    const engine = makeEngine(
      {
        users: [USER_A],
        ...aiFiles([{ name: `${USER_A}/orphan.pdf`, created_at: OLD }]),
      },
      {
        revealOnFinalCheck: [
          {
            table: "ai_message_files",
            row: {
              id: "late",
              message_id: "m9",
              user_id: USER_A,
              storage_path: `${USER_A}/orphan.pdf`,
            },
          },
        ],
      },
    );
    const report = await reconcileStorage({ execute: true, now: NOW });
    const ai = report.buckets.find((b) => b.bucket === "ai-files");
    expect(ai?.orphans).toBe(1); // seen during the scan…
    expect(ai?.deleted).toBe(0); // …but the fresh re-collection keeps it
    expect(engine.objects["ai-files"]).toHaveLength(1);
    expect(engine.events).toEqual([]);
  });

  it("reports (not throws) storage remove failures for the next tick", async () => {
    const engine = makeEngine(
      {
        users: [USER_A],
        ...aiFiles([
          { name: `${USER_A}/o1.pdf`, created_at: OLD },
          { name: `${USER_A}/o2.pdf`, created_at: OLD },
        ]),
      },
      { removeError: () => "bucket down" },
    );
    const report = await reconcileStorage({ execute: true, now: NOW });
    const ai = report.buckets.find((b) => b.bucket === "ai-files");
    expect(ai?.deleted).toBe(0);
    expect(ai?.deleteErrors).toBe(2);
    expect(engine.objects["ai-files"]).toHaveLength(2);
  });

  it("aborts the whole tick loudly on a database read failure", async () => {
    const engine = makeEngine(
      {
        users: [USER_A],
        ...aiFiles([{ name: `${USER_A}/o1.pdf`, created_at: OLD }]),
        objects: {
          "ai-files": [{ name: `${USER_A}/o1.pdf`, created_at: OLD }],
          "application-attachments": [
            { name: `${USER_A}/draft1/a.pdf`, created_at: OLD },
          ],
        },
      },
      {
        referenceReadError: (t) => (t === "ai_file_uploads" ? "db down" : null),
      },
    );
    await expect(reconcileStorage({ execute: true, now: NOW })).rejects.toThrow(
      /storage_reconcile_failed/,
    );
    expect(engine.events).toEqual([]);
    // Nothing in either bucket was touched.
    expect(engine.objects["ai-files"]).toHaveLength(1);
    expect(engine.objects["application-attachments"]).toHaveLength(1);
  });

  it("aborts the tick (deletes nothing) on a storage list failure", async () => {
    const engine = makeEngine(
      {
        users: [USER_A],
        objects: {
          "ai-files": [{ name: `${USER_A}/o1.pdf`, created_at: OLD }],
        },
      },
      { listError: () => "list down" },
    );
    await expect(reconcileStorage({ execute: true, now: NOW })).rejects.toThrow(
      /storage_reconcile_failed/,
    );
    expect(engine.events).toEqual([]);
  });

  it("reports missing objects (dangling rows) without attempting to fix them", async () => {
    const engine = makeEngine({
      users: [USER_A],
      ...aiFiles([{ name: `${USER_A}/other.pdf`, created_at: OLD }]),
      tables: {
        ai_file_uploads: [
          {
            id: "u1",
            user_id: USER_A,
            storage_path: `${USER_A}/vanished.pdf`,
          },
        ],
      },
    });
    const report = await reconcileStorage({ execute: true, now: NOW });
    const ai = report.buckets.find((b) => b.bucket === "ai-files");
    // The dangling row is only reported — while `other.pdf` is a genuine
    // orphan and is legitimately reclaimed.
    expect(ai?.missingObjects).toBe(1);
    expect(ai?.orphans).toBe(1);
    expect(ai?.deleted).toBe(1);
    expect(engine.events).toEqual([
      `storage-remove:ai-files:${USER_A}/other.pdf`,
    ]);
  });

  it("clamps maxDeletes to the storage batch limit (100)", async () => {
    const orphans = Array.from({ length: 150 }, (_, i) => ({
      name: `${USER_A}/o${i}.pdf`,
      created_at: OLD,
    }));
    const engine = makeEngine({ users: [USER_A], ...aiFiles(orphans) });
    const report = await reconcileStorage({
      execute: true,
      maxDeletes: 1000,
      now: NOW,
    });
    expect(report.maxDeletes).toBe(100);
    expect(report.maxDeletes).toBe(MAX_MAX_DELETES);
    const ai = report.buckets.find((b) => b.bucket === "ai-files");
    expect(ai?.deleted).toBe(100);
    expect(engine.objects["ai-files"]).toHaveLength(50);
  });

  it("scans users across pages (>1000 users — bounded, no cap on discovery)", async () => {
    const uuidUsers = Array.from(
      { length: 1500 },
      (_, i) =>
        `${String(i).padStart(8, "0")}-${String(i).padStart(4, "0")}-4001-8001-${String(i).padStart(12, "0")}`,
    );
    const objects: StoredObject[] = uuidUsers.map((u) => ({
      name: `${u}/orphan.pdf`,
      created_at: OLD,
    }));
    const engine = makeEngine({
      users: uuidUsers,
      ...aiFiles(objects),
    });
    const report = await reconcileStorage({
      execute: true,
      maxDeletes: 100,
      now: NOW,
    });
    const ai = report.buckets.find((b) => b.bucket === "ai-files");
    expect(ai?.scanned).toBe(1500);
    expect(ai?.orphans).toBe(1500);
    expect(ai?.deleted).toBe(100);
    expect(engine.objects["ai-files"]).toHaveLength(1400);
  });
});

describe("POST /api/internal/storage-reconcile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("EMAIL_WORKER_SECRET", SECRET);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const orphanSeed = () =>
    makeEngine({
      users: [USER_A],
      ...aiFiles([{ name: `${USER_A}/orphan.pdf`, created_at: OLD }]),
    });

  it("401 when the secret header is missing", async () => {
    const engine = orphanSeed();
    const res = await reconcileRoute(reconcileRequest({}, null));
    expect(res.status).toBe(401);
    expect(engine.events).toEqual([]);
  });

  it("401 on a wrong secret", async () => {
    orphanSeed();
    const res = await reconcileRoute(reconcileRequest({}, "wrong-secret"));
    expect(res.status).toBe(401);
  });

  it("401 when no worker secret is configured (fail closed)", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("EMAIL_WORKER_SECRET", "");
    orphanSeed();
    const res = await reconcileRoute(reconcileRequest({}, SECRET));
    expect(res.status).toBe(401);
  });

  it("400 on extra fields (strict schema)", async () => {
    orphanSeed();
    const res = await reconcileRoute(
      reconcileRequest({ execute: true, maxDeletes: 1, bucket: "ai-files" }),
    );
    expect(res.status).toBe(400);
  });

  it("400 on out-of-range or non-integer maxDeletes", async () => {
    orphanSeed();
    for (const body of [
      { maxDeletes: 0 },
      { maxDeletes: 101 },
      { maxDeletes: 2.5 },
    ]) {
      const res = await reconcileRoute(reconcileRequest(body));
      expect(res.status).toBe(400);
    }
  });

  it("400 on invalid JSON", async () => {
    orphanSeed();
    const res = await reconcileRoute(
      new Request("http://localhost/api/internal/storage-reconcile", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-email-worker-secret": SECRET,
        },
        body: "{not json",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("defaults to a dry run — orphans exist but nothing is deleted", async () => {
    const engine = orphanSeed();
    const res = await reconcileRoute(reconcileRequest({}));
    expect(res.status).toBe(200);
    const report = (await res.json()) as { dryRun: boolean };
    expect(report.dryRun).toBe(true);
    expect(engine.events).toEqual([]);
    expect(engine.objects["ai-files"]).toHaveLength(1);
  });

  it("execute:true performs a bounded deletion", async () => {
    const engine = orphanSeed();
    const res = await reconcileRoute(
      reconcileRequest({ execute: true, maxDeletes: 1 }),
    );
    expect(res.status).toBe(200);
    const report = (await res.json()) as {
      dryRun: boolean;
      buckets: Array<{ bucket: string; deleted: number }>;
    };
    expect(report.dryRun).toBe(false);
    expect(report.buckets.find((b) => b.bucket === "ai-files")?.deleted).toBe(
      1,
    );
    expect(engine.objects["ai-files"]).toHaveLength(0);
  });

  it("500 with a generic message on internal failure (no detail leak)", async () => {
    makeEngine(
      {
        users: [USER_A],
        ...aiFiles([{ name: `${USER_A}/o.pdf`, created_at: OLD }]),
      },
      { referenceReadError: () => "relation ai_file_uploads does not exist" },
    );
    const res = await reconcileRoute(reconcileRequest({}));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Reconciliation failed" });
  });
});

describe("removeAttachment (Phase 17 ordering)", () => {
  const seed = (userId: string = USER_A) =>
    makeEngine({
      users: [USER_A, USER_B],
      tables: {
        application_drafts: [{ id: "d1", user_id: userId, goal: "arbeit" }],
        application_draft_attachments: [
          {
            id: "a1",
            draft_id: "d1",
            user_id: userId,
            storage_path: `${userId}/d1/att.pdf`,
          },
        ],
      },
      objects: {
        "application-attachments": [
          { name: `${userId}/d1/att.pdf`, created_at: OLD },
        ],
      },
    });

  beforeEach(() => vi.clearAllMocks());

  it("rejects without a session", async () => {
    seed();
    mockUser(null);
    await expect(
      removeAttachment({ draftId: "d1", attachmentId: "a1" }),
    ).rejects.toThrow("Not authorized.");
  });

  it("rejects a foreign draft (ownership)", async () => {
    const engine = seed(USER_B);
    mockUser(USER_A);
    await expect(
      removeAttachment({ draftId: "d1", attachmentId: "a1" }),
    ).rejects.toThrow("Draft not found.");
    expect(engine.events).toEqual([]);
  });

  it("deletes the row first, then sweeps storage (erasure contract)", async () => {
    const engine = seed();
    mockUser(USER_A);
    await removeAttachment({ draftId: "d1", attachmentId: "a1" });
    expect(engine.tables["application_draft_attachments"]).toEqual([]);
    expect(engine.objects["application-attachments"]).toEqual([]);
    const deleteIdx = engine.events.indexOf(
      "delete:application_draft_attachments",
    );
    const removeIdx = engine.events.findIndex((e) =>
      e.startsWith("storage-remove:application-attachments"),
    );
    expect(deleteIdx).toBeGreaterThanOrEqual(0);
    expect(removeIdx).toBeGreaterThanOrEqual(0);
    expect(deleteIdx).toBeLessThan(removeIdx);
  });

  it("survives a storage failure (the row erasure stands, orphan is reclaimed later)", async () => {
    const engine = makeEngine(
      {
        users: [USER_A, USER_B],
        tables: {
          application_drafts: [{ id: "d1", user_id: USER_A, goal: "arbeit" }],
          application_draft_attachments: [
            {
              id: "a1",
              draft_id: "d1",
              user_id: USER_A,
              storage_path: `${USER_A}/d1/att.pdf`,
            },
          ],
        },
        objects: {
          "application-attachments": [
            { name: `${USER_A}/d1/att.pdf`, created_at: OLD },
          ],
        },
      },
      { removeError: () => "bucket down" },
    );
    mockUser(USER_A);
    await expect(
      removeAttachment({ draftId: "d1", attachmentId: "a1" }),
    ).resolves.toBeUndefined();
    expect(engine.tables["application_draft_attachments"]).toEqual([]);
    expect(engine.objects["application-attachments"]).toHaveLength(1);
  });

  it("throws when the row delete fails — storage stays untouched", async () => {
    const engine = makeEngine(
      {
        users: [USER_A, USER_B],
        tables: {
          application_drafts: [{ id: "d1", user_id: USER_A, goal: "arbeit" }],
          application_draft_attachments: [
            {
              id: "a1",
              draft_id: "d1",
              user_id: USER_A,
              storage_path: `${USER_A}/d1/att.pdf`,
            },
          ],
        },
        objects: {
          "application-attachments": [
            { name: `${USER_A}/d1/att.pdf`, created_at: OLD },
          ],
        },
      },
      {
        deleteError: (t) =>
          t === "application_draft_attachments" ? "db down" : null,
      },
    );
    mockUser(USER_A);
    await expect(
      removeAttachment({ draftId: "d1", attachmentId: "a1" }),
    ).rejects.toThrow("Unable to remove attachment.");
    expect(engine.tables["application_draft_attachments"]).toHaveLength(1);
    expect(engine.events).toEqual([]);
  });
});
