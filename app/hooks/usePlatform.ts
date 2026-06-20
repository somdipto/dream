"use client";

import { useEffect, useState } from "react";

// Lightweight platform detection.
//
// Returns `{ isDesktop, isMobile }` derived from the user agent and a
// coarse pointer check. SSR-safe (returns `false` until mounted, then
// re-hydrates with the real value). Used to gate the desktop-only
// keyboard + mouse-look handlers and to skip the voice auto-arm on
// desktop where the user is unlikely to have a mic attached.
//
// Why not just `window.innerWidth < 768`? Tablets and small laptops
// lie. The pointer check (`matchMedia("(pointer: fine)")`) is a much
// better signal for "this user has a real keyboard and mouse".

export interface PlatformInfo {
  /** True on the desktop layout (pointer:fine, no touch). */
  isDesktop: boolean;
  /** True on a phone / tablet. */
  isMobile: boolean;
  /** Has a real keyboard attached. */
  hasKeyboard: boolean;
}

export function usePlatform(): PlatformInfo {
  const [info, setInfo] = useState<PlatformInfo>({
    isDesktop: false,
    isMobile: false,
    hasKeyboard: false,
  });

  useEffect(() => {
    function detect() {
      const fine = window.matchMedia("(pointer: fine)").matches;
      const coarse = window.matchMedia("(pointer: coarse)").matches;
      const hover = window.matchMedia("(hover: hover)").matches;
      const ua = navigator.userAgent;
      const touchUa = /Mobi|Android|iPhone|iPad|iPod/i.test(ua);

      // A "desktop" surface: fine pointer (mouse), hover capable, no
      // touch UA. Phones can fake `pointer: fine` on some browsers
      // when a mouse is attached — `hover: hover` disambiguates.
      const isDesktop = fine && hover && !touchUa;
      const isMobile = coarse || touchUa;
      // Best-effort keyboard detection: every desktop browser reports
      // `keyboard` as part of the `pointer:fine` media. We also fall
      // back to UA heuristic.
      const hasKeyboard = isDesktop;
      setInfo({ isDesktop, isMobile, hasKeyboard });
    }
    detect();
    // Re-detect on resize in case the user plugged in a mouse or
    // rotated a tablet into a desktop dock.
    window.addEventListener("resize", detect);
    return () => window.removeEventListener("resize", detect);
  }, []);

  return info;
}