"use client";

// Chip strip used inside the dream input card. Renders a horizontal
// row of small emoji + label buttons. The active chip gets a bright
// white background; inactive chips are subtle. The component is
// presentational only — the parent owns the state.

import type { ReactNode } from "react";

export interface Chip {
  id: string;
  label: string;
  emoji: string;
}

interface ChipStripProps {
  chips: Chip[];
  activeId: string | null;
  onSelect: (id: string | null) => void;
  /** Small variant for tighter rows. */
  size?: "sm" | "md";
  /** Optional trailing node (e.g. a help icon). */
  trailing?: ReactNode;
}

export function ChipStrip({ chips, activeId, onSelect, size = "md", trailing }: ChipStripProps) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="radiogroup">
      {chips.map((c) => {
        const active = activeId === c.id;
        const sizeCls =
          size === "sm"
            ? "h-7 px-2.5 text-[11px]"
            : "h-8 px-3 text-xs";
        return (
          <button
            key={c.id}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onSelect(active ? null : c.id)}
            className={
              "inline-flex items-center gap-1 rounded-full border transition " +
              sizeCls +
              " " +
              (active
                ? "border-white/40 bg-white text-black shadow"
                : "border-white/15 bg-white/5 text-white/85 hover:bg-white/15")
            }
          >
            <span aria-hidden>{c.emoji}</span>
            <span className="font-medium">{c.label}</span>
          </button>
        );
      })}
      {trailing}
    </div>
  );
}