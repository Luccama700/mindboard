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
 *
 * `labelledBy` names the scroller after whatever holds the box: on the desk,
 * the frame's title, so a keyboard that lands on it hears which pane it is in.
 * A named scroller is a `group`, because an element with no role may not carry
 * a name. Without a name it has no role, so the gallery's markup is unchanged.
 */
export function PaneBox({
  paneId,
  children,
  style,
  labelledBy,
}: {
  paneId: string;
  children: ReactNode;
  style?: CSSProperties;
  labelledBy?: string;
}) {
  return (
    <div className="v2-pane" data-pane={paneId} style={style}>
      <div
        className="v2-pane-body"
        tabIndex={0}
        role={labelledBy === undefined ? undefined : "group"}
        aria-labelledby={labelledBy}
      >
        {children}
      </div>
    </div>
  );
}
