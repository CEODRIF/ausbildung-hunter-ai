"use client";

import { ErrorState } from "@/components/ui";

export default function NewApplicationError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="min-h-screen bg-[#f6f8fb] px-5 py-12 sm:px-8">
      <div className="mx-auto max-w-xl">
        <ErrorState
          title="The application workspace could not load"
          description="Please try again. Your saved drafts remain protected."
          onRetry={reset}
        />
      </div>
    </main>
  );
}
