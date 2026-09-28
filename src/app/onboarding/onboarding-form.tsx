"use client";

import { useActionState, useState } from "react";
import { AuthFeedback } from "@/components/auth-feedback";
import { saveGoal } from "@/app/onboarding/actions";

const initialState = { error: "" };

export function OnboardingForm() {
  const [state, formAction, pending] = useActionState(saveGoal, initialState);
  const [selected, setSelected] = useState("");
  return (
    <form action={formAction} className="space-y-4">
      <label className="group block cursor-pointer">
        <input
          className="peer sr-only"
          type="radio"
          name="goal"
          value="ausbildung"
          checked={selected === "ausbildung"}
          onChange={(event) => setSelected(event.target.value)}
          required
        />
        <span className="flex items-center justify-between rounded-2xl border border-[#e2e8f1] bg-white p-5 transition hover:border-[#b9c9e2] peer-checked:border-[#2f6fed] peer-checked:bg-[#f3f7ff] peer-focus-visible:ring-4 peer-focus-visible:ring-[#2f6fed]/10">
          <span>
            <span className="block text-lg font-bold text-[#1d3458]">
              Ausbildung
            </span>
            <span className="mt-1 block text-sm text-[#7b8aa0]">
              Find a practical path to start your career.
            </span>
          </span>
          <span className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-[#d5deeb] text-white peer-checked:border-[#2f6fed] peer-checked:bg-[#2f6fed]">
            ✓
          </span>
        </span>
      </label>
      <label className="group block cursor-pointer">
        <input
          className="peer sr-only"
          type="radio"
          name="goal"
          value="arbeit"
          checked={selected === "arbeit"}
          onChange={(event) => setSelected(event.target.value)}
        />
        <span className="flex items-center justify-between rounded-2xl border border-[#e2e8f1] bg-white p-5 transition hover:border-[#b9c9e2] peer-checked:border-[#2f6fed] peer-checked:bg-[#f3f7ff] peer-focus-visible:ring-4 peer-focus-visible:ring-[#2f6fed]/10">
          <span>
            <span className="block text-lg font-bold text-[#1d3458]">
              Arbeit
            </span>
            <span className="mt-1 block text-sm text-[#7b8aa0]">
              Explore jobs that match your next chapter.
            </span>
          </span>
          <span className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-[#d5deeb] text-white peer-checked:border-[#2f6fed] peer-checked:bg-[#2f6fed]">
            ✓
          </span>
        </span>
      </label>
      <AuthFeedback state={state} />
      <button
        className="mt-3 flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#2f6fed] px-5 text-sm font-semibold text-white shadow-[0_8px_18px_rgba(47,111,237,0.22)] transition hover:bg-[#255dcc] disabled:cursor-not-allowed disabled:opacity-50"
        type="submit"
        disabled={pending || !selected}
      >
        {pending ? (
          "Saving your choice…"
        ) : (
          <>
            Continue <span>→</span>
          </>
        )}
      </button>
    </form>
  );
}
