// IANA zone list for the settings timezone dropdown. Pure: callers pass `now`
// so offset labels are computed for a known instant and tests stay
// deterministic. Grouped by region (the part before the first slash) so a
// native <select> can render <optgroup>s that read as headers in the iOS
// wheel picker.

export type TimezoneOption = { id: string; label: string };
export type TimezoneGroup = { region: string; zones: TimezoneOption[] };

// No-slash zones (UTC) land in this group, which always sorts first.
export const UTC_REGION = "utc";

const REGION_ORDER = [
  UTC_REGION,
  "America",
  "Europe",
  "Asia",
  "Africa",
  "Australia",
  "Pacific",
  "Atlantic",
  "Indian",
  "Antarctica",
  "Arctic",
  "Etc",
];

// Used only when the runtime lacks Intl.supportedValuesOf (old Safari).
const FALLBACK_ZONES = [
  "UTC",
  "America/Vancouver",
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Toronto",
  "America/Mexico_City",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Lisbon",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Moscow",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Pacific/Auckland",
];

export function listTimeZones(): string[] {
  try {
    if (typeof Intl.supportedValuesOf === "function") {
      const zones = Intl.supportedValuesOf("timeZone");
      if (zones.length > 0) {
        return zones.includes("UTC") ? zones : ["UTC", ...zones];
      }
    }
  } catch {
    // fall through to the static list
  }
  return FALLBACK_ZONES;
}

// "UTC-07:00" / "UTC+05:30" / "UTC+00:00"; null when the zone is unknown.
export function utcOffsetLabel(timeZone: string, now: Date): string | null {
  try {
    const part = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "longOffset",
    })
      .formatToParts(now)
      .find((p) => p.type === "timeZoneName")?.value;
    if (!part) return null;
    if (part === "GMT") return "UTC+00:00";
    return part.replace(/^GMT/, "UTC");
  } catch {
    return null;
  }
}

function regionOf(id: string): string {
  const slash = id.indexOf("/");
  return slash === -1 ? UTC_REGION : id.slice(0, slash);
}

function cityOf(id: string): string {
  const slash = id.indexOf("/");
  return (slash === -1 ? id : id.slice(slash + 1)).replace(/_/g, " ");
}

function regionRank(region: string): number {
  const index = REGION_ORDER.indexOf(region);
  return index === -1 ? REGION_ORDER.length : index;
}

export function groupTimeZones(zones: string[], now: Date): TimezoneGroup[] {
  const byRegion = new Map<string, TimezoneOption[]>();
  for (const id of new Set(zones)) {
    const region = regionOf(id);
    const offset = utcOffsetLabel(id, now);
    const city = cityOf(id);
    const label = offset ? `${city} (${offset})` : city;
    const bucket = byRegion.get(region);
    if (bucket) bucket.push({ id, label });
    else byRegion.set(region, [{ id, label }]);
  }
  return [...byRegion.entries()]
    .sort(([a], [b]) => regionRank(a) - regionRank(b) || a.localeCompare(b))
    .map(([region, options]) => ({
      region,
      zones: options.sort((a, b) => a.id.localeCompare(b.id)),
    }));
}
