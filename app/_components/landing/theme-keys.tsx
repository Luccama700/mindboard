"use client";

import { useSyncExternalStore } from "react";
import {
  THEMES,
  THEME_NAMES,
  setActiveTheme,
  type ThemeName,
} from "../themes";
import { useInView } from "./use-in-view";

// The theme is a class on <html>; the page reads it from there, so the keys
// agree with whatever the layout rendered and with a change made elsewhere.
function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  return () => observer.disconnect();
}

function currentTheme(): ThemeName {
  const classes = document.documentElement.classList;
  return THEME_NAMES.find((name) => classes.contains(`theme-${name}`)) ?? "dark";
}

// Six keys. Pressing one repaints this whole page, live, with the same class
// swap the app uses, and keeps the choice for the sign-in page and beyond.
export function ThemeKeys() {
  const { ref, inView } = useInView<HTMLElement>();
  const active = useSyncExternalStore(
    subscribe,
    currentTheme,
    () => "dark" as ThemeName,
  );

  return (
    <section
      ref={ref}
      className={`landing-sec landing-themes${inView ? " is-in" : ""}`}
    >
      <div className="landing-sec-head">
        <p className="landing-kicker">themes</p>
        <h2 className="landing-h2">six ways to look at it.</h2>
        <p className="landing-sec-lede">
          press one. this page follows, and so does the app. every colour can
          be repainted later.
        </p>
      </div>

      <div className="landing-keys">
        {THEMES.map((theme, index) => {
          const { palette } = theme;
          const on = active === theme.name;
          return (
            <button
              key={theme.name}
              type="button"
              className="landing-key"
              aria-pressed={on}
              onClick={() => setActiveTheme(theme.name)}
              style={{
                ["--i" as string]: index,
                backgroundColor: palette.bg,
                color: palette.fg,
                borderColor: on ? palette.accent : palette.borderStrong,
              }}
            >
              <span className="landing-key-top">
                <span
                  className="landing-key-dot"
                  style={{ backgroundColor: palette.accent }}
                />
                <span style={{ color: palette.muted }}>
                  {on ? "on" : `0${index + 1}`}
                </span>
              </span>
              <span className="landing-key-name">{theme.label}</span>
              <span className="landing-key-tag" style={{ color: palette.muted }}>
                {theme.tagline}
              </span>
              <span className="landing-key-swatch" aria-hidden>
                {[palette.bgCard, palette.borderSubtle, palette.fg, palette.accent].map(
                  (swatch, i) => (
                    <i key={i} style={{ backgroundColor: swatch }} />
                  ),
                )}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
