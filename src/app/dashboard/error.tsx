"use client";

import { ErrorState } from "@/components/ui";

export default function DashboardError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="mx-auto max-w-2xl px-5 py-12 sm:px-8">
      <ErrorState
        title="Your dashboard could not load"
        description="We could not retrieve your account data. Please try again."
        onRetry={reset}
      />
    </div>
  );
}
