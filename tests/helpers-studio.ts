/**
 * AI Bewerbung Studio — in-memory Supabase-style admin client for tests.
 *
 * The studio engine (src/lib/studio.ts) only talks to Postgres through
 * createAdminClient() (service role). This helper emulates the small slice
 * of the PostgREST builder API the engine uses:
 *   from(table).select/eq/in/gte/order/limit/insert/update(.select).maybeSingle/single
 * plus admin.storage.from(bucket).upload/remove and admin.rpc.
 *
 * It models the UNIQUE constraints of the studio migration
 * (studio_send_attempts.idempotency_key, studio_applications.idempotency_key,
 * studio_documents (application_id, doc_type, version)) so duplicate-send and
 * versioning behavior can be tested without a database.
 *
 * No real I/O, no network, no email — the email provider is mocked by the
 * consuming test file.
 */
import { randomUUID } from "node:crypto";

export interface RecordedOp {
  table: string;
  op: "select" | "insert" | "update" | "rpc" | "storage";
  filters: Record<string, unknown>;
  args: unknown[];
}

interface ChainState {
  table: string;
  filters: Array<{ kind: "eq" | "in" | "gte"; col: string; val: unknown }>;
  limit: number | null;
  pending:
    | { op: "select" }
    | { op: "insert"; vals: Record<string, unknown> }
    | { op: "update"; vals: Record<string, unknown> }
    | { op: "delete" }
    | null;
  shape: "rows" | "single" | "maybeSingle";
  selectAfter: boolean;
}

export function createStudioDb(seed: Record<string, Record<string, unknown>[]> = {}) {
  const tables: Record<string, Record<string, unknown>[]> = {
    studio_applications: [],
    studio_documents: [],
    studio_attachments: [],
    studio_send_attempts: [],
    email_accounts: [],
    activity_logs: [],
    candidate_profiles: [],
    profiles: [],
    ...seed,
  };
  const calls: RecordedOp[] = [];
  const uploaded: Array<{ bucket: string; path: string }> = [];
  let failTables: Set<string> = new Set();
  let rpcImpl: ((fn: string, args: Record<string, unknown>) => { data: unknown; error: unknown } | Promise<{ data: unknown; error: unknown }>) | null = null;
  let uploadError: unknown = null;
  /** Inject a PostgREST-style insert error per table (e.g. missing column). */
  const insertErrors: Record<string, string> = {};

  function rows(table: string): Record<string, unknown>[] {
    return tables[table] ?? [];
  }

  function matches(row: Record<string, unknown>, filters: ChainState["filters"]): boolean {
    return filters.every((f) => {
      const v = row[f.col];
      if (f.kind === "eq") {
        if (f.val === null) return v === null || v === undefined;
        return v === f.val;
      }
      if (f.kind === "in") return Array.isArray(f.val) && f.val.includes(v);
      if (f.kind === "gte") return v !== null && v !== undefined && (v as string | number) >= (f.val as string | number);
      return true;
    });
  }

  function uniqueConflict(table: string, vals: Record<string, unknown>): boolean {
    // Mirrors the real partial unique index from
    // 20261212000000_studio_slot_no.sql: (user_id, slot_no) WHERE slot_no > 0.
    if (table === "studio_applications" && typeof vals.slot_no === "number" && vals.slot_no > 0) {
      return rows(table).some((r) => r.user_id === vals.user_id && r.slot_no === vals.slot_no);
    }
    if (table === "studio_send_attempts" && vals.idempotency_key != null) {
      return rows(table).some((r) => r.idempotency_key === vals.idempotency_key && r.id !== vals.id);
    }
    if (table === "studio_applications" && vals.idempotency_key != null) {
      return rows(table).some((r) => r.idempotency_key === vals.idempotency_key && r.id !== vals.id);
    }
    if (table === "studio_documents") {
      return rows(table).some(
        (r) =>
          r.application_id === vals.application_id &&
          r.doc_type === vals.doc_type &&
          r.version === vals.version &&
          r.id !== vals.id,
      );
    }
    return false;
  }

  function makeChain(table: string) {
    const st: ChainState = { table, filters: [], limit: null, pending: null, shape: "rows", selectAfter: false };

    const chain: Record<string | symbol, unknown> = {
      select: (..._args: unknown[]) => {
        // Column lists intentionally not modeled — full rows are returned.
        st.selectAfter = st.pending !== null;
        if (st.pending === null) st.pending = { op: "select" };
        return chain;
      },
      eq: (col: string, val: unknown) => (st.filters.push({ kind: "eq", col, val }), chain),
      in: (col: string, val: unknown[]) => (st.filters.push({ kind: "in", col, val }), chain),
      gte: (col: string, val: unknown) => (st.filters.push({ kind: "gte", col, val }), chain),
      order: (..._args: unknown[]) => chain,
      limit: (n: number) => ((st.limit = n), chain),
      insert: (vals: Record<string, unknown>) => ((st.pending = { op: "insert", vals }), chain),
      update: (vals: Record<string, unknown>) => ((st.pending = { op: "update", vals }), chain),
      delete: () => ((st.pending = { op: "delete" }), chain),
      maybeSingle: () => ((st.shape = "maybeSingle"), chain),
      single: () => ((st.shape = "single"), chain),
    };

    chain.then = (
      onFulfilled?: (v: unknown) => unknown,
      onRejected?: (e: unknown) => unknown,
    ): Promise<unknown> => {
      const result = Promise.resolve().then(execute);
      return onFulfilled ? result.then(onFulfilled, onRejected) : result.then(undefined, onRejected);
    };
    function execute(): { data: unknown; error: unknown } {
      if (failTables.has(table)) {
        return { data: null, error: { message: `relation "public.${table}" does not exist` } };
      }
      const ts = rows(table);
      const matched = ts.filter((r) => matches(r, st.filters));
      if (st.pending?.op === "insert") {
        calls.push({ table, op: "insert", filters: filterMap(st), args: [st.pending.vals] });
        if (insertErrors[table]) {
          return { data: null, error: { message: insertErrors[table] } };
        }
        if (uniqueConflict(table, st.pending.vals)) {
          // Postgres-accurate constraint name so engine classification
          // (which matches on the constraint) is tested faithfully.
          const constraint =
            table === "studio_applications" && typeof st.pending.vals.slot_no === "number" && st.pending.vals.slot_no > 0
              ? "studio_applications_user_slot_unique"
              : table === "studio_send_attempts"
                ? "studio_send_attempts_idempotency_key_key"
                : table === "studio_documents"
                  ? "studio_documents_application_id_doc_type_version_key"
                  : "unknown_unique";
          return {
            data: null,
            error: { message: `duplicate key value violates unique constraint "${constraint}"` },
          };
        }
        const row: Record<string, unknown> = {
          id: randomUUID(),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          ...st.pending.vals,
        };
        ts.push(row);
        const out = st.shape === "single" || st.selectAfter ? row : null;
        return { data: out, error: null };
      }
      if (st.pending?.op === "update") {
        calls.push({ table, op: "update", filters: filterMap(st), args: [st.pending.vals] });
        for (const r of matched) Object.assign(r, st.pending.vals, { updated_at: new Date().toISOString() });
        const out = st.shape === "maybeSingle" ? matched[0] ?? null : st.shape === "single" ? matched[0] ?? null : st.selectAfter ? matched : null;
        if (st.shape === "single" && !matched.length) {
          return { data: null, error: { message: "no rows" } };
        }
        return { data: out, error: null };
      }
      if (st.pending?.op === "delete") {
        calls.push({ table, op: "select", filters: filterMap(st), args: [] });
        tables[table] = ts.filter((r) => !matches(r, st.filters));
        return { data: null, error: null };
      }
      // plain select
      calls.push({ table, op: "select", filters: filterMap(st), args: [] });
      const limited = st.limit !== null ? matched.slice(0, st.limit) : matched;
      if (st.shape === "maybeSingle") return { data: limited[0] ?? null, error: null };
      if (st.shape === "single") {
        return limited.length
          ? { data: limited[0], error: null }
          : { data: null, error: { message: "no rows" } };
      }
      return { data: limited, error: null };
    }

    function filterMap(st: ChainState): Record<string, unknown> {
      const m: Record<string, unknown> = {};
      for (const f of st.filters) m[f.kind === "in" ? `in:${f.col}` : `${f.kind}:${f.col}`] = f.val;
      return m;
    }

    return chain as unknown as typeof chain & Promise<{ data: unknown; error: unknown }>;
  }

  const admin = {
    from: (table: string) => makeChain(table),
    rpc: async (fn: string, args: Record<string, unknown> = {}): Promise<{ data: unknown; error: unknown }> => {
      calls.push({ table: fn, op: "rpc", filters: {}, args: [args] });
      if (rpcImpl) return rpcImpl(fn, args);
      if (fn === "recover_stale_studio_attempts") return { data: 0, error: null };
      if (fn === "claim_due_studio_attempts") return { data: [], error: null };
      if (fn === "feature_quota_status" || fn === "feature_capacity_status")
        return { data: { used: 0, resets_at: null }, error: null };
      if (fn === "reserve_feature_op") return { data: [{ status: "reserved" }], error: null };
      if (fn === "complete_feature_op") return { data: [{ status: "no_op" }], error: null };
      if (fn === "release_feature_op") return { data: [{ status: "released" }], error: null };
      return { data: null, error: null };
    },
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string, _buffer: unknown, _opts: unknown) => {
          calls.push({ table: bucket, op: "storage", filters: { path }, args: [] });
          if (uploadError) return { error: uploadError };
          uploaded.push({ bucket, path });
          return { error: null };
        },
        remove: async (paths: string[]) => {
          calls.push({ table: bucket, op: "storage", filters: { remove: paths }, args: [] });
          return { error: null };
        },
      }),
    },
  };

  return {
    tables,
    calls,
    uploaded,
    admin,
    /** Simulate the pre-migration state (tables do not exist yet). */
    failTables: (names: string[]) => (failTables = new Set(names)),
    /** Force a specific PostgREST insert error on the next inserts for a table. */
    failInsert: (table: string, message: string) => (insertErrors[table] = message),
    setRpc: (impl: NonNullable<typeof rpcImpl>) => (rpcImpl = impl),
    setUploadError: (e: unknown) => (uploadError = e),
  };
}

export type StudioDb = ReturnType<typeof createStudioDb>;
