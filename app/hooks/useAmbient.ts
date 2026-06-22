"use client";

// Sound World — procedural WebAudio ambient bed that matches
// the user's prompt. No assets, no licensing, no server. Just
// filtered noise + LFOs.
//
// The user picks "a misty forest" → we run pink noise through
// a low-pass filter at 600Hz with a slow LFO. They say "ocean"
// → brown noise with a 0.3Hz gain LFO mimicking wave swell.
// Each keyword has a small `voice`-like patch.
//
// The audio context can only be created inside a user gesture
// (browser autoplay policy). We defer the actual `new
// AudioContext()` to the first user tap on the Sound toggle.

import { useCallback, useEffect, useRef, useState } from "react";
import { dreamBus } from "../lib/event-bus";
import { DEFAULT_PATCH, patchFor, type Patch } from "../lib/ambient-patches";

export interface UseAmbientOptions {
  /** Active = the user has toggled the audio on at least once. */
  enabled: boolean;
  /** Pause the audio without tearing down (e.g. VR mode). */
  paused?: boolean;
  /**
   * When true, the master gain is multiplied by a small
   * factor (0.25) so the user's voice is more intelligible
   * over the ambient bed. Use while the mic is open.
   * Ramped over ~200ms to avoid a click.
   */
  duckWhileListening?: boolean;
}

export interface UseAmbientApi {
  on: () => void;
  off: () => void;
  toggle: () => void;
  isOn: boolean;
}

export function useAmbient({ enabled, paused = false, duckWhileListening = false }: UseAmbientOptions): UseAmbientApi {
  const [isOn, setIsOn] = useState(false);
  // Mirror of isOn so toggle() can read the freshest value
  // without depending on `isOn` (which would force the
  // toggle handler to re-bind every state flip).
  const isOnRef = useRef(false);
  // DUCKED_GAIN multiplies the patch's gain when the user
  // is voice-listening. 0.25 = quarter-volume; the ambient
  // bed fades back in 200ms after the mic closes. Tracked
  // in a ref so the master-loop interval (which runs
  // every 250ms) and the ducking effect can both read the
  // freshest value without re-binding each other.
  const DUCKED_GAIN = 0.25;
  const duckRef = useRef(false);
  // Round 9: mirror `paused` into a ref so the on() callback
  // can check it without re-binding on every `paused` flip.
  // The pause effect itself re-runs on `paused` changes
  // (line 154), so the ref just needs to stay in sync.
  const pausedRef = useRef(paused);
  const duckWhileListeningRef = useRef(duckWhileListening);
  const ctxRef = useRef<AudioContext | null>(null);
  const masterRef = useRef<GainNode | null>(null);
  const filterRef = useRef<BiquadFilterNode | null>(null);
  const noiseRef = useRef<AudioBufferSourceNode | null>(null);
  const lfoRef = useRef<OscillatorNode | null>(null);
  const lfoGainRef = useRef<GainNode | null>(null);
  // The setTimeout that `off()` schedules to call
  // `ctx.suspend()` 350ms after the gain ramp. Tracked so
  // we can cancel it on `on()` (otherwise an `on()` that
  // follows `off()` within 350ms gets silently muted when
  // the deferred suspend lands) and on `teardown()` (the
  // context is already closed; suspend would throw
  // `InvalidStateError` on a closed AudioContext).
  const suspendTimerRef = useRef<number | null>(null);
  // Latest patch the user has asked for. Applied on the next
  // ~250ms tick (we don't want to snap-cut; we crossfade
  // gain at the master and ramp filter frequency).
  const pendingPatchRef = useRef<Patch>(DEFAULT_PATCH);
  const currentPatchRef = useRef<Patch>(DEFAULT_PATCH);

  // Subscribe to loadScene events and update the pending patch.
  useEffect(() => {
    const off = dreamBus.on("dream:loadScene", (d: { prompt: string; seed: number }) => {
      if (d?.prompt) {
        pendingPatchRef.current = patchFor(d.prompt);
      }
    });
    return off;
  }, []);

  // Master loop. Every 250ms, if a pending patch differs
  // from the current, ramp filter frequency + gain toward
  // it over 800ms. Cheap because the ramp is on the
  // AudioParam, not the audio thread.
  useEffect(() => {
    if (!isOn || !ctxRef.current) return;
    const id = window.setInterval(() => {
      const ctx = ctxRef.current;
      const filter = filterRef.current;
      const master = masterRef.current;
      if (!ctx || !filter || !master) return;
      const want = pendingPatchRef.current;
      const have = currentPatchRef.current;
      if (want === have) return;
      // Crossfade gain. Multiplied by the duck factor so a
      // patch change during a voice-listening window does
      // not blast back to full volume.
      const t = ctx.currentTime;
      const now = t;
      const duckMul = duckRef.current ? DUCKED_GAIN : 1;
      const target = want.gain * duckMul;
      master.gain.cancelScheduledValues(now);
      master.gain.setValueAtTime(master.gain.value, now);
      master.gain.linearRampToValueAtTime(target, now + 0.8);
      // Reroute through a NEW filter? Too expensive. Instead
      // we crossfade TWO filter chains. Simpler: just update
      // the existing filter's parameters with a 800ms ramp.
      filter.type = want.type;
      filter.frequency.cancelScheduledValues(now);
      filter.frequency.setValueAtTime(filter.frequency.value, now);
      filter.frequency.linearRampToValueAtTime(want.cutoff, now + 0.8);
      filter.Q.cancelScheduledValues(now);
      filter.Q.setValueAtTime(filter.Q.value, now);
      filter.Q.linearRampToValueAtTime(want.q, now + 0.8);
      // Update the LFO if its target frequency changed.
      if (have.lfoRate !== want.lfoRate && lfoRef.current) {
        lfoRef.current.frequency.cancelScheduledValues(now);
        lfoRef.current.frequency.setValueAtTime(lfoRef.current.frequency.value, now);
        lfoRef.current.frequency.linearRampToValueAtTime(want.lfoRate, now + 0.8);
      }
      if (have.lfoDepth !== want.lfoDepth && lfoGainRef.current) {
        lfoGainRef.current.gain.cancelScheduledValues(now);
        lfoGainRef.current.gain.setValueAtTime(lfoGainRef.current.gain.value, now);
        lfoGainRef.current.gain.linearRampToValueAtTime(want.lfoDepth, now + 0.8);
      }
      // Re-color the noise source if needed. We tear down
      // and re-create the source because the noise buffer
      // is generated once and we don't want to swap it
      // mid-stream.
      if (have.noiseColor !== want.noiseColor && noiseRef.current) {
        // QA19 fix: the previous code only called `stop()`,
        // which leaves the node connected to the filter. Web
        // Audio holds the connection until explicitly
        // disconnected, so the stopped node sits in the
        // graph indefinitely and the audio thread iterates
        // it on every block. Disconnect + stop so the node
        // can be GC'd.
        try { noiseRef.current.stop(); } catch { /* noop */ }
        try { noiseRef.current.disconnect(); } catch { /* noop */ }
        const next = makeNoiseSource(ctx, filter, want.noiseColor);
        next.start();
        noiseRef.current = next;
      }
      currentPatchRef.current = want;
    }, 250);
    return () => window.clearInterval(id);
  }, [isOn]);

  // Pause/resume on `paused` toggle.
  useEffect(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    // QA16: a teardown() that ran earlier in the same render
    // could have nulled ctxRef.current while the paused
    // effect was already queued. The captured `ctx` is the
    // stale (closed) context, and `suspend()` on a closed
    // AudioContext throws `InvalidStateError` — unhandled
    // and noisy in the console. Guard on the live state.
    if (ctx.state === "closed") return;
    pausedRef.current = paused;
    if (paused) {
      try { void ctx.suspend(); } catch { /* closed mid-flight */ }
    } else {
      try { void ctx.resume(); } catch { /* closed mid-flight */ }
    }
  }, [paused]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      teardown();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // QA16: if the parent unmounts while a suspend timer is
  // pending, clear it. teardown() already does this, but
  // we add a dedicated effect so the cleanup is explicit
  // and React's strict-mode double-mount is covered.
  useEffect(() => {
    return () => {
      if (suspendTimerRef.current != null) {
        window.clearTimeout(suspendTimerRef.current);
        suspendTimerRef.current = null;
      }
    };
  }, []);

  // F4: voice-listening duck. When `duckWhileListening`
  // flips true, ramp the master gain down to 25% of the
  // current patch gain over 200ms. When it flips false,
  // ramp back up. The 200ms ramp keeps the change
  // inaudible — voice STT is still picking up the user
  // 200ms after the mic opens, but the brain filters out
  // a slow gain change as natural.
  useEffect(() => {
    duckWhileListeningRef.current = duckWhileListening;
    if (!isOnRef.current) {
      // Track the desired state even if ambient isn't on
      // yet — the next `on()` reads duckRef and starts at
      // the ducked gain instead of full.
      duckRef.current = duckWhileListening;
      return;
    }
    const ctx = ctxRef.current;
    const master = masterRef.current;
    if (!ctx || !master || ctx.state === "closed") {
      duckRef.current = duckWhileListening;
      return;
    }
    const wasDucked = duckRef.current;
    if (wasDucked === duckWhileListening) return;
    duckRef.current = duckWhileListening;
    const t = ctx.currentTime;
    const patchGain = pendingPatchRef.current.gain;
    const target = duckWhileListening ? patchGain * DUCKED_GAIN : patchGain;
    master.gain.cancelScheduledValues(t);
    master.gain.setValueAtTime(master.gain.value, t);
    master.gain.linearRampToValueAtTime(target, t + 0.2);
  }, [duckWhileListening]);

  function ensureContext(): AudioContext | null {
    if (typeof window === "undefined") return null;
    if (ctxRef.current) return ctxRef.current;
    const Ctor: typeof AudioContext =
      window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctor) return null;
    const ctx = new Ctor();
    // Master gain starts at 0 — ramped up to default patch
    // gain on `on()`.
    const master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);
    // Filter chain.
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = DEFAULT_PATCH.cutoff;
    filter.Q.value = DEFAULT_PATCH.q;
    filter.connect(master);
    // LFO modulating the filter cutoff.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = DEFAULT_PATCH.lfoRate;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = DEFAULT_PATCH.lfoDepth;
    lfo.connect(lfoGain);
    lfoGain.connect(filter.frequency);
    lfo.start();
    // White-noise source (3 seconds, looped). Buffer is
    // generated once; the "color" is approximated by
    // weighting samples via a small running average.
    const source = makeNoiseSource(ctx, filter, DEFAULT_PATCH.noiseColor);
    source.start();
    ctxRef.current = ctx;
    masterRef.current = master;
    filterRef.current = filter;
    noiseRef.current = source;
    lfoRef.current = lfo;
    lfoGainRef.current = lfoGain;
    return ctx;
  }

  function teardown() {
    // QA16: cancel any pending suspend timer so a teardown
    // followed by an `on()` doesn't have a stale timer fire
    // against the new context.
    if (suspendTimerRef.current != null) {
      window.clearTimeout(suspendTimerRef.current);
      suspendTimerRef.current = null;
    }
    try { noiseRef.current?.stop(); } catch { /* noop */ }
    try { lfoRef.current?.stop(); } catch { /* noop */ }
    try { ctxRef.current?.close(); } catch { /* noop */ }
    noiseRef.current = null;
    lfoRef.current = null;
    lfoGainRef.current = null;
    masterRef.current = null;
    filterRef.current = null;
    ctxRef.current = null;
  }

  const on = useCallback(() => {
    // QA16: cancel the deferred suspend from a recent
    // `off()` so the audio doesn't go silent 350ms after
    // the user re-enabled it.
    if (suspendTimerRef.current != null) {
      window.clearTimeout(suspendTimerRef.current);
      suspendTimerRef.current = null;
    }
    const ctx = ensureContext();
    if (!ctx) return;
    if (ctx.state === "closed") return;
    // Round 9: honor `paused`. If ambient is toggled on
    // while paused=true, the AudioContext must NOT resume.
    // The pause effect at line 160 only re-runs on `paused`
    // changes — not on ambient toggles — so this is the
    // only place we can stop the audio.
    if (!pausedRef.current) {
      try { void ctx.resume(); } catch { /* closed mid-flight */ }
    }
    const master = masterRef.current;
    if (master) {
      const t = ctx.currentTime;
      // Honor the duck factor at `on()` time — if the user
      // toggles ambient on while the mic is already open,
      // we should start at the ducked gain, not full.
      const duckMul = duckRef.current ? DUCKED_GAIN : 1;
      const target = pendingPatchRef.current.gain * duckMul;
      master.gain.cancelScheduledValues(t);
      master.gain.setValueAtTime(master.gain.value, t);
      master.gain.linearRampToValueAtTime(target, t + 0.6);
    }
    isOnRef.current = true;
    setIsOn(true);
    // Round 8 fix: flush the pending patch on `on()` so
    // it re-syncs from the current scene. Without this,
    // pendingPatchRef drifts when ambient is off and
    // the user has painted multiple dreams; toggling
    // ambient on would play the WRONG patch for the
    // live world.
    pendingPatchRef.current = DEFAULT_PATCH;
    currentPatchRef.current = DEFAULT_PATCH;
    // Round 9: honor `paused` here too. If ambient is
    // toggled on while paused=true (e.g. VR mode is
    // active), the AudioContext must NOT resume — the
    // pause effect only fires on `paused` changes, not
    // on ambient toggles.
  }, [paused]);

  const off = useCallback(() => {
    const ctx = ctxRef.current;
    const master = masterRef.current;
    if (!ctx || !master || ctx.state === "closed") {
      isOnRef.current = false;
      setIsOn(false);
      return;
    }
    const t = ctx.currentTime;
    master.gain.cancelScheduledValues(t);
    master.gain.setValueAtTime(master.gain.value, t);
    master.gain.linearRampToValueAtTime(0, t + 0.3);
    // Schedule the context suspend after the ramp so the
    // audio doesn't click. Track the timer so `on()` and
    // `teardown()` can cancel it before it fires against a
    // suspended or closed context.
    suspendTimerRef.current = window.setTimeout(() => {
      suspendTimerRef.current = null;
      const live = ctxRef.current;
      if (!live || live.state === "closed") return;
      try { void live.suspend(); } catch { /* closed mid-flight */ }
    }, 350);
    isOnRef.current = false;
    setIsOn(false);
  }, []);

  const toggle = useCallback(() => {
    // QA16: read isOn from a ref so a rapid double-tap
    // (faster than the React re-render) doesn't see the
    // same isOn value twice and call on() twice in a row.
    if (isOnRef.current) off();
    else on();
  }, [on, off]);

  // Don't render audio unless the user enabled it.
  if (!enabled) {
    return { on: () => {}, off: () => {}, toggle: () => {}, isOn: false };
  }
  return { on, off, toggle, isOn };
}

// ── helpers ──────────────────────────────────────────────────

function makeNoiseSource(
  ctx: AudioContext,
  out: AudioNode,
  color: 0 | 1 | 2,
): AudioBufferSourceNode {
  const buf = ctx.createBuffer(1, ctx.sampleRate * 3, ctx.sampleRate);
  const data = buf.getChannelData(0);
  if (color === 0) {
    // White noise.
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  } else if (color === 1) {
    // Pink noise (Voss-McCartney).
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < data.length; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.96900 * b2 + w * 0.1538520;
      b3 = 0.86650 * b3 + w * 0.3104856;
      b4 = 0.55000 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.0168980;
      data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
  } else {
    // Brown noise (integrated white).
    let last = 0;
    for (let i = 0; i < data.length; i++) {
      const w = Math.random() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;
      data[i] = last * 3.5;
    }
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  src.connect(out);
  return src;
}

// (QA6: Patches are now imported from ambient-patches.ts so
// the table is unit-testable without an AudioContext.)
