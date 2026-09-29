"use client";

export function AuthFeedback({
  state,
}: {
  state?: { error?: string; success?: string };
}) {
  if (state?.error)
    return (
      <p
        className="rounded-xl border border-danger/25 bg-danger-soft px-3.5 py-3 text-sm font-medium leading-5 text-danger"
        role="alert"
      >
        {state.error}
      </p>
    );
  if (state?.success)
    return (
      <p
        className="rounded-xl border border-success/25 bg-success-soft px-3.5 py-3 text-sm font-medium leading-5 text-success"
        role="status"
      >
        {state.success}
      </p>
    );
  return null;
}
