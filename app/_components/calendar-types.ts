export type CalendarItem =
  | {
      kind: "task";
      id: string;
      title: string;
      color: string;
      group: string;
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
    };
