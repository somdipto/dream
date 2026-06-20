"use client";

// Catches any uncaught render error in the LingbotApp tree (network
// failure reaching the token route, malformed JWT, runtime exception
// inside the SDK) and surfaces a retryable overlay instead of a blank
// white screen on mobile.
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="grid min-h-screen place-items-center bg-black p-6 text-white">
      <div className="max-w-sm text-center">
        <h2 className="text-lg font-semibold">Something went wrong</h2>
        <p className="mt-2 text-sm text-white/60">{error.message || "Unknown error"}</p>
        {error.digest && (
          <p className="mt-1 font-mono text-[10px] text-white/30">digest: {error.digest}</p>
        )}
        <button
          onClick={reset}
          className="mt-6 rounded-full bg-white px-5 py-2 text-sm font-medium text-black hover:bg-white/90"
        >
          Try again
        </button>
      </div>
    </main>
  );
}
