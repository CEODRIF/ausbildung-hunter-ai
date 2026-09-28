export default function AILoading() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#f6f8fb]">
      <div className="flex items-center gap-3 text-sm text-[#71819a]">
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-[#dbe5f4] border-t-[#2f6fed]" />
        Preparing your AI workspace
      </div>
    </div>
  );
}
