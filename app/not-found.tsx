import Link from "next/link";

export default function NotFound() {
  return (
    <main className="grid min-h-screen place-items-center bg-black p-6 text-white">
      <div className="max-w-sm text-center">
        <h2 className="text-lg font-semibold">This dream hasn't been painted yet</h2>
        <p className="mt-2 text-sm text-white/60">
          The page you're looking for doesn't exist.
        </p>
        <Link
          href="/"
          className="mt-6 inline-block rounded-full bg-white px-5 py-2 text-sm font-medium text-black hover:bg-white/90"
        >
          Back to start
        </Link>
      </div>
    </main>
  );
}
