"use client";

import { useEffect, useRef, useState } from "react";
import { useLingbotCommandError } from "@reactor-models/lingbot";

// Surface command_error messages from the model. Lingbot emits these
// when a command fails its preconditions — for example, calling
// `start` before a prompt or an image has been set, or uploading a
// file that isn't a valid image. Without this component those
// failures are silent: the user clicks a button and nothing happens.
//
// QA15 fix: previously we cleared the error on the next `state`
// snapshot, but state messages fire 10+ times per second while the
// world paints, so the error was visible for ~100ms and then
// disappeared. Now we hold the error for 4 seconds (long enough to
// read) OR until the user dismisses it with the × button.

const HOLD_MS = 4000;

export function CommandError() {
  const [error, setError] = useState<{
    command: string;
    reason: string;
  } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useLingbotCommandError((msg) => {
    setError({ command: msg.command, reason: msg.reason });
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setError(null), HOLD_MS);
  });

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  if (!error) return null;

  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-lg border border-white/20 bg-white/8 p-3 text-white backdrop-blur"
    >
      <div className="flex-1">
        <span className="text-[10px] uppercase tracking-wider text-white/55">
          {error.command} failed
        </span>
        <p className="mt-1 text-xs">{error.reason}</p>
      </div>
      <button
        onClick={() => {
          if (timerRef.current) clearTimeout(timerRef.current);
          setError(null);
        }}
        aria-label="Dismiss error"
        data-testid="command-error-dismiss"
        className="rounded p-1 text-white/70 hover:bg-white/10 hover:text-white"
      >
        ×
      </button>
    </div>
  );
}
