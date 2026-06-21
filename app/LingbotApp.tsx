"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { LingbotProvider, useLingbot } from "@reactor-models/lingbot";
import { Video } from "./components/Video";
import { DirectorOverlay } from "./components/DirectorOverlay";
import { PromptTrail } from "./components/PromptTrail";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { StatusBadge } from "./components/StatusBadge";
import { CommandError } from "./components/CommandError";
import { VoiceDream } from "./components/VoiceDream";
import { GyroController } from "./components/GyroController";
import { cycleStyle, cycleVariant, resetDirector, setDirectorState, getDirectorState } from "./lib/director-state";
import { timeBandForNow, variantIdForBand, labelForBand } from "./lib/time-of-day";
import { DesktopController } from "./components/DesktopController";
import { DesktopDream } from "./components/DesktopDream";
import { SessionSidebar } from "./components/SessionSidebar";
import { VRView } from "./components/VRView";
import { VirtualJoystick } from "./components/VirtualJoystick";
import { SessionProvider, useSessions } from "./components/SessionProvider";
import { useMotion } from "./hooks/useMotion";
import { useVoice } from "./hooks/useVoice";
import { useRemDrift } from "./hooks/useRemDrift";
import { useAmbient } from "./hooks/useAmbient";
import { usePlatform } from "./hooks/usePlatform";
import { generateSeedImage } from "./lib/seed-image";
import { composeScenePrompt } from "./lib/scene-composer";
import { dailyDream, dailyDreamTitle } from "./lib/curated-scenes";
import { dreamBus } from "./lib/event-bus";
import {
  blackScreenLogCount,
  getBlackScreenLog,
  clearBlackScreenLog,
  type BlackScreenEvent,
} from "./lib/black-screen-log";
import { classifyReactorError } from "./lib/reactor-errors";
import { bustNextToken, consumeBust } from "./lib/token-bust";
import { loadUserKey, getFingerprint, saveUserKey as _saveUserKey, clearUserKey as _clearUserKey } from "./lib/byok";

async function fetchToken(): Promise<string> {
  // M9.8: respect the one-shot bust flag so the Lingbot SDK doesn't
  // reuse a 6-hour JWT cached for an exhausted key. The flag is set
  // by the 402-recovery flow in ReactorErrorScreen before connect()
  // is called again.
  //
  // M9.12: forward the BYOK key (if any) to the server so the user
  // can supply their own key when the host's pool is exhausted.
  const bust = consumeBust();
  const url = bust ? "/api/reactor/token?nocache=1" : "/api/reactor/token";
  const userKey = loadUserKey();
  const headers: Record<string, string> = {};
  if (userKey) headers["X-Reactor-User-Key"] = userKey;
  const r = await fetch(url, {
    cache: bust ? "no-store" : undefined,
    headers,
  });
  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Token fetch failed: ${r.status}`);
  }
  const { jwt } = (await r.json()) as { jwt: string };
  return jwt;
}

// Brighter, hyper-realistic default desktop scene. M9.13 tightened
// the lighting cues further after the user reported "blank dark
// black screen" — every descriptor now actively pushes the model
// toward a clearly-lit, daytime, photo-real result. Repetition is
// intentional; LingBot's prompt parser weights early + explicit
// lighting words heavily.
// QA5: shorter default desktop scene prompt. The previous
// 454-char version + CAMERA_GRAMMAR + MOTION_HINT
// exceeded Reactor's ~1200-char server cap, producing a
// "prompt too long" error on first paint. This prompt
// fits comfortably with the composer wrapper while still
// describing a vivid scene.
const DEFAULT_DESKTOP_PROMPT =
  "a sunlit alpine meadow at golden hour, soft warm sunlight from the upper left, vivid wildflowers in the foreground, distant snow-capped peaks, clear blue sky with soft cumulus clouds, butterflies, hyper-realistic, cinematic lighting";

// QA16: a tiny module-level handoff so the Begin tap's Daily
// Dream seed is delivered to the Dream surface even when its
// event-bus listener is still mounting. LingbotApp fills the
// slot from handleBegin; VoiceDream/DesktopDream drain it on
// their first render. The slot is single-use: drained on
// first read so a slow mount doesn't replay a stale seed.
let pendingDailyScene: { prompt: string; seed: number } | null = null;
export function _takePendingDailyScene() {
  const v = pendingDailyScene;
  pendingDailyScene = null;
  return v;
}

export function LingbotApp() {
  return (
    <SessionProvider>
      <LingbotProvider getJwt={fetchToken}>
        <DreamSurface />
      </LingbotProvider>
    </SessionProvider>
  );
}

// ---------------------------------------------------------------------------
// M9.12: BYOK — a small inline field on the Begin overlay that lets the
// user paste their own Reactor API key. Stored in localStorage (see
// app/lib/byok.ts), forwarded to the server as the X-Reactor-User-Key
// header on every token request. The server tries the user key first
// and falls back to the env pool if it 402s.
// ---------------------------------------------------------------------------
function ByokKeyField({ onChanged }: { onChanged?: () => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [savedFingerprint, setSavedFingerprint] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Hydrate the saved-fingerprint from localStorage on mount and
  // when the field is opened.
  useEffect(() => {
    if (open) {
      const fp = getFingerprint();
      setSavedFingerprint(fp);
      setDraft("");
      setError(null);
    }
  }, [open]);

  function onSave(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = draft.trim();
    if (!v) return;
    const ok = _saveUserKey(v);
    if (!ok) {
      setError("That doesn't look like a Reactor key (expected rk_<40+ chars).");
      return;
    }
    setSavedFingerprint(getFingerprint());
    setDraft("");
    setError(null);
    onChanged?.();
  }

  function onClear() {
    _clearUserKey();
    setSavedFingerprint(null);
    setDraft("");
    setError(null);
    onChanged?.();
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="byok-open-btn"
        className="mt-4 text-[11px] text-white/45 underline-offset-2 hover:text-white/75 hover:underline"
      >
        Use your own Reactor key
      </button>
    );
  }

  return (
    <div className="mt-4 w-full max-w-sm rounded-2xl border border-white/10 bg-white/5 p-3 text-left text-xs text-white/80">
      {savedFingerprint ? (
        <div className="flex items-center justify-between gap-2">
          <span className="text-emerald-300">
            Using your key <code className="font-mono">{savedFingerprint}</code>
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-full border border-white/15 px-2 py-1 text-[10px] text-white/70 hover:bg-white/10"
            >
              Done
            </button>
            <button
              type="button"
              onClick={onClear}
              data-testid="byok-clear-btn"
              className="rounded-full border border-red-400/30 px-2 py-1 text-[10px] text-red-200 hover:bg-red-500/15"
            >
              Remove
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={onSave} className="flex flex-col gap-2">
          <label htmlFor="byok-key" className="text-[11px] text-white/65">
            Paste a Reactor key (rk_…). Stored only on this device.
          </label>
          <div className="flex gap-2">
            <input
              id="byok-key"
              type="password"
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setError(null);
              }}
              placeholder="rk_…"
              autoComplete="off"
              spellCheck={false}
              data-testid="byok-input"
              className="min-w-0 flex-1 rounded-md border border-white/15 bg-black/40 px-2 py-1.5 font-mono text-[11px] text-white placeholder:text-white/30 focus:border-white/40 focus:outline-none"
            />
            <button
              type="submit"
              data-testid="byok-save-btn"
              className="rounded-md bg-white px-3 py-1.5 text-[11px] font-medium text-black hover:bg-white/90"
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-md border border-white/15 px-2 py-1.5 text-[11px] text-white/70 hover:bg-white/10"
            >
              Cancel
            </button>
          </div>
          {error && <p className="text-[10px] text-red-300">{error}</p>}
          <p className="text-[10px] text-white/40">
            Get one at{" "}
            <a
              className="underline"
              href="https://reactor.inc/account/api-keys"
              target="_blank"
              rel="noopener noreferrer"
            >
              reactor.inc/account/api-keys
            </a>
            .
          </p>
        </form>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// M9.16: Black-screen memory chip — a small indicator on the Begin
// overlay that surfaces when the persistent log has at least one
// event. Tapping it opens a panel listing the recent events with
// timestamps and a Clear button. Hidden when the log is empty so
// the first-time user sees no extra chrome.
// ---------------------------------------------------------------------------
function BlackScreenMemoryChip() {
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<BlackScreenEvent[]>([]);
  const [count, setCount] = useState(0);

  useEffect(() => {
    setCount(blackScreenLogCount());
    if (open) setEvents(getBlackScreenLog());
  }, [open]);

  // Refresh count every 5s while closed, so a long-lived dark
  // frame recorded by the watchdog surfaces in the chip without
  // requiring a Begin-overlay remount.
  useEffect(() => {
    if (open) return;
    const t = window.setInterval(() => setCount(blackScreenLogCount()), 5000);
    return () => window.clearInterval(t);
  }, [open]);

  if (count === 0) return null;

  return (
    <div className="mt-3 w-full max-w-sm">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        data-testid="black-screen-chip"
        className="inline-flex items-center gap-2 rounded-full border border-amber-400/30 bg-amber-500/15 px-3 py-1.5 text-[11px] text-amber-100 backdrop-blur hover:bg-amber-500/25"
      >
        <span aria-hidden="true">●</span>
        <span>
          {count} black-screen event{count === 1 ? "" : "s"} remembered
        </span>
      </button>
      {open && (
        <div
          className="mt-2 max-h-64 overflow-y-auto rounded-2xl border border-white/10 bg-black/60 p-3 text-left text-[11px] text-white/85 backdrop-blur"
          data-testid="black-screen-panel"
        >
          <div className="mb-2 flex items-center justify-between">
            <span className="text-white/65">Recent black-screen events</span>
            <button
              type="button"
              onClick={() => {
                clearBlackScreenLog();
                setEvents([]);
                setCount(0);
                setOpen(false);
              }}
              className="rounded-full border border-white/15 px-2 py-0.5 text-[10px] text-white/70 hover:bg-white/10"
              data-testid="black-screen-clear"
            >
              Clear
            </button>
          </div>
          {events.length === 0 ? (
            <p className="text-white/45">No events.</p>
          ) : (
            <ul className="space-y-1.5">
              {events
                .slice()
                .reverse()
                .map((e, i) => (
                  <li
                    key={`${e.ts}-${i}`}
                    className="rounded-md border border-white/5 bg-white/5 px-2 py-1.5"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-amber-200">
                        {e.source}
                      </span>
                      <span className="text-white/40">
                        {new Date(e.ts).toLocaleTimeString()}
                      </span>
                    </div>
                    {e.note && (
                      <div className="mt-0.5 text-white/55">{e.note}</div>
                    )}
                  </li>
                ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// QA3: PromptHistoryChips — a horizontal scrollable strip of
// recent prompts the user has spoken or typed, newest first.
// Tapping a chip re-uses that prompt (with a fresh seed) so
// the user can re-roll a scene they liked without re-typing.
//
// Hidden when there are no prompts yet. The strip is keyboard
// scrollable on desktop.
// ---------------------------------------------------------------------------
function PromptHistoryChips({
  prompts,
  onPick,
}: {
  prompts: { prompt: string; seed: number; timestamp: number }[];
  onPick: (p: { prompt: string; seed: number }) => void;
}) {
  if (prompts.length === 0) return null;
  return (
    <div className="mt-3 w-full max-w-md" data-testid="prompt-history">
      <p className="text-[10px] uppercase tracking-wider text-white/45">
        Recent
      </p>
      <div className="mt-2 flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
        {prompts.slice(0, 5).map((p, i) => (
          <button
            key={`${p.timestamp}-${i}`}
            type="button"
            onClick={() => onPick({ prompt: p.prompt, seed: p.seed })}
            // QA11/A11Y-4: added aria-label so screen
            // readers announce the full prompt, not the
            // truncated visible text. The chip clips with
            // `truncate` and `title` was also the truncated
            // value — both made the chip unusable in a
            // screen reader.
            aria-label={`Re-dream: ${p.prompt}`}
            className="shrink-0 max-w-[180px] truncate rounded-full border border-white/15 bg-white/5 px-3 py-1.5 text-[11px] text-white/85 hover:bg-white/15 min-h-[36px]"
            title={p.prompt}
            data-testid="prompt-history-chip"
          >
            {p.prompt}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// QA2: NewSessionConfirmModal — replaces window.confirm on the
// "+ New session" button. In-app modal that respects the design
// language, traps focus, dismisses with Esc, and looks the same
// on iOS Safari as it does on Chrome.
//
// Props are the existing session's title + scene count so the
// user can confirm they want to start a new journal entry
// while the existing one is preserved.
// ---------------------------------------------------------------------------
function NewSessionConfirmModal({
  title,
  sceneCount,
  onConfirm,
  onCancel,
}: {
  title: string;
  sceneCount: number;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  // QA4: keep the last focused element on the page so we can
  // restore focus on close (and to detect Tab cycling outside
  // the modal in the keydown handler below).
  const previousFocusRef = useRef<Element | null>(null);
  useEffect(() => {
    if (typeof document === "undefined") return;
    previousFocusRef.current = document.activeElement;
    confirmRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
        return;
      }
      if (e.key !== "Tab") return;
      // QA4: simple 2-button focus trap. If focus is on the
      // last button and the user Tabs forward, send it back to
      // the first; Shift+Tab on the first button sends it to
      // the last. Prevents focus from escaping the dialog into
      // the page behind (where the recovery banner's Discard
      // button could be triggered accidentally).
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (active === cancelRef.current) {
          e.preventDefault();
          confirmRef.current?.focus();
        }
      } else {
        if (active === confirmRef.current) {
          e.preventDefault();
          cancelRef.current?.focus();
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      // Restore focus to the element that opened the modal so
      // keyboard users don't lose their place.
      const prev = previousFocusRef.current as HTMLElement | null;
      if (prev && typeof prev.focus === "function") {
        try { prev.focus(); } catch { /* element unmounted */ }
      }
    };
  }, [onCancel]);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-session-confirm-title"
      data-testid="new-session-confirm"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6 backdrop-blur"
      onClick={(e) => {
        // Click outside the dialog → cancel.
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-[#0a0a14]/95 p-5 text-white shadow-2xl">
        <h2
          id="new-session-confirm-title"
          className="text-base font-semibold text-white"
        >
          Start a new session?
        </h2>
        <p className="mt-2 text-sm text-white/70">
          Your current session{" "}
          <span className="text-white">“{title}”</span> is saved with{" "}
          <span className="text-white">
            {sceneCount} scene{sceneCount === 1 ? "" : "s"}
          </span>
          . The next paint will go into a fresh journal entry.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="min-h-[40px] rounded-full border border-white/15 bg-white/5 px-4 py-2 text-sm text-white/85 hover:bg-white/10"
            data-testid="new-session-cancel"
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            className="min-h-[40px] rounded-full border border-emerald-400/40 bg-emerald-500/30 px-4 py-2 text-sm font-medium text-emerald-100 hover:bg-emerald-500/40"
            data-testid="new-session-confirm-btn"
          >
            New session
          </button>
        </div>
      </div>
    </div>
  );
}

// QA4: tiny confirm dialog for the recovery banner's Discard
// button. Previously this used window.confirm which is hostile
// on mobile Safari (blocks the JS thread, can be dismissed by
// tapping outside the dialog, breaks the visual flow). Reuses
// the same in-app modal pattern as NewSessionConfirmModal.
function ConfirmDialog({
  title,
  message,
  confirmLabel,
  onConfirm,
  onCancel,
  destructive = false,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  destructive?: boolean;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<Element | null>(null);
  useEffect(() => {
    if (typeof document === "undefined") return;
    previousFocusRef.current = document.activeElement;
    confirmRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { e.preventDefault(); onCancel(); return; }
      if (e.key !== "Tab") return;
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (active === cancelRef.current) {
          e.preventDefault();
          confirmRef.current?.focus();
        }
      } else {
        if (active === confirmRef.current) {
          e.preventDefault();
          cancelRef.current?.focus();
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      const prev = previousFocusRef.current as HTMLElement | null;
      if (prev && typeof prev.focus === "function") {
        try { prev.focus(); } catch { /* unmounted */ }
      }
    };
  }, [onCancel]);
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-6 backdrop-blur"
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-[#0a0a14]/95 p-5 text-white shadow-2xl">
        <h2 id="confirm-dialog-title" className="text-base font-semibold text-white">{title}</h2>
        <p className="mt-2 text-sm text-white/70">{message}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="min-h-[40px] rounded-full border border-white/15 bg-white/5 px-4 py-2 text-sm text-white/85 hover:bg-white/10"
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            className={
              destructive
                ? "min-h-[40px] rounded-full border border-red-400/40 bg-red-500/30 px-4 py-2 text-sm font-medium text-red-100 hover:bg-red-500/40"
                : "min-h-[40px] rounded-full border border-emerald-400/40 bg-emerald-500/30 px-4 py-2 text-sm font-medium text-emerald-100 hover:bg-emerald-500/40"
            }
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// QA4: keyboard-shortcuts overlay. Toggled by pressing "?"
// anywhere in the world surface (ignored on the Begin overlay
// because the world isn't active yet). Lists every shortcut
// we ship, grouped by context.
const SHORTCUT_GROUPS: Array<{ title: string; items: Array<[string, string]> }> = [
  {
    title: "World",
    items: [
      ["W / A / S / D", "Walk forward / left / back / right"],
      ["↑ ↓ ← →", "Walk (arrow keys)"],
      ["Q / E", "Look left / right"],
      ["Space", "Pause / resume the world"],
      ["Shift", "Hold to walk faster"],
    ],
  },
  {
    title: "Voice",
    items: [
      ["Mic button", "Mute / unmute the mic"],
      ["Tap-and-hold on mobile", "Push-to-talk instead of auto-listen"],
    ],
  },
  {
    // QA12/F10: keyboard-driven director cycling.
    title: "Director",
    items: [
      ["D", "Cycle cinema style (next)"],
      ["Shift + D", "Cycle cinema style (previous)"],
      ["N", "Cycle time / weather variant (next)"],
      ["Shift + N", "Cycle time / weather variant (previous)"],
      ["0", "Clear director look"],
    ],
  },
  {
    title: "Journal",
    items: [
      ["☰", "Open the saved-scenes sidebar"],
      ["?", "Show / hide this shortcuts panel"],
      ["Esc", "Close any open dialog"],
    ],
  },
];

function ShortcutsModal({ onClose }: { onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<Element | null>(null);
  useEffect(() => {
    if (typeof document === "undefined") return;
    previousFocusRef.current = document.activeElement;
    closeRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
    }
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      const prev = previousFocusRef.current as HTMLElement | null;
      if (prev && typeof prev.focus === "function") {
        try { prev.focus(); } catch { /* unmounted */ }
      }
    };
  }, [onClose]);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="shortcuts-title"
      data-testid="shortcuts-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6 backdrop-blur"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-[#0a0a14]/95 p-5 text-white shadow-2xl">
        <h2 id="shortcuts-title" className="text-base font-semibold text-white">
          Keyboard shortcuts
        </h2>
        <p className="mt-1 text-xs text-white/55">
          Press <kbd className="rounded border border-white/15 bg-white/5 px-1.5 py-0.5 font-mono text-[10px]">?</kbd> any time to bring this back.
        </p>
        <div className="mt-4 space-y-4">
          {SHORTCUT_GROUPS.map((g) => (
            <div key={g.title}>
              <p className="text-[10px] uppercase tracking-wider text-white/45">{g.title}</p>
              <dl className="mt-1.5 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1.5 text-xs">
                {g.items.map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt>
                      <kbd className="rounded border border-white/15 bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-white/85">
                        {k}
                      </kbd>
                    </dt>
                    <dd className="text-white/70">{v}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
        <div className="mt-5 flex justify-end">
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="min-h-[40px] rounded-full border border-white/15 bg-white/5 px-4 py-2 text-sm text-white/85 hover:bg-white/10"
            data-testid="shortcuts-close"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// QA4: First-run onboarding hint. Shown the first time the
// user visits Dream; the dismissal is persisted in
// localStorage so the Begin overlay stays clean on subsequent
// visits. The steps are platform-aware: mobile users see
// voice + tilt, desktop users see keyboard + text.
function FirstRunHint() {
  const [visible, setVisible] = useState(false);
  const platform = usePlatform();
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      if (window.localStorage.getItem("lingbot.hint.seen.v1") === "1") return;
    } catch {
      return; // localStorage blocked; skip the hint rather than crash.
    }
    setVisible(true);
  }, []);
  if (!visible) return null;
  const isMobile = platform.isMobile;
  const steps = isMobile
    ? [
        "Tap Begin, then allow microphone + motion.",
        "Tilt your phone to look around; speak to change the world.",
        "Tap ☰ to revisit or replay any saved scene.",
      ]
    : [
        "Tap Begin. A first scene paints itself.",
        "Use W A S D or arrow keys to walk; Q / E to look.",
        "Tap ☰ to browse the journal, or press ? for all shortcuts.",
      ];
  return (
    <div
      data-testid="first-run-hint"
      className="mx-auto mt-4 w-full max-w-sm rounded-2xl border border-white/10 bg-white/5 p-3 text-left text-xs text-white/75 backdrop-blur"
    >
      <p className="mb-2 text-[10px] uppercase tracking-wider text-white/45">
        First time here?
      </p>
      <ol className="space-y-1.5">
        {steps.map((s, i) => (
          <li key={i} className="flex gap-2">
            <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-white/10 text-[10px] font-semibold text-white/85">
              {i + 1}
            </span>
            <span className="flex-1 leading-snug">{s}</span>
          </li>
        ))}
      </ol>
      <button
        type="button"
        onClick={() => {
          try { window.localStorage.setItem("lingbot.hint.seen.v1", "1"); } catch { /* ignore */ }
          setVisible(false);
        }}
        data-testid="first-run-dismiss"
        className="mt-3 w-full rounded-full border border-white/15 bg-white/5 py-1.5 text-xs text-white/85 hover:bg-white/10"
      >
        Got it
      </button>
    </div>
  );
}

// A surface that picks its controls by platform:
//   - desktop  → keyboard + mouse + text input. Default scene paints
//                itself on connect so the screen is never black.
//   - mobile   → gyroscope + voice. Mic auto-arms, scene starts on
//                the first spoken phrase.
function DreamSurface() {
  const { status, connect, disconnect, lastError } = useLingbot();
  const platform = usePlatform();
  const motion = useMotion();
  const voice = useVoice();
  const sessions = useSessions();
  const [hasBegun, setHasBegun] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [vrMode, setVrMode] = useState(false);
  const [pruneToast, setPruneToast] = useState<string | null>(null);
  // QA12/F10: Director keyboard shortcut toast. Shows
  // "Director: noir" for 1.2s after D/N/0.
  const [directorToast, setDirectorToast] = useState<string | null>(null);
  const directorToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showDirectorToast = useCallback((msg: string) => {
    setDirectorToast(msg);
    if (directorToastTimer.current) clearTimeout(directorToastTimer.current);
    directorToastTimer.current = setTimeout(() => setDirectorToast(null), 1200);
  }, []);
  // QA4: ? opens the keyboard-shortcuts overlay. Dismissed
  // with Escape or by tapping outside. Available on every
  // platform because mobile users with bluetooth keyboards
  // (iPad Pro etc.) benefit too.
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // QA2: replace window.confirm with a custom in-app modal.
  // Mobile Safari's native confirm blocks the JS thread, can be
  // dismissed by tapping outside the dialog, and breaks the
  // app's visual flow. The custom modal matches the design
  // language and is keyboard / focus-trap friendly.
  const [newSessionConfirm, setNewSessionConfirm] = useState<{
    title: string;
    sceneCount: number;
  } | null>(null);

  // QA4: separate state for the recovery-banner's Discard
  // confirmation. Was previously window.confirm which is
  // hostile on mobile Safari.
  const [recoveryDiscardConfirm, setRecoveryDiscardConfirm] = useState(false);

  // Show a non-blocking toast when localStorage is full and we prune.
  // Deduped: ignore further increments while a toast is already
  // showing, so a permanently-over-quota user doesn't get a fresh
  // toast every save. (Audit bug #22.)
  useEffect(() => {
    // QA5: snapshot the pruneNotice at the moment the toast
    // appears so the user sees "pruned N sessions" rather
    // than a single deduped message. The previous behavior
    // hid subsequent prunes behind a single "oldest
    // sessions" toast — users had no idea their second or
    // third prune happened.
    if (sessions.pruneNotice > 0 && !pruneToast) {
      const n = sessions.pruneNotice;
      setPruneToast(
        n === 1
          ? "Storage full — pruned oldest saved session."
          : `Storage full — pruned ${n} oldest saved sessions.`,
      );
      const t = setTimeout(() => setPruneToast(null), 4000);
      return () => clearTimeout(t);
    }
  }, [sessions.pruneNotice, pruneToast]);

  // QA4: ? opens the shortcuts overlay. Also Escape closes it
  // when it's the only open modal. We keep this listener at
  // the surface level so it doesn't fire on the Begin overlay
  // (where there's no "world" yet to act on).
  useEffect(() => {
    if (!hasBegun) return;
    function onKey(e: KeyboardEvent) {
      // Ignore key combos with modifiers so we don't steal
      // browser shortcuts.
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // Don't intercept while the user is typing in any
      // text input. Same rules as the desktop controller.
      const t = e.target as HTMLElement | null;
      if (t) {
        const tag = t.tagName ?? "";
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        if (t.isContentEditable) return;
        if (t.getAttribute?.("role") === "textbox") return;
      }
      // ? or Shift+/
      if (e.key === "?" || (e.key === "/" && e.shiftKey)) {
        e.preventDefault();
        setShortcutsOpen((v) => !v);
        return;
      }
      // QA12/F10: Director keyboard shortcuts.
      //   D / Shift+D → cycle style forward/backward
      //   N / Shift+N → cycle variant forward/backward
      //   0           → reset to no look
      if (e.key === "d" || e.key === "D") {
        e.preventDefault();
        const next = cycleStyle(e.shiftKey ? -1 : 1);
        if (next) showDirectorToast(`Director: ${next}`);
        return;
      }
      if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        const next = cycleVariant(e.shiftKey ? -1 : 1);
        if (next) showDirectorToast(`Variant: ${next}`);
        return;
      }
      if (e.key === "0") {
        e.preventDefault();
        resetDirector();
        showDirectorToast("Director: cleared");
        return;
      }
      if (e.key === "Escape" && shortcutsOpen) {
        e.preventDefault();
        setShortcutsOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hasBegun, shortcutsOpen]);

  // QA14/F12: Time-of-day auto-shift. The first time the
  // world mounts, set the Director variant to match the
  // user's local clock so the cinema filter tints
  // accordingly (golden hour at dusk, night at 11pm).
  // We only fire on the rising edge of `hasBegun` (so a
  // user who picks a chip afterwards isn't overridden).
  // Disabled on VR (no Director visible). Stored under a
  // ref so the rising-edge detection is stable across
  // re-renders.
  const lastAutoShiftedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!hasBegun) return;
    if (lastAutoShiftedRef.current !== null) return;
    lastAutoShiftedRef.current = "applied";
    const band = timeBandForNow();
    const variant = variantIdForBand(band);
    const current = getDirectorState();
    // Only override if the user hasn't already picked a
    // variant (the chip owner is the source of truth).
    if (current.variantId === null) {
      setDirectorState({ variantId: variant });
      if (band !== "none") {
        // Show a brief violet toast so the user knows the
        // shift is intentional (not a bug).
        showDirectorToast(`Auto-shifted to ${labelForBand(band)}`);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasBegun]);

  const handleBegin = useCallback(async () => {
    // QA16: drop the second tap of a double-tap. Clear the
    // gate on the *next* macrotask so a user who genuinely
    // tapped twice (one Begin, one "did it work?") gets
    // through eventually — but a single double-fire from
    // iOS Safari doesn't burn a second connect.
    if (beginInflightRef.current) return;
    beginInflightRef.current = true;
    setTimeout(() => {
      beginInflightRef.current = false;
    }, 500);
    if (platform.isMobile) {
      // QA6: AWAIT the iOS motion permission prompt.
      // Previously `void motion.requestPermission()` ran
      // fire-and-forget and `setHasBegun(true)` flipped
      // immediately, dropping the user into the world
      // before the native prompt resolved. On iOS this
      // meant the prompt was sometimes never shown (the
      // app's gesture was already consumed by the Begin
      // tap) and the user got the world with no gyroscope
      // and no way to re-prompt. Now we await the result
      // and only then flip hasBegun. On Android (no
      // requestPermission API), `motion.permission` is
      // already "granted" or "unsupported" so the await
      // resolves immediately.
      if (motion.permission === "default") {
        try {
          await motion.requestPermission();
        } catch {
          // Permission dialog threw — fall through and
          // let the user start the world anyway. They can
          // re-enable motion later in browser settings.
        }
      }
      if (voice.supported && !voice.listening) {
        try {
          voice.start();
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn("[dream] voice.start() during Begin:", e);
        }
      }
      if (typeof screen !== "undefined" && "orientation" in screen) {
        try {
          (screen.orientation as any).lock?.("portrait");
        } catch {
          // iOS Safari throws on user-preference locks; harmless.
        }
      }
    }
    setHasBegun(true);
    if (status === "disconnected") {
      void connect();
    }
    // Daily Dream auto-pick: on a fresh device (no saved sessions),
    // surface today's curated scene so the user sees something
    // interesting the moment they tap Begin. Skip if there's a share
    // URL in flight (readDreamFromUrl takes precedence) or if the
    // user has saved sessions they'd prefer to revisit.
    if (sessions.hydrated && sessions.sessions.length === 0) {
      if (typeof window !== "undefined" && !window.location.search.includes("d=")) {
        const dream = dailyDream();
        // QA16: store the pending scene in a module-level slot
        // the Dream surface will drain on mount. This replaces
        // the 200ms setTimeout hack, which dropped the emit on
        // slow phones where the listener took >200ms to attach.
        // The slot is shared between LingbotApp (which fills it
        // from the Begin tap) and VoiceDream/DesktopDream
        // (which drain it on first render).
        const id = sessions.createSession({
          title: dailyDreamTitle(),
          seed: { prompt: dream.prompt, seed: dream.seed },
        });
        void id;
        pendingDailyScene = { prompt: dream.prompt, seed: dream.seed };
        // Fire now too — if the listener is already attached,
        // great. If not, the Dream surface will drain the slot
        // on mount and re-emit.
        dreamBus.emit("dream:loadScene", { prompt: dream.prompt, seed: dream.seed });
      }
    }
    // Depend on stable primitives only. `motion` and `voice` are objects
    // whose identity changes per render; pinning them caused
    // handleBegin to be a new function every render, which forced the
    // Begin button to re-render and re-bind listeners unnecessarily.
  }, [
    platform.isMobile,
    motion.permission,
    motion.requestPermission,
    voice.supported,
    voice.listening,
    voice.start,
    status,
    connect,
    sessions.hydrated,
    sessions.sessions.length,
    sessions.createSession,
  ]);

  // QA5: keep a ref to the in-flight teardown so a rapid
  // double-tap of the Reset button doesn't kick off two
  // parallel teardowns. Whichever loses the race is a
  // no-op.
  const resetInflightRef = useRef<Promise<void> | null>(null);
  // QA16: de-duplicate rapid Begin taps. iOS Safari can
  // double-fire a click after the first paint of the overlay,
  // especially when the user double-taps. Without this, two
  // connect() calls race each other — the second call enters
  // while the SDK is already mid-connect, drops us into an
  // undefined ready state, and the user sees the Begin overlay
  // stuck even though hasBegun is true.
  const beginInflightRef = useRef(false);
  const handleReset = useCallback(() => {
    // Order matters: await the voice teardown BEFORE disconnect so
    // the SDK teardown doesn't race the recogniser's audio handle.
    // Without the await, a slow Android Chrome can hand a still-
    // active mic to the next voice.start() and produce a
    // `NotAllowedError` (audit bug #17).
    if (resetInflightRef.current) return;
    const teardown = async () => {
      try {
        if (platform.isMobile) {
          try {
            await voice.stop();
          } catch {
            // best-effort
          }
          voice.reset();
        }
        try {
          await disconnect();
        } catch {
          // best-effort
        }
      } finally {
        // Always advance the Begin overlay, even if a step
        // threw, otherwise the user is stuck on a black
        // screen with no way back.
        setHasBegun(false);
        resetInflightRef.current = null;
      }
    };
    resetInflightRef.current = teardown();
  }, [disconnect, voice.stop, voice.reset, platform.isMobile]);

  // Auto-retry once on transient disconnect (hackathon wifi is flaky).
  // The previous version reset `reconnectingRef.current = false` in
  // the cleanup path, which fired on every dep change. If `status`
  // flipped `disconnected → connecting` mid-timeout, the cleanup
  // cleared the ref and a subsequent disconnect would refire the
  // reconnect — breaking the "one reconnect per disconnect" guarantee.
  // We now only clear the ref on success (status → ready) or on
  // explicit hasBegun change.
  const reconnectingRef = useRef(false);
  // QA16: cap total retries across a session to 2 — once on
  // the first disconnect, once on a second. After that, the
  // user must hit Begin again. Without this, a flaky network
  // cycles disconnected → connecting → disconnected forever
  // and burns Reactor credits on each cycle. Reset to 0 on
  // a successful ready transition.
  const retryCountRef = useRef(0);
  // QA15 fix: surface a visible "Reconnecting…" pill so the user
  // can tell the app is doing something instead of appearing to
  // hang. Boolean so the overlay can show a spinner next to the
  // amber dot.
  const [autoRetrying, setAutoRetrying] = useState(false);
  useEffect(() => {
    if (status === "ready") {
      // Successful transition — allow a future disconnect to retry.
      reconnectingRef.current = false;
      retryCountRef.current = 0;
      setAutoRetrying(false);
      return;
    }
    if (status !== "disconnected" || !hasBegun || !lastError) {
      setAutoRetrying(false);
      return;
    }
    // QA15 fix: never auto-retry on a classified terminal error.
    // For auth/credits/quota failures the next Begin tap (with a
    // fresh BYOK key paste) is the only correct path; a silent
    // 1.5s retry would race the user and burn their new key with
    // the same broken state. We let `handleReset` clear the
    // error before the user can begin again.
    const classified = classifyReactorError(lastError.message);
    if (
      classified.reason === "credits_depleted" ||
      classified.reason === "auth" ||
      classified.reason === "rate_limited" ||
      classified.reason === "service_unavailable"
    ) {
      setAutoRetrying(false);
      return;
    }
    if (reconnectingRef.current) return;
    // QA16: hard cap. We also bail if lastError flipped to a
    // non-error message in the meantime (e.g. SDK transient
    // state update cancelled the retry mid-flight).
    if (retryCountRef.current >= 2) {
      setAutoRetrying(false);
      return;
    }
    reconnectingRef.current = true;
    retryCountRef.current += 1;
    setAutoRetrying(true);
    // QA16: exponential backoff with jitter — 1.5s, 3s, then
    // bail. The cap above stops the third attempt.
    const delay = 1500 * 2 ** (retryCountRef.current - 1);
    const jitter = Math.floor(Math.random() * 250);
    const t = setTimeout(() => {
      void connect();
    }, delay + jitter);
    return () => {
      clearTimeout(t);
      // Don't clear `autoRetrying` here — the effect's cleanup
      // fires on every dependency change, including status flips,
      // which is exactly when we want the pill to stay visible.
      // We clear it only when the user reaches `ready` (above) or
      // a classified terminal error trips (above).
    };
  }, [status, hasBegun, lastError, connect]);

  // M9.11: "stuck" detection — if the SDK is taking longer than 8s
  // to either connect or surface an error, give the user an escape
  // hatch to manually rotate to a fresh key. This is the proactive
  // counterpart to the 402 error screen's "Try a different key"
  // button — for the case where the API isn't returning a
  // classified error at all, just hanging.
  //
  // QA15 fix: the previous implementation restarted the 8s clock
  // on every status flip (disconnected → connecting → disconnected
  // is the exact pattern for flaky wifi). Now we use a
  // connectingSinceRef deadline computed from wall-clock time,
  // so the user surfaces "Try a different key" on a single
  // uninterrupted 8s of stuck-ness, regardless of how many
  // SDK transitions happen inside that window.
  //
  // QA16 fix: the QA15 fix had its own bug — the cleanup
  // branch (status reaching "ready" or user backing out) was
  // the ONLY place that nulled connectingSinceRef. But the
  // re-entry branch at the top of the effect was guarded by
  // `connectingSinceRef.current === null`, so once the timer
  // fired and the effect re-ran (because status changed), the
  // new run would not see null and would re-use the SAME
  // ref, which is correct — except that the previous run's
  // cleanup ALSO touched the ref in the "successful" path,
  // racing the new run. The observed bug: a slow SDK that
  // does disconnected → connecting → disconnected →
  // connecting resets the 8s clock on each disconnected
  // (because the "no progress" reset path was looking at
  // `status !== isConnectingLike` and that branch was
  // unreachable from the effect itself). The fix is to
  // only reset on terminal outcomes, and let the
  // connectingSinceRef persist across re-runs.
  const connectingSinceRef = useRef<number | null>(null);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    // First — terminal outcomes clear the clock.
    if (status === "ready" || !hasBegun) {
      connectingSinceRef.current = null;
      setStuck(false);
      return;
    }
    const isConnectingLike =
      status === "connecting" || status === "waiting" || status === "disconnected";
    if (!isConnectingLike) {
      // Some other state (e.g. "error") — don't trip the
      // stuck detector, the error pill is doing that work.
      // But also don't reset the clock, because the SDK
      // may soon return to "connecting" and the 8s window
      // should keep ticking from the original disconnect.
      return;
    }
    // Start the clock the first time we enter a
    // connecting-like state, then keep using the same
    // deadline across re-runs.
    if (connectingSinceRef.current === null) {
      connectingSinceRef.current = Date.now();
    }
    const start = connectingSinceRef.current;
    const t = setTimeout(() => {
      // Only trip if the ref is still pointing at the same
      // start instant (i.e. we haven't been cleared by a
      // terminal outcome in the meantime).
      if (connectingSinceRef.current === start) {
        setStuck(true);
      }
    }, 8000);
    return () => clearTimeout(t);
  }, [status, hasBegun]);

  // QA6/F1: REM Drift. When the world goes quiet for 12s and
  // the user has spoken at least one prompt, auto-paint a
  // mashed-up "REM cycle" prompt. This makes the demo legible
  // to a passive observer — the world keeps mutating even when
  // the user stops talking. Paused while the user is actively
  // recording voice (voice.listening === true).
  const remPaused =
    !hasBegun ||
    status !== "ready" ||
    (platform.isMobile && voice.listening);
  // QA6/F3: Sound World. Procedural WebAudio ambient that
  // tracks the current scene's prompt. The hook is a
  // no-op until the user taps the sound toggle (browser
  // autoplay policy: AudioContext can only be created
  // inside a user gesture).
  const ambient = useAmbient({
    enabled: hasBegun,
    paused: vrMode,
  });
  useRemDrift({
    paused: remPaused,
    onDrift: (remPrompt) => {
      // Route through the same loadScene path the rest of the
      // app uses. The bus listener on VoiceDream/DesktopDream
      // picks it up and calls paintDream.
      dreamBus.emit("dream:loadScene", { prompt: remPrompt, seed: Math.floor(Math.random() * 0x7fffffff) });
      // Brief toast so the user knows the dream drifted on
      // its own (some users find this uncanny).
      dreamBus.emit("dream:toast", {
        kind: "info",
        message: "Your dream drifted…",
        ttlMs: 2500,
      });
    },
  });

  const onTryDifferentKey = useCallback(() => {
    // M9.8 bust flag + reconnect. The cached 6-hour JWT (if any) is
    // skipped, so the SDK mints a fresh token from the next healthy
    // key in the M9.7 server pool.
    bustNextToken();
    void connect();
  }, [connect]);

  // Before Begin: friendly landing overlay.
  //
  // M9.14: the prior versions oscillated between pure black (M9.6,
  // which the user eventually complained was too dark) and the
  // multi-stop aurora (M8.4-M9.5, which they called "very shit").
  // The middle ground: a single soft warm radial gradient on a
  // dark-but-not-black base. The eye gets a gentle sun-like glow
  // at the center (matching the "sunlit alpine meadow" default
  // scene the app launches into), the corners stay dark enough
  // that the white headline pops. No animated aurora — the user
  // found that noisy. No pure black — they found that a void.
  if (!hasBegun) {
    return (
      <main className="relative grid min-h-screen place-items-center overflow-hidden bg-[#0a0a14] p-6 text-white">
        <div
          className="pointer-events-none absolute inset-0"
          aria-hidden="true"
          data-testid="begin-warmth"
          style={{
            background:
              "radial-gradient(ellipse at 50% 35%, rgba(253,224,150,0.18) 0%, rgba(244,114,182,0.06) 35%, rgba(10,10,20,0) 70%)",
          }}
        />
        {/* Recovery banner — surfaces if the previous storage blob was
            unreadable. Gives the user a chance to restore before we
            silently lose the journal. (Audit bug #30.)
            The × button now requires a confirm tap before discarding
            so the user doesn't accidentally nuke their recoverable
            data with a single misclick. */}
        {sessions.recoveryNotice && (
          <div
            role="alert"
            aria-live="assertive"
            className="fixed inset-x-3 top-3 z-50 flex justify-center"
          >
            <div className="flex max-w-md items-center gap-3 rounded-2xl border border-amber-400/40 bg-amber-500/15 px-4 py-3 text-xs text-amber-100 shadow-2xl backdrop-blur">
              <span className="flex-1">
                We couldn't read your saved journal. The last snapshot was
                preserved — tap Restore to bring it back.
              </span>
              <button
                type="button"
                onClick={() => setRecoveryDiscardConfirm(true)}
                className="rounded-full border border-amber-400/30 px-3 py-1 text-amber-100 hover:bg-amber-500/20"
                data-testid="recovery-discard-btn"
              >
                Discard
              </button>
              <RestoreButton sessions={sessions} />
            </div>
          </div>
        )}
        <div className="max-w-sm text-center">
          <h1 className="text-2xl font-semibold tracking-tight">
            Speak your dream into the world.
          </h1>
          {/* QA5/F3: time-of-day greeting. The previous Begin
              overlay said the same thing every time, so
              returning users got the same wall of text. Now
              the greeting is contextual — "Good morning" at
              6am, "Late-night" after 11pm — and the empty-
              state's first prompt rotates based on the hour
              so each new session gets a fresh suggestion. */}
          {(() => {
            const h = new Date().getHours();
            const greeting =
              h < 5
                ? "Late night"
                : h < 12
                  ? "Good morning"
                  : h < 17
                    ? "Good afternoon"
                    : h < 21
                      ? "Good evening"
                      : "Late night";
            const suggestion =
              h < 12
                ? "Try: a misty forest at sunrise"
                : h < 17
                  ? "Try: a Tokyo rooftop in the rain"
                  : h < 21
                    ? "Try: a desert canyon at sunset"
                    : "Try: a neon-lit alley at midnight";
            return (
              <div className="mt-2 flex flex-col items-center gap-1">
                <p
                  className="text-[10px] uppercase tracking-[0.2em] text-white/45"
                  data-testid="begin-greeting"
                >
                  {greeting}
                </p>
                <p className="text-[11px] text-white/55">{suggestion}</p>
              </div>
            );
          })()}
          <p className="mt-2 text-sm text-white/60">
            {platform.isDesktop
              ? "A first scene paints itself. Then describe a new dream, or walk with W A S D and look with the mouse."
              : "Say a scene out loud. Tilt to walk through it. Every phrase you speak mutates the world in place."}
          </p>
          {/* Daily Dream — a deterministic curated pick from today's
              date. Surfaces as a "today's pick" chip below the
              description so the user knows what they'll see first. */}
          {sessions.sessions.length === 0 && (
            <div className="mt-5 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1.5 text-[11px] text-white/80">
              <span aria-hidden="true">☀</span>
              <span>
                Today's dream · {dailyDream().emoji} {dailyDream().id.replace(/-/g, " ")}
              </span>
            </div>
          )}
          {sessions.sessions.length > 0 && (
            <p className="mt-2 text-xs text-emerald-300">
              {sessions.sessions.length} saved dream{sessions.sessions.length === 1 ? "" : "s"} on this device.
            </p>
          )}
          {/* QA3: recent prompts as scrollable chips. Tapping a
              chip starts a session and re-uses that prompt. */}
          <PromptHistoryChips
            prompts={sessions.recentPrompts()}
            onPick={({ prompt, seed }) => {
              sessions.createSession({ title: prompt.slice(0, 60), seed: { prompt, seed } });
              setHasBegun(true);
              if (status === "disconnected") void connect();
              // QA11/BUG-9: defer the loadScene emit so the
              // VoiceDream / DesktopDream component has time
              // to mount its bus listener. Without this, the
              // first chip tap on the Begin overlay emits to
              // zero listeners and the world stays black.
              // 200ms matches the daily-dream path below.
              setTimeout(() => {
                dreamBus.emit("dream:loadScene", { prompt, seed });
              }, 200);
            }}
          />
          <button
            onClick={handleBegin}
            data-testid="begin-btn"
            className="mt-8 inline-flex items-center gap-2 rounded-full bg-white px-6 py-3 text-sm font-medium text-black hover:bg-white/90"
          >
            Begin
          </button>
          {/* QA4: First-run hint. Shown only the first time the
              user visits; dismissed permanently via
              localStorage. Three numbered steps walk through
              the basic flow. Skipping on subsequent visits
              keeps the Begin overlay clean for repeat users. */}
          <FirstRunHint />
          <ByokKeyField />
          <BlackScreenMemoryChip />
          <p className="mt-6 text-[10px] uppercase tracking-wider text-white/40">
            Powered by Reactor · LingBot
          </p>
        </div>
      </main>
    );
  }

  // Top bar + sidebar are hoisted here so they remain reachable on
  // every post-Begin state — including the connecting-error overlay.
  // Before this fix, when Reactor returned 402 (credits_depleted) the
  // early-return for status==="disconnected" hid the entire topbar,
  // so the user had no way to open the journal, start a new session,
  // or load a previously-painted scene while offline. The sidebar
  // works offline because sessions live in localStorage.
  const topbar = !vrMode ? (
    <>
      <div className="pointer-events-none fixed inset-x-0 top-0 z-20 flex items-start justify-between gap-3 p-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <div className="pointer-events-auto flex flex-col items-start gap-2">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setSidebarOpen(true)}
              aria-label="Open saved sessions"
              data-testid="sessions-btn"
              className="grid h-10 w-10 place-items-center rounded-full border border-white/10 bg-black/40 text-white/80 backdrop-blur hover:bg-black/60"
            >
              ☰
            </button>
            {/* QA4: ? opens the keyboard-shortcuts overlay.
                Available on every platform — mobile users with
                bluetooth keyboards (iPad Pro etc.) benefit
                from the same shortcut list. */}
            <button
              type="button"
              onClick={() => setShortcutsOpen(true)}
              aria-label="Show keyboard shortcuts"
              data-testid="shortcuts-btn"
              className="grid h-10 w-10 place-items-center rounded-full border border-white/10 bg-black/40 text-xs text-white/80 backdrop-blur hover:bg-black/60"
            >
              ?
            </button>
            {/* QA6/F3: Sound World toggle. The ambient bed
                stays off until the user opts in (browser
                autoplay policy). When on, the audio layer
                matches the current scene's prompt and
                crossfades on scene change. */}
            <button
              type="button"
              onClick={() => ambient.toggle()}
              aria-label={ambient.isOn ? "Mute ambient sound" : "Play ambient sound"}
              aria-pressed={ambient.isOn}
              data-testid="ambient-toggle"
              data-ambient-on={ambient.isOn ? "true" : "false"}
              className={[
                "grid h-10 w-10 place-items-center rounded-full border text-xs backdrop-blur transition-colors",
                ambient.isOn
                  ? "border-emerald-300/40 bg-emerald-400/20 text-emerald-100 hover:bg-emerald-400/30"
                  : "border-white/10 bg-black/40 text-white/80 hover:bg-black/60",
              ].join(" ")}
            >
              {ambient.isOn ? "🔊" : "🔇"}
            </button>
            <StatusBadge />
          </div>
          <CommandError />
          {platform.isMobile && motion.permission === "denied" && (
            <p
              role="status"
              aria-live="polite"
              className="rounded-full border border-white/10 bg-black/70 px-3 py-1 text-[10px] text-white/70 backdrop-blur"
            >
              Motion: off — use the D-pad below
            </p>
          )}
          {platform.isMobile && motion.permission === "unsupported" && (
            <p
              role="status"
              aria-live="polite"
              className="rounded-full border border-white/10 bg-black/70 px-3 py-1 text-[10px] text-white/70 backdrop-blur"
            >
              Motion not supported on this device
            </p>
          )}
        </div>
        <div className="pointer-events-auto flex flex-wrap items-center justify-end gap-2">
          {/* M9.15: visible active-session chip. The user reported
              "I am continuing on that session until I start a new
              session completely" — they had no visual cue for which
              session they were in. The chip shows the active session's
              title (or "Untitled" if no scenes yet) so the user can
              confirm at a glance which journal the next paint will
              land in. Tapping the chip opens the sidebar. */}
          {sessions.activeSession && (
            <button
              type="button"
              onClick={() => setSidebarOpen(true)}
              data-testid="active-session-chip"
              // QA11/A11Y-14: replaced `title` with
              // `aria-label` so screen readers announce
              // the full context. `title` is hover-only
              // and most SRs ignore it.
              aria-label={`Currently editing ${sessions.activeSession.title}, ${sessions.activeSession.scenes.length} ${sessions.activeSession.scenes.length === 1 ? "scene" : "scenes"}. Tap to open sidebar.`}
              className="min-h-[40px] rounded-full border border-white/15 bg-white/10 px-3 py-1.5 text-xs text-white/85 backdrop-blur hover:bg-white/15"
            >
              <span className="text-white/55" aria-hidden="true">● </span>
              {sessions.activeSession.title}
              <span className="ml-1.5 text-white/45" aria-hidden="true">
                · {sessions.activeSession.scenes.length}
              </span>
            </button>
          )}
          <button
            onClick={() => {
              // "New session" — keep the current world running, just
              // start a fresh journal entry. The next paint goes into
              // the new session.
              // M9.15: confirm before discarding in-progress scenes.
              // The user has been surprised by taps creating new
              // sessions silently. A short confirm prompt catches
              // accidental taps (especially on mobile where the
              // button is in the top-right reach).
              // QA2: replaced window.confirm with an in-app modal —
              // mobile Safari's native confirm is hostile (blocks
              // the thread, breaks the design language, can be
              // dismissed by tapping outside).
              const sceneCount = sessions.activeSession?.scenes.length ?? 0;
              if (sceneCount > 0) {
                setNewSessionConfirm({
                  title: sessions.activeSession?.title ?? "Untitled session",
                  sceneCount,
                });
                return;
              }
              sessions.createSession();
            }}
            aria-label="Start a new session"
            data-testid="new-session-btn"
            className="min-h-[40px] rounded-full border border-emerald-400/40 bg-emerald-500/20 px-3 py-1.5 text-xs font-medium text-emerald-100 backdrop-blur hover:bg-emerald-500/30"
          >
            {platform.isMobile ? "+ New session" : "+ New session"}
          </button>
          <button
            onClick={handleReset}
            aria-label="Start over"
            data-testid="reset-btn"
            className="min-h-[40px] rounded-full border border-white/10 bg-black/40 px-3 py-1.5 text-xs text-white/80 backdrop-blur hover:bg-black/60"
          >
            {platform.isMobile ? "↻" : "Reset"}
          </button>
          {platform.isMobile && (
            <button
              onClick={() => setVrMode(true)}
              aria-label="Enter VR mode"
              data-testid="vr-btn"
              className="grid h-10 w-10 place-items-center rounded-full border border-violet-400/40 bg-violet-500/20 text-base text-violet-100 backdrop-blur hover:bg-violet-500/30"
            >
              ◐
            </button>
          )}
        </div>
      </div>
    </>
  ) : null;

  const sidebar = (
    <SessionSidebar
      open={sidebarOpen}
      onClose={() => setSidebarOpen(false)}
      onSelectScene={(sessionId, sceneId) => {
        // Painting a specific past scene = re-running its prompt.
        const s = sessions.sessions.find((x) => x.id === sessionId);
        const sc = s?.scenes.find((x) => x.id === sceneId);
        if (sc) {
          // First, ask any in-flight paint to short-circuit so the
          // in-progress scene doesn't end up in the wrong journal
          // entry after `setActive` flips the active session.
          dreamBus.emit("dream:abortPaint", {});
          sessions.setActive(sessionId);
          // The Dream component re-runs the last scene on active-session
          // change. We forward the prompt via a typed event bus that
          // only our own modules can emit on — no global window event
          // for browser extensions to hijack.
          dreamBus.emit("dream:loadScene", { prompt: sc.prompt, seed: sc.seed });
        }
        setSidebarOpen(false);
      }}
      onPickCurated={(s) => {
        // Curated gallery: also dispatch the same load event so the
        // current Dream component re-paints with the curated seed.
        dreamBus.emit("dream:abortPaint", {});
        dreamBus.emit("dream:loadScene", { prompt: s.prompt, seed: s.seed });
      }}
    />
  );

  // Connecting: brief overlay between Begin and Connected. We track
  // a "has begun connecting" flag so the initial 100ms post-Begin
  // render doesn't flash a "disconnected" overlay.
//
// Bug fix: this used to be a hard `bg-black` page. That read as
// "broken app" the moment a real user hit Begin, because the SDK
// takes 5-15 seconds to actually connect. We now mirror the
// Video.tsx aurora background so the user sees a beautiful animated
// gradient while waiting, not a black void.
  if (status === "disconnected" || status === "connecting" || status === "waiting") {
    // If we have a classified error (a real Reactor-side failure,
    // not just a transient blip), render the dedicated error screen.
    // The classifier turns raw JSON like
    //   "Failed to create session: 402 {\"error\":\"credits_depleted\"..."
    // into a typed reason + short message + CTA.
    const classified =
      status === "disconnected" && lastError
        ? classifyReactorError(lastError.message)
        : null;
    const isKnownError = classified && classified.reason !== "unknown";
    // Aurora is shown ONLY while the SDK is actively trying to
    // connect (no classified error). On a terminal error, fall back
    // to a quiet black surface so the user can focus on the
    // message and CTA — the design pass in M9.6 prefers that over
    // a busy gradient behind the error text.
    const showAurora = !isKnownError;
    return (
      <>
        {topbar}
        {sidebar}
        {/* M9.14: bg-black → bg-[#0a0a14] to match the Begin
            overlay's warmer base. The connecting state is a
            continuation of the Begin experience; if the base color
            changes between them, the user perceives a flash. Same
            warmer base throughout the pre-paint journey. */}
        <main className="relative grid min-h-screen place-items-center overflow-hidden bg-[#0a0a14] p-6 text-white">
          {/* Aurora background — same gradient as Video.tsx so the
              transition from connecting → playing is seamless, with
              no hard black cut. (M8.4 bug fix; only rendered while
              we're actively connecting — see showAurora above.) */}
          {showAurora && (
            <div
              className="pointer-events-none absolute inset-0 animate-[aurora-shift_18s_ease-in-out_infinite] bg-[radial-gradient(ellipse_at_top_left,rgba(99,102,241,0.55),transparent_55%),radial-gradient(ellipse_at_bottom_right,rgba(236,72,153,0.45),transparent_55%),radial-gradient(ellipse_at_top_right,rgba(34,211,238,0.40),transparent_55%),radial-gradient(ellipse_at_bottom_left,rgba(168,85,247,0.40),transparent_55%)] bg-[length:200%_200%]"
              aria-hidden="true"
              data-testid="connect-aurora"
            />
          )}
          {isKnownError && classified ? (
            <ReactorErrorScreen
              classified={classified}
              onRetry={() => void connect()}
              onBack={handleReset}
            />
          ) : (
            <div className="relative max-w-sm text-center">
              <div className="mx-auto h-2 w-2 animate-pulse rounded-full bg-amber-400" />
              <p className="mt-4 text-sm text-white/85">
                {status === "disconnected"
                  ? lastError
                    ? "Couldn't connect — try again in a moment."
                    : "Reconnecting…"
                  : status === "connecting"
                    ? "Connecting to Reactor…"
                    : "Waiting for a GPU…"}
              </p>
              <p className="mt-1 text-xs text-white/55">
                This usually takes 5–15 seconds.
              </p>
              {/* QA15: tiny inline pill so the user knows a
                  silent retry is in flight. Distinct from the
                  reconnecting text above (which covers BOTH
                  manual and auto retry). */}
              {autoRetrying && (
                <div
                  role="status"
                  aria-live="polite"
                  data-testid="auto-retry-pill"
                  className="mt-3 inline-flex items-center gap-2 rounded-full border border-amber-400/30 bg-amber-400/10 px-3 py-1 text-[11px] text-amber-200"
                >
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-300" />
                  Retrying in a moment…
                </div>
              )}
              {lastError && (
                <button
                  onClick={() => void connect()}
                  className="mt-6 rounded-full bg-white/15 px-5 py-2 text-sm font-medium text-white hover:bg-white/25"
                >
                  Try again
                </button>
              )}
              {!lastError && stuck && (
                <button
                  type="button"
                  onClick={onTryDifferentKey}
                  data-testid="connect-stuck-rotate-key"
                  className="mt-6 inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/5 px-5 py-2 text-xs font-medium text-white/85 hover:bg-white/15"
                >
                  Try a different key
                </button>
              )}
              <button
                onClick={handleReset}
                className="mt-3 block w-full text-[10px] uppercase tracking-wider text-white/45 hover:text-white/70"
              >
                Back
              </button>
            </div>
          )}
        </main>
      </>
    );
  }

  return (
    <main className="relative min-h-screen bg-black text-white">
      {topbar}
      {/* QA7/F7: Paint Trail. Shows the user's last 20
          prompts as fading pills above the action bar. */}
      {hasBegun && !vrMode && <PromptTrail />}
      {sidebar}
      <CursorEmbed />
      {/* QA9/F8: Error boundary catches render errors
          in the dream chrome (Director filter, paint
          chip) without taking down the whole app. The
          inner boundary on the Dream component catches
          paint-specific crashes so the user can still
          open the sidebar to grab their saved sessions. */}
      {/* Video fills the screen as background. */}
      <div
        className="fixed inset-0 z-0 transition-transform duration-500 ease-out"
        style={{
          // QA12/F9: Mini-Player. When the sidebar opens
          // on desktop, the world shrinks into a corner
          // so the user can keep walking while reading
          // the journal. Skipped on mobile (the bottom
          // sheet IS the journal) and in VR (where the
          // user is wearing a headset). The transform is
          // pure CSS — no re-mount, no state churn.
          transform:
            sidebarOpen && !platform.isMobile && !vrMode
              ? "translate(-72%, -72%) scale(0.28)"
              : undefined,
          transformOrigin: "top right",
        }}
        data-testid="dream-canvas"
        data-pip={sidebarOpen && !platform.isMobile && !vrMode ? "true" : "false"}
      >
        <ErrorBoundary label="Dream canvas">
          <Video />
          {/* QA6/F2: Director overlay — CSS cinema filter that
              reacts to chip clicks. Sits inside the z-0
              container so it composites with the video but
              doesn't intercept pointer events. */}
          <DirectorOverlay />
        </ErrorBoundary>
      </div>

{/* QA12/F9: "Expand" button visible only when the
          Mini-Player is active. Restores fullscreen by
          closing the sidebar. Sits in the top-right of
          the (now small) world, so the user can quickly
          jump back. */}
      {sidebarOpen && !platform.isMobile && !vrMode && hasBegun && (
        <button
          type="button"
          onClick={() => setSidebarOpen(false)}
          aria-label="Expand the dream back to fullscreen"
          title="Expand to fullscreen"
          data-testid="pip-expand-btn"
          className="fixed right-4 top-4 z-30 grid h-10 w-10 place-items-center rounded-full border border-white/15 bg-black/70 text-sm text-white/85 backdrop-blur hover:bg-black/85"
        >
          ⤢
        </button>
      )}

      {/* Virtual joystick fallback — rendered ABOVE the video and
          BELOW the top/bottom bars. Only shown on mobile when motion
          permission was denied (or is unsupported). The user can
          drag the screen to look and drag down to walk forward. */}
      {platform.isMobile &&
        !vrMode &&
        (motion.permission === "denied" || motion.permission === "unsupported") && (
          <VirtualJoystick enabled={status === "ready"} />
        )}

      {/* Bottom — voice UI on mobile, text + paint on desktop.
          Hidden in VR mode. */}
      {!vrMode && (
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-20 flex justify-center p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <div className="w-full max-w-md">
          {platform.isMobile ? <VoiceDream /> : <DesktopDream />}
        </div>
      </div>
      )}

      {/* Headless controllers — run while connected. */}
      {platform.isMobile && !vrMode ? (
        <GyroController enabled={status === "ready"} voiceListening={voice.listening} />
      ) : !platform.isMobile ? (
        <>
          <DesktopController enabled={status === "ready"} />
          <DesktopDefaultScene
            enabled={status === "ready"}
            prompt={DEFAULT_DESKTOP_PROMPT}
            hasUserScenes={(sessions.activeSession?.scenes.length ?? 0) > 0}
          />
        </>
      ) : null}

      {/* Prune toast */}
      {pruneToast && (
        <div className="pointer-events-none fixed left-1/2 top-20 z-50 -translate-x-1/2 rounded-full border border-amber-400/40 bg-amber-500/20 px-4 py-1.5 text-xs text-amber-100 shadow-lg backdrop-blur">
          {pruneToast}
        </div>
      )}

      {/* QA12/F10: Director keyboard shortcut toast.
          Sits just above the prune toast position with a
          violet tint so it reads as the Director palette. */}
      {directorToast && (
        <div
          className="pointer-events-none fixed left-1/2 top-32 z-50 -translate-x-1/2 rounded-full border border-violet-400/40 bg-violet-500/20 px-4 py-1.5 text-xs text-violet-100 shadow-lg backdrop-blur"
          role="status"
          aria-live="polite"
          data-testid="director-toast"
        >
          {directorToast}
        </div>
      )}

      {/* QA2: New-session confirm modal (replaces window.confirm).
          Rendered above all other UI; Esc and click-outside both
          dismiss without creating a new session. */}
      {newSessionConfirm && (
        <NewSessionConfirmModal
          title={newSessionConfirm.title}
          sceneCount={newSessionConfirm.sceneCount}
          onConfirm={() => {
            sessions.createSession();
            setNewSessionConfirm(null);
          }}
          onCancel={() => setNewSessionConfirm(null)}
        />
      )}
      {recoveryDiscardConfirm && (
        <ConfirmDialog
          title="Discard recoverable snapshot?"
          message="This permanently removes the last saved journal snapshot. You can't get it back."
          confirmLabel="Discard"
          destructive
          onConfirm={() => {
            sessions.dismissRecovery();
            setRecoveryDiscardConfirm(false);
          }}
          onCancel={() => setRecoveryDiscardConfirm(false)}
        />
      )}
      {shortcutsOpen && (
        <ShortcutsModal onClose={() => setShortcutsOpen(false)} />
      )}

      {/* VR mode — fullscreen overlay. Renders two side-by-side
          lenses for stereoscopic viewing. Mobile-only (the toggle
          button is hidden on desktop). */}
      {vrMode && platform.isMobile && (
        <VRView open={vrMode} onClose={() => setVrMode(false)} />
      )}
    </main>
  );
}

// On desktop, paint the default scene once the world is ready, UNLESS
// the active session already has scenes (in which case the user has
// saved work to restore). Tuned for hyper-realism with a brighter,
// more vivid prompt.
function DesktopDefaultScene({
  enabled,
  prompt,
  hasUserScenes,
}: {
  enabled: boolean;
  prompt: string;
  hasUserScenes: boolean;
}) {
  const { setImage, setPrompt, start, uploadFile } = useLingbot();
  const sessions = useSessions();
  const ran = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    if (hasUserScenes) return; // user has a saved session — don't overwrite
    if (ran.current) return;
    ran.current = true;
    void (async () => {
      try {
        const seed = Math.floor(Math.random() * 0xffffffff);
        const blob = await generateSeedImage({ seed });
        // Try the upload twice with a 2s gap. Reactor's upload
        // slot is occasionally sticky; a retry almost always
        // succeeds where the first call hung. We can't safely
        // paint without an anchor image (Reactor rejects start()
        // with "No image set") so we abort the auto-paint if both
        // attempts fail.
        let ref: Awaited<ReturnType<typeof uploadFile>> | null = null;
        for (let attempt = 0; attempt < 2 && !ref; attempt++) {
          const uploadPromise = blob ? uploadFile(blob, { name: `seed-${seed}.png` }) : Promise.resolve(null);
          const uploadTimeout = new Promise<null>((resolve) =>
            setTimeout(() => resolve(null), 4000),
          );
          ref = (await Promise.race([uploadPromise, uploadTimeout])) as Awaited<ReturnType<typeof uploadFile>> | null;
          if (!ref && attempt === 0) {
            await new Promise<void>((resolve) => setTimeout(resolve, 2000));
          }
        }
        if (!ref) {
          // eslint-disable-next-line no-console
          console.warn("[dream] default scene seed upload failed twice — aborting auto-paint, waiting for user input");
          return;
        }
        await setImage({ image: ref });
        // Wait for image_accepted up to 6s. If it never arrives,
        // skip the start to avoid Reactor's "No image set" error.
        // Wait for the imageReady callback the store wires up.
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        await setPrompt({ prompt: composeScenePrompt({ text: prompt, isFirst: true }) });
        await start();
        // Save the default as the first scene of the active session.
        sessions.addScene({ prompt, seed });
      } catch (e: any) {
        // non-fatal — if the backend is failing, still record the
        // user's intent so the session isn't empty.
        try {
          sessions.addScene({
            prompt,
            seed: Math.floor(Math.random() * 0xffffffff),
          });
        } catch {
          // ignore
        }
      }
    })();
  }, [enabled, prompt, hasUserScenes, setImage, setPrompt, start, uploadFile, sessions]);

  return null;
}

// Hide the system cursor on the canvas once the world is generating.
// The user wants a "Valorant / CSGO" embedded-cursor feel: when the
// generation is live, the OS cursor is invisible so the user sees only
// the painted world; when idle (no generation running, e.g. on a
// pre-Begin landing page) the cursor is restored.
//
// Inline component for the recovery-banner Restore button. Shows a
// spinner while parsing the corrupt blob (synchronous parse, can
// take >100 ms on devices with many large scenes) and disables the
// button so a frustrated user can't double-tap.
function RestoreButton({
  sessions,
}: {
  sessions: ReturnType<typeof useSessions>;
}) {
  const [restoring, setRestoring] = useState(false);
  return (
    <button
      type="button"
      disabled={restoring}
      onClick={() => {
        if (restoring) return;
        setRestoring(true);
        // Restore synchronously today, but defer one microtask so
        // React has a chance to commit the disabled state before the
        // parse blocks the main thread.
        queueMicrotask(() => {
          try {
            sessions.restoreBackup();
          } finally {
            setRestoring(false);
          }
        });
      }}
      className="flex items-center justify-center gap-2 rounded-full bg-amber-300 px-3 py-1 font-medium text-amber-950 hover:bg-amber-200 disabled:cursor-not-allowed disabled:opacity-60"
      data-testid="recovery-restore-btn"
    >
      {restoring && (
        <span
          aria-hidden="true"
          className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-amber-950/30 border-t-amber-950"
        />
      )}
      {restoring ? "Restoring…" : "Restore"}
    </button>
  );
}

// Full-screen error overlay rendered when Reactor returns a typed
// failure (e.g. 402 credits_depleted, 401 bad API key, 503 down).
// The raw error message used to be dumped here as
//   "Couldn't connect: Failed to create session: 402 {json}"
// — unreadable to a real user. We now classify the message and
// show a clear headline + body + the right CTA.
//
// The Back button returns the user to the Begin overlay, which
// keeps the journal sidebar reachable offline (sessions live in
// localStorage, not in Reactor).
function ReactorErrorScreen({
  classified,
  onRetry,
  onBack,
}: {
  classified: import("./lib/reactor-errors").ClassifiedReactorError;
  onRetry: () => void;
  onBack: () => void;
}) {
  // The credits_depleted CTA points at the dashboard and should
  // open in a new tab (we don't want to navigate away from the
  // app entirely — the user may want to come back and replay
  // their journal).
  const ctaIsExternal = !!classified.ctaHref;
  const ctaOnClick = classified.ctaHref
    ? () => window.open(classified.ctaHref!, "_blank", "noopener,noreferrer")
    : () => {
        // M9.8: a non-credits-depleted retry may be reusing a stale
        // cached JWT, especially if the key was just rotated. Bust
        // the cache so the next token mint hits Reactor fresh.
        bustNextToken();
        onRetry();
      };

  // For credits_depleted, offer a secondary "try a different key"
  // path that doesn't require the user to wait for the dashboard
  // round-trip. The server's key pool (M9.7) handles the rotation
  // transparently — we just need to bust the cached JWT.
  const showFallbackKeyRetry =
    classified.reason === "credits_depleted";
  const onFallbackKey = () => {
    bustNextToken();
    onRetry();
  };
  // M9.12: on 402, the user might want to paste their own Reactor
  // key (BYOK). If they don't have the dashboard open in another
  // tab, this is the fastest path to a working session. The
  // server's X-Reactor-User-Key path (M9.12) will use the new key
  // on the next /api/reactor/token call.
  const [showByokPaste, setShowByokPaste] = useState(false);
  const [byokDraft, setByokDraft] = useState("");
  const [byokError, setByokError] = useState<string | null>(null);
  // QA5: track whether a user key is currently saved so
  // the user has a visible path to remove it. The previous
  // flow: user pastes a key with a typo → 401 → fatal
  // (no fall-through) → user sees "API key rejected"
  // forever. Now they can clear the saved key and retry
  // with the env pool.
  const [hasUserKey, setHasUserKey] = useState(false);
  useEffect(() => {
    setHasUserKey(loadUserKey() !== null);
  }, []);
  const onByokSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = byokDraft.trim();
    if (!v) return;
    const ok = _saveUserKey(v);
    if (!ok) {
      setByokError("That doesn't look like a Reactor key (rk_<40+ chars).");
      return;
    }
    setByokError(null);
    setByokDraft("");
    setShowByokPaste(false);
    setHasUserKey(true);
    bustNextToken();
    onRetry();
  };
  const onRemoveUserKey = () => {
    _clearUserKey();
    setHasUserKey(false);
    setByokDraft("");
    setByokError(null);
    setShowByokPaste(false);
    bustNextToken();
    onRetry();
  };
  return (
    <div
      role="alert"
      aria-live="assertive"
      className="relative max-w-md text-center"
      data-testid={`reactor-error-${classified.reason}`}
    >
      <div className="mx-auto grid h-12 w-12 place-items-center rounded-full border border-white/15 bg-white/5">
        <span aria-hidden="true" className="text-2xl">
          {classified.reason === "credits_depleted" ? "✕" : "!"}
        </span>
      </div>
      <h1 className="mt-5 text-2xl font-semibold tracking-tight">
        {classified.title}
      </h1>
      <p className="mt-3 text-sm leading-relaxed text-white/70">
        {classified.body}
      </p>
      {classified.ctaLabel && (
        <button
          type="button"
          onClick={ctaOnClick}
          className="mt-7 inline-flex items-center gap-2 rounded-full bg-white px-6 py-2.5 text-sm font-medium text-black hover:bg-white/90"
        >
          {classified.ctaLabel}
          {ctaIsExternal && (
            <span aria-hidden="true" className="text-xs">↗</span>
          )}
        </button>
      )}
      {showFallbackKeyRetry && (
        <button
          type="button"
          onClick={onFallbackKey}
          className="mt-3 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-5 py-2 text-xs font-medium text-white/85 hover:bg-white/10"
          data-testid="reactor-error-try-fallback"
        >
          Try a different key
        </button>
      )}
      {showFallbackKeyRetry && !showByokPaste && (
        <button
          type="button"
          onClick={() => setShowByokPaste(true)}
          className="mt-2 block w-full text-[10px] text-white/45 underline-offset-2 hover:text-white/75 hover:underline"
          data-testid="reactor-error-byok-open"
        >
          Paste your own key
        </button>
      )}
      {/* QA5: when a user key is already saved (a previous
          session set it), the user needs a visible way to
          remove it. Previously the only way to fall back to
          the env pool was to wait for the key to expire, or
          to clear localStorage by hand. */}
      {showFallbackKeyRetry && hasUserKey && (
        <button
          type="button"
          onClick={onRemoveUserKey}
          className="mt-2 block w-full text-[10px] text-white/45 underline-offset-2 hover:text-white/75 hover:underline"
          data-testid="reactor-error-byok-remove"
        >
          Remove your key and use the shared one
        </button>
      )}
      {showFallbackKeyRetry && showByokPaste && (
        <form onSubmit={onByokSubmit} className="mt-3 flex flex-col gap-2">
          <div className="flex gap-2">
            <input
              type="password"
              value={byokDraft}
              onChange={(e) => {
                setByokDraft(e.target.value);
                setByokError(null);
              }}
              placeholder="rk_…"
              autoComplete="off"
              spellCheck={false}
              data-testid="reactor-error-byok-input"
              className="min-w-0 flex-1 rounded-md border border-white/15 bg-black/40 px-2 py-1.5 font-mono text-[11px] text-white placeholder:text-white/30 focus:border-white/40 focus:outline-none"
            />
            <button
              type="submit"
              data-testid="reactor-error-byok-save"
              className="rounded-md bg-white px-3 py-1.5 text-[11px] font-medium text-black hover:bg-white/90"
            >
              Save & retry
            </button>
          </div>
          {byokError && (
            <p className="text-[10px] text-red-300">{byokError}</p>
          )}
        </form>
      )}
      <button
        type="button"
        onClick={onBack}
        className="mt-4 block w-full text-[10px] uppercase tracking-wider text-white/45 hover:text-white/70"
      >
        Back to start
      </button>
    </div>
  );
}

// We use the "none" cursor value on the document body so the cursor
// also disappears over the video element itself, not just over the
// top-level UI.
function CursorEmbed() {
  const { status } = useLingbot();
  const [hide, setHide] = useState(false);
  // Ref-guarded: only remove the class on cleanup if *we* added it.
  // Without this, if the component remounts with hide=false while a
  // previous mount had hide=true, the previous cleanup removes the
  // class — but the new mount's effect hasn't run yet, so there's a
  // visible flash where the cursor is hidden but nothing in the
  // active component wants it hidden.
  const appliedRef = useRef(false);
  useEffect(() => {
    setHide(status === "ready");
  }, [status]);
  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    if (hide) {
      root.classList.add("cursor-hidden");
      appliedRef.current = true;
    } else {
      root.classList.remove("cursor-hidden");
      appliedRef.current = false;
    }
    return () => {
      if (appliedRef.current) {
        root.classList.remove("cursor-hidden");
        appliedRef.current = false;
      }
    };
  }, [hide]);
  return null;
}