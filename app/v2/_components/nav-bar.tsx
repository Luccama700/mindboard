"use client";

import Link from "next/link";
import type { CSSProperties } from "react";

import { TODAY_COPY } from "@/app/lib/v2/view/today";
import { AppearanceTrigger } from "./appearance-root";

/** The pages that exist, in the order `TODAY_COPY.navItems` names them. */
const DESTINATIONS = ["/v2/today", "/v2/week"] as const;

/** A page the rail can point at, and say it is on. */
export type NavPath = (typeof DESTINATIONS)[number];

/**
 * The four destinations, and the control that opens the appearance panel.
 *
 * ONE ELEMENT, TWO SHAPES. Below 1024px it is the phone's bottom bar, pinned to
 * the viewport, exactly as before. From 1024px up it is the slim rail down the
 * left edge of the desktop page. Today and Week are pages, so they are links,
 * and the one this page is carries `aria-current`. The other two do not exist
 * yet and are DISABLED placeholders, not links to nowhere.
 *
 * It comes FIRST in the document, which is what makes the desktop reading order
 * rail, main, side. On the phone that puts the bar at the start of the tab order
 * while it still paints at the bottom of the screen, which is the usual place
 * for navigation to be.
 */
export function NavBar({ current }: { current: NavPath }) {
  // The phone bar's marker slides under the current item; it is one item wide.
  const marker = { "--v2-nav-at": DESTINATIONS.indexOf(current) } as CSSProperties;

  return (
    <nav className="v2-nav" aria-label={TODAY_COPY.navLabel}>
      <div className="v2-ind" style={marker} />
      <div className="v2-nav-items">
        {TODAY_COPY.navItems.map((label, index) => {
          const href: NavPath | undefined = DESTINATIONS[index];
          if (href === undefined) {
            return (
              <button key={label} type="button" disabled>
                {label}
              </button>
            );
          }
          return (
            <Link key={label} href={href} aria-current={href === current ? "page" : undefined}>
              {label}
            </Link>
          );
        })}
      </div>
      {/* The rail's foot. Hidden on the phone, where the header carries it. */}
      <AppearanceTrigger variant="rail" />
    </nav>
  );
}
