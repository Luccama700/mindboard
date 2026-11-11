// What the first paint needs, in a cookie, and nothing else.
//
// WHY ONLY PART OF THE DESK. The server draws the first paint before any script
// runs, so the layout it draws has to arrive with the request. The whole saved
// desk does not fit a cookie (it was measured), and most of it is layouts that
// are not open. So the cookie carries the rail, which the server draws in full,
// and the open layout's arrangement on each screen class it was changed on,
// because the server does not know the window's width. Everything else, other
// layouts' arrangements and every closed pane's place, stays in the browser's
// own storage and arrives once script runs.
//
// THE TEXT. Seven fields joined by !:
//
//   1                                    the version of this text
//   today~week~u1.quests.Deep'20work     the rail, in order: a built in layout
//                                        is its id, one of the user's is its
//                                        id, base and title joined by .
//   week                                 the hidden layouts, in the order they
//                                        were hidden, joined by ~
//   u1                                   the open layout
//   <compact> <regular> <wide>           the open layout's arrangement on each
//                                        class (codec.ts), empty when it is
//                                        the default
//
// A title is the only free text. Its letters and digits are kept, and every
// other byte of its UTF-8 is written as ' and two hex digits, so no title can
// reach a separator, and every character of the cookie is one that
// encodeURIComponent leaves alone and a cookie may hold.
//
// READING IT BACK IS THE ENGINE'S PARSER. The reader only splits the text into
// the plain value parseTileSet reads from storage and hands it over, so every
// repair (an unknown layout, a pane the catalog does not know, a slot equal to
// its default, a focus) is the parser's, and there is one definition of a
// sound desk rather than two. Text that does not follow the shape above, that
// is longer than the cookie may be, or that is of another version, is the
// empty desk.
//
// Pure. No DOM, no storage, no clock, no randomness: the page reads and writes
// the cookie and hands the value here.

import { BUILT_IN_LAYOUTS } from "./catalog";
import { encodeArrangement, readArrangement } from "./codec";
import { EMPTY_TILE_SET, arrangementOf, isChanged, parseTileSet } from "./store";
import type { TileSet } from "./store";
import type { LayoutId, ScreenClass } from "./types";

export const TILE_COOKIE = "mb-v2-desk";

/**
 * The longest value written or read. A browser keeps about 4096 bytes for the
 * name, the value and the attributes together; this leaves room for the rest.
 */
export const TILE_COOKIE_MAX = 3800;

const VERSION = "1";
const FIELD = "!";
const ITEM = "~";
const PART = ".";
const ESCAPE = "'";

/** The classes, in the order their fields are written. */
const CLASSES: readonly ScreenClass[] = ["compact", "regular", "wide"];

/** Version, rail, hidden, current, then one field per class. */
const FIELD_COUNT = 4 + CLASSES.length;

const HEX = "0123456789abcdef";

function isAsciiLetterOrDigit(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)
  );
}

/** A layout id or base as the cookie spells it: [a-z0-9], at least one. Whether it is one is the parser's call. */
function isLayoutToken(value: unknown): value is LayoutId {
  if (typeof value !== "string" || value.length === 0) return false;
  for (let at = 0; at < value.length; at += 1) {
    const char = value[at];
    if (!((char >= "a" && char <= "z") || (char >= "0" && char <= "9"))) return false;
  }
  return true;
}

function isBuiltIn(id: LayoutId): boolean {
  return BUILT_IN_LAYOUTS.some((meta) => meta.id === id);
}

// ----------------------------------------------------------------- titles

/** One code point as the bytes of its UTF-8. */
function utf8(point: number): number[] {
  if (point < 0x80) return [point];
  if (point < 0x800) return [0xc0 | (point >> 6), 0x80 | (point & 0x3f)];
  if (point < 0x10000) {
    return [0xe0 | (point >> 12), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f)];
  }
  return [
    0xf0 | (point >> 18),
    0x80 | ((point >> 12) & 0x3f),
    0x80 | ((point >> 6) & 0x3f),
    0x80 | (point & 0x3f),
  ];
}

/**
 * A title in letters, digits and escapes. Safe for any string: half of a
 * surrogate pair standing alone has no UTF-8 and is left out, as cleanTitle
 * leaves it out.
 */
function writeTitle(title: string): string {
  let out = "";
  for (let at = 0; at < title.length; at += 1) {
    const unit = title.charCodeAt(at);
    let point = unit;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = title.charCodeAt(at + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) continue;
      point = 0x10000 + ((unit - 0xd800) << 10) + (next - 0xdc00);
      at += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      continue;
    }
    for (const byte of utf8(point)) {
      out += isAsciiLetterOrDigit(byte)
        ? String.fromCharCode(byte)
        : `${ESCAPE}${HEX[byte >> 4]}${HEX[byte & 0x0f]}`;
    }
  }
  return out;
}

function hexValue(char: string | undefined): number {
  if (char === undefined) return -1;
  const at = HEX.indexOf(char.toLowerCase());
  return char.length === 1 ? at : -1;
}

/** The bytes a title was written as, or null when it is not letters, digits and whole escapes. */
function titleBytes(text: string): number[] | null {
  const bytes: number[] = [];
  for (let at = 0; at < text.length; at += 1) {
    const code = text.charCodeAt(at);
    if (isAsciiLetterOrDigit(code)) {
      bytes.push(code);
      continue;
    }
    if (text[at] !== ESCAPE) return null;
    const high = hexValue(text[at + 1]);
    const low = hexValue(text[at + 2]);
    if (high < 0 || low < 0) return null;
    bytes.push(high * 16 + low);
    at += 2;
  }
  return bytes;
}

function isContinuation(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}

/**
 * UTF-8 back to a string, or null for anything that is not well formed: a
 * sequence cut short, a byte where none may start, a code point written in
 * more bytes than it needs, half of a surrogate pair, or a point past U+10FFFF.
 */
function fromUtf8(bytes: readonly number[]): string | null {
  let out = "";
  let at = 0;
  while (at < bytes.length) {
    const lead = bytes[at];
    let length: number;
    let point: number;
    let least: number;
    if (lead < 0x80) {
      length = 1;
      point = lead;
      least = 0;
    } else if (lead >= 0xc2 && lead <= 0xdf) {
      length = 2;
      point = lead & 0x1f;
      least = 0x80;
    } else if (lead >= 0xe0 && lead <= 0xef) {
      length = 3;
      point = lead & 0x0f;
      least = 0x800;
    } else if (lead >= 0xf0 && lead <= 0xf4) {
      length = 4;
      point = lead & 0x07;
      least = 0x10000;
    } else {
      return null;
    }
    for (let next = 1; next < length; next += 1) {
      const byte = bytes[at + next];
      if (!isContinuation(byte)) return null;
      point = (point << 6) | ((byte as number) & 0x3f);
    }
    if (point < least || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) return null;
    out += String.fromCodePoint(point);
    at += length;
  }
  return out;
}

function readTitle(text: string): string | null {
  const bytes = titleBytes(text);
  return bytes === null ? null : fromUtf8(bytes);
}

// ---------------------------------------------------------------- writing

/**
 * The cookie's value for this desk, or null when it cannot carry it: longer
 * than TILE_COOKIE_MAX, or a layout id the cookie cannot spell (no desk the
 * engine made has one). An arrangement is written for a class only when the
 * engine says that class of the open layout is changed.
 */
export function encodeTileCookie(set: TileSet): string | null {
  const rail: string[] = [];
  for (const meta of set.layouts) {
    if (!isLayoutToken(meta.id)) return null;
    if (isBuiltIn(meta.id)) {
      rail.push(meta.id);
      continue;
    }
    if (!isLayoutToken(meta.base)) return null;
    rail.push([meta.id, meta.base, writeTitle(meta.title)].join(PART));
  }
  if (!set.hidden.every(isLayoutToken) || !isLayoutToken(set.current)) return null;
  const arrangements = CLASSES.map((cls) =>
    isChanged(set, set.current, cls) ? encodeArrangement(arrangementOf(set, set.current, cls)) : "",
  );
  const text = [VERSION, rail.join(ITEM), set.hidden.join(ITEM), set.current, ...arrangements].join(
    FIELD,
  );
  return text.length > TILE_COOKIE_MAX ? null : text;
}

// ---------------------------------------------------------------- reading

/** A field of items joined by ~: none when it is empty, null when an item is. */
function items(field: string): string[] | null {
  if (field.length === 0) return [];
  const listed = field.split(ITEM);
  return listed.every((item) => item.length > 0) ? listed : null;
}

/** The rail as the plain list the parser reads, or null when an entry is not in the shape above. */
function readRail(field: string): Array<Record<string, string>> | null {
  const entries = items(field);
  if (entries === null) return null;
  const out: Array<Record<string, string>> = [];
  for (const entry of entries) {
    const parts = entry.split(PART);
    if (parts.length === 1) {
      if (!isLayoutToken(parts[0])) return null;
      out.push({ id: parts[0] });
      continue;
    }
    if (parts.length !== 3) return null;
    const [id, base, written] = parts;
    if (!isLayoutToken(id) || !isLayoutToken(base)) return null;
    const title = readTitle(written);
    if (title === null) return null;
    out.push({ id, base, title });
  }
  return out;
}

function readIds(field: string): LayoutId[] | null {
  const listed = items(field);
  if (listed === null || !listed.every(isLayoutToken)) return null;
  return listed;
}

/**
 * The desk a cookie's value describes, as the engine's parser reads it: the
 * rail, and the open layout's arrangements, every one repaired by the parser.
 * Absent, malformed, too long or of another version, the empty desk.
 */
export function decodeTileCookie(value: string | undefined): TileSet {
  if (typeof value !== "string" || value.length > TILE_COOKIE_MAX) return EMPTY_TILE_SET;
  const fields = value.split(FIELD);
  if (fields.length !== FIELD_COUNT || fields[0] !== VERSION) return EMPTY_TILE_SET;
  const layouts = readRail(fields[1]);
  const hidden = readIds(fields[2]);
  const current = fields[3];
  if (layouts === null || hidden === null || !isLayoutToken(current)) return EMPTY_TILE_SET;

  const classes: Array<[ScreenClass, Record<string, unknown>]> = [];
  for (let index = 0; index < CLASSES.length; index += 1) {
    const text = fields[4 + index];
    if (text.length === 0) continue;
    const read = readArrangement(text);
    if (read === null) return EMPTY_TILE_SET;
    classes.push([CLASSES[index], read]);
  }

  return parseTileSet({
    version: EMPTY_TILE_SET.version,
    layouts,
    hidden,
    current,
    // Built with Object.fromEntries, so the open layout's id is an own key of
    // the record whatever word it is; the parser reads only the layouts it kept.
    slots: classes.length === 0 ? {} : Object.fromEntries([[current, Object.fromEntries(classes)]]),
  });
}
