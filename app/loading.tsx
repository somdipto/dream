export default function Loading() {
  return (
    <main className="grid min-h-screen place-items-center bg-black text-white">
      <div className="flex items-center gap-3 text-sm text-white/60">
        <span className="h-2 w-2 animate-pulse rounded-full bg-amber-400" />
        Loading…
      </div>
    </main>
  );
}
