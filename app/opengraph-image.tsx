import { ImageResponse } from "next/og";

// Open Graph / Twitter Card preview image. Renders server-side at
// 1200×630 (the size most chat apps fetch for share previews) so we
// never have to ship a binary asset.
//
// Pure black theme: matches the in-app landing page. Black
// background, the "dream" wordmark, and a one-line tagline. We
// render real DOM-like elements via Satori (next/og's underlying
// engine) — no <svg> shorthand for filters, no CSS that Satori
// doesn't support.

export const runtime = "nodejs";
export const alt = "Dream — speak a world into being";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

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
          backgroundColor: "#000000",
          color: "white",
          fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
          position: "relative",
        }}
      >
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
