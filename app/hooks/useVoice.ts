"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Browser-side voice-to-text. Wraps `SpeechRecognition` (Web Speech API).
//
// Android Chrome: best support — `continuous: true` behaves as expected,
// audio is sent to Google's network speech service.
// iOS Safari: requires the user-gesture click; auto-stops after silence;
// auto-restart on `onend` is the standard workaround.
// Desktop Firefox: not supported — `useVoice` returns `{ supported: false }`
// and the UI falls back to the on-screen text input.
//
// Why we auto-restart: SpeechRecognition is not actually a continuous
// stream — both Chrome and Safari cap a session or stop on silence. The
// canonical pattern is to call `rec.start()` again from `onend`. We hold
// a single `shouldListen` flag so the restart knows whether to keep going.
//
// Why a silence flush: in continuous mode the engine keeps emitting
// non-final results while the user is still speaking. We expose them as
// `interim` so the UI can show "live" feedback, but we only commit a
// `final` transcript after the user taps Send OR no new interim result
// has arrived for `silenceMs`. This avoids the engine's "early final"
// premature emissions on Android.

type SR = typeof window.SpeechRecognition extends undefined
  ? never
  : NonNullable<typeof window.SpeechRecognition>;

declare global {
  interface Window {
    SpeechRecognition?: any;
    webkitSpeechRecognition?: any;
  }
}

export interface VoiceState {
  supported: boolean;
  listening: boolean;
  interim: string;
  /** Last fully-committed transcript (from a Send tap or silence flush). */
  final: string | null;
  /** Permission or recognition error message, if any. */
  error: string | null;
}

export interface VoiceControls extends VoiceState {
  start: () => void;
  stop: () => void;
  /** Manually commit the current interim + buffered text as `final`. */
  commit: () => string | null;
  /** Clear `final` so the next commit starts fresh. */
  reset: () => void;
}

const SILENCE_MS = 1500;
const LANG = "en-US";

export function useVoice(): VoiceControls {
  const supported =
    typeof window !== "undefined" &&
    (Boolean(window.SpeechRecognition) || Boolean(window.webkitSpeechRecognition));

  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [final, setFinal] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const recRef = useRef<any | null>(null);
  const shouldListenRef = useRef(false);
  const bufferRef = useRef("");
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushSilence = useCallback(() => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  }, []);

  const armSilenceFlush = useCallback(() => {
    flushSilence();
    silenceTimerRef.current = setTimeout(() => {
      const text = bufferRef.current.trim();
      if (text) {
        setFinal(text);
        bufferRef.current = "";
        setInterim("");
      }
    }, SILENCE_MS);
  }, [flushSilence]);

  const start = useCallback(() => {
    if (!supported) {
      setError("Speech recognition not supported in this browser");
      return;
    }
    if (shouldListenRef.current) return; // already started
    shouldListenRef.current = true;
    setError(null);
    bufferRef.current = "";
    setInterim("");

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = LANG;

    rec.onresult = (e: any) => {
      let liveInterim = "";
      let liveFinal = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const t = r[0].transcript;
        if (r.isFinal) {
          liveFinal += t;
        } else {
          liveInterim += t;
        }
      }
      if (liveFinal) {
        // ponytail: `liveFinal` may not include trailing space — preserve buffer order.
        bufferRef.current = (bufferRef.current + " " + liveFinal).trim();
      }
      // ponytail: interim is what the engine *currently* thinks the user said.
      // We expose the *combined* (buffer + live interim) so the UI shows
      // everything spoken so far, with the live portion visibly highlighted.
      const live = bufferRef.current + (liveInterim ? " " + liveInterim : "");
      setInterim(live);
      armSilenceFlush();
    };

    rec.onerror = (e: any) => {
      // "no-speech" and "aborted" are routine — don't surface as errors.
      if (e.error === "no-speech" || e.error === "aborted") return;
      setError(`${e.error}${e.message ? ": " + e.message : ""}`);
      // Hard errors (not-allowed, audio-capture, service-not-allowed)
      // mean we can't recover — stop the loop.
      if (
        e.error === "not-allowed" ||
        e.error === "audio-capture" ||
        e.error === "service-not-allowed"
      ) {
        shouldListenRef.current = false;
        setListening(false);
      }
    };

    rec.onend = () => {
      // Auto-restart while the user wants to be listening. The browser
      // ends the session after silence or a session cap; this loop keeps
      // it effectively continuous.
      if (shouldListenRef.current) {
        try {
          rec.start();
          return;
        } catch {
          // If start() throws (e.g., already started), fall through to idle.
        }
      }
      setListening(false);
    };

    recRef.current = rec;
    try {
      rec.start();
      setListening(true);
    } catch (e: any) {
      setError(e?.message ?? String(e));
      shouldListenRef.current = false;
      setListening(false);
    }
  }, [supported, armSilenceFlush]);

  const stop = useCallback(() => {
    shouldListenRef.current = false;
    flushSilence();
    const rec = recRef.current;
    if (rec) {
      try {
        rec.stop();
      } catch {
        // ponytail: stopping an already-stopped recogniser throws on some browsers.
      }
    }
    recRef.current = null;
    setListening(false);
  }, [flushSilence]);

  const commit = useCallback((): string | null => {
    flushSilence();
    const text = (bufferRef.current + (interim ? " " + interim : "")).trim();
    if (!text) return null;
    setFinal(text);
    bufferRef.current = "";
    setInterim("");
    // ponytail: keep the recogniser running so the user can speak again.
    return text;
  }, [interim, flushSilence]);

  const reset = useCallback(() => {
    setFinal(null);
    bufferRef.current = "";
    setInterim("");
    flushSilence();
  }, [flushSilence]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      shouldListenRef.current = false;
      flushSilence();
      const rec = recRef.current;
      if (rec) {
        try {
          rec.stop();
        } catch {
          // ponytail: see stop().
        }
      }
      recRef.current = null;
    };
  }, [flushSilence]);

  return {
    supported,
    listening,
    interim,
    final,
    error,
    start,
    stop,
    commit,
    reset,
  };
}