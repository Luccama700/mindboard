"use client";

import { useEffect, useRef, type KeyboardEvent } from "react";

import {
  APPEARANCE_COPY,
  CUSTOM_SCHEME_ID,
  DEFAULT_APPEARANCE,
  SCHEMES,
  normalizeHex,
  resolveAppearance,
  type Appearance,
} from "@/app/lib/v2/view/appearance";

const FOCUSABLE = [
  "button:not([disabled])",
  "input:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

/**
 * The appearance panel: four built-in schemes, a custom pair, and a way back.
 *
 * It is a real panel rather than a popover: a heading, labelled inputs, a close
 * button, focus kept inside while it is open and handed back to whichever
 * control opened it. It is NOT portalled to the body, because every selector and
 * every token in v2.css starts at `[data-v2-root]`: outside that element the
 * panel would have no palette at all.
 *
 * Changes apply as they are picked, which is the whole point of a colour
 * control: the page behind the panel is the preview. So there is no Apply and no
 * Cancel, and the stored value is written on every change.
 */
export function AppearancePanel({
  appearance,
  onChoose,
  onClose,
}: {
  appearance: Appearance;
  onChoose: (next: Appearance) => void;
  onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement | null>(null);
  const { background, accent } = resolveAppearance(appearance);
  const custom = appearance.schemeId === CUSTOM_SCHEME_ID;

  // The panel itself takes focus rather than its first control, so the heading
  // is what a screen reader reads out and Tab then lands on the first choice.
  useEffect(() => {
    panel.current?.focus();
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const inside = panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
    if (inside === undefined || inside.length === 0) return;
    const first = inside[0];
    const last = inside[inside.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === panel.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  /**
   * Touching either colour input switches to the custom pair, seeded from the
   * two colours currently on screen. Picking Background while Paper is on means
   * "Paper's accent with my background", not "my background and black".
   */
  const pick = (part: "background" | "accent", value: string) => {
    const colour = normalizeHex(value);
    if (colour === null) return;
    onChoose({
      schemeId: CUSTOM_SCHEME_ID,
      background: part === "background" ? colour : background,
      accent: part === "accent" ? colour : accent,
    });
  };

  return (
    <div className="v2-sheet" role="presentation">
      <div
        className="v2-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="v2-appearance-title"
        tabIndex={-1}
        ref={panel}
        onKeyDown={onKeyDown}
      >
        <div className="v2-panel-top">
          <h2 id="v2-appearance-title">{APPEARANCE_COPY.title}</h2>
          <button type="button" className="v2-quiet" onClick={onClose}>
            {APPEARANCE_COPY.close}
          </button>
        </div>

        <div
          className="v2-panel-group"
          role="group"
          aria-labelledby="v2-appearance-schemes"
        >
          <p className="v2-panel-label" id="v2-appearance-schemes">
            {APPEARANCE_COPY.schemes}
          </p>
          <div className="v2-swatches">
            {SCHEMES.map((scheme) => (
              <button
                key={scheme.id}
                type="button"
                className="v2-swatch"
                aria-pressed={appearance.schemeId === scheme.id}
                onClick={() =>
                  onChoose({ schemeId: scheme.id, background: null, accent: null })
                }
              >
                {/* Two chips: the page and the accent. Marks, not text, so the
                    scheme's own two colours are shown exactly as they are. */}
                <span className="v2-swatch-colours" aria-hidden="true">
                  <span style={{ background: scheme.background }} />
                  <span style={{ background: scheme.accent }} />
                </span>
                <span className="v2-swatch-name">{scheme.name}</span>
              </button>
            ))}
          </div>
        </div>

        <div
          className="v2-panel-group"
          role="group"
          aria-labelledby="v2-appearance-custom"
        >
          <p className="v2-panel-label" id="v2-appearance-custom">
            {APPEARANCE_COPY.custom}
            {custom ? "" : ` ${APPEARANCE_COPY.customHint}`}
          </p>
          <div className="v2-fields">
            <label className="v2-field">
              <span>{APPEARANCE_COPY.background}</span>
              <input
                type="color"
                value={background.toLowerCase()}
                onChange={(event) => pick("background", event.target.value)}
              />
            </label>
            <label className="v2-field">
              <span>{APPEARANCE_COPY.accent}</span>
              <input
                type="color"
                value={accent.toLowerCase()}
                onChange={(event) => pick("accent", event.target.value)}
              />
            </label>
          </div>
        </div>

        <div className="v2-panel-foot">
          <button
            type="button"
            className="v2-go"
            onClick={() => onChoose({ ...DEFAULT_APPEARANCE })}
          >
            {APPEARANCE_COPY.reset}
          </button>
          <p className="v2-panel-note">{APPEARANCE_COPY.stored}</p>
        </div>
      </div>
    </div>
  );
}
