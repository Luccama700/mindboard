"use client";

import { useRef } from "react";

export const PALETTE = [
  "#B5FF3C",
  "#7CFF6B",
  "#3CD9FF",
  "#3C8FFF",
  "#C892FF",
  "#FF6BFF",
  "#FF6B9D",
  "#FF6B6B",
  "#FFB73C",
  "#FFE93C",
  "#A0A0A0",
  "#F5F0E8",
];

export function isPaletteColor(color: string): boolean {
  return PALETTE.some((c) => c.toLowerCase() === color.toLowerCase());
}

export function ColorPicker({
  value,
  onChange,
  label = "color",
}: {
  value: string;
  onChange: (c: string) => void;
  label?: string;
}) {
  const customRef = useRef<HTMLInputElement>(null);
  const customActive = !isPaletteColor(value);

  function openCustom() {
    const el = customRef.current;
    if (!el) return;
    if (typeof el.showPicker === "function") {
      try {
        el.showPicker();
        return;
      } catch {
        // fall through
      }
    }
    el.focus();
    el.click();
  }

  return (
    <div>
      <p className="text-[10px] tracking-widest uppercase text-[#6b6b6b] mb-2">
        {label}
      </p>
      <div className="flex flex-wrap gap-3 items-center">
        {PALETTE.map((c) => {
          const selected = value.toLowerCase() === c.toLowerCase();
          return (
            <button
              key={c}
              type="button"
              onClick={() => onChange(c)}
              aria-label={`pick color ${c}`}
              className={`w-9 h-9 transition-transform ${
                selected
                  ? "ring-2 ring-[#f5f0e8] ring-offset-2 ring-offset-[#141414] scale-110"
                  : ""
              }`}
              style={{ backgroundColor: c }}
            />
          );
        })}

        <button
          type="button"
          onClick={openCustom}
          aria-label="pick custom color"
          className={`relative w-9 h-9 transition-transform overflow-hidden ${
            customActive
              ? "ring-2 ring-[#f5f0e8] ring-offset-2 ring-offset-[#141414] scale-110"
              : ""
          }`}
          style={{
            background: customActive
              ? value
              : "conic-gradient(from 0deg, #ff6b6b, #ffb73c, #ffe93c, #7cff6b, #3cd9ff, #c892ff, #ff6bff, #ff6b6b)",
          }}
        >
          {!customActive && (
            <span
              aria-hidden
              className="absolute inset-0 flex items-center justify-center text-[#0d0d0d] text-base font-bold"
            >
              +
            </span>
          )}
        </button>

        <input
          ref={customRef}
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
          tabIndex={-1}
          aria-hidden
          className="sr-only"
        />
      </div>
      {customActive && (
        <p className="text-[10px] tracking-widest uppercase text-[#6b6b6b] mt-2">
          custom · {value.toUpperCase()}
        </p>
      )}
    </div>
  );
}
