import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { EventRow, type VirtualEvent } from "@/app/_components/event-row";

const timedEvent: VirtualEvent = {
  id: "event-1",
  title: "Design review",
  startDateKey: "2026-05-24",
  startTime: "09:00",
  endTime: "10:00",
  allDay: false,
  groupName: "work",
  groupColor: "#3C8FFF",
};

describe("EventRow", () => {
  afterEach(() => {
    cleanup();
  });

  test("renders a linked calendar event with group, time, and date", () => {
    render(<EventRow event={timedEvent} />);

    expect(screen.getByText("Design review")).toBeDefined();
    expect(screen.getByText("work")).toBeDefined();
    expect(screen.getByText("09:00 – 10:00")).toBeDefined();
    expect(screen.getByText("May 24")).toBeDefined();
  });

  test("can hide the date when the surrounding section already labels it", () => {
    render(<EventRow event={timedEvent} hideDate />);

    expect(screen.getByText("Design review")).toBeDefined();
    expect(screen.queryByText("May 24")).toBeNull();
  });
});
