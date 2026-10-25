import {
  createConversation,
  getConversation,
  listConversations,
} from "@/lib/ai-service";
import { AIChat } from "@/components/ai-chat";
import { getCurrentUserAndProfile } from "@/lib/auth";
import {
  checkFeature,
  effectiveUploadLimitMbForUser,
} from "@/lib/billing/entitlement-service";

export const dynamic = "force-dynamic";
export default async function AIPage({
  searchParams,
}: {
  searchParams: Promise<{ conversation?: string }>;
}) {
  const { user } = await getCurrentUserAndProfile();
  let conversations = await listConversations();
  const params = await searchParams;
  let selected = conversations.find(
    (conversation) => conversation.id === params.conversation,
  );
  if (!selected) {
    selected = conversations[0] ?? (await createConversation());
    conversations = conversations.length ? conversations : [selected];
  }
  const [data, fileLimitMb, aiEntitlement] = await Promise.all([
    getConversation(selected.id),
    // TRUE per-file upload cap for this plan (server-derived: min(plan cap,
    // 10 MB platform ceiling)) — the composer hint must not promise 10 MB
    // to a trial user whose plan cap is 2 MB (P0 quota audit).
    user ? effectiveUploadLimitMbForUser(user.id) : Promise.resolve(10),
    // Canonical AI entitlement for the header indicator (server-derived; a
    // failed read arrives as a lookup_error entitlement → the indicator's
    // honest unknown state, never a fabricated number).
    user ? checkFeature(user.id, "ai_assistant") : Promise.resolve(null),
  ]);
  return (
    <AIChat
      conversations={conversations}
      selectedConversation={data.conversation}
      initialMessages={data.messages}
      fileLimitMb={fileLimitMb}
      aiEntitlement={aiEntitlement}
    />
  );
}
