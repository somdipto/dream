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
  /**
   * QA4: live mic level in [0, 1]. Updated at ~20 fps while the
   * mic is open. 0 when the mic is closed or unsupported. UI
   * components draw a level meter from this so the user knows
   * their voice is actually being captured.
   */
  level: number;
}

export interface VoiceControls extends VoiceState {
  start: () => void;
  /**
   * Stop the recogniser. Returns a Promise that resolves once the
   * recogniser's `onend` has fired (or after a 200ms safety timeout).
   * Callers that need to chain other teardown — e.g. disconnecting
   * the Lingbot SDK — should `await voice.stop()` so they don't race
   * the recogniser's audio handle.
   */
  stop: () => Promise<void>;
  /** Manually commit the current interim + buffered text as `final`. */
  commit: () => string | null;
  /** Clear `final` so the next commit starts fresh. */
  reset: () => void;
  /**
   * Register a handler that fires on every speech-recognition `isFinal`
   * result. The handler receives the full buffered transcript at the
   * moment the engine commits a final. The handler is also called by
   * the silence-flush auto-commit. Use this to wire the recognition
   * results directly into the world (no manual "Send" required).
   *
   * The function returns an unsubscribe handle.
   */
  onFinal: (cb: (text: string) => void) => () => void;
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
  // QA4: live mic level. Updated ~20 times/sec while the
  // mic is open. 0 when the mic is closed or unsupported.
  const [level, setLevel] = useState(0);

  const recRef = useRef<any | null>(null);
  const shouldListenRef = useRef(false);
  const bufferRef = useRef("");
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finalListenersRef = useRef<Set<(text: string) => void>>(new Set());
  // QA4: refs to the AnalyserNode + RAF + mic stream so we
  // can tear them down in stop() / cleanup. The stream
  // handle is the critical one to release — without it the
  // mic stays open after a hot reload.
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const levelRafRef = useRef<number | null>(null);

  const flushSilence = useCallback(() => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  }, []);

  /** Internal: commit `bufferRef` as final, notify listeners, reset state. */
  const commitBufferAsFinal = useCallback(() => {
    const text = bufferRef.current.trim();
    if (!text) return;
    setFinal(text);
    bufferRef.current = "";
    setInterim("");
    finalListenersRef.current.forEach((cb) => {
      try {
        cb(text);
      } catch {
        // ponytail: a listener error must not stop other listeners.
      }
    });
  }, []);

  const armSilenceFlush = useCallback(() => {
    flushSilence();
    silenceTimerRef.current = setTimeout(() => {
      commitBufferAsFinal();
    }, SILENCE_MS);
  }, [flushSilence, commitBufferAsFinal]);

  // QA4: start the mic level meter. Asks for a fresh
  // getUserMedia stream (independent of SpeechRecognition,
  // which owns its own audio) and pumps an AnalyserNode via
  // requestAnimationFrame. Any failure (denied permission,
  // insecure context) is swallowed — the level meter is
  // non-critical.
  const startLevelMeter = useCallback(async () => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices) return;
    if (streamRef.current) return; // already running
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      streamRef.current = stream;
      const Ctor: typeof AudioContext =
        (window as any).AudioContext || (window as any).webkitAudioContext;
      if (!Ctor) return;
      const ctx = new Ctor();
      audioContextRef.current = ctx;
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
      analyserRef.current = analyser;
      const buf = new Uint8Array(analyser.fftSize);
      let raf = 0;
      const tick = () => {
        if (!analyserRef.current) return;
        analyserRef.current.getByteTimeDomainData(buf);
        // RMS over the time-domain buffer (centered at 128).
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / buf.length);
        // Map RMS to a 0..1 scale, biased so quiet speech is
        // visible but loud speech tops out at 1.0.
        const norm = Math.min(1, rms * 4);
        setLevel(norm);
        raf = requestAnimationFrame(tick);
        levelRafRef.current = raf;
      };
      raf = requestAnimationFrame(tick);
    } catch {
      // No-op: level meter is non-critical. The user still
      // gets the speech-to-text pipeline.
    }
  }, []);

  // QA4: stop the level meter and release the mic. Idempotent.
  const stopLevelMeter = useCallback(() => {
    if (levelRafRef.current != null) {
      cancelAnimationFrame(levelRafRef.current);
      levelRafRef.current = null;
    }
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) track.stop();
      streamRef.current = null;
    }
    if (audioContextRef.current) {
      try { audioContextRef.current.close(); } catch { /* noop */ }
      audioContextRef.current = null;
    }
    analyserRef.current = null;
    setLevel(0);
  }, []);

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
        // Engine committed a final — fire listeners immediately so the
        // world can mutate without waiting for the silence flush.
        commitBufferAsFinal();
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
        if (silenceTimerRef.current) {
          clearTimeout(silenceTimerRef.current);
          silenceTimerRef.current = null;
        }
        setListening(false);
      }
    };

    rec.onend = () => {
      // Auto-restart while the user wants to be listening. The browser
      // ends the session after silence or a session cap; this loop keeps
      // it effectively continuous. Construct a *fresh* recogniser each
      // time — Chrome will refuse `start()` on the same instance after
      // it ends once.
      if (shouldListenRef.current) {
        // Detach this recogniser's listeners so a delayed onend doesn't
        // double-fire while we're spinning up the next one.
        rec.onresult = null;
        rec.onerror = null;
        rec.onend = null;
        recRef.current = null;
        // Defer to next tick so any in-flight onresult lands first.
        setTimeout(() => {
          if (!shouldListenRef.current) return;
          try {
            start();
          } catch {
            // give up — will recover on the next user gesture.
          }
        }, 50);
        return;
      }
      setListening(false);
    };

    recRef.current = rec;
    try {
      rec.start();
      setListening(true);
      // QA6: clear any prior error on a successful start.
      // Without this, the user's "Tap to retry" banner
      // stayed visible during the auto-restart loop, which
      // made it look like the mic was still broken.
      setError(null);
      // QA4: start the audio-level meter alongside the
      // recogniser. The meter is best-effort — it never
      // blocks the speech pipeline.
      void startLevelMeter();
    } catch (e: any) {
      setError(e?.message ?? String(e));
      shouldListenRef.current = false;
      setListening(false);
    }
  }, [supported, armSilenceFlush, commitBufferAsFinal, startLevelMeter]);

  // stop() resolves once the recogniser has actually finished
  // tearing down. We wait for `onend` (some browsers fire it
  // asynchronously after abort()) or a 200 ms safety timeout,
  // whichever first. Callers that need to chain other teardown
  // after stop — e.g. disconnecting the Lingbot SDK — should
  // `await voice.stop()` so they don't race the recogniser's
  // audio handle.
  const stop = useCallback((): Promise<void> => {
    shouldListenRef.current = false;
    flushSilence();
    const rec = recRef.current;
    if (!rec) {
      setListening(false);
      return Promise.resolve();
    }
    // Null handlers FIRST so a delayed onend (which browsers sometimes
    // fire after `stop()`) doesn't restart the recogniser via the
    // auto-restart loop. Audit bug #14/#16.
    try {
      rec.onresult = null;
      rec.onerror = null;
    } catch {
      // ignore
    }
    // Wrap onend so we can resolve our promise when it fires.
    const prevOnEnd = rec.onend;
    return new Promise<void>((resolve) => {
      const onSettled = () => {
        clearTimeout(timer);
        resolve();
      };
      rec.onend = onSettled;
      // Safety net: even if `onend` never fires (some Android
      // Chrome builds can hang the recogniser after abort()),
      // resolve after 200ms so callers never block forever.
      const timer = setTimeout(onSettled, 200);
      try {
        // abort() cuts the audio immediately so a mid-utterance stop
        // doesn't lose the user's last phrase to a delayed onresult.
        if (typeof rec.abort === "function") {
          rec.abort();
        } else {
          rec.stop();
        }
      } catch {
        // ponytail: stopping an already-stopped recogniser throws on
        // some browsers. Treat as already-stopped.
        onSettled();
      }
      // If a previous onend was registered (unlikely now that we
      // nulled it above, but defensive), keep it for any external
      // listener.
      void prevOnEnd;
    }).finally(() => {
      recRef.current = null;
      setListening(false);
      // QA4: also tear down the audio-level meter. The mic
      // stream is the important thing to release here — without
      // it the OS mic indicator stays lit after a stop.
      stopLevelMeter();
    });
  }, [flushSilence, stopLevelMeter]);

  const commit = useCallback((): string | null => {
    flushSilence();
    const text = (bufferRef.current + (interim ? " " + interim : "")).trim();
    if (!text) return null;
    commitBufferAsFinal();
    return text;
  }, [interim, flushSilence, commitBufferAsFinal]);

  const reset = useCallback(() => {
    setFinal(null);
    bufferRef.current = "";
    setInterim("");
    flushSilence();
  }, [flushSilence]);

  const onFinal = useCallback((cb: (text: string) => void) => {
    finalListenersRef.current.add(cb);
    return () => {
      finalListenersRef.current.delete(cb);
    };
  }, []);

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
    level,
    start,
    stop,
    commit,
    reset,
    onFinal,
  };
}