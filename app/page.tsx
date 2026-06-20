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
  // The route accepts both REACTOR_API_KEYS (M9.7: comma-separated
  // pool with auto-rotation) and the legacy single REACTOR_API_KEY.
  // Either env being present is sufficient to consider the server
  // configured.
  const hasPool = !!process.env.REACTOR_API_KEYS?.trim();
  const hasSingle = !!process.env.REACTOR_API_KEY?.trim();
  const hasKey = hasPool || hasSingle;
  if (!hasKey) {
    return (
      <main className="relative grid min-h-screen place-items-center bg-black p-6 text-white">
        <div className="max-w-sm text-center">
          <h1 className="text-2xl font-semibold tracking-tight">
            Set REACTOR_API_KEYS
          </h1>
          <p className="mt-3 text-sm text-white/60">
            Add <code className="rounded bg-white/10 px-1.5 py-0.5">REACTOR_API_KEYS</code> to
            your environment as a comma-separated list of keys, then redeploy. The first key is
            used; if it returns 402 (out of credits), the server automatically rotates to the
            next one. Get keys at{" "}
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
          <p className="mt-3 text-xs text-white/40">
            Or set the legacy single <code className="rounded bg-white/10 px-1">REACTOR_API_KEY</code>{" "}
            env var.
          </p>
        </div>
      </main>
    );
  }
  return <LingbotApp />;
}