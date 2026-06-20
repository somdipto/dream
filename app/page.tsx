import { LingbotApp } from "./LingbotApp";

// The page is a Server Component. Its only job is to check whether
// the app is configured (REACTOR_API_KEY is present) and render the
// right tree:
//   - missing key  → friendly inline setup-required landing
//   - present      → <LingbotApp />, which fetches the JWT itself
//
// We don't mint the token here. Token minting lives behind
// /api/reactor/token so the same client-side flow works whether the
// frontend is Next.js, Vite, CRA, or anything else — the route is
// the framework-agnostic contract.
//
// `dynamic = "force-dynamic"` skips static prerendering so the env
// check runs per-request.
export const dynamic = "force-dynamic";

export default function Page() {
  const hasKey = !!process.env.REACTOR_API_KEY;
  if (!hasKey) {
    return (
      <main className="relative grid min-h-screen place-items-center bg-black p-6 text-white">
        <div className="max-w-sm text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Set REACTOR_API_KEY</h1>
          <p className="mt-2 text-sm text-white/60">
            Add <code className="rounded bg-white/10 px-1.5 py-0.5">REACTOR_API_KEY</code> to your
            environment, then redeploy. Get a key at{" "}
            <a
              className="underline"
              href="https://reactor.inc/account/api-keys"
              target="_blank"
              rel="noopener noreferrer"
            >
              reactor.inc/account/api-keys
            </a>
            .
          </p>
        </div>
      </main>
    );
  }
  return <LingbotApp />;
}