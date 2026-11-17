"use client";

import { Fragment, type CSSProperties } from "react";

import { identityTokens } from "@/app/lib/v2/view/appearance";
import { CALENDAR_COPY, type CalendarChip } from "@/app/lib/v2/view/calendar";
import { useAppearance } from "../appearance-root";

/**
 * A calendar's colour as the four identity tokens, exactly as a list row takes
 * a group's colour (see list-row.tsx and `identityTokens`).
 *
 * A calendar with NO colour takes the accent, as the accent: handed in as the
 * colour itself rather than as null, because `identityTokens(null)` gives the
 * mark the scheme's edge grey, which is right for a list row with no group and
 * wrong for an event, which has to read as something on a calendar.
 */
export function calendarIdentity(
  color: string | null,
  tokens: Record<string, string>,
): Record<string, string> {
  return identityTokens(color ?? tokens["--v2-accent"] ?? null, tokens);
}

/**
 * One thing on the calendar: an event, or a block the app planned.
 *
 * READ ONLY. It is a list item and nothing else: no link, no button, no tab
 * stop, so a keyboard walks the links and the scrollers and never a hundred
 * chips.
 *
 * A TOOLTIP IN THE GRID ONLY, AND NEVER ON THE LIST ITEM. A placed chip clips,
 * so its whole text is a tooltip for a pointer. A `title` on the item itself
 * made a screen reader say the chip twice, its words and then the tooltip, so
 * the tooltip sits on one empty span that covers the chip and is hidden from the
 * accessibility tree: a pointer anywhere on the chip still finds it, and nothing
 * is named twice. An agenda chip shows all of its words and has no tooltip.
 *
 * The same element serves the agenda and the grid; the stylesheet decides
 * whether it flows or is placed, reading the four numbers below in the grid and
 * ignoring them in the agenda. Nothing here measures anything.
 *
 * ITS WORDS ARE IN READING ORDER: title, time, the calendar's name, the place.
 * A planned block has no calendar, so it says Planned in that slot. Each part is
 * its own element with a space between, so a screen reader hears four phrases
 * and not one run of text.
 */
export function CalendarChipItem({
  chip,
  placed,
}: {
  chip: CalendarChip;
  /** In the grid, where the chip is sized by its time and clips its words. */
  placed: boolean;
}) {
  const { tokens } = useAppearance();
  const planned = chip.kind === "planned";

  const lines: Array<[className: string, text: string | null]> = [
    ["v2-cal-chip-title", chip.title],
    ["v2-cal-chip-time", chip.time],
    ["v2-cal-chip-cal", planned ? CALENDAR_COPY.planned : chip.calendar],
    ["v2-cal-chip-loc", chip.location],
  ];
  const parts = lines.filter(
    (line): line is [className: string, text: string] => line[1] !== null && line[1] !== "",
  );

  // A planned block takes no identity: the stylesheet draws it in the accent,
  // outlined and unfilled, so it can never pass for something on the calendar.
  const style = {
    ...(planned ? {} : calendarIdentity(chip.color, tokens)),
    "--v2-cal-at": chip.top,
    "--v2-cal-span": chip.height,
    "--v2-cal-i": chip.column,
    "--v2-cal-n": chip.columnCount,
  } as CSSProperties;

  return (
    <li
      className="v2-cal-chip"
      data-kind={chip.kind}
      data-before={chip.continuesBefore ? "" : undefined}
      data-after={chip.continuesAfter ? "" : undefined}
      style={style}
    >
      {parts.map(([className, text], index) => (
        <Fragment key={className}>
          {index > 0 && " "}
          <span className={className}>{text}</span>
        </Fragment>
      ))}
      {placed && (
        <span
          className="v2-cal-chip-tip"
          aria-hidden="true"
          title={parts.map(([, text]) => text).join("\n")}
        />
      )}
    </li>
  );
}
