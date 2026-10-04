/**
 * Community — availability switch.
 *
 * The community chat is temporarily withdrawn from the product, so the whole
 * feature is parked behind ONE boolean:
 *
 *   true  → `/community` renders the Coming Soon page instead of the chat.
 *           No profile lookup, no message fetch, no realtime subscription —
 *           opening the route must not start (or even prepare) any data access.
 *   false → the original behaviour returns unchanged: onboarding, the real-
 *           time chat, the unread badge and /api/community/* all work again.
 *
 * Deliberately NOT a deletion: the chat components, realtime channel, Supabase
 * server helpers, migrations, RLS policies and the API route are all still in
 * place — only the entry point is switched off. Flipping this constant back to
 * `false` restores the feature with no other change.
 *
 * Scope: this module is imported by the `/community` page only. It must never
 * be used to gate anything else.
 */
export const COMMUNITY_COMING_SOON = true;
