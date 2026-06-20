# See your dreams in real

A voice-first, gyroscope-driven world model demo built on **Reactor + LingBot** for the Inception hackathon. Speak a scene, walk through it by tilting your phone.

## Demo flow (30 seconds)

1. Tap **Begin**. Mic + motion permission prompts appear.
2. Speak: *"a misty pine forest at dawn, soft light, fog between the trees."*
3. Tap the mic again (or stay silent 1.5 s) — the model paints the world.
4. **Tilt forward** to walk, **left/right** to turn.
5. Speak again to mutate the world in place: *"now a thunderstorm rolls in, rain starts falling."*

## Stack

- **Next.js 15** (App Router) + **React 19** + **TypeScript**
- **Reactor + LingBot** — the only navigable world model in the Reactor lineup (WASD + arrow keys)
- **Web Speech API** for in-browser voice-to-text (zero backend STT)
- **DeviceOrientationEvent** for gyroscope → camera control
- **Tailwind v4** for the mobile-first dark UI

## Run it

```bash
cp .env.example .env
# Add your Reactor key from https://reactor.inc/dashboard
# REACTOR_API_KEY=rk_...

pnpm install
pnpm dev
```

Open on your phone (LAN URL from `pnpm dev`) using **Android Chrome**. iOS Safari works in a degraded form — the iOS permission gate is implemented but `SpeechRecognition` quirks on iOS mean the text-input fallback is the more reliable path.

## Architecture

```
app/
├─ api/reactor/token/route.ts   # JWT minter (server-side, never exposes API key)
├─ LingbotApp.tsx               # mobile-first layout, top status / bottom voice
├─ page.tsx                     # boots the right surface (Setup vs Dream)
├─ SetupRequired.tsx            # shown if REACTOR_API_KEY is missing
├─ components/
│  ├─ Video.tsx                 # full-bleed <LingbotMainVideoView />
│  ├─ StatusBadge.tsx           # connection state pill (top of screen)
│  ├─ CommandError.tsx          # surfaces model errors
│  ├─ VoiceDream.tsx            # mic button + transcript + text fallback
│  └─ GyroController.tsx        # headless — tilt → setMovement / setLook*
└─ hooks/
   ├─ useVoice.ts               # Web Speech API wrapper (auto-restart, silence flush)
   └─ useMotion.ts              # DeviceOrientationEvent + iOS gate + EMA smoothing
```

## How voice maps to a world

The user speaks free-form English. We match keywords in the transcript against a small theme → scene router (forest/rain/desert/medieval/cyberpunk) and pick one of the five seed images bundled in `public/images/`. The matched scene's curated prompt becomes the **base** prompt; subsequent utterances are composed on top (`"<base prompt> The user is now narrating: <new text>."`) and re-sent via `set_prompt`, mutating the world in place at the next chunk boundary without resetting position.

## How gyroscope maps to a camera

| Tilt | Action |
|---|---|
| Pitch > 25° (top tipping away) | `set_movement: forward` |
| Pitch < -25° | `set_movement: back` |
| Yaw > 15° (relative to first reading) | `set_look_horizontal: right` |
| Yaw < -15° | `set_look_horizontal: left` |
| Pitch 5°..20° | `set_look_vertical: down` (look at the ground) |
| Pitch -5°..-15° | `set_look_vertical: up` |

Each axis is held as persistent state — we only re-send when the state *changes*, not on every frame, so chunk-boundary command loss (a documented LingBot gotcha) doesn't drop our inputs.

## Deliberately out of scope

- iOS Safari as primary (Android Chrome only).
- Cloud STT (Web Speech API is enough for a one-day hackathon).
- Multi-model switching.
- Account / persistence.

## License

Hackathon code. Don't ship it to production without auth, rate limits, and a real STT service.
