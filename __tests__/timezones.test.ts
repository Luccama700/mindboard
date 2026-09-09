import { describe, expect, it } from "vitest";
import {
  groupTimeZones,
  listTimeZones,
  utcOffsetLabel,
  UTC_REGION,
} from "@/app/_components/timezones";

const SUMMER = new Date("2026-09-06T12:00:00Z");
const WINTER = new Date("2026-01-15T12:00:00Z");

describe("utcOffsetLabel", () => {
  it("renders the zone's offset at the given instant", () => {
    expect(utcOffsetLabel("America/Vancouver", SUMMER)).toBe("UTC-07:00");
    expect(utcOffsetLabel("America/Vancouver", WINTER)).toBe("UTC-08:00");
    expect(utcOffsetLabel("Asia/Kolkata", SUMMER)).toBe("UTC+05:30");
    expect(utcOffsetLabel("Asia/Tokyo", SUMMER)).toBe("UTC+09:00");
  });

  it("spells UTC itself as a zero offset", () => {
    expect(utcOffsetLabel("UTC", SUMMER)).toBe("UTC+00:00");
    expect(utcOffsetLabel("Europe/London", WINTER)).toBe("UTC+00:00");
  });

  it("returns null for an unknown zone instead of throwing", () => {
    expect(utcOffsetLabel("Nowhere/Fake", SUMMER)).toBeNull();
  });
});

describe("listTimeZones", () => {
  it("returns the runtime's IANA list with UTC present", () => {
    const zones = listTimeZones();
    expect(zones.length).toBeGreaterThan(100);
    expect(zones).toContain("UTC");
    expect(zones).toContain("America/Vancouver");
    expect(zones).toContain("Asia/Tokyo");
    // three-segment ids must survive intact
    expect(zones).toContain("America/Argentina/Salta");
  });
});

describe("groupTimeZones", () => {
  it("groups by region with utc first, then the preferred region order", () => {
    const groups = groupTimeZones(
      [
        "Europe/Paris",
        "Asia/Tokyo",
        "America/Vancouver",
        "UTC",
        "Africa/Lagos",
        "America/New_York",
      ],
      SUMMER,
    );
    expect(groups.map((g) => g.region)).toEqual([
      UTC_REGION,
      "America",
      "Europe",
      "Asia",
      "Africa",
    ]);
    expect(groups[1].zones.map((z) => z.id)).toEqual([
      "America/New_York",
      "America/Vancouver",
    ]);
  });

  it("labels each zone by city with underscores as spaces and the offset", () => {
    const [america] = groupTimeZones(
      ["America/Argentina/Buenos_Aires", "America/Los_Angeles"],
      SUMMER,
    );
    expect(america.zones).toEqual([
      { id: "America/Argentina/Buenos_Aires", label: "Argentina/Buenos Aires (UTC-03:00)" },
      { id: "America/Los_Angeles", label: "Los Angeles (UTC-07:00)" },
    ]);
  });

  it("puts unknown regions after the preferred ones, alphabetically", () => {
    const groups = groupTimeZones(
      ["Zzz/One", "Etc/GMT+5", "Mars/Olympus", "Europe/Rome"],
      SUMMER,
    );
    expect(groups.map((g) => g.region)).toEqual(["Europe", "Etc", "Mars", "Zzz"]);
    expect(groups[2].zones[0].label).toBe("Olympus");
  });

  it("dedupes repeated ids", () => {
    const groups = groupTimeZones(["UTC", "UTC"], SUMMER);
    expect(groups).toHaveLength(1);
    expect(groups[0].zones).toHaveLength(1);
  });
});
