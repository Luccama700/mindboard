"use client";

import { useState, useTransition } from "react";
import { savePreferences } from "@/app/actions/settings";
import { Button } from "@/app/_components/ui";
import { INPUT_CLASS } from "@/app/_components/ui";

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
  const guessed =
    typeof Intl !== "undefined"
      ? Intl.DateTimeFormat().resolvedOptions().timeZone
      : "UTC";
  const [timezone, setTimezone] = useState(initialTimezone ?? guessed);
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
        <p className="text-label uppercase text-muted mb-1.5">timezone</p>
        <input
          type="text"
          value={timezone}
          onChange={(e) => setTimezone(e.target.value)}
          placeholder="America/Vancouver"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          className={INPUT_CLASS}
        />
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
