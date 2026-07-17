"use client";

import { useState, useTransition } from "react";
import { requestAgentRun } from "@/app/actions/tasks";

// "✦ run agent now" — stamps a request the PC's 5-minute poll picks up
// (docs/overnight-agent-plan.md). Feedback is local: the run itself reports
// back into the tasks it touches (badges + notes).
export function AgentRunButton() {
  const [state, setState] = useState<"idle" | "requested" | "error">("idle");
  const [pending, startTransition] = useTransition();

  function request() {
    startTransition(async () => {
      const result = await requestAgentRun();
      setState(result.error ? "error" : "requested");
    });
  }

  if (state === "requested") {
    return (
      <span className="text-[10px] tracking-widest uppercase text-accent whitespace-nowrap">
        ✦ requested — the pc picks it up within ~5 min
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={request}
      disabled={pending}
      className="text-[10px] tracking-widest uppercase px-2.5 py-1.5 border border-line-strong text-muted hover:border-fg hover:text-fg transition-colors disabled:opacity-50 whitespace-nowrap"
    >
      {pending ? "requesting…" : state === "error" ? "retry: run agent now" : "✦ run agent now"}
    </button>
  );
}
