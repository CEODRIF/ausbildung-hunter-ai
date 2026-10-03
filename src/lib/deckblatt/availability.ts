/**
 * Deckblatt AI — availability switch.
 *
 * The generator is temporarily withdrawn from the product while a new version is
 * built, so the whole feature is parked behind ONE boolean:
 *
 *   true  → `/deckblatt` renders the Coming Soon page and the generation API
 *           refuses to start a run (503 `coming_soon`). No quota is reserved,
 *           the provider is never called.
 *   false → the original behaviour returns unchanged: the page mounts
 *           <DeckblattGenerator /> and the API runs its normal
 *           auth → rate limit → validate → reserve → provider → settle flow.
 *
 * Deliberately NOT a deletion: the API route, provider integration, quota
 * ledger, migrations, renderer, generator, types and tests are all still in
 * place — only the entry point is switched off. Flipping this constant back to
 * `false` restores the feature with no other change.
 *
 * Scope: this module is imported by the `/deckblatt` page and by
 * `/api/deckblatt/generate` only. It must never be used to gate anything else.
 */
export const DECKBLATT_COMING_SOON = true;
