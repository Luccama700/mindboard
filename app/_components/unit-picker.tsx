"use client";

import { useState } from "react";
import { UNIT_SUGGESTIONS, isSuggestedUnit } from "./inventory-units";

const CUSTOM = "__custom__";

export function UnitPicker({
  value,
  onChange,
  recent = [],
  label = "unit",
}: {
  value: string;
  onChange: (u: string) => void;
  recent?: string[];
  label?: string;
}) {
  const recentExtra = recent.filter((u) => u.trim() && !isSuggestedUnit(u));

  const known = new Map<string, string>();
  for (const u of recentExtra) known.set(u.toLowerCase(), u);
  for (const g of UNIT_SUGGESTIONS) {
    for (const u of g.units) known.set(u.toLowerCase(), u);
  }

  const trimmed = value.trim();
  const isCustomValue = trimmed !== "" && !known.has(trimmed.toLowerCase());

  const [prevValue, setPrevValue] = useState(value);
  const [forceCustom, setForceCustom] = useState(isCustomValue);
  const [customDraft, setCustomDraft] = useState(isCustomValue ? value : "");
  if (value !== prevValue) {
    setPrevValue(value);
    setForceCustom(isCustomValue);
    setCustomDraft(isCustomValue ? value : "");
  }

  const customMode = forceCustom || isCustomValue;
  const selectValue = customMode
    ? CUSTOM
    : trimmed === ""
      ? ""
      : (known.get(trimmed.toLowerCase()) ?? "");

  function onSelect(v: string) {
    if (v === CUSTOM) {
      setForceCustom(true);
      return;
    }
    setForceCustom(false);
    onChange(v);
  }

  function commitCustom() {
    const next = customDraft.trim();
    if (next && next.toLowerCase() !== trimmed.toLowerCase()) onChange(next);
  }

  return (
    <div className="space-y-2">
      <p className="text-[10px] tracking-widest uppercase text-muted">{label}</p>
      <select
        value={selectValue}
        onChange={(e) => onSelect(e.target.value)}
        aria-label={label}
        className="w-full bg-card border border-line-strong focus:border-accent text-fg text-xs uppercase tracking-widest px-2 py-2 focus:outline-none transition-colors"
      >
        <option value="">—</option>
        {recentExtra.length > 0 && (
          <optgroup label="recent">
            {recentExtra.map((u) => (
              <option key={`recent-${u}`} value={u}>
                {u}
              </option>
            ))}
          </optgroup>
        )}
        {UNIT_SUGGESTIONS.map((group) => (
          <optgroup key={group.category} label={group.category}>
            {group.units.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </optgroup>
        ))}
        <option value={CUSTOM}>custom…</option>
      </select>

      {customMode && (
        <input
          type="text"
          value={customDraft}
          onChange={(e) => setCustomDraft(e.target.value)}
          onBlur={commitCustom}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.currentTarget.blur();
            }
          }}
          placeholder="type a unit…"
          maxLength={32}
          aria-label="custom unit"
          autoFocus
          className="w-full bg-card border border-accent text-fg placeholder-muted text-sm px-3 py-2 focus:outline-none transition-colors"
        />
      )}
    </div>
  );
}
