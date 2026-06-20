"use client";

// Lightweight React error boundary. Catches render errors
// in the children and shows a "reset" button + a copy of
// the stack. Used to wrap the dream rendering so a
// single failing paint or chip click doesn't take down
// the whole app (audit gap: a NaN in director-state could
// crash the topbar; a CSS filter syntax error could crash
// the whole overlay tree).
//
// Class component because React's error-boundary API
// (`componentDidCatch` + `getDerivedStateFromError`) is
// only supported on classes — function components can't
// implement it. We keep the class as small as possible.

import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Label shown in the error message. */
  label?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string }) {
    // eslint-disable-next-line no-console
    console.error(`[dream] ErrorBoundary (${this.props.label ?? "root"}) caught:`, error, info);
  }

  reset = () => {
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div
        className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-black/90 p-6 text-center text-white"
        role="alert"
        data-testid="error-boundary"
      >
        <div className="text-2xl">😵‍💫</div>
        <h1 className="text-lg font-semibold">
          {this.props.label ? `${this.props.label} crashed` : "Something went wrong"}
        </h1>
        <p className="max-w-md text-sm text-white/70">
          The dream engine hit an unexpected error. Your saved sessions are safe — try again.
        </p>
        <pre className="max-h-40 max-w-2xl overflow-auto rounded-lg border border-white/10 bg-black/60 p-3 text-left text-[10px] text-red-200">
          {error.message}
          {error.stack ? "\n\n" + error.stack.split("\n").slice(0, 5).join("\n") : ""}
        </pre>
        <button
          type="button"
          onClick={this.reset}
          className="rounded-full bg-white px-5 py-2 text-sm font-medium text-black transition hover:bg-white/90"
          data-testid="error-boundary-reset"
        >
          Try again
        </button>
      </div>
    );
  }
}