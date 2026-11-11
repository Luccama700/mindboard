// The tile engine: a tiled workspace as pure values.
//
// Panes always fill the workspace, dividers resize, panes dock against each
// other or stack as tabs, three named arrangements, one saved layout per screen
// size. Nothing here renders, stores or measures anything: a screen calls these
// functions, draws the rectangles they return, and hands whatever came out of
// the browser to parseTileSet.
//
//   types.ts     the shapes
//   tree.ts      every operation on the tree, each one pure and immutable
//   geometry.ts  tree to rectangles, and pointer to drop zone
//   catalog.ts   the five panes, the three arrangements, the six default trees
//   store.ts     what is saved, and the parser that cannot return a broken screen
//
// The geometry module is NOT called layout.ts: Next reads any layout file under
// app/ as a route layout, whatever folder it is in, and the build fails on one
// that exports functions instead of a component.

export * from "./types";
export * from "./tree";
export * from "./geometry";
export * from "./catalog";
export * from "./store";
