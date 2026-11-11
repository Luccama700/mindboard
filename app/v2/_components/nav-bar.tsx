"use client";

import Link from "next/link";
import type { CSSProperties } from "react";

import { TODAY_COPY } from "@/app/lib/v2/view/today";
import { AppearanceTrigger } from "./appearance-root";

/** A page the rail can point at, and say it is on. */
export type NavPath = "/v2/today" | "/v2/week";

/**
 * The rail's four destinations, in the order it shows them, each with the page
 * it opens, or null for one that does not exist yet. Named, so a label and its
 * page cannot drift apart by their places in two lists.
 */
const DESTINATIONS: ReadonlyArray<{ label: string; href: NavPath | null }> = [
  { label: TODAY_COPY.nav.today, href: "/v2/today" },
  { label: TODAY_COPY.nav.week, href: "/v2/week" },
  { label: TODAY_COPY.nav.quests, href: null },
  { label: TODAY_COPY.nav.money, href: null },
];

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
  const at = DESTINATIONS.findIndex((destination) => destination.href === current);
  const marker = { "--v2-nav-at": at } as CSSProperties;

  return (
    <nav className="v2-nav" aria-label={TODAY_COPY.navLabel}>
      <div className="v2-ind" style={marker} />
      <div className="v2-nav-items">
        {DESTINATIONS.map(({ label, href }) =>
          href === null ? (
            <button key={label} type="button" disabled>
              {label}
            </button>
          ) : (
            <Link key={label} href={href} aria-current={href === current ? "page" : undefined}>
              {label}
            </Link>
          ),
        )}
      </div>
      {/* The rail's foot. Hidden on the phone, where the header carries it. */}
      <AppearanceTrigger variant="rail" />
    </nav>
  );
}
