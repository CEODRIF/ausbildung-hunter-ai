"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { checkRateLimit } from "@/lib/rate-limit";
import { communityProfileSchema } from "@/lib/community";

/**
 * Community server actions — all writes go through the user's own session
 * client, so the RLS "own row only" policies are the second line of
 * defense (the actions never take a user id from the client either).
 */

export type OnboardingErrorCode =
  | "name_required"
  | "name_too_long"
  | "avatar_invalid"
  | "rate_limited"
  | "generic";

export type CompleteOnboardingResult =
  | { ok: true }
  | { ok: false; code: OnboardingErrorCode };

/**
 * First-time community onboarding: save the display name + one of the five
 * predefined avatars and mark the user as a community member (row exists).
 */
export async function completeOnboarding(input: {
  displayName: string;
  avatarId: string;
}): Promise<CompleteOnboardingResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, code: "generic" };

  const parsed = communityProfileSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (issue.path[0] === "avatarId") return { ok: false, code: "avatar_invalid" };
    // displayName issues: too_small → required, too_big → too long.
    return {
      ok: false,
      code: issue.code === "too_big" ? "name_too_long" : "name_required",
    };
  }

  const limited = await checkRateLimit("community_onboarding", user.id);
  if (!limited.allowed) return { ok: false, code: "rate_limited" };

  let error: { message: string } | null = null;
  try {
    const result = await supabase.from("community_profiles").upsert(
      {
        user_id: user.id,
        display_name: parsed.data.displayName,
        avatar_id: parsed.data.avatarId,
      },
      { onConflict: "user_id" },
    );
    error = result.error;
  } catch (thrown) {
    // Never let a transport failure escape as a rejected action: the caller
    // shows a clear inline error instead of the error boundary.
    console.error("[community] onboarding write threw:", thrown);
    return { ok: false, code: "generic" };
  }
  if (error) {
    console.error("[community] onboarding write failed:", error.message);
    return { ok: false, code: "generic" };
  }

  revalidatePath("/community");
  return { ok: true };
}

const uuidValue = z.string().uuid();

/**
 * Advance this user's read cursor (badge / unread counter). Only called
 * from the Community page itself, so "shell mounted" never marks messages
 * read — entering /community does.
 */
export async function markCommunityRead(lastMessageId: string): Promise<void> {
  if (!uuidValue.safeParse(lastMessageId).success) return;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;
  try {
    const { error } = await supabase.from("community_read_state").upsert(
      { user_id: user.id, last_read_message_id: lastMessageId },
      { onConflict: "user_id" },
    );
    if (error) console.error("[community] read cursor failed:", error.message);
  } catch (thrown) {
    // The badge is chrome: a failed cursor write must never surface anywhere.
    console.error("[community] read cursor threw:", thrown);
  }
}
