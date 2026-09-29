export default function NewApplicationLoading() {
  return (
    <div className="px-4 py-6 sm:px-6 lg:px-10">
      <div className="mx-auto max-w-7xl">
        <div className="shimmer h-4 w-36 rounded-full" />
        <div className="mt-7 grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
          <div className="shimmer h-[620px] rounded-2xl border border-line bg-surface" />
          <div className="shimmer h-96 rounded-2xl border border-line bg-surface" />
        </div>
      </div>
    </div>
  );
}
