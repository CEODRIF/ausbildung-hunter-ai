-- ============================================================================
-- Community Phase 6B — room-scoped storage READ policies for community images.
--
-- ADDITIVE OBLIGATIONS (the complete change surface of this migration):
--   * DROPS exactly one obsolete policy: "Community members can read community
--     images" (v1, re-tightened for non-dm paths in v3). It granted SELECT on
--     EVERY non-DM object in `community-images` to EVERY authenticated user —
--     knowing the object path was enough. Hidden (moderated) message images,
--     images in disabled rooms, and questions from blocked authors all stayed
--     readable through signed URLs.
--   * REPLACES it with two row-pinned SELECT policies:
--       - "Room-scoped members can read message images"
--           {user_id}/{message_id}/image.{ext}
--       - "Room-scoped members can read question images"
--           {user_id}/{question_id}/image.{ext}
--     An object is readable ONLY when the referenced live DB row points at
--     exactly this object (image_path = name) AND the row itself is readable
--     by the requesting user under the existing table RLS — i.e. the SAME
--     authorization relationships the app already enforces:
--       * messages: `hidden_by is null` (moderation hiding) + the message's
--         room is enabled (rooms are open to all authenticated members;
--         there is no per-room membership table in this schema —
--         `community_rooms.enabled` IS the room-access gate, mirrored from
--         the "Community members can read enabled rooms" policy and the
--         server API's `fetchRoomBySlug` enabled-filter),
--       * questions: the question's room is enabled + no block in EITHER
--         direction between viewer and author (mirrored verbatim from the
--         "Members can read questions" policy).
--   * DM images are NOT touched: "Members can read dm images of their
--     conversations" (v3) already scopes DM reads to conversation
--     participants (`auth.uid() in (member_a, member_b)`).
--   * The bucket stays PRIVATE (`public = false` — v1, untouched here),
--     the 2 MB file size limit and MIME allowlist stay, and ALL insert /
--     delete policies are byte-for-byte unchanged.
--   * Service-role (admin client) reads are unaffected — GDPR deletion,
--     export, moderation, and the Phase 6A janitor all run with the
--     service key, which bypasses RLS.
--
-- FAIL-CLOSED: any object without a matching live, readable row (deleted
-- rows, malformed segments, unknown shapes) matches no policy → denied.
-- No casts that can raise: row ids are compared in text form
-- (`id::text = lower(segment)`), so garbage paths filter out instead of
-- erroring the whole read.
--
-- NO Phase 6C (voice TTL) / 6D (infrastructure) / 6F (question moderation)
-- content. No tables, columns, functions, or grants are created.
--
-- Rollback:
--   drop policy if exists "Room-scoped members can read message images" on storage.objects;
--   drop policy if exists "Room-scoped members can read question images" on storage.objects;
--   create policy "Community members can read community images"
--   on storage.objects for select to authenticated
--   using (bucket_id = 'community-images' and (storage.foldername(name))[1] <> 'dm');
-- ============================================================================

drop policy if exists "Community members can read community images" on storage.objects;

-- Room message images: readable iff a LIVE, non-hidden message in an
-- ENABLED room references exactly this object, and the object sits under
-- that message's author folder (the v1/v2/v3 path contract).
create policy "Room-scoped members can read message images"
on storage.objects for select to authenticated
using (
  bucket_id = 'community-images'
  and (storage.foldername(name))[1] <> 'dm'
  and exists (
    select 1
    from public.community_messages m
    where m.image_path = name
      and m.id::text = lower((storage.foldername(name))[2])
      and m.user_id::text = lower((storage.foldername(name))[1])
      and m.hidden_by is null
      and exists (
        select 1 from public.community_rooms r
        where r.id = m.room_id and r.enabled
      )
  )
);

-- Room question images: readable iff a LIVE question in an ENABLED room
-- references exactly this object, the object sits under the author's
-- folder, and no block exists in EITHER direction between viewer and
-- author — the same conditions as "Members can read questions".
create policy "Room-scoped members can read question images"
on storage.objects for select to authenticated
using (
  bucket_id = 'community-images'
  and (storage.foldername(name))[1] <> 'dm'
  and exists (
    select 1
    from public.community_questions q
    where q.image_path = name
      and q.id::text = lower((storage.foldername(name))[2])
      and q.author_id::text = lower((storage.foldername(name))[1])
      and exists (
        select 1 from public.community_rooms r
        where r.id = q.room_id and r.enabled
      )
      and not exists (
        select 1 from public.community_blocks b
        where (b.blocker_id = auth.uid() and b.blocked_id = q.author_id)
           or (b.blocker_id = q.author_id and b.blocked_id = auth.uid())
      )
  )
);
