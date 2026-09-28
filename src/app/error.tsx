"use client";

import { ErrorState } from "@/components/ui";

export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f6f8fb] p-5">
      <div className="w-full max-w-md">
        <ErrorState
          title="This page could not load"
          description="An unexpected error interrupted the page. Try loading it again."
          onRetry={reset}
        />
      </div>
    </main>
  );
}
