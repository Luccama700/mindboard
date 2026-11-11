import type { CSSProperties, ReactNode } from "react";

/**
 * The box a body is drawn in: the `v2-pane` container, with the scroller every
 * body shares.
 *
 * TWO ELEMENTS, ONE JOB EACH. The outer one is the size container a body's
 * leaves answer to (`container-type: inline-size`, named `v2-pane`, desk.css)
 * and fills whatever holds it; the inner one scrolls the body on the block
 * axis, so a tall body (the day's line in a short box) scrolls inside the pane
 * and never the page.
 *
 * The scroller takes focus, as a side list does, so a keyboard can reach a box
 * whose body has nothing to press and still scroll it. Its ring is drawn inside
 * the box, where the box's own edge cannot cut it off.
 *
 * `style` is how the holder sizes the box (the gallery's fixed width and
 * height); the box itself never measures anything.
 */
export function PaneBox({
  paneId,
  children,
  style,
}: {
  paneId: string;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div className="v2-pane" data-pane={paneId} style={style}>
      <div className="v2-pane-body" tabIndex={0}>
        {children}
      </div>
    </div>
  );
}
