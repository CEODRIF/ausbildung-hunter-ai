/**
 * Email Assistant connection-UI tests.
 *
 * Production bug: a user with a VALID Gmail connection still saw the initial
 * "Verbinden Gmail" card, because the top provider section was hard-coded
 * and never read the `email_accounts` state. Fix: the card is derived from
 * the CURRENT status fields (`is_active` + `requires_reconnect`) via
 * providerSection(). The yellow drafts reassignment box was removed from the
 * UI only — drafts, their storage and the server-side reassignment action
 * are untouched (pinned by the source guards below).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  providerSection,
  type ProviderAccountView,
} from "@/lib/email-provider-state";

const root = resolve(__dirname, "..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

const gmailActive: ProviderAccountView = {
  provider: "gmail",
  email: "a@gmail.com",
  is_active: true,
  requires_reconnect: false,
};
const gmailExpired: ProviderAccountView = {
  provider: "gmail",
  email: "a@gmail.com",
  is_active: false,
  requires_reconnect: true,
};
/** Old row with no explicit flag — must still never count as connected. */
const gmailStaleRow: ProviderAccountView = {
  provider: "gmail",
  email: "a@gmail.com",
  is_active: false,
  requires_reconnect: false,
};
const outlookActive: ProviderAccountView = {
  provider: "outlook",
  email: "a@outlook.com",
  is_active: true,
  requires_reconnect: false,
};

describe("provider section state (top Gmail/Outlook cards)", () => {
  it("healthy Gmail connection → 'connected' with the linked email (no connect card)", () => {
    const s = providerSection([gmailActive], "gmail");
    expect(s.kind).toBe("connected");
    if (s.kind === "connected") {
      expect(s.active.map((a) => a.email)).toEqual(["a@gmail.com"]);
    }
  });

  it("no Gmail account at all → the regular initial connect card", () => {
    expect(providerSection([], "gmail")).toEqual({ kind: "connect" });
    // an active account of the OTHER provider must not leak in
    expect(providerSection([outlookActive], "gmail")).toEqual({
      kind: "connect",
    });
  });

  it("expired / re-authorization needed → 'reconnect', never a live-connection claim", () => {
    expect(providerSection([gmailExpired], "gmail").kind).toBe("reconnect");
    // stale row without the explicit flag: still not "connected"
    expect(providerSection([gmailStaleRow], "gmail").kind).toBe("reconnect");
    // active row that the provider layer already flagged for re-auth
    const flagged = { ...gmailActive, requires_reconnect: true };
    expect(providerSection([flagged], "gmail").kind).toBe("reconnect");
  });

  it("multiple accounts: healthy ones → connected list; a single expired one → reconnect", () => {
    const mixed = providerSection(
      [gmailActive, { ...gmailActive, email: "b@gmail.com" }, gmailExpired],
      "gmail",
    );
    expect(mixed.kind).toBe("connected");
    if (mixed.kind === "connected") expect(mixed.active).toHaveLength(2);

    const onlyStale = providerSection([gmailExpired], "gmail");
    expect(onlyStale.kind).toBe("reconnect");
    if (onlyStale.kind === "reconnect")
      expect(onlyStale.account.email).toBe("a@gmail.com");
  });

  it("providers are independent (active Gmail does not hide the Outlook connect card)", () => {
    expect(providerSection([gmailActive], "outlook").kind).toBe("connect");
    expect(providerSection([gmailActive, outlookActive], "outlook").kind).toBe(
      "connected",
    );
  });
});

describe("yellow drafts box: removed from the UI, mechanism intact, no token leakage", () => {
  const BOX_KEYS = [
    "draftsBlockIntro",
    "untitledArbeit",
    "untitledAusbildung",
    "chooseSender",
    "moveDraft",
    "connectOther",
  ] as const;

  it("the page no longer renders the box (intro, draft list, move control, connect-another hint)", () => {
    const src = read("src/app/settings/email/page.tsx");
    for (const key of BOX_KEYS) {
      expect(src, key).not.toContain(key);
    }
    // the box was the only UI caller of the reassignment action
    expect(src).not.toContain("reassignDraftSender");
    expect(src).not.toContain("listDraftsBySender");
  });

  it("the six box translations are gone from the dictionary", () => {
    const dict = read("src/lib/i18n/dictionaries.ts");
    for (const key of BOX_KEYS) {
      expect(dict, key).not.toContain(`${key}:`);
    }
  });

  it("the draft reassignment MECHANISM is preserved (server action + user-scoped query)", () => {
    expect(read("src/app/settings/email/actions.ts")).toContain(
      "export async function reassignDraftSender",
    );
    expect(read("src/lib/application-drafts.ts")).toContain(
      "export async function listDraftsBySender",
    );
  });

  it("the page never touches access/refresh tokens", () => {
    const src = read("src/app/settings/email/page.tsx");
    for (const token of ["access_token", "refresh_token", "token_expires"]) {
      expect(src, token).not.toContain(token);
    }
  });
});
