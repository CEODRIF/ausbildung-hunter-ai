"use client";

export function AuthFeedback({
  state,
}: {
  state?: { error?: string; success?: string };
}) {
  if (state?.error)
    return (
      <p
        className="rounded-xl border border-[#f5d7da] bg-[#fff8f8] px-3.5 py-3 text-sm font-medium leading-5 text-[#a3404b]"
        role="alert"
      >
        {state.error}
      </p>
    );
  if (state?.success)
    return (
      <p
        className="rounded-xl border border-[#ccefe1] bg-[#f3fcf8] px-3.5 py-3 text-sm font-medium leading-5 text-[#187e5b]"
        role="status"
      >
        {state.success}
      </p>
    );
  return null;
}
