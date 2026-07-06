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
    };
