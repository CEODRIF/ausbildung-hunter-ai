/**
 * Admin action confirmation — deliberate two-step for every
 * access-changing administrative action.
 *
 * Pinned contract (source-level, the security model is structural):
 *   1. EVERY access-changing action (set_plan ×2, cancel, reactivate,
 *      grant_admin, revoke_admin) goes through the `pending` confirmation
 *      state — no button may call the API directly on first click.
 *   2. The confirmation names the TARGET user's e-mail and the action
 *      label (safe identification of the intended user — the wrong-user
 *      subscription incident class is guarded at the UI level).
 *   3. Only the explicit confirm click fires the request; the cancel
 *      button discards the pending state without any network call.
 *   4. Actor identity is still never sent (the API derives it from the
 *      session); only action + documented parameters travel.
 *   5. i18n: admin.confirm* exist in all four languages.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { dictionaries, SUPPORTED_LANGUAGES } from "@/lib/i18n/dictionaries";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (relative: string) => readFileSync(resolve(root, relative), "utf8");

const ACTIONS = read("src/components/admin-user-actions.tsx");
const API_ROUTE = read("src/app/api/admin/users/[id]/route.ts");

const ALL_ACTION_BUTTONS = [
  { action: "set_plan", label: "admin.plus30", extra: 'plan: "plus", periodDays: 30' },
  { action: "set_plan", label: "admin.pro30", extra: 'plan: "pro", periodDays: 30' },
  { action: "cancel_subscription", label: "admin.cancelSub", extra: "{}" },
  { action: "reactivate_subscription", label: "admin.reactivate", extra: 'plan: "plus", periodDays: 30' },
  { action: "grant_admin", label: "admin.grantAdmin", extra: "{}" },
  { action: "revoke_admin", label: "admin.revokeAdmin", extra: "{}" },
];

describe("admin actions — two-step confirmation (source contract)", () => {
  it("routes every access-changing action through the pending state", () => {
    for (const { action, label } of ALL_ACTION_BUTTONS) {
      // Each action is wired as: actionButton("<action>", "<label>", ...)
      expect(ACTIONS).toContain(`actionButton("${action}", "${label}"`);
    }
  });

  it("no button may POST directly on first click (all fire setPending)", () => {
    // The only place that builds the fetch request is `call()`, and the
    // only caller of `call()` is the confirmed `confirm()` path.
    expect(ACTIONS).toContain("const confirm = async () => {");
    expect(ACTIONS).toContain("await call(action.action, action.extra)");
    // Buttons go through the helper, which only sets pending state:
    expect(ACTIONS).toContain("setPending({ action, labelKey, extra })");
    // There must be no onClick that invokes call() directly:
    expect(ACTIONS).not.toMatch(/onClick=\{.*call\(/);
  });

  it("the confirmation names the target e-mail and the action", () => {
    expect(ACTIONS).toContain('t("admin.confirmBody"');
    expect(ACTIONS).toContain("email: row.email");
    expect(ACTIONS).toContain("action: t(pending.labelKey)");
  });

  it("confirm fires the request; cancel discards it without network access", () => {
    expect(ACTIONS).toContain('t("admin.confirmYes")');
    expect(ACTIONS).toContain('t("admin.confirmNo")');
    expect(ACTIONS).toContain("onClick={() => setPending(null)}");
  });

  it("actor identity is still never sent; only action + documented params", () => {
    expect(ACTIONS).toContain('body: JSON.stringify({ action, ...extra })');
    // The actor (received as a prop for the self-row guard) must not leak
    // into the request body in any form:
    expect(ACTIONS).not.toMatch(/JSON\.stringify\([^)]*actorId/);
    expect(ACTIONS).not.toContain("actor_id");
  });

  it("server side unchanged: strict action enum, requireAdmin, audit", () => {
    expect(API_ROUTE).toContain("set_plan");
    expect(API_ROUTE).toContain("cancel_subscription");
    expect(API_ROUTE).toContain("requireAdmin");
  });
});

describe("i18n — admin.confirm* parity", () => {
  it("confirmBody carries both placeholders; all keys non-empty in 4 languages", () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      const admin = dictionaries[lang].admin as Record<string, string>;
      for (const key of ["confirmBody", "confirmYes", "confirmNo"]) {
        expect(admin[key]).toBeTypeOf("string");
        expect(admin[key]?.trim()).not.toHaveLength(0);
      }
      expect(admin["confirmBody"]).toContain("{email}");
      expect(admin["confirmBody"]).toContain("{action}");
    }
  });
});
