import {
  createConversation,
  getConversation,
  listConversations,
} from "@/lib/ai-service";
import { AIChat } from "@/components/ai-chat";

export const dynamic = "force-dynamic";
export default async function AIPage({
  searchParams,
}: {
  searchParams: Promise<{ conversation?: string }>;
}) {
  let conversations = await listConversations();
  const params = await searchParams;
  let selected = conversations.find(
    (conversation) => conversation.id === params.conversation,
  );
  if (!selected) {
    selected = conversations[0] ?? (await createConversation());
    conversations = conversations.length ? conversations : [selected];
  }
  const data = await getConversation(selected.id);
  return (
    <AIChat
      conversations={conversations}
      selectedConversation={data.conversation}
      initialMessages={data.messages}
    />
  );
}
