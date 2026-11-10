"use client";

import { TODAY_COPY } from "@/app/lib/v2/view/today";

/**
 * The prototype's frame has four tabs and reserves the space for them, so the
 * bar is here to keep the screen the right shape. Only Today exists in this
 * slice: the other three are DISABLED placeholders, not links to nowhere.
 */
export function NavBar() {
  return (
    <nav className="v2-nav" aria-label={TODAY_COPY.navLabel}>
      <div className="v2-ind" />
      {TODAY_COPY.navItems.map((label, index) => (
        <button
          key={label}
          type="button"
          disabled={index > 0}
          aria-current={index === 0 ? "page" : undefined}
        >
          {label}
        </button>
      ))}
    </nav>
  );
}
