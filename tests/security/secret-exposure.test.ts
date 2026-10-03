import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Secret-exposure contracts.
 *
 * The real risk is not "is a secret written down" but "can the browser graph
 * reach it". Next only inlines `NEXT_PUBLIC_*` into client code, so a server
 * secret read from a browser-reachable module leaks its NAME (and would leak
 * its value the moment anyone renamed the variable), and `server-only` is the
 * build-time tripwire that prevents it. These tests pin the invariant:
 *
 *   1. every module that reads a server secret imports "server-only" (or is a
 *      route handler, which is server-only by construction);
 *   2. no client entry point ("use client") reaches such a module through ANY
 *      chain of local imports — enforced by walking the real import graph;
 *   3. the browser-shared Supabase config module references no secret;
 *   4. .env.example never marks a secret as NEXT_PUBLIC_ and ships no real
 *      credential-looking value;
 *   5. no JWT-shaped secret literal is committed in src/.
 */
const root = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/+$/, "");
const srcDir = join(root, "src");

/** Env vars that must never leave the server. */
const SERVER_SECRETS = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "AI_API_KEY",
  "EMAIL_TOKEN_ENCRYPTION_KEY",
  "EMAIL_WORKER_SECRET",
  "TAVILY_API_KEY",
  "POLLINATIONS_API_KEY",
  "GOOGLE_CLIENT_SECRET",
  "MICROSOFT_CLIENT_SECRET",
  "ARBEITSAGENTUR_API_KEY",
  "GEMINI_API_KEY",
  "CRON_SECRET",
] as const;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

const allSourceFiles = walk(srcDir);
const read = (file: string) => readFileSync(file, "utf8");
const isServerOnly = (file: string) => /^import\s+"server-only";/m.test(read(file));
const isClientEntry = (file: string) => /^\s*"use client";/m.test(read(file));
/**
 * A "use server" module is an RPC boundary: the client bundle only keeps a
 * reference to the action, never the module body. Traversal must therefore
 * STOP there — otherwise every server action that touches the database reads
 * as a "client reaches server-only" violation.
 */
const isServerAction = (file: string) => /^\s*"use server";/m.test(read(file));
const rel = (file: string) => file.replace(`${root}/`, "");

/** Resolve an import specifier to a file inside src/, or null (external). */
function resolveLocal(fromFile: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = join(srcDir, specifier.slice(2));
  else if (specifier.startsWith(".")) base = resolve(dirname(fromFile), specifier);
  else return null;
  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Value imports only.
 *
 * `import type { X } from "..."` (and an `import { type A } from "..."` whose
 * every binding is a type) is ERASED by the compiler and creates no runtime
 * edge — counting those produced false positives such as
 * `profile-menu.tsx -> lib/auth.ts`, which the Next build would otherwise have
 * rejected outright.
 */
function localImports(file: string): string[] {
  const source = read(file);
  const out: string[] = [];
  const statement =
    /(?:^|\n)\s*(?:import|export)\s+([\s\S]*?)from\s+"([^"]+)"/g;
  for (const match of source.matchAll(statement)) {
    const clause = match[1].trim();
    if (/^type\s/.test(clause)) continue;
    const braced = clause.match(/\{([\s\S]*)\}/);
    if (braced) {
      const bindings = braced[1]
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
      const allTypes =
        bindings.length > 0 && bindings.every((part) => /^type\s/.test(part));
      if (allTypes) continue;
    }
    const resolved = resolveLocal(file, match[2]);
    if (resolved) out.push(resolved);
  }
  return out;
}

/** Every local module reachable from `entry` (excluding the entry itself).
 *  Server-action modules are leaves: they are not part of the client bundle. */
function reachableFrom(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = localImports(entry);
  while (queue.length) {
    const next = queue.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);
    if (isServerAction(next)) continue;
    queue.push(...localImports(next));
  }
  return seen;
}

describe("server secrets stay behind server-only", () => {
  it("every secret-reading module is server-only or a route handler", () => {
    const pattern = new RegExp(`process\\.env\\.(${SERVER_SECRETS.join("|")})`);
    const violations = allSourceFiles
      .filter((file) => pattern.test(read(file)))
      // Route handlers live under app/api/** and are never bundled for the
      // browser; server actions declare "use server" explicitly.
      .filter((file) => !rel(file).startsWith("src/app/api/"))
      .filter((file) => !isServerOnly(file) && !/^\s*"use server";/m.test(read(file)))
      .map(rel);
    expect(violations).toEqual([]);
  });

  it("no client entry point reads a server secret directly", () => {
    const pattern = new RegExp(`process\\.env\\.(${SERVER_SECRETS.join("|")})`);
    expect(
      allSourceFiles.filter((f) => isClientEntry(f) && pattern.test(read(f))).map(rel),
    ).toEqual([]);
  });

  it("no client entry point can REACH a server-only module (import graph walk)", () => {
    const clientEntries = allSourceFiles.filter(isClientEntry);
    expect(clientEntries.length).toBeGreaterThan(10); // sanity: graph was found
    const violations: string[] = [];
    for (const entry of clientEntries) {
      for (const reached of reachableFrom(entry)) {
        if (isServerOnly(reached) && !isServerAction(reached)) {
          violations.push(`${rel(entry)} -> ${rel(reached)}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("the browser-shared Supabase config never touches a secret", () => {
    const config = read(join(srcDir, "lib/supabase/config.ts"));
    for (const secret of SERVER_SECRETS) {
      expect(config).not.toContain(secret);
    }
    // …and it must not be marked server-only, because the browser client
    // legitimately imports it.
    expect(isServerOnly(join(srcDir, "lib/supabase/config.ts"))).toBe(false);
  });

  it("the service-role key is read only from server-only modules", () => {
    const readers = allSourceFiles
      .filter((file) => read(file).includes("SUPABASE_SERVICE_ROLE_KEY"))
      .map(rel)
      .sort();
    // The admin client, plus the OAuth-state signer (which prefers
    // EMAIL_TOKEN_ENCRYPTION_KEY and only falls back to the service key).
    expect(readers).toEqual([
      "src/lib/oauth-state.ts",
      "src/lib/supabase/admin.ts",
    ]);
    for (const reader of readers) {
      expect(isServerOnly(join(root, reader)), reader).toBe(true);
    }
  });
});

describe(".env.example ships placeholders only", () => {
  const example = readFileSync(join(root, ".env.example"), "utf8");
  const entries = example
    .split("\n")
    .map((line) => line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => [m[1], m[2].trim()] as const);
  const nameFor = (name: string) => entries.find(([key]) => key === name)?.[1];

  it("lists every server secret with a placeholder, never a real value", () => {
    expect(entries.length).toBeGreaterThan(15);
    for (const [name, value] of entries) {
      // No credential-shaped values: JWTs, long random blobs, or real hosts.
      expect(value, `${name} looks like a real credential`).not.toMatch(
        /eyJ[A-Za-z0-9_-]{20,}|[A-Za-z0-9+/]{60,}={0,2}/,
      );
    }
  });

  it("never exposes a server secret through NEXT_PUBLIC_", () => {
    const suspicious = entries
      .map(([name]) => name)
      .filter((name) => name.startsWith("NEXT_PUBLIC_"))
      .filter((name) => /KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL/.test(name));
    // The only NEXT_PUBLIC_ names allowed are the Supabase project URL and the
    // publishable/anon key (RLS-protected, designed for the browser).
    expect(suspicious).toEqual(["NEXT_PUBLIC_SUPABASE_ANON_KEY"]);
  });

  it("documents the two public Supabase variables", () => {
    expect(nameFor("NEXT_PUBLIC_SUPABASE_URL")).toContain("your-project");
    expect(nameFor("NEXT_PUBLIC_SUPABASE_ANON_KEY")).toContain("your-anon-key");
    expect(nameFor("SUPABASE_SERVICE_ROLE_KEY")).toContain("your-service-role-key");
  });
});

describe("no credential literals committed in src", () => {
  it("contains no JWT-shaped string", () => {
    const offenders = allSourceFiles
      .filter((file) => /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/.test(read(file)))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it("contains no hardcoded bearer/service token assignment", () => {
    const offenders = allSourceFiles
      .filter((file) =>
        /(?:api[_-]?key|secret|token)\s*[:=]\s*["'][A-Za-z0-9_\-+/]{24,}["']/i.test(
          read(file),
        ),
      )
      .map(rel);
    expect(offenders).toEqual([]);
  });
});
