"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import {
  useLingbot,
  useLingbotState,
  useLingbotImageAccepted,
  type LingbotStateMessage,
} from "@reactor-models/lingbot";
import { SCENES, findSceneById, type Scene } from "../lib/scenes";
import { useVoice } from "../hooks/useVoice";

// The single hero surface of the app. Replaces ScenePicker + CustomStart
// + DynamicEvents with a voice-first flow:
//
//   1. Tap "Begin". Mic starts. Status pill flips to "Listening".
//   2. User speaks. Interim + final transcript shown live.
//   3. User taps "Paint my dream" (or 1.5s silence auto-flushes).
//   4. We pick a seed scene by keyword, upload the image, send prompt,
//      start generation.
//   5. World is live. Mic stays armed — every new spoken phrase mutates
//      the world in place via set_prompt. Walk by tilting (GyroController).
//
// Lingbot chains we depend on:
//   uploadFile(blob) → FileRef
//   setImage({ image: ref }) → image_accepted
//   setPrompt({ prompt: ... }) → prompt_accepted
//   start()                 → generation_started
//
// On mutation, the chain is just `setPrompt({ prompt: newPrompt })` —
// the model picks it up on the next chunk boundary, no restart needed.

const KEYWORD_TO_SCENE: ReadonlyArray<{ keywords: string[]; sceneId: string }> = [
  {
    keywords: ["dragon", "fly", "wing", "castle", "sky", "flying", "drogon"],
    sceneId: "dragon_ride",
  },
  {
    keywords: ["rain", "storm", "sea", "ocean", "boat", "wave", "thunder", "sail"],
    sceneId: "storm_crossing",
  },
  {
    keywords: ["car", "drive", "truck", "desert", "dune", "canyon", "4x4", "defender", "road"],
    sceneId: "citadel_approach",
  },
  {
    keywords: ["meadow", "flower", "spring", "dog", "puppy", "retriever", "field", "wildflower"],
    sceneId: "spring_valley",
  },
  {
    keywords: [
      "castle", "knight", "rider", "horse", "sword", "kingdom", "medieval",
      "fantasy", "twilight", "knight", "warrior", "banner",
    ],
    sceneId: "misted_kingdom",
  },
];

const FALLBACK_SCENE_ID = "misted_kingdom"; // safe open-valley prompt

function pickScene(transcript: string): Scene {
  const t = transcript.toLowerCase();
  for (const entry of KEYWORD_TO_SCENE) {
    if (entry.keywords.some((k) => t.includes(k))) {
      const s = findSceneById(entry.sceneId);
      if (s) return s;
    }
  }
  return findSceneById(FALLBACK_SCENE_ID) ?? SCENES[0];
}

export function VoiceDream() {
  const { status, uploadFile, setImage, setPrompt, start } = useLingbot();
  const [snapshot, setSnapshot] = useState<LingbotStateMessage | null>(null);
  const voice = useVoice();
  const [phase, setPhase] = useState<"idle" | "loading" | "live">("idle");
  const [lastPrompt, setLastPrompt] = useState<string | null>(null);
  const [activeScene, setActiveScene] = useState<Scene | null>(null);
  const [error, setError] = useState<string | null>(null);
  const imageReadyRef = useRef<(() => void) | null>(null);

  useLingbotState((msg) => setSnapshot(msg));

  useEffect(() => {
    if (status !== "ready") {
      setSnapshot(null);
      setPhase("idle");
    }
  }, [status]);

  useLingbotImageAccepted(() => {
    if (imageReadyRef.current) {
      imageReadyRef.current();
      imageReadyRef.current = null;
    }
  });

  const ready = status === "ready";
  const generating = snapshot?.started === true;

  // When generation has started, transition to "live" phase.
  useEffect(() => {
    if (generating) setPhase("live");
    else if (ready && phase === "loading") {
      // Still loading — keep phase.
    } else if (!ready) {
      setPhase("idle");
    }
  }, [generating, ready, phase]);

  // The big "Send" handler. Called on tap, on Enter key in the input, and
  // from the silence-flush auto-commit.
  async function paintDream(transcript: string) {
    const text = transcript.trim();
    if (!text || !ready) return;
    setError(null);

    // On the very first paint, pick a seed scene, upload its image, and
    // start. On subsequent paints, just re-send set_prompt.
    if (!generating) {
      const scene = pickScene(text);
      setActiveScene(scene);
      setLastPrompt(text);
      setPhase("loading");
      try {
        const blob = await fetch(scene.imageUrl).then((r) => r.blob());
        const ref = await uploadFile(blob, { name: `${scene.id}.jpg` });
        const imageReady = new Promise<void>((resolve) => {
          imageReadyRef.current = resolve;
        });
        await setImage({ image: ref });
        await imageReady;
        await setPrompt({ prompt: scene.prompt });
        await start();
      } catch (e: any) {
        setError(e?.message ?? String(e));
        setPhase("idle");
      }
    } else {
      // In-place mutation. Frame the user's words as a scene-changing
      // atmospheric event (matching the "dynamic events" pattern from
      // app/lib/dynamic-events.ts) so the prompt stays in the model's
      // third-person descriptive register. Avoids the awkward
      // "user is now narrating" meta-commentary.
      const composed = activeScene
        ? `${activeScene.prompt} ${text.trim().replace(/[.!]+$/, "")} now, visible across the scene.`
        : text;
      setLastPrompt(text);
      try {
        await setPrompt({ prompt: composed });
      } catch (e: any) {
        setError(e?.message ?? String(e));
      }
    }
  }

  function onMicClick() {
    if (!voice.supported) {
      setError("Voice not supported in this browser. Use the text input below.");
      return;
    }
    if (voice.listening) {
      const committed = voice.commit();
      if (committed) void paintDream(committed);
    } else {
      voice.start();
    }
  }

  function onTextSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const text = (data.get("text") as string | null)?.trim();
    if (!text) return;
    e.currentTarget.reset();
    void paintDream(text);
  }

  return (
    <div className="pointer-events-auto flex flex-col gap-3">
      {/* Transcript card */}
      <div className="rounded-2xl border border-white/10 bg-black/40 px-4 py-3 text-white shadow-lg backdrop-blur">
        <p className="text-[10px] uppercase tracking-widest text-white/50">
          {phase === "live" ? "Now narrating" : phase === "loading" ? "Painting your dream…" : "Describe your dream"}
        </p>
        <p className="mt-1 min-h-[1.25rem] text-sm leading-snug">
          {voice.interim || lastPrompt || (phase === "live" ? "(speak to mutate the world)" : "Say: \"a misty pine forest at dawn, soft light, fog between the trees.\"")}
        </p>
        {error && <p className="mt-1 text-xs text-red-300">{error}</p>}
      </div>

      {/* Mic button — primary action. */}
      <button
        type="button"
        onClick={onMicClick}
        disabled={!voice.supported || !ready}
        className={[
          "mx-auto grid h-16 w-16 place-items-center rounded-full border transition active:scale-95",
          voice.listening
            ? "animate-pulse border-red-400/60 bg-red-500/80 text-white"
            : "border-white/20 bg-white/10 text-white hover:bg-white/20",
          (!voice.supported || !ready) && "opacity-40",
        ].filter(Boolean).join(" ")}
        aria-label={voice.listening ? "Send transcript" : "Start listening"}
      >
        <MicIcon active={voice.listening} />
      </button>

      {/* Text fallback (always visible — small, below the mic). */}
      <form onSubmit={onTextSubmit} className="flex gap-2">
        <input
          name="text"
          placeholder="…or type a prompt"
          disabled={!ready}
          className="flex-1 rounded-full border border-white/10 bg-black/40 px-4 py-2 text-sm text-white placeholder:text-white/40 focus:border-white/30 focus:outline-none disabled:opacity-40"
        />
        <button
          type="submit"
          disabled={!ready}
          className="rounded-full bg-white/15 px-4 py-2 text-sm font-medium text-white hover:bg-white/25 disabled:opacity-40"
        >
          Send
        </button>
      </form>
    </div>
  );
}

function MicIcon({ active }: { active: boolean }) {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="3" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <line x1="12" y1="18" x2="12" y2="22" />
      {active && <circle cx="12" cy="12" r="2" fill="currentColor" />}
    </svg>
  );
}