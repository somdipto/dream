import type { Metadata, Viewport } from "next";
import "@reactor-team/ui/styles.css";
import "./globals.css";

// Where the deployed site lives. Used as `metadataBase` so that
// relative image paths in the Open Graph block resolve to absolute
// URLs — most chat / social apps require absolute image URLs to
// render a preview.
const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ?? "https://dream.example.com";

export const metadata: Metadata = {
  // ponytail: the previous version had a hardcoded `<link
  // rel="apple-touch-icon">` in <head> that pointed at a different
  // file (icon-192.png) than the metadata's `icons.apple`. iOS used
  // the manual one and ignored the metadata. We now let the metadata
  // be the single source of truth.
  metadataBase: new URL(SITE_URL),
  title: "See your dreams in real",
  description:
    "Speak a scene. Walk through it by tilting your phone. Powered by Reactor + LingBot.",
  applicationName: "Dream",
  icons: {
    icon: [{ url: "/favicon-ico.png", type: "image/png" }],
    apple: "/apple-touch-icon.png",
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Dream",
  },
  formatDetection: { telephone: false },
  // Generated at request time by `app/opengraph-image.tsx`. Sharing
  // the URL on iMessage / Twitter / Discord now shows a real preview
  // card instead of a broken-image placeholder.
  openGraph: {
    title: "See your dreams in real",
    description:
      "Speak a scene. Walk through it by tilting your phone. A world-model demo on Reactor + LingBot.",
    url: SITE_URL,
    siteName: "Dream",
    type: "website",
    images: [
      {
        url: "/opengraph-image",
        width: 1200,
        height: 630,
        alt: "Dream — speak a world into being",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "See your dreams in real",
    description:
      "Speak a scene. Walk through it by tilting your phone. A world-model demo on Reactor + LingBot.",
    images: [{ url: "/opengraph-image", width: 1200, height: 630, alt: "Dream" }],
  },
};

// QA4: viewport-fit=cover is required for env(safe-area-inset-*) to
// resolve on iPhone notch / Dynamic Island. themeColor is what paints
// the browser chrome to match the app background. Updated to
// #0a0a14 so the URL bar matches the warmer page background
// (audit found a visible seam on iPhone notch load where chrome
// was #000 and page was #0a0a14). maximumScale removed because
// it breaks pinch-to-zoom — a WCAG 2.1 SC 1.4.4 regression.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0a0a14",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      {/* M9.14: bg-black → bg-[#0a0a14] for the warmer theme
          (matching the Begin + connecting overlays). The
          0x14 channel keeps the page dark but not a void —
          a friendlier surface during the brief moment between
          layout paint and the overlay's own background taking
          over. */}
      <body className="min-h-screen bg-[#0a0a14] text-zinc-100 antialiased">
        {children}
      </body>
    </html>
  );
}
