// GitHub Actions regression — the SHARED scheduler infrastructure
// (.github/workflows/email-scheduler.yml) must stay untouched by the
// AUTO BEWERB sending-window feature:
//  - the original every-5-minutes UTC cron expression remains unchanged;
//  - all three scheduler endpoints are still ticked (none removed);
//  - triggers, concurrency, secrets and the enable-gate are intact;
//  - no duplicate workflow was introduced for the auto-bewerb scheduler.
// The window itself is enforced in the application + Postgres (see the
// migration + src/lib/auto-bewerb/sending-window.ts) — never by the cron.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WORKFLOWS_DIR = fileURLToPath(new URL("../.github/workflows", import.meta.url));
const read = (name: string) => readFileSync(join(WORKFLOWS_DIR, name), "utf8");

describe("GitHub Actions scheduler regression (shared infrastructure)", () => {
  const yml = () => read("email-scheduler.yml");

  it("email-scheduler.yml still exists", () => {
    expect(() => yml()).not.toThrow();
  });

  it("the original */5 UTC cron schedule is unchanged", () => {
    expect(yml()).toMatch(/schedule:\s*\n\s*- cron: "\*\/5 \* \* \* \*"/);
  });

  it("all three scheduler endpoints are still ticked (none removed)", () => {
    const w = yml();
    expect(w).toContain("/api/cron/email-scheduler");
    expect(w).toContain("/api/cron/bew-scheduler");
    expect(w).toContain("/api/cron/auto-bewerb-scheduler");
  });

  it("triggers, concurrency, secrets and the enable-gate are intact", () => {
    const w = yml();
    expect(w).toContain("workflow_dispatch: {}");
    expect(w).toContain("group: email-scheduler-tick");
    expect(w).toContain("cancel-in-progress: false");
    expect(w).toContain("secrets.CRON_SECRET");
    expect(w).toContain("vars.EMAIL_SCHEDULER_GH == 'true'");
  });

  it("no duplicate workflow references the auto-bewerb scheduler", () => {
    for (const f of readdirSync(WORKFLOWS_DIR)) {
      if (f === "email-scheduler.yml") continue;
      const other = read(f);
      expect(other, `unexpected auto-bewerb-scheduler reference in ${f}`).not.toContain("auto-bewerb-scheduler");
    }
  });
});
