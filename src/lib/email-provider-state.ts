/**
 * Pure decision logic for the Email Assistant provider cards
 * (Gmail / Outlook section at the top of /settings/email).
 *
 * Background: the cards used to always render the initial "Connect" card
 * even when the user already had a valid connection, because the top
 * section never looked at the `email_accounts` state. This module derives
 * the card state from the CURRENT database status fields only:
 *
 *   - `is_active` + `requires_reconnect=false`  → healthy connection
 *   - `is_active=false` or `requires_reconnect`  → re-authorization needed
 *
 * An old/stale record is never treated as connected: a record is only
 * "connected" while BOTH status fields say so.
 */

export type EmailProviderId = "gmail" | "outlook";

/** The fields the UI decisions need (token-free by construction). */
export type ProviderAccountView = {
  provider: EmailProviderId;
  email: string;
  is_active: boolean;
  requires_reconnect: boolean;
};

export type ProviderSection =
  /** At least one healthy account: green "Connected" state, no connect button. */
  | { kind: "connected"; active: ProviderAccountView[] }
  /** No healthy account, but an expired/revoked one exists: separate Reconnect action. */
  | { kind: "reconnect"; account: ProviderAccountView }
  /** No account at all (or unknown state): the regular initial connect card. */
  | { kind: "connect" };

export function providerSection(
  accounts: ReadonlyArray<ProviderAccountView>,
  provider: EmailProviderId,
): ProviderSection {
  const own = accounts.filter((a) => a.provider === provider);
  const active = own.filter((a) => a.is_active && !a.requires_reconnect);
  if (active.length > 0) {
    return { kind: "connected", active };
  }
  const stale = own.find((a) => a.requires_reconnect || !a.is_active);
  if (stale) {
    return { kind: "reconnect", account: stale };
  }
  return { kind: "connect" };
}
