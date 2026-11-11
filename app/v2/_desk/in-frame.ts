"use client";

import { createContext, useContext } from "react";

// Whether a pane body is drawn in a frame of the desk.
//
// THE OUTLINE OF THE DESK. The page's one h1 is the desk's own, and each frame
// names its pane with an h2, so a body inside a frame starts at h3. The same
// bodies are drawn alone in the gallery, and their leaves on Today and Week,
// where the headings they bring are the page's own (the date is the h1 there).
// So a body asks this, and passes the leaves it reuses a heading level only
// when it is in a frame: outside one, every leaf renders exactly as it did.

export const InFrame = createContext(false);

export function useInFrame(): boolean {
  return useContext(InFrame);
}
