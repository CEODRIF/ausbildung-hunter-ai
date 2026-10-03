import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Authorization / IDOR contracts.
 *
 * The rules enforced here:
 *  - every API route proves who is calling it, or is on a documented public
 *    allowlist (health probe, provider webhook, OAuth callback, the
 *    secret-authenticated internal worker endpoints);
 *  - no route derives the ACTOR from the request body — identity comes from
 *    the session, and a client-supplied id is only ever a TARGET that must be
 *    re-checked server-side (`.eq("user_id", ...)`);
 *  - the database is the last line of defence: RLS on, `auth.uid()`-scoped
 *    policies, privileged RPCs revoked from client roles, and every
 *    SECURITY DEFINER function pinned to `set search_path = public`.
 */
const root = fileURLToPath(new URL("../..", import.meta.url));
const apiDir = join(root, "src/app/api");
const read = (file: string) => readFileSync(file, "utf8");
const rel = (file: string) => file.replace(`${root}/`, "");

function walk(dir: string, filter: (file: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, filter));
    else if (filter(full)) out.push(full);
  }
  return out;
}

const routeFiles = walk(apiDir, (file) => file.endsWith("route.ts")).sort();

/** Recognized proof of authentication inside a route module. */
const AUTH_TOKENS = [
  "getCurrentUserAndProfile",
  "requireAdmin",
  "auth.getUser",
  "currentUser(",
  "EMAIL_WORKER_SECRET",
  "CRON_SECRET",
  "verifyBillingWebhook",
] as const;

/**
 * Endpoints that are intentionally reachable without a user session, each for
 * a documented reason. Adding a route here is a security decision.
 */
const PUBLIC_ROUTES: Record<string, string> = {
  "src/app/api/health/route.ts": "unauthenticated liveness/readiness probe",
  "src/app/api/billing/webhook/route.ts": "provider webhook (signature-verified)",
  "src/app/api/email/callback/[provider]/route.ts":
    "OAuth redirect target (state-verified, session-scoped)",
  "src/app/api/internal/email-worker/route.ts": "shared-secret worker endpoint",
  "src/app/api/internal/email-worker/claim/route.ts":
    "shared-secret worker endpoint",
  "src/app/api/internal/storage-reconcile/route.ts":
    "shared-secret maintenance endpoint",
};

const migrationDir = join(root, "supabase/migrations");
const migrations = readdirSync(migrationDir)
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => ({
    name,
    sql: readFileSync(join(migrationDir, name), "utf8"),
  }));
const allSql = migrations.map((m) => m.sql).join("\n");
const normalizedSql = allSql.replace(/\s+/g, " ");

describe("every API route authenticates the caller", () => {
  it("finds the routes (sanity)", () => {
    expect(routeFiles.length).toBeGreaterThanOrEqual(34);
  });

  it("no route is missing an authentication check outside the allowlist", () => {
    const unguarded = routeFiles
      .filter((file) => !AUTH_TOKENS.some((token) => read(file).includes(token)))
      .map(rel)
      .filter((file) => !(file in PUBLIC_ROUTES));
    expect(unguarded).toEqual([]);
  });

  it("every allowlisted public route still carries its own gate", () => {
    for (const file of Object.keys(PUBLIC_ROUTES)) {
      const source = read(join(root, file));
      const hasGate = AUTH_TOKENS.some((token) => source.includes(token));
      expect(hasGate, `${file} has no gate at all`).toBe(true);
    }
  });

  it("the internal worker endpoints verify their shared secret BEFORE the body is used", () => {
    for (const file of routeFiles.filter((f) => rel(f).includes("src/app/api/internal/"))) {
      const source = read(file);
      const secretCheck = source.indexOf("EMAIL_WORKER_SECRET");
      const firstBodyUse = source.indexOf("await request.json()");
      expect(secretCheck).toBeGreaterThan(-1);
      expect(secretCheck).toBeLessThan(firstBodyUse);
      // Fail closed when the secret is not configured.
      expect(source).toMatch(/!configuredSecret/);
    }
  });
});

describe("identity is never taken from the request", () => {
  it("no route reads an actor id out of the body or query", () => {
    const offenders = routeFiles
      .map((file) => ({ file: rel(file), source: read(file) }))
      .filter(({ source }) =>
        /body\.(user_?[iI]d|userId)|searchParams\.get\(["']user_?id["']\)|params\.[a-zA-Z]*user_?[iI]d/.test(
          source,
        ),
      )
      // The worker endpoints act on behalf of the shared secret, not a user
      // session — they are excluded because they authenticate the CALLER.
      .filter(({ file }) => !file.includes("src/app/api/internal/"))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it("client-supplied conversation ids are re-scoped to the session user", () => {
    const generate = read(join(apiDir, "ai/generate-file/route.ts"));
    expect(generate).toContain('.eq("user_id", user.id)');
    const service = read(join(root, "src/lib/ai-service.ts"));
    // assertConversation is the single gate every conversation-scoped call uses.
    expect(service).toMatch(
      /async function assertConversation\([\s\S]{0,400}\.eq\("user_id", userId\)/,
    );
  });

  it("the scanner re-reads uploads scoped to the session user (foreign id cannot be scanned)", () => {
    const scanner = read(join(root, "src/lib/bewerbung-scanner.ts"));
    expect(scanner).toMatch(
      /from\("ai_file_uploads"\)[\s\S]{0,200}\.eq\("user_id", user\.id\)/,
    );
    // …and refuses when the resolved set does not match the requested files.
    expect(scanner).toContain("uploads.length !== files.length");
  });

  it("the scanner request contract cannot carry storage_path / size_bytes / user_id", () => {
    const schema = read(join(root, "src/lib/bewerbung-schema.ts"));
    const scanSchema = schema.slice(
      schema.indexOf("export const scanFileReferenceSchema"),
      schema.indexOf("export const scanRequestBodySchema"),
    );
    expect(scanSchema).not.toContain("storage_path");
    expect(scanSchema).not.toContain("size_bytes");
    expect(scanSchema).not.toContain("user_id");
    // The library only accepts the fields it needs.
    const scanner = read(join(root, "src/lib/bewerbung-scanner.ts"));
    expect(scanner).toContain(
      'export type ScanFileInput = Pick<ScanFile, "id" | "filename" | "mime_type">;',
    );
    expect(scanner).toContain("files: ScanFileInput[]");
  });

  it("admin routes require an admin/owner role (vertical privilege escalation)", () => {
    const adminRoutes = routeFiles.filter((f) => rel(f).includes("src/app/api/admin/"));
    expect(adminRoutes.length).toBeGreaterThan(0);
    // requireAdmin (billing/plan administration) or requirePlatformOwner (the
    // notification console, which is stricter still).
    for (const file of adminRoutes) {
      expect(read(file), rel(file)).toMatch(/requireAdmin|requirePlatformOwner/);
    }
  });
});

describe("database authorization (RLS, grants, SECURITY DEFINER)", () => {
  it("profiles are readable/updatable only by their owner", () => {
    const foundation = migrations.find((m) => m.name.includes("auth_foundation"));
    expect(foundation).toBeTruthy();
    const sql = foundation!.sql.replace(/\s+/g, " ");
    expect(sql).toContain("alter table public.profiles enable row level security");
    expect(sql).toMatch(
      /create policy "Users can read their own profile"[\s\S]{0,200}auth\.uid\(\) = id/,
    );
    expect(sql).toMatch(
      /create policy "Users can update their own onboarding fields"[\s\S]{0,260}auth\.uid\(\) = id/,
    );
    // …and only those two: no INSERT/DELETE policy may exist on profiles.
    expect(sql).not.toMatch(/create policy [^;]* on public\.profiles for insert/i);
    expect(sql).not.toMatch(/create policy [^;]* on public\.profiles for delete/i);
  });

  it("system-managed profile fields cannot be self-escalated", () => {
    const foundation = migrations.find((m) => m.name.includes("auth_foundation"))!;
    const fn = foundation.sql.replace(/\s+/g, " ");
    for (const column of [
      "account_status",
      "daily_email_limit",
      "full_name",
      "email",
      "id",
      "created_at",
    ]) {
      expect(fn, `${column} is not protected`).toMatch(
        new RegExp(`new\\.${column}\\s*:?=\\s*old\\.${column}`),
      );
    }
    // The guard only applies to the authenticated role (service role keeps
    // full control for admin flows).
    expect(fn).toContain("auth.role() = 'authenticated'");
  });

  it("invitation and verification codes are closed to client roles", () => {
    const foundation = migrations.find((m) => m.name.includes("auth_foundation"))!;
    const sql = foundation.sql.replace(/\s+/g, " ");
    for (const table of ["invitation_codes", "verification_codes"]) {
      expect(sql).toContain(`alter table public.${table} enable row level security`);
      expect(sql).toMatch(
        new RegExp(`revoke all on public\\.${table} from anon, authenticated`),
      );
    }
    // No permissive policy may exist on them.
    expect(normalizedSql).not.toMatch(
      /create policy [^;]* on public\.(invitation_codes|verification_codes)/i,
    );
  });

  it("privileged RPCs are SECURITY DEFINER with a pinned search_path and are revoked from clients", () => {
    const definerFns = [
      "validate_invitation_code",
      "consume_invitation_code",
      "check_rate_limit",
      "reserve_ai_request",
    ];
    for (const fn of definerFns) {
      const declaration = new RegExp(
        `function public\\.${fn}\\([\\s\\S]{0,400}?security definer[\\s\\S]{0,200}?set search_path = public`,
      );
      expect(normalizedSql, `${fn} must be SECURITY DEFINER + pinned search_path`).toMatch(
        declaration,
      );
    }
    expect(normalizedSql).toMatch(
      /revoke all on function public\.validate_invitation_code[\s\S]{0,80}from public, anon, authenticated/,
    );
    expect(normalizedSql).toMatch(
      /revoke all on function public\.consume_invitation_code[\s\S]{0,80}from public, anon, authenticated/,
    );
  });

  it("storage policies scope every object to the owner's folder", () => {
    const storagePolicies = normalizedSql.match(
      /create policy [^;]* on storage\.objects[^;]*/gi,
    );
    expect(storagePolicies && storagePolicies.length).toBeGreaterThanOrEqual(6);
    for (const policy of storagePolicies!) {
      expect(policy, policy.slice(0, 80)).toMatch(
        /\(storage\.foldername\(name\)\)\[1\] = auth\.uid\(\)::text/,
      );
    }
  });

  it("no bucket that holds user documents is public", () => {
    expect(normalizedSql).toMatch(
      /values \('application-attachments', 'application-attachments', false,/,
    );
    expect(normalizedSql).toMatch(/values \('ai-files', 'ai-files', false,/);
  });
});
