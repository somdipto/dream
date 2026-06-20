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

// ponytail: viewport-fit=cover is required for env(safe-area-inset-*) to
// resolve on iPhone notch / Dynamic Island. themeColor is what paints
// the browser chrome to match the app background.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: "#000000",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-black text-zinc-100 antialiased">
        {children}
      </body>
    </html>
  );
}
