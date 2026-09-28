export default function NewApplicationLoading() {
  return (
    <main className="min-h-screen bg-[#f6f8fb] px-5 py-8 sm:px-8 lg:px-10">
      <div className="mx-auto max-w-7xl">
        <div className="shimmer h-4 w-36 rounded-full" />
        <div className="mt-7 grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
          <div className="shimmer h-[620px] rounded-2xl border border-[#e7ecf3] bg-white" />
          <div className="shimmer h-96 rounded-2xl border border-[#e7ecf3] bg-white" />
        </div>
      </div>
    </main>
  );
}
