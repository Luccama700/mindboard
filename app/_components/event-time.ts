// Zone-aware readers/writers for Google event boundaries in the calendar
// client. Google hands back instants (a dateTime with an offset); which DAY
// and which HOUR a block lands on must come from the user's stored zone, not
// the device's — a Vancouver 09:00 viewed from London is still 09:00 on the
// grid. `timeZone` null = the device clock (the pre-settings behavior).
import {
  zonedClockMinutes,
  zonedDateKey,
  zonedWallTimeToUtcMs,
} from "@/app/lib/snapshots/zoned-time";

// The day an event is bucketed under. All-day events carry a bare date.
export function eventDateKey(
  start: string,
  allDay: boolean,
  timeZone: string | null,
): string {
  if (allDay) return start.slice(0, 10);
  return zonedDateKey(Date.parse(start), timeZone);
}

// Minutes past the zone's midnight for a timed boundary (0..1439).
export function eventMinutes(value: string, timeZone: string | null): number {
  return zonedClockMinutes(Date.parse(value), timeZone);
}

// A grid drop (day + minutes past midnight, may exceed 1439 after a shift)
// back to the UTC instant Google is sent.
export function wallMinutesToIso(
  dateKey: string,
  minutes: number,
  timeZone: string | null,
): string {
  return new Date(
    zonedWallTimeToUtcMs(dateKey, 0, minutes, timeZone),
  ).toISOString();
}

// A date + "HH:MM" pair from the edit panel back to the UTC instant.
export function wallTimeToIso(
  dateKey: string,
  time: string,
  timeZone: string | null,
): string {
  const [hours, minutes] = time.split(":").map(Number);
  return new Date(
    zonedWallTimeToUtcMs(dateKey, hours, minutes, timeZone),
  ).toISOString();
}
