import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Phase 17 — storage orphan reconciliation (janitor).
 *
 * Every erasure path in this app is row-first with a *best-effort* storage
 * sweep: a transient storage failure (or a crash inside a storage-first
 * upload, or any pre-Phase-16 conversation deletion) can leave a storage
 * object behind whose database row is gone. For active accounts only whole-
 * account deletion would ever remove such an object — a CV the user deleted
 * would otherwise remain in storage indefinitely. This module is the
 * scheduled janitor that closes that gap.
 *
 * Safety model (all server-side, all tested):
 * - **Dry-run by default** — the worker endpoint only deletes when the body
 *   explicitly says `execute: true`; the default tick reports what it would
 *   delete.
 * - **Reference collection is paginated** — a PostgREST row cap must never
 *   let a live reference go unseen (an unseen reference is a deleted live
 *   file).
 * - **Age grace period** — objects younger than 24 h are never deleted
 *   (protects the storage-first upload window).
 * - **Prefix gate** — only objects under a valid `{user-uuid}/` prefix are
 *   ever candidates; anything else is reported and never touched.
 * - **DM gate (Phase 6A, community-images only)** — objects under the
 *   conversation-prefixed `dm/` namespace are candidates only when the
 *   full shape `dm/{uuid}/{uuid}/…` matches AND the sender (third segment)
 *   is a live user; anything else is reported and never touched.
 * - **Double-check** — references are re-collected immediately before any
 *   deletion; a row that appears between scan and delete wins.
 * - **Bounded execution** — at most `maxDeletes` (clamped ≤ 100, the
 *   storage batch limit) objects per tick.
 * - **Loud failure** — any database read or storage LIST error aborts the
 *   whole tick (no partial, unverifiable knowledge is ever acted on).
 *   Storage REMOVE errors are reported per batch, never thrown.
 */

export const RECONCILE_GRACE_PERIOD_HOURS = 24;
export const DEFAULT_MAX_DELETES = 50;
export const MAX_MAX_DELETES = 100;

const LIST_PAGE_SIZE = 1000;
const MAX_LIST_PAGES = 20;
const REF_PAGE_SIZE = 1000;
const MAX_REF_PAGES = 50;
const USER_PREFIX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\//i;

/** Phase 6A — strict DM image shape: dm/{conversation-uuid}/{sender-uuid}/…
 *  (capture group 2 = the sender, checked against live users below). */
const DM_PATH_SHAPE =
  /^dm\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/.+/i;

interface BucketSpec {
  bucket: string;
  referenceTables: Array<{ table: string; column: string }>;
  /** Phase 6A: additionally scan the conversation-prefixed `dm/` namespace
   *  (Community DM images) under the strict DM gate. */
  dmScan?: boolean;
}

/** The two private buckets and the tables whose rows keep objects alive. */
export const BUCKETS: BucketSpec[] = [
  {
    bucket: "ai-files",
    referenceTables: [
      { table: "ai_file_uploads", column: "storage_path" },
      { table: "ai_message_files", column: "storage_path" },
      { table: "ai_generated_files", column: "storage_path" },
    ],
  },
  {
    bucket: "application-attachments",
    referenceTables: [
      { table: "application_draft_attachments", column: "storage_path" },
    ],
  },
  // Phase 6A — Community images. Reference set = every live Community image
  // row (room messages, questions, DMs — sender-agnostic: a referenced
  // object survives regardless of which user's row points at it).
  {
    bucket: "community-images",
    referenceTables: [
      { table: "community_messages", column: "image_path" },
      { table: "community_questions", column: "image_path" },
      { table: "community_direct_messages", column: "image_path" },
    ],
    dmScan: true,
  },
];

export interface BucketReport {
  bucket: string;
  /** Objects listed under live user prefixes. */
  scanned: number;
  /** Objects with at least one live referencing row. */
  referenced: number;
  /** Unreferenced, old enough, valid prefix — deletion candidates. */
  orphans: number;
  /** Unreferenced but inside the age grace period (retried next tick). */
  tooYoung: number;
  /** Not under a `{user-uuid}/` prefix — reported, never deleted. */
  unknownPrefix: number;
  /** Rows referencing objects that are missing from storage (diagnostic only). */
  missingObjects: number;
  /** Dry-run: sample of what would be deleted (capped). */
  wouldDelete: string[];
  /** Execute mode: objects actually removed this tick. */
  deleted: number;
  /** Execute mode: objects whose removal reported a failure (retried next tick). */
  deleteErrors: number;
}

export interface ReconcileReport {
  dryRun: boolean;
  maxDeletes: number;
  gracePeriodHours: number;
  generatedAt: string;
  buckets: BucketReport[];
}

export interface ReconcileOptions {
  /** false (default) = report only; true = delete up to `maxDeletes`. */
  execute?: boolean;
  /** Per-tick deletion budget (clamped to 1..MAX_MAX_DELETES). */
  maxDeletes?: number;
  /** Injectable clock (tests). */
  now?: Date;
}

type AdminClient = ReturnType<typeof createAdminClient>;

async function collectReferencePaths(
  admin: AdminClient,
  spec: BucketSpec,
): Promise<Set<string>> {
  const paths = new Set<string>();
  for (const { table, column } of spec.referenceTables) {
    for (let page = 0; page < MAX_REF_PAGES; page++) {
      const from = page * REF_PAGE_SIZE;
      const to = from + REF_PAGE_SIZE - 1;
      const { data, error } = await admin
        .from(table)
        .select(column)
        .range(from, to);
      if (error)
        throw new Error(`storage_reconcile_failed: reference read (${table})`);
      const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;
      for (const row of rows) {
        const value = row[column];
        if (typeof value === "string" && value.length > 0) paths.add(value);
      }
      if (rows.length < REF_PAGE_SIZE) break;
    }
  }
  return paths;
}

async function collectUserPrefixes(admin: AdminClient): Promise<string[]> {
  const users: string[] = [];
  for (let page = 0; page < MAX_REF_PAGES; page++) {
    const from = page * REF_PAGE_SIZE;
    const to = from + REF_PAGE_SIZE - 1;
    const { data, error } = await admin
      .from("profiles")
      .select("id")
      .range(from, to);
    if (error) throw new Error("storage_reconcile_failed: user read");
    const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;
    for (const row of rows) {
      if (typeof row["id"] === "string") users.push(row["id"]);
    }
    if (rows.length < REF_PAGE_SIZE) break;
  }
  return users;
}

interface ListedObject {
  name: string;
  createdAt: string | null;
}

/** Storage LIST failures abort the tick (loud, no partial knowledge). */
async function listUserObjects(
  admin: AdminClient,
  bucket: string,
  userId: string,
): Promise<ListedObject[]> {
  const objects: ListedObject[] = [];
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const { data, error } = await admin.storage.from(bucket).list("", {
      search: `${userId}/`,
      limit: LIST_PAGE_SIZE,
      offset: page * LIST_PAGE_SIZE,
    });
    if (error)
      throw new Error(`storage_reconcile_failed: list (${bucket}/${userId})`);
    const files = (data ?? []) as unknown as Array<Record<string, unknown>>;
    const prefix = `${userId}/`;
    for (const file of files) {
      const name = typeof file["name"] === "string" ? file["name"] : null;
      // Defensive: the account-deletion sweep uses the same filter — only
      // objects actually under the searched prefix are in scope.
      if (!name || !name.startsWith(prefix)) continue;
      const metadata = (file["metadata"] ?? {}) as Record<string, unknown>;
      objects.push({
        name,
        createdAt:
          typeof file["created_at"] === "string"
            ? file["created_at"]
            : typeof metadata["created_at"] === "string"
              ? metadata["created_at"]
              : null,
      });
    }
    if (files.length < LIST_PAGE_SIZE) break;
  }
  return objects;
}

/** Phase 6A — enumerate objects under the `dm/` namespace (paginated;
 *  storage LIST failures abort the tick, like the user-prefix list). */
async function listDmObjects(admin: AdminClient, bucket: string): Promise<ListedObject[]> {
  const objects: ListedObject[] = [];
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const { data, error } = await admin.storage.from(bucket).list("", {
      search: "dm/",
      limit: LIST_PAGE_SIZE,
      offset: page * LIST_PAGE_SIZE,
    });
    if (error) throw new Error(`storage_reconcile_failed: list (${bucket}/dm)`);
    const files = (data ?? []) as unknown as Array<Record<string, unknown>>;
    for (const file of files) {
      const name = typeof file["name"] === "string" ? file["name"] : null;
      // Defensive: substring search — only names actually under `dm/`.
      if (!name || !name.startsWith("dm/")) continue;
      const metadata = (file["metadata"] ?? {}) as Record<string, unknown>;
      objects.push({
        name,
        createdAt:
          typeof file["created_at"] === "string"
            ? file["created_at"]
            : typeof metadata["created_at"] === "string"
              ? metadata["created_at"]
              : null,
      });
    }
    if (files.length < LIST_PAGE_SIZE) break;
  }
  return objects;
}

async function reconcileBucket(
  admin: AdminClient,
  spec: BucketSpec,
  opts: { execute: boolean; maxDeletes: number; now: Date },
): Promise<BucketReport> {
  const graceMs = RECONCILE_GRACE_PERIOD_HOURS * 60 * 60 * 1000;
  const report: BucketReport = {
    bucket: spec.bucket,
    scanned: 0,
    referenced: 0,
    orphans: 0,
    tooYoung: 0,
    unknownPrefix: 0,
    missingObjects: 0,
    wouldDelete: [],
    deleted: 0,
    deleteErrors: 0,
  };

  const referenced = await collectReferencePaths(admin, spec);
  const users = await collectUserPrefixes(admin);

  const listed = new Set<string>();
  const orphans: string[] = [];
  for (const userId of users) {
    for (const obj of await listUserObjects(admin, spec.bucket, userId)) {
      report.scanned += 1;
      listed.add(obj.name);
      if (referenced.has(obj.name)) {
        report.referenced += 1;
        continue;
      }
      if (!USER_PREFIX.test(obj.name)) {
        // Defensive: semantics unknown — report, never delete.
        report.unknownPrefix += 1;
        continue;
      }
      const age =
        obj.createdAt !== null
          ? opts.now.getTime() - Date.parse(obj.createdAt)
          : null;
      // Unknown age is treated as too young (never delete what we cannot date).
      if (age === null || Number.isNaN(age) || age < graceMs) {
        report.tooYoung += 1;
        continue;
      }
      orphans.push(obj.name);
    }
  }

  // Phase 6A — `dm/` namespace (Community DM images). Same safety model as
  // the user-prefix pass, plus the strict DM gate: a candidate must match
  // dm/{uuid}/{uuid}/… AND its sender (third segment) must be a live user.
  if (spec.dmScan) {
    const liveUsers = new Set(users);
    for (const obj of await listDmObjects(admin, spec.bucket)) {
      report.scanned += 1;
      listed.add(obj.name);
      if (referenced.has(obj.name)) {
        report.referenced += 1;
        continue;
      }
      const match = DM_PATH_SHAPE.exec(obj.name);
      if (!match || !liveUsers.has(match[1])) {
        // Shape unknown or sender no longer exists — report, never delete.
        report.unknownPrefix += 1;
        continue;
      }
      const age =
        obj.createdAt !== null
          ? opts.now.getTime() - Date.parse(obj.createdAt)
          : null;
      if (age === null || Number.isNaN(age) || age < graceMs) {
        report.tooYoung += 1;
        continue;
      }
      orphans.push(obj.name);
    }
  }

  // Diagnostic only — rows pointing at missing objects (e.g. a failed
  // storage-first upload whose compensation also failed). Never "fixed" here.
  for (const path of referenced) {
    if (!listed.has(path)) report.missingObjects += 1;
  }

  report.orphans = orphans.length;
  if (!opts.execute) {
    report.wouldDelete = orphans.slice(0, 20);
    return report;
  }

  // Double-check: a row appearing between the scan and the delete wins.
  const fresh = await collectReferencePaths(admin, spec);
  const candidates = orphans
    .filter((path) => !fresh.has(path))
    .slice(0, opts.maxDeletes);
  for (let i = 0; i < candidates.length; i += MAX_MAX_DELETES) {
    const batch = candidates.slice(i, i + MAX_MAX_DELETES);
    const { error } = await admin.storage.from(spec.bucket).remove(batch);
    if (error) report.deleteErrors += batch.length;
    else report.deleted += batch.length;
  }
  return report;
}

/** Run one reconciliation tick across both private buckets. */
export async function reconcileStorage(
  options: ReconcileOptions = {},
): Promise<ReconcileReport> {
  const admin = createAdminClient();
  const execute = options.execute === true;
  const maxDeletes = Math.min(
    MAX_MAX_DELETES,
    Math.max(1, Math.trunc(options.maxDeletes ?? DEFAULT_MAX_DELETES)),
  );
  const now = options.now ?? new Date();

  const buckets: BucketReport[] = [];
  for (const spec of BUCKETS) {
    // A read failure throws and aborts the tick (route → 500, next retry).
    buckets.push(
      await reconcileBucket(admin, spec, { execute, maxDeletes, now }),
    );
  }

  return {
    dryRun: !execute,
    maxDeletes,
    gracePeriodHours: RECONCILE_GRACE_PERIOD_HOURS,
    generatedAt: now.toISOString(),
    buckets,
  };
}
