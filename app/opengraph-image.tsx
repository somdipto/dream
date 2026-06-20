import { ImageResponse } from "next/og";

// Open Graph / Twitter Card preview image. Renders server-side at
// 1200×630 (the size most chat apps fetch for share previews) so we
// never have to ship a binary asset.
//
// The layout mirrors the in-app landing page: dark background, the
// same aurora gradient LingbotApp.tsx uses, the "dream" wordmark,
// and a one-line tagline. We render real DOM-like elements via Satori
// (next/og's underlying engine) — no <svg> shorthand for filters,
// no CSS that Satori doesn't support.

export const runtime = "nodejs";
export const alt = "Dream — speak a world into being";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Soft, multi-stop aurora roughly matching `app/globals.css` so the
// preview image and the live app share a visual identity.
const AURORA = {
  indigo: "rgba(99,102,241,0.55)",
  pink: "rgba(236,72,153,0.45)",
  cyan: "rgba(34,211,238,0.40)",
  purple: "rgba(168,85,247,0.40)",
};

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "72px",
          backgroundColor: "#0a0612",
          color: "white",
          fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
          // Multi-layer radial gradient — emulated by stacking many
          // divs is too expensive; Satori understands the `backgroundImage`
          // shorthand for `radial-gradient` though the syntax is
          // restricted to what it can render. We layer two big colored
          // circles instead, which Satori does render cleanly.
          position: "relative",
        }}
      >
        {/* Aurora blob 1 — indigo top-left */}
        <div
          style={{
            position: "absolute",
            top: "-200px",
            left: "-200px",
            width: "900px",
            height: "900px",
            borderRadius: "50%",
            background: AURORA.indigo,
            filter: "blur(120px)",
            display: "flex",
          }}
        />
        {/* Aurora blob 2 — pink bottom-right */}
        <div
          style={{
            position: "absolute",
            bottom: "-300px",
            right: "-200px",
            width: "1000px",
            height: "1000px",
            borderRadius: "50%",
            background: AURORA.pink,
            filter: "blur(140px)",
            display: "flex",
          }}
        />
        {/* Aurora blob 3 — cyan top-right */}
        <div
          style={{
            position: "absolute",
            top: "-150px",
            right: "-100px",
            width: "700px",
            height: "700px",
            borderRadius: "50%",
            background: AURORA.cyan,
            filter: "blur(120px)",
            display: "flex",
          }}
        />
        {/* Aurora blob 4 — purple bottom-left */}
        <div
          style={{
            position: "absolute",
            bottom: "-200px",
            left: "-100px",
            width: "800px",
            height: "800px",
            borderRadius: "50%",
            background: AURORA.purple,
            filter: "blur(140px)",
            display: "flex",
          }}
        />

        {/* Wordmark + tagline */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "24px",
            position: "relative",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "14px",
              fontSize: "32px",
              letterSpacing: "0.04em",
              color: "rgba(255,255,255,0.55)",
              textTransform: "uppercase",
            }}
          >
            <span>☀</span>
            <span>Reactor · LingBot</span>
          </div>
          <div
            style={{
              display: "flex",
              fontSize: "120px",
              fontWeight: 700,
              letterSpacing: "-0.03em",
              lineHeight: 1,
            }}
          >
            dream
          </div>
          <div
            style={{
              display: "flex",
              fontSize: "40px",
              fontWeight: 400,
              lineHeight: 1.3,
              color: "rgba(255,255,255,0.85)",
              maxWidth: "950px",
            }}
          >
            Speak a world into being.
          </div>
        </div>

        {/* Bottom bar — capability chips + URL */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            position: "relative",
            fontSize: "22px",
            color: "rgba(255,255,255,0.55)",
          }}
        >
          <div style={{ display: "flex", gap: "16px" }}>
            <Chip>🎙 voice</Chip>
            <Chip>🌀 gyroscope</Chip>
            <Chip>👓 VR</Chip>
          </div>
          <div
            style={{
              display: "flex",
              padding: "10px 18px",
              borderRadius: "999px",
              border: "1px solid rgba(255,255,255,0.2)",
              background: "rgba(255,255,255,0.05)",
            }}
          >
            dream.app
          </div>
        </div>
      </div>
    ),
    { ...size },
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        padding: "10px 18px",
        borderRadius: "999px",
        border: "1px solid rgba(255,255,255,0.2)",
        background: "rgba(255,255,255,0.05)",
      }}
    >
      {children}
    </div>
  );
}
