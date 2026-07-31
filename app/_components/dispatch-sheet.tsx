"use client";

import { useState, useTransition } from "react";
import { requestTaskDispatch } from "@/app/actions/tasks";
import { Sheet } from "./stream-sheets";
import { Button, INPUT_CLASS } from "./ui";

// "✦ do it": hand one open task to the home worker with a one-shot note
// (spec: docs/superpowers/specs/2026-07-31-task-dispatch-design.md). Feedback
// is local and deliberately thin — the run itself reports back into the task
// (badge + an "## Agent result" section in the notes), same as the overnight
// tracks. Copy mirrors the ✦ run agent now button on /tasks.
export function DispatchSheet({
  task,
  onClose,
}: {
  task: { id: string; title: string };
  onClose: () => void;
}) {
  const [note, setNote] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const trimmed = note.trim();

  const submit = () => {
    if (!trimmed) return;
    setError(null);
    startTransition(async () => {
      const result = await requestTaskDispatch({
        taskId: task.id,
        note: trimmed,
      });
      if (result.error) setError(result.error);
      else setSent(true);
    });
  };

  return (
    <Sheet title="send to the agent" onClose={onClose}>
      <div className="space-y-4">
        <p className="text-body text-fg">{task.title}</p>

        {sent ? (
          <>
            <p className="text-action text-accent">
              ✦ dispatched — the pc picks it up within ~5 min
            </p>
            <Button onClick={onClose}>close</Button>
          </>
        ) : (
          <>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="anything the agent should know or do?"
              aria-label="note for the agent"
              rows={4}
              className={`${INPUT_CLASS} resize-none`}
            />
            {error && <p className="text-action text-danger">{error}</p>}
            <Button
              variant="accent"
              onClick={submit}
              disabled={pending || trimmed === ""}
            >
              {pending ? "sending…" : "✦ do it"}
            </Button>
          </>
        )}
      </div>
    </Sheet>
  );
}
