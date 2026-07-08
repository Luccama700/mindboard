"use client";

import { useEffect } from "react";
import { BootHero } from "./boot-hero";
import { CloseCta } from "./close-cta";
import { DayScene } from "./day-scene";
import { GrammarDoors } from "./grammar-doors";
import { McpBridge } from "./mcp-bridge";
import { ThemeSplit } from "./theme-split";

// The logged-out `/`: "one day on the board". A terminal boots, then a
// pinned scroll-scrubbed scene plays one full day through the product —
// wake, capture, money, shelf, night — followed by the capture grammar, the
// live theme flip, and the close. Scrolling back rewinds the day. Zero
// network calls; every color is a theme token so the flip recolors running
// animations; reduced motion gets static frames of the same story.
export function Landing() {
  // Server-action redirects (sign-out lands here) preserve the previous
  // page's scroll position, which would drop the visitor into the middle of
  // the story with the boot sequence already off-screen. The page is a
  // sequence — always start it from the top.
  useEffect(() => {
    if (window.scrollY > 0) window.scrollTo(0, 0);
  }, []);

  return (
    <main className="min-h-screen bg-page text-fg overflow-x-clip">
      <BootHero />
      <DayScene />
      <McpBridge />
      <GrammarDoors />
      <ThemeSplit />
      <CloseCta />
    </main>
  );
}
