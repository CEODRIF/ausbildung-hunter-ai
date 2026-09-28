"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export async function saveGoal(
  _previousState: { error?: string },
  formData: FormData,
) {
  const goal = String(formData.get("goal") ?? "");
  if (goal !== "ausbildung" && goal !== "arbeit")
    return { error: "Choose Ausbildung or Arbeit to continue." };
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Your session expired. Please sign in again." };
  const { error } = await supabase
    .from("profiles")
    .update({ selected_goal: goal })
    .eq("id", user.id);
  if (error)
    return { error: "We could not save your choice. Please try again." };
  redirect("/dashboard");
}
