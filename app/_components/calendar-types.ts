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
