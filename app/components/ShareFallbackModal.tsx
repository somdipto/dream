"use client";

import { useEffect, useRef } from "react";

// Shared fallback modal for clipboard-copy failures.
//
// Appears when both navigator.clipboard.writeText and the
// execCommand fallback fail (e.g. locked-down iframe, HTTP
// origin in a sandboxed context, ancient WebView). The URL is
// pre-selected so the user can long-press → Copy on mobile
// without tapping anything.

export function ShareFallbackModal({
  url,
  onClose,
}: {
  url: string;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  // Pre-select the URL the moment the modal opens.
  useEffect(() => {
    const t = setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 50);
    return () => clearTimeout(t);
  }, []);
  // Escape closes the modal.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/70 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Copy your dream link"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-white/10 bg-black p-5 text-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-sm font-medium uppercase tracking-widest text-white/70">
          Copy your dream link
        </h2>
        <p className="mt-2 text-xs text-white/50">
          Long-press the URL below and choose Copy.
        </p>
        <input
          ref={inputRef}
          readOnly
          value={url}
          onFocus={(e) => e.currentTarget.select()}
          className="mt-3 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-3 text-sm text-white outline-none focus:border-white/40"
        />
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-xs text-white/80 hover:bg-white/10"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
