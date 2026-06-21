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
// iPadOS 13+ detection:
//   On iPadOS, Safari reports a `Macintosh` user-agent (Apple's "all
//   Macs are iPads" privacy initiative). The reliable signal is
//   `navigator.maxTouchPoints > 0` combined with `Macintosh` UA — that
//   is an iPad. Without this, iPads were mis-detected as desktop and
//   the gyro/mic UI was hidden.

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
    // QA16/R3: `hasKeyboard` was previously aliased to
    // `isDesktop`, which conflated two independent signals
    // (an iMac with no keyboard, an iPad with a Smart
    // Keyboard). We now treat hasKeyboard as a "we have
    // observed the user typing" signal — set the first time
    // a `keydown` fires and never cleared. The signal is
    // session-local, so a user who plugs in a keyboard mid-
    // session gets `hasKeyboard: true` from that point on.
    let hasKeyboard = false;
    const onFirstKey = () => {
      if (hasKeyboard) return;
      hasKeyboard = true;
      detect();
    };
    function detect() {
      const fine = window.matchMedia("(pointer: fine)").matches;
      const coarse = window.matchMedia("(pointer: coarse)").matches;
      const hover = window.matchMedia("(hover: hover)").matches;
      const ua = navigator.userAgent;
      const touchUa = /Mobi|Android|iPhone|iPad|iPod/i.test(ua);
      // iPadOS 13+ hides behind Macintosh UA but reports touch points.
      const isIpadOs =
        /Macintosh/i.test(ua) && (navigator.maxTouchPoints ?? 0) > 0;
      const isMobileUa = touchUa || isIpadOs;

      // A "desktop" surface: fine pointer (mouse), hover capable, no
      // touch UA AND not iPadOS. Phones can fake `pointer: fine` on
      // some browsers when a mouse is attached — `hover: hover`
      // disambiguates.
      const isDesktop = fine && hover && !isMobileUa;
      const isMobile = coarse || isMobileUa;
      setInfo({ isDesktop, isMobile, hasKeyboard });
    }
    detect();
    window.addEventListener("keydown", onFirstKey, { once: true });

    // Subscribe to media-query changes so attaching/detaching a mouse
    // or keyboard (e.g. an iPad into its keyboard dock) re-detects
    // without waiting for a resize event.
    const queries = [
      window.matchMedia("(pointer: fine)"),
      window.matchMedia("(pointer: coarse)"),
      window.matchMedia("(hover: hover)"),
    ];
    const mqListener = () => detect();
    // QA16/R3: Safari < 14 only exposes the legacy
    // MediaQueryList.addListener / removeListener API. The
    // addEventListener call is a silent no-op on those
    // versions, so live changes never re-detected. Feature-
    // detect and fall back.
    function addMqListener(
      q: MediaQueryList,
      fn: (ev: MediaQueryListEvent) => void,
    ) {
      if (typeof q.addEventListener === "function") {
        q.addEventListener("change", fn);
      } else if (typeof (q as unknown as {
        addListener?: (fn: (ev: MediaQueryListEvent) => void) => void;
      }).addListener === "function") {
        (q as unknown as {
          addListener: (fn: (ev: MediaQueryListEvent) => void) => void;
        }).addListener(fn);
      }
    }
    function removeMqListener(
      q: MediaQueryList,
      fn: (ev: MediaQueryListEvent) => void,
    ) {
      if (typeof q.removeEventListener === "function") {
        q.removeEventListener("change", fn);
      } else if (typeof (q as unknown as {
        removeListener?: (fn: (ev: MediaQueryListEvent) => void) => void;
      }).removeListener === "function") {
        (q as unknown as {
          removeListener: (fn: (ev: MediaQueryListEvent) => void) => void;
        }).removeListener(fn);
      }
    }
    for (const q of queries) addMqListener(q, mqListener);
    window.addEventListener("resize", mqListener);
    return () => {
      window.removeEventListener("keydown", onFirstKey);
      for (const q of queries) removeMqListener(q, mqListener);
      window.removeEventListener("resize", mqListener);
    };
  }, []);

  return info;
}