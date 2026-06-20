import type { Metadata, Viewport } from "next";
import "@reactor-team/ui/styles.css";
import "./globals.css";

export const metadata: Metadata = {
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
      <head>
        <link rel="apple-touch-icon" href="/icon-192.png" />
      </head>
      <body className="min-h-screen bg-zinc-950 text-zinc-100 antialiased">
        {children}
      </body>
    </html>
  );
}
