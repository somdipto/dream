"use client";

import { LingbotMainVideoView } from "@reactor-models/lingbot";

// Full-bleed background video. `<LingbotMainVideoView>` is a pre-bound
// `<ReactorView track="main_video">` from the typed SDK — no refs, no
// `srcObject`, no autoplay tricks.
export function Video() {
  return (
    <div className="h-full w-full overflow-hidden bg-black">
      <LingbotMainVideoView
        className="h-full w-full"
        videoObjectFit="cover"
      />
    </div>
  );
}
