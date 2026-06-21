// Robust copy-to-clipboard that works on every surface the app runs on.
//
//   1. navigator.clipboard.writeText  — works on HTTPS / localhost
//      and in iframes that have the clipboard-write permission.
//   2. Hidden <textarea> + execCommand — works on plain HTTP,
//      older Safari, and as a final fallback when the modern
//      API throws or is unavailable (NotAllowedError on
//      permissions-policy'd iframes is the common case).
//   3. Selection returned in the result — call sites can show
//      the user a pre-selected modal with the URL on the
//      (rare) platforms where neither path works.
//
// Why we keep #2: an `npm audit` will tell you execCommand is
// deprecated. It is. But it's the only thing that works on
// HTTP origins and on iframes sandboxed without
// `allow-clipboard-write`. Removing it turns a confirmed-working
// fallback into a "copy" button that does nothing on
// GitHub-Project-Preview-style HTTP hosts.

export type CopyResult =
  | { ok: true; via: "clipboard-api" | "exec-command" }
  | { ok: false; text: string; reason: "no-document" | "both-failed" };

export async function copyToClipboard(text: string): Promise<CopyResult> {
  if (typeof document === "undefined") {
    return { ok: false, text, reason: "no-document" };
  }
  // 1. Try the modern API.
  if (
    typeof navigator !== "undefined" &&
    navigator.clipboard &&
    typeof navigator.clipboard.writeText === "function" &&
    window.isSecureContext
  ) {
    try {
      await navigator.clipboard.writeText(text);
      return { ok: true, via: "clipboard-api" };
    } catch {
      // Permission denied, sandboxed iframe, etc. Fall through.
    }
  }
  // 2. execCommand fallback. Works on http://, http sandboxed
  //    iframes, and older mobile WebViews.
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    // Off-screen but still focusable.
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.left = "0";
    ta.style.width = "1px";
    ta.style.height = "1px";
    ta.style.opacity = "0";
    ta.style.pointerEvents = "none";
    document.body.appendChild(ta);
    // Preserve any current selection so the copy doesn't
    // blow away the user's text selection in surrounding UI.
    const sel = document.getSelection();
    const savedRanges = sel && sel.rangeCount > 0
      ? Array.from({ length: sel.rangeCount }, () => sel.getRangeAt(0).cloneRange())
      : [];
    ta.select();
    ta.setSelectionRange(0, text.length);
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    // Restore prior selection.
    if (sel && savedRanges.length) {
      sel.removeAllRanges();
      for (const r of savedRanges) sel.addRange(r);
    }
    document.body.removeChild(ta);
    if (ok) return { ok: true, via: "exec-command" };
  } catch {
    // DOM access failed (CSP, locked-down iframe, etc.).
  }
  return { ok: false, text, reason: "both-failed" };
}
