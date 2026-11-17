"use client";

import { useEffect } from "react";
import { DayLine } from "./day-line";
import { FinePrint } from "./fine-print";
import { Hero } from "./hero";
import { McpApprove } from "./mcp-approve";
import { ThemeKeys } from "./theme-keys";
import "./landing.css";

// The logged-out `/`: "put it down." The page is the product at small scale.
// The hero holds a working desk (the Dock's own capture grammar, four panes it
// files into), then the day as a line of six stops, an MCP approval the
// visitor answers, the six themes as live keys, and the fine print as a man
// page. Zero network calls. Every colour is a theme token, so a theme flip
// repaints everything, running animations included; reduced motion gets the
// same story with nothing moving.
export function Landing() {
  // Server-action redirects (sign-out lands here) preserve the previous
  // page's scroll position, which would drop the visitor into the middle of
  // the page. It reads from the top.
  useEffect(() => {
    if (window.scrollY > 0) window.scrollTo(0, 0);
  }, []);

  return (
    <main className="landing">
      <Hero />
      <DayLine />
      <McpApprove />
      <ThemeKeys />
      <FinePrint />
    </main>
  );
}
