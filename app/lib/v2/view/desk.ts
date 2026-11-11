// The desk's words, and what the pane gallery is asked for.
//
// Pure: no DOM, no storage, no clock. The gallery page reads its search
// parameters through `galleryRequest`, so what a URL can ask for is decided in
// one place a test can reach without rendering a page.

/** Every static string the desk prints. Later tasks add theirs. */
export const DESK_COPY = {
  heading: "Desk",
  /** A pane id the desk has no body for yet, or one it does not know at all. */
  notBuilt: "This pane is not built yet.",
  /** A source that cannot speak about quests at all. */
  noQuests: "No quests in this copy.",
  /** A source that holds no money data. */
  noMoney: "No money data in this copy.",
  /** The past-due pane when nothing is past its date. */
  nothingPastDue: "Nothing is past its date.",
  /** The not-today pane when everything the planner wanted fit. */
  allFitToday: "Everything fit today.",
  /** The gallery's one line over the box. `{pane}`, `{w}` and `{h}` are filled. */
  gallery: "{pane}, {w} by {h} px",
  /** The rail, as a landmark. */
  rail: "Desk",
  /** The layouts, on the rail and in the phone's list. */
  layouts: "Layouts",
  /** The pane list on the rail. */
  panes: "Panes",
  /** The pane list's three groups, by the catalog's group. */
  groupDay: "Day",
  groupQuests: "Quests",
  groupMoney: "Money",
  /** Read after a pane that is open in the layout on screen. */
  open: "open",
  /** The phone's bottom bar: the panes of the layout on screen. */
  bar: "Panes in this layout",
  /** Read before the layout's name on the phone's top bar button. */
  layoutButton: "Layout",
  /** A divider's name: the panes on either side of it. `{first}` and `{second}` are filled. */
  divider: "Resize {first} and {second}",
  /** The close control on a pane's tab, or beside its title. `{pane}` is filled. */
  closePane: "Close {pane}",
  /** The maximize control in a pane's header, pressed while the pane fills the desk. */
  maximizePane: "Maximize {pane}",
  /** What the live region says after a change on the desk. `{pane}` is filled. */
  paneClosed: "{pane} closed.",
  paneOpened: "{pane} opened.",
  paneMaximized: "{pane} fills the desk.",
  paneRestored: "{pane} is back in its place.",
  /** A desk too large for the cookie: kept in this browser, but the server cannot draw it. */
  savedHereOnly: "Layout saved on this device. The first paint may show the default.",

  // Managing the layouts, on the rail and in the phone's list. `{layout}` is filled.
  /** The control that turns the list of layouts into the list to manage them. */
  editLayouts: "Edit",
  editLayoutsName: "Edit layouts",
  doneEditing: "Done",
  doneEditingName: "Done editing layouts",
  /** Read after a layout that differs from its default on this screen size. */
  changed: "changed",
  /** Shown after a built in layout that is hidden from the list. */
  hidden: "hidden",
  moveUp: "Move up",
  moveDown: "Move down",
  rename: "Rename",
  renameField: "New name for {layout}",
  save: "Save",
  cancel: "Cancel",
  remove: "Delete",
  confirmRemove: "Delete {layout}?",
  keep: "Keep",
  hide: "Hide",
  show: "Show",
  reset: "Reset this layout",
  confirmReset: "Put {layout} back as it started, on this screen size?",
  resetConfirm: "Reset",
  newLayout: "New layout from this one",
  newField: "Name for the new layout",
  /** Said where "New layout from this one" would be, once the desk is full. */
  layoutLimit: "A desk holds twelve layouts. Delete one of your own to make room for another.",
  layoutMade: "Made {layout}.",
  layoutRenamed: "Renamed to {layout}.",
  layoutRemoved: "{layout} deleted.",
  layoutMovedUp: "{layout} moved up.",
  layoutMovedDown: "{layout} moved down.",
  layoutHidden: "{layout} hidden.",
  layoutShown: "{layout} shown.",
  layoutReset: "{layout} is back as it started.",

  // The phone's list of the panes in the layout on screen. `{pane}` is filled.
  arrangePanes: "Arrange",
  arrangePanesName: "Arrange the panes in this layout",
  inLayout: "In this layout",
  notInLayout: "Not in this layout",
  paneMovedUp: "{pane} moved up.",
  paneMovedDown: "{pane} moved down.",
  paneHidden: "{pane} hidden.",
  paneShown: "{pane} shown.",
} as const;

/**
 * One of the desk's sentences with its slots filled: `{pane}`, `{first}`,
 * `{second}`, `{layout}`. One pass with a function, for galleryLine's reason: a
 * title is filled in as plain text, and a slot written inside a title stays as
 * it is.
 */
export function deskLine(template: string, slots: Readonly<Record<string, string>>): string {
  return template.replace(/\{(pane|first|second|layout)\}/g, (whole, name: string) =>
    Object.hasOwn(slots, name) ? slots[name] : whole,
  );
}

/**
 * The gallery's one line: which pane, and the size of its box.
 *
 * ONE PASS, WITH A FUNCTION. The pane id is whatever the URL said, so it is
 * filled in as plain text: a replacement string would expand `$&` and its kin,
 * and filling the slots one after another would fill a `{w}` written inside the
 * id with the real width.
 */
export function galleryLine(pane: string, width: number, height: number): string {
  const slots: Record<string, string> = { pane, w: String(width), h: String(height) };
  return DESK_COPY.gallery.replace(/\{(pane|w|h)\}/g, (_slot, name: string) => slots[name]);
}

/** The gallery's box in px: the default, and the bounds each side is held to. */
export const GALLERY_SIZE = { width: 464, height: 600, min: 160, max: 2400 } as const;

/** The pane the gallery draws when the URL names none. */
const DEFAULT_PANE = "today";

/** Where a pane's options sit in the gallery's URL: `?o.<key>=<value>`. */
const OPTION_PREFIX = "o.";

type Search = Record<string, string | string[] | undefined>;

/** A pane's view options as a URL or a stored layout gave them: key and value, in order. */
export type PaneOptionPairs = ReadonlyArray<readonly [string, string]>;

/**
 * The options a body is handed: key to value, in an object with NO PROTOTYPE,
 * frozen.
 *
 * The keys come from a URL or a stored layout. In a plain object a key such as
 * `hasOwnProperty` would shadow the method a body might call, and an inherited
 * name such as `constructor` would read as an option nobody set. Here every key
 * is data and nothing else is there. A body reads one only as `options[key]`,
 * compared against its own list of choices.
 *
 * Built where it is used, in the browser: a server component cannot hand a
 * client component an object with no prototype (React refuses it), so the page
 * hands the pairs across and the client builds this from them.
 */
export function paneOptions(pairs: PaneOptionPairs): Readonly<Record<string, string>> {
  const options = Object.create(null) as Record<string, string>;
  for (const [key, value] of pairs) options[key] = value;
  return Object.freeze(options);
}

/** What one request to the gallery asked for, read and held to its bounds. */
export interface GalleryRequest {
  /** As given: an id the registry does not know draws NotBuilt, and is named. */
  paneId: string;
  width: number;
  height: number;
  /** The pane's view options, as pairs (see `paneOptions`). The body judges each one. */
  options: PaneOptionPairs;
  /** `?stale=1`: the sample's money as it looks when the ledger is old. */
  stale: boolean;
  /** The day a snapshot is asked to plan, or null. The source judges it. */
  date: string | null;
  /** The week a calendar link asked for, or null. The source judges it. */
  week: string | null;
}

/**
 * One parameter, as a string. A repeated parameter arrives as a list, which is
 * not any one value, so it is read as absent rather than as its first entry.
 */
function oneOf(value: string | string[] | undefined): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * One side of the box: a whole number of px, held to the bounds. Anything that
 * is not plainly a whole number (empty, signed, a decimal, an exponent, a list)
 * is the default, because a parameter is in a URL and a bad one must not cost
 * the page.
 */
function side(value: string | string[] | undefined, fallback: number): number {
  const text = oneOf(value);
  if (text === null || !/^\d+$/.test(text)) return fallback;
  return Math.min(GALLERY_SIZE.max, Math.max(GALLERY_SIZE.min, Number(text)));
}

export function galleryRequest(asked: Search): GalleryRequest {
  const options: Array<readonly [string, string]> = [];
  for (const [name, value] of Object.entries(asked)) {
    if (!name.startsWith(OPTION_PREFIX) || name.length === OPTION_PREFIX.length) continue;
    const text = oneOf(value);
    if (text !== null) options.push([name.slice(OPTION_PREFIX.length), text]);
  }
  return {
    paneId: oneOf(asked.pane) ?? DEFAULT_PANE,
    width: side(asked.w, GALLERY_SIZE.width),
    height: side(asked.h, GALLERY_SIZE.height),
    options,
    stale: oneOf(asked.stale) === "1",
    date: oneOf(asked.date),
    week: oneOf(asked.week),
  };
}

/**
 * What every link inside the gallery carries back besides its own parameter, so
 * a calendar's week link redraws the same pane at the same size with the same
 * options. The sizes are the ones the box was drawn at, not the raw ones.
 *
 * The `date` is carried only when it is the day that was planned, exactly as
 * Today carries it: a date the source ignored changed nothing, and a link that
 * dropped one it used would plan the clock's day instead.
 */
export function galleryKeep(request: GalleryRequest, plannedDate: string): Record<string, string> {
  const keep: Record<string, string> = {
    pane: request.paneId,
    w: String(request.width),
    h: String(request.height),
  };
  for (const [key, value] of request.options) keep[`${OPTION_PREFIX}${key}`] = value;
  if (request.stale) keep.stale = "1";
  if (request.date !== null && request.date === plannedDate) keep.date = request.date;
  return keep;
}
