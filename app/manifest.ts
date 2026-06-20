import type { MetadataRoute } from "next";

// PWA manifest. Makes the app installable to the phone home screen
// and tells the browser to render it fullscreen without the address bar.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "See your dreams in real",
    short_name: "Dream",
    description: "Speak a scene. Walk through it by tilting your phone.",
    start_url: "/",
    display: "fullscreen",
    orientation: "portrait",
    background_color: "#000000",
    theme_color: "#000000",
    icons: [
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
      },
    ],
  };
}
