import { LoadingState } from "@/components/ui";

export default function Loading() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <LoadingState label="Loading workspace" />
    </div>
  );
}
