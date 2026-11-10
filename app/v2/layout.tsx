// The v2 shell. It nests INSIDE app/layout.tsx, which owns <html> and <body>,
// sets a monospace font and a theme class, and loads globals.css. None of that
// can be changed from here, so [data-v2-root] paints its own background and
// declares its own fonts and colours (see v2.css) and everything v2 renders
// lives under it.
//
// The root element itself is rendered by AppearanceRoot, a client component,
// because the scheme is a runtime choice: it writes the ten colour tokens on
// that element and reads the stored choice after hydration. This layout stays a
// server component and hands it only the two font class names, so next/font is
// still resolved on the server.
//
// The two fonts come through next/font/google, which self hosts them: the
// prototype linked fonts.googleapis.com, which would be a third party request
// on every page load and a layout shift while it resolves.

import type { Metadata } from "next";
import { Atkinson_Hyperlegible, Chakra_Petch } from "next/font/google";

import { AppearanceRoot } from "./_components/appearance-root";
import "./v2.css";

const display = Chakra_Petch({
  weight: ["500", "600", "700"],
  subsets: ["latin"],
  display: "swap",
  variable: "--font-v2-display",
});

const text = Atkinson_Hyperlegible({
  weight: ["400", "700"],
  subsets: ["latin"],
  display: "swap",
  variable: "--font-v2-text",
});

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function V2Layout({ children }: { children: React.ReactNode }) {
  return (
    <AppearanceRoot className={`${display.variable} ${text.variable}`}>
      {children}
    </AppearanceRoot>
  );
}
