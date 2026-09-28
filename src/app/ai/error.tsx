"use client";
import { ErrorState } from "@/components/ui";
export default function AIError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f6f8fb] p-5">
      <div className="w-full max-w-md">
        <ErrorState
          title="The AI workspace could not load"
          description="Please try again. Your conversations remain protected."
          onRetry={reset}
        />
      </div>
    </main>
  );
}
