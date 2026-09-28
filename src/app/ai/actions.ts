"use server";

import { revalidatePath } from "next/cache";
import {
  createConversation,
  deleteConversation,
  renameConversation,
} from "@/lib/ai-service";

export async function newConversation() {
  await createConversation();
  revalidatePath("/ai");
}
export async function renameAIConversation(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  const title = String(formData.get("title") ?? "");
  await renameConversation(id, title);
  revalidatePath("/ai");
}
export async function deleteAIConversation(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  await deleteConversation(id);
  revalidatePath("/ai");
}
