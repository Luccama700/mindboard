export type CalendarItem =
  | {
      kind: "task";
      id: string;
      title: string;
      color: string;
      group: string;
      dueTime: string | null; // "HH:MM:SS" — renders as a block in the hour grid
      durationMin: number | null;
      pushed: boolean; // mirrored to a real Google Calendar event
    }
  | {
      kind: "event";
      id: string;
      eventId: string;
      calendarId: string;
      title: string;
      start: string;
      end: string;
      allDay: boolean;
      calendar: string;
      color: string;
      writable: boolean;
      startTimeZone: string | null;
      endTimeZone: string | null;
    }
  | {
      kind: "finance";
      id: string;
      title: string;
      color: string;
      direction: "in" | "out";
      amount: number;
      currency: string;
      category: string;
    }
  | {
      // A virtual occurrence of a recurring task. Timed rules render as a
      // dashed, non-draggable block; untimed rules ride the due row (and are
      // soft-placed by the gap planner). plannedStart/plannedMinutes are filled
      // by that planner — always null until it lands. slotStart/slotMinutes are
      // an APPROVED per-occurrence commitment (migration 0042): when present they
      // override dueTime for that day and count as busy time (never advisory).
      kind: "rtask";
      id: string; // `rtask:${ruleId}:${dateKey}`
      ruleId: string;
      title: string;
      color: string;
      dueTime: string | null; // "HH:MM:SS"; null = untimed
      durationMin: number | null;
      plannedStart: string | null; // "HH:MM:SS" advisory placement
      plannedMinutes: number | null;
      slotStart: string | null; // "HH:MM:SS" committed slot time (overrides dueTime)
      slotMinutes: number | null;
      scheduleLabel: string; // "every day", "mon/wed/fri", …
      done: boolean;
    };
