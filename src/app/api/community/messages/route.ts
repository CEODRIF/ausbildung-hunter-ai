import { NextResponse } from "next/server";
import { getCurrentUserAndProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  checkRateLimit,
  rateLimitHeaders,
  tooManyRequests,
} from "@/lib/rate-limit";
import {
  buildCommunityImagePath,
  COMMUNITY_MAX_MESSAGE_LENGTH,
  COMMUNITY_PAGE_SIZE,
  type CommunityMessageView,
  validateCommunityImage,
} from "@/lib/community";

/**
 * Community chat message API.
 *
 * GET  — newest N messages (optionally older than `before_at`), enriched with
 *        the author's community profile. Feeds the initial render and the
 *        "load older" scroll-up pagination.
 * POST — create a message (multipart/form-data: `message` text and/or
 *        `image` file). The sender's identity ALWAYS comes from the
 *        authenticated session; the RLS policy makes impersonation fail at
 *        the database level as well.
 *
 * Images: only image/jpeg|png|webp, ≤ 2 MB, re-validated server-side from
 * the actual bytes (MIME allowlist + magic bytes). Storage paths are
 * generated server-side as {user_id}/{message_id}/image.{ext}.
 */

async function loadAuthors(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userIds: string[],
): Promise<Record<string, { display_name: string; avatar_id: string }>> {
  if (userIds.length === 0) return {};
  const { data: profiles } = await supabase
    .from("community_profiles")
    .select("user_id,display_name,avatar_id")
    .in("user_id", userIds);
  const byUser: Record<string, { display_name: string; avatar_id: string }> = {};
  for (const p of profiles ?? []) {
    byUser[p.user_id] = {
      display_name: p.display_name,
      avatar_id: p.avatar_id,
    };
  }
  return byUser;
}

export async function GET(request: Request) {
  const { user } = await getCurrentUserAndProfile();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limited = await checkRateLimit("community_history", user.id);
  if (!limited.allowed) return tooManyRequests(limited);

  const url = new URL(request.url);
  const beforeAt = url.searchParams.get("before_at");
  if (beforeAt && Number.isNaN(Date.parse(beforeAt))) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const supabase = await createClient();
  let query = supabase
    .from("community_messages")
    .select("id,user_id,message,image_path,created_at,updated_at")
    .order("created_at", { ascending: false })
    .limit(COMMUNITY_PAGE_SIZE);
  if (beforeAt) query = query.lt("created_at", beforeAt);
  const { data: messages, error } = await query;
  if (error)
    return NextResponse.json({ error: "Could not load messages." }, { status: 500 });

  const items = (messages ?? []) as CommunityMessageView[];
  const byUser = await loadAuthors(
    supabase,
    [...new Set(items.map((m) => m.user_id))],
  );
  const views = items
    .map((m) => ({ ...m, author: byUser[m.user_id] ?? null }))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));

  return NextResponse.json({ items: views }, { headers: rateLimitHeaders(limited) });
}

export async function POST(request: Request) {
  const { user } = await getCurrentUserAndProfile();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limited = await checkRateLimit("community_message", user.id);
  if (!limited.allowed) return tooManyRequests(limited);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const rawText = form.get("message");
  const text = typeof rawText === "string" ? rawText.trim() : "";
  if (text.length > COMMUNITY_MAX_MESSAGE_LENGTH) {
    return NextResponse.json({ error: "text_too_long" }, { status: 400 });
  }

  const file = form.get("image");
  // A message needs at least one of: text or image. Empty messages and
  // empty image messages are both forbidden.
  if (!text && !(file instanceof File)) {
    return NextResponse.json({ error: "empty_message" }, { status: 400 });
  }

  const supabase = await createClient();

  // Senders must have completed the community onboarding (profile exists).
  const { data: profile } = await supabase
    .from("community_profiles")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!profile) {
    return NextResponse.json({ error: "profile_required" }, { status: 409 });
  }

  // Idempotency: the client MAY supply its own UUID so that a retry after a
  // lost response reuses the SAME row instead of creating a duplicate. The
  // id is validated as a UUID and only ever becomes THIS session user's own
  // row (the RLS insert policy enforces user_id = auth.uid()).
  const rawId = form.get("id");
  const clientMessageId =
    typeof rawId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      rawId,
    )
      ? rawId
      : null;

  if (clientMessageId) {
    const { data: existing } = await supabase
      .from("community_messages")
      .select("id,user_id,message,image_path,created_at,updated_at")
      .eq("id", clientMessageId)
      .maybeSingle();
    if (existing) {
      // Someone else's row: never claimable — reject without echoing it.
      if (existing.user_id !== user.id) {
        return NextResponse.json({ error: "Invalid request." }, { status: 400 });
      }
      // This exact message was already persisted (first attempt succeeded,
      // response lost). Return it — the client flips its optimistic row to
      // "sent" and nothing is duplicated.
      return NextResponse.json(
        { message: existing, duplicate: true },
        { status: 200, headers: rateLimitHeaders(limited) },
      );
    }
  }

  const messageId = clientMessageId ?? crypto.randomUUID();
  let imagePath: string | null = null;

  if (file instanceof File) {
    // Never trust the client-declared type/size/filename: re-validate the
    // actual bytes (size, MIME allowlist, magic bytes).
    const bytes = new Uint8Array(await file.arrayBuffer());
    const verdict = validateCommunityImage(file.type, bytes);
    if (!verdict.ok) {
      return NextResponse.json(
        { error: verdict.code },
        { status: verdict.code === "image_too_large" ? 413 : 415 },
      );
    }
    const path = buildCommunityImagePath(user.id, messageId, verdict.ext);
    if (!path)
      return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    const { error: uploadError } = await supabase.storage
      .from("community-images")
      .upload(path, new Blob([bytes], { type: file.type }), {
        contentType: file.type,
        upsert: false,
        cacheControl: "31536000",
      });
    if (uploadError) {
      // Storage re-enforces the 2 MB bucket limit and the MIME allowlist.
      const tooBig = /limit/i.test(uploadError.message ?? "");
      return NextResponse.json(
        { error: tooBig ? "image_too_large" : "invalid_image" },
        { status: tooBig ? 413 : 415 },
      );
    }
    imagePath = path;
  }

  const { data: row, error } = await supabase
    .from("community_messages")
    .insert({
      id: messageId,
      // Always the session user — a user_id sent in the form body is ignored.
      user_id: user.id,
      message: text || null,
      image_path: imagePath,
    })
    .select("id,user_id,message,image_path,created_at,updated_at")
    .single();
  if (error) {
    // 23505 = primary-key violation: a concurrent retry (two tabs, or the
    // pre-check raced another request) already created this exact row.
    // Idempotent success — return it instead of failing the retry.
    if ((error as { code?: string }).code === "23505") {
      const { data: existing } = await supabase
        .from("community_messages")
        .select("id,user_id,message,image_path,created_at,updated_at")
        .eq("id", messageId)
        .maybeSingle();
      if (existing) {
        return NextResponse.json(
          { message: existing, duplicate: true },
          { status: 200, headers: rateLimitHeaders(limited) },
        );
      }
    }
    return NextResponse.json({ error: "Could not send message." }, { status: 500 });
  }

  return NextResponse.json(
    { message: row },
    { status: 201, headers: rateLimitHeaders(limited) },
  );
}
