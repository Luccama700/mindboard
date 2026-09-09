import { describe, expect, it } from "vitest";
import {
  eventDateKey,
  eventMinutes,
  wallMinutesToIso,
  wallTimeToIso,
} from "@/app/_components/event-time";
import { formatClockTime } from "@/app/_components/date-utils";

const VANCOUVER = "America/Vancouver";
const LONDON = "Europe/London";
const TOKYO = "Asia/Tokyo";

// The reported bug: a Vancouver-time schedule viewed from the UK. Google hands
// back the instant with Vancouver's offset; the grid must place it at the
// SETTINGS zone's wall clock, not the device's.
const VAN_9AM = "2026-09-08T09:00:00-07:00"; // tue 09:00 PDT = 16:00Z = 17:00 BST
const VAN_LATE = "2026-09-08T22:30:00-07:00"; // tue 22:30 PDT = wed 06:30 BST

describe("eventDateKey", () => {
  it("buckets a timed event on the day it falls on in the zone", () => {
    expect(eventDateKey(VAN_9AM, false, VANCOUVER)).toBe("2026-09-08");
    expect(eventDateKey(VAN_9AM, false, LONDON)).toBe("2026-09-08");
    // Late evening in Vancouver is already the next morning in London.
    expect(eventDateKey(VAN_LATE, false, VANCOUVER)).toBe("2026-09-08");
    expect(eventDateKey(VAN_LATE, false, LONDON)).toBe("2026-09-09");
  });

  it("keeps an all-day event on its bare date regardless of zone", () => {
    expect(eventDateKey("2026-09-08", true, LONDON)).toBe("2026-09-08");
    expect(eventDateKey("2026-09-08", true, TOKYO)).toBe("2026-09-08");
  });
});

describe("eventMinutes", () => {
  it("positions the block at the zone's wall clock", () => {
    expect(eventMinutes(VAN_9AM, VANCOUVER)).toBe(9 * 60);
    expect(eventMinutes(VAN_9AM, LONDON)).toBe(17 * 60);
    expect(eventMinutes(VAN_9AM, TOKYO)).toBe(1 * 60); // wed 01:00 JST
    expect(eventMinutes(VAN_LATE, LONDON)).toBe(6 * 60 + 30);
  });
});

describe("formatClockTime", () => {
  it("labels the instant in the zone, zero-padded 24h", () => {
    expect(formatClockTime(VAN_9AM, VANCOUVER)).toBe("09:00");
    expect(formatClockTime(VAN_9AM, LONDON)).toBe("17:00");
    expect(formatClockTime(VAN_LATE, LONDON)).toBe("06:30");
  });
});

describe("wallMinutesToIso / wallTimeToIso", () => {
  it("turns a zone wall time back into the UTC instant Google expects", () => {
    // Dropping a block at 10:00 on the Vancouver grid means 17:00Z.
    expect(wallMinutesToIso("2026-09-08", 10 * 60, VANCOUVER)).toBe(
      "2026-09-08T17:00:00.000Z",
    );
    expect(wallMinutesToIso("2026-09-08", 10 * 60, LONDON)).toBe(
      "2026-09-08T09:00:00.000Z",
    );
    expect(wallTimeToIso("2026-09-08", "10:15", TOKYO)).toBe(
      "2026-09-08T01:15:00.000Z",
    );
  });

  it("rolls minutes past midnight into the next day", () => {
    expect(wallMinutesToIso("2026-09-08", 25 * 60, VANCOUVER)).toBe(
      "2026-09-09T08:00:00.000Z",
    );
  });

  it("round-trips through the grid's own readers", () => {
    for (const zone of [VANCOUVER, LONDON, TOKYO]) {
      const iso = wallMinutesToIso("2026-09-08", 13 * 60 + 45, zone);
      expect(eventDateKey(iso, false, zone)).toBe("2026-09-08");
      expect(eventMinutes(iso, zone)).toBe(13 * 60 + 45);
    }
  });

  it("survives a DST boundary day in the zone", () => {
    // 2026-11-01: Vancouver falls back at 02:00. 09:00 PST = 17:00Z.
    expect(wallMinutesToIso("2026-11-01", 9 * 60, VANCOUVER)).toBe(
      "2026-11-01T17:00:00.000Z",
    );
    expect(eventMinutes("2026-11-01T09:00:00-08:00", VANCOUVER)).toBe(9 * 60);
  });
});
