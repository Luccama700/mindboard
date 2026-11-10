// The calendar window's engine, in one import.
//
// Pure except `CalendarPort`, and the only implementation of that port on this
// branch is the fake. Nothing here imports Google or Postgres, so a page, a
// test or a route can take the whole engine without reaching anything real.

export {
  MINUTES_PER_DAY,
  MIN_EVENT_MINUTES,
  SNAP_STEP_MINUTES,
  fromEngineEvent,
} from "@/app/lib/v2/calendar/types";
export type {
  AllDayPlaced,
  CalEvent,
  DayLayout,
  TimedPlaced,
} from "@/app/lib/v2/calendar/types";

export {
  layoutAllDay,
  layoutDay,
  minuteInstant,
  weekOf,
  weekRange,
} from "@/app/lib/v2/calendar/grid";

export {
  DRAFT_ID_PREFIX,
  draftAt,
  isDraftId,
  moveAllDay,
  moveTimed,
  resizeTimed,
  snapMinute,
} from "@/app/lib/v2/calendar/edit";

export { applyOp, canonicalEvents, commit, invertOp, settle } from "@/app/lib/v2/calendar/ops";
export type {
  CalendarChange,
  CalendarOp,
  CommitFailure,
  CommitResult,
} from "@/app/lib/v2/calendar/ops";

export {
  CalendarConflictError,
  CalendarMissingError,
  CalendarReadOnlyError,
} from "@/app/lib/v2/calendar/port";
export type {
  CalendarChanges,
  CalendarPort,
  CalendarRange,
} from "@/app/lib/v2/calendar/port";

export { FakeCalendar } from "@/app/lib/v2/calendar/fake-port";
export type { FakeCalendarOptions } from "@/app/lib/v2/calendar/fake-port";
