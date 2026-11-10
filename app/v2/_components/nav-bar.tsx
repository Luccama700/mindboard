"use client";

import { TODAY_COPY } from "@/app/lib/v2/view/today";
import { AppearanceTrigger } from "./appearance-root";

/**
 * The four destinations, and the control that opens the appearance panel.
 *
 * ONE ELEMENT, TWO SHAPES. Below 1024px it is the phone's bottom bar, pinned to
 * the viewport, exactly as before. From 1024px up it is the slim rail down the
 * left edge of the desktop page. Only Today exists in this slice: the other
 * three are DISABLED placeholders, not links to nowhere.
 *
 * It comes FIRST in the document, which is what makes the desktop reading order
 * rail, main, side. On the phone that puts the bar at the start of the tab order
 * while it still paints at the bottom of the screen, which is the usual place
 * for navigation to be.
 */
export function NavBar() {
  return (
    <nav className="v2-nav" aria-label={TODAY_COPY.navLabel}>
      <div className="v2-ind" />
      <div className="v2-nav-items">
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
      </div>
      {/* The rail's foot. Hidden on the phone, where the header carries it. */}
      <AppearanceTrigger variant="rail" />
    </nav>
  );
}
