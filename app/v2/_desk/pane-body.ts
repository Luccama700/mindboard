// What a pane's content is, to the desk: a component that fills the box it is
// given and reads its own data from the providers above it.
//
// A body never measures itself and never asks how wide the window is. Its
// container is named `v2-pane` and it answers to that container's own size, so
// the same body is right in a 230 px tab and in a 1300 px half of the screen.

import type { ReactNode } from "react";

export interface PaneBodyProps {
  /**
   * The view options the user set for this pane in this layout, key to value.
   * A key that is absent has its default. Never trusted further than "is this
   * one of the choices": the body falls back to the default for anything else.
   */
  options: Readonly<Record<string, string>>;
}

export type PaneBody = (props: PaneBodyProps) => ReactNode;
