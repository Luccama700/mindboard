"use client";

import { useMemo, useState, useSyncExternalStore, useTransition } from "react";
import { savePreferences } from "@/app/actions/settings";
import { Button } from "@/app/_components/ui";
import { INPUT_CLASS } from "@/app/_components/ui";
import { groupTimeZones, listTimeZones } from "@/app/_components/timezones";

// The zone list comes from the runtime's ICU data, which differs between the
// Node build and the browser, so it is only rendered after hydration — the
// server HTML carries just the saved value as a single option.
const subscribeNoop = () => () => {};
function useIsClient() {
  return useSyncExternalStore(
    subscribeNoop,
    () => true,
    () => false,
  );
}

function deviceTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

export function PreferencesForm({
  initialTimezone,
  initialWakeStart,
  initialWakeEnd,
  initialStreamMaxTasks,
}: {
  initialTimezone: string | null;
  initialWakeStart: number;
  initialWakeEnd: number;
  initialStreamMaxTasks: number;
}) {
  const isClient = useIsClient();
  // null = nothing saved and nothing picked yet; the device's zone is then the
  // preselected option (a form default, never persisted until save).
  const [picked, setPicked] = useState<string | null>(initialTimezone);
  const timezone = picked ?? (isClient ? deviceTimeZone() : null) ?? "UTC";
  const zoneGroups = useMemo(
    () => groupTimeZones(isClient ? listTimeZones() : [], new Date()),
    [isClient],
  );
  const knownZone = useMemo(
    () => zoneGroups.some((g) => g.zones.some((z) => z.id === timezone)),
    [zoneGroups, timezone],
  );
  const [wakeStart, setWakeStart] = useState(String(initialWakeStart));
  const [wakeEnd, setWakeEnd] = useState(String(initialWakeEnd));
  const [streamMax, setStreamMax] = useState(String(initialStreamMaxTasks));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  const submit = () => {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await savePreferences({
        timezone,
        wakeStartHour: Number(wakeStart),
        wakeEndHour: Number(wakeEnd),
        streamMaxTasks: Number(streamMax),
      });
      if (result.error) setError(result.error);
      else setSaved(true);
    });
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="space-y-4"
    >
      <div>
        <label
          htmlFor="preferences-timezone"
          className="text-label uppercase text-muted mb-1.5 block"
        >
          timezone
        </label>
        <select
          id="preferences-timezone"
          value={timezone}
          onChange={(e) => setPicked(e.target.value)}
          className={INPUT_CLASS}
        >
          {!knownZone && <option value={timezone}>{timezone}</option>}
          {zoneGroups.map((group) => (
            <optgroup key={group.region} label={group.region}>
              {group.zones.map((zone) => (
                <option key={zone.id} value={zone.id}>
                  {zone.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <p className="text-meta text-muted leading-relaxed mt-1.5">
          the board&rsquo;s &ldquo;today&rdquo;, due times and free hours all follow
          this zone, whatever device you open it on.
        </p>
      </div>

      <div className="flex gap-3">
        <div className="flex-1">
          <p className="text-label uppercase text-muted mb-1.5">wake from</p>
          <input
            type="number"
            min={0}
            max={23}
            value={wakeStart}
            onChange={(e) => setWakeStart(e.target.value)}
            className={INPUT_CLASS}
          />
        </div>
        <div className="flex-1">
          <p className="text-label uppercase text-muted mb-1.5">until</p>
          <input
            type="number"
            min={1}
            max={24}
            value={wakeEnd}
            onChange={(e) => setWakeEnd(e.target.value)}
            className={INPUT_CLASS}
          />
        </div>
      </div>
      <p className="text-meta text-muted leading-relaxed">
        the wake window bounds the free-hours math on the home screen.
      </p>

      <div>
        <p className="text-label uppercase text-muted mb-1.5">board tasks shown</p>
        <input
          type="number"
          min={3}
          max={15}
          value={streamMax}
          onChange={(e) => setStreamMax(e.target.value)}
          className={INPUT_CLASS}
        />
        <p className="text-meta text-muted leading-relaxed mt-1.5">
          max tasks on the daily board before &ldquo;more&rdquo;.
        </p>
      </div>

      {error && <p className="text-action text-danger">{error}</p>}
      {saved && !error && <p className="text-action text-accent">saved ✓</p>}

      <Button type="submit" disabled={pending}>
        {pending ? "saving…" : "save preferences"}
      </Button>
    </form>
  );
}
