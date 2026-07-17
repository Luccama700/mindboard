"use client";

import { useState, useTransition } from "react";
import { saveAgentModels } from "@/app/actions/settings";
import {
  AGENT_MODEL_CHOICES,
  DEFAULT_BUILD_MODEL,
  DEFAULT_PLAN_MODEL,
} from "@/app/_components/agent-models";
import { Button } from "@/app/_components/ui";
import { INPUT_CLASS } from "@/app/_components/ui";

// Overnight-agent model picker (docs/overnight-agent-plan.md): which model
// writes the plans and which implements them. A stored null means "follow
// the orchestrator's default", so the empty select value round-trips to
// null — picking a concrete model pins it, "default" un-pins it.
export function AgentModelsForm({
  initialPlanModel,
  initialBuildModel,
}: {
  initialPlanModel: string | null;
  initialBuildModel: string | null;
}) {
  const [planModel, setPlanModel] = useState(initialPlanModel ?? "");
  const [buildModel, setBuildModel] = useState(initialBuildModel ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  const submit = () => {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await saveAgentModels({
        planModel: planModel || null,
        buildModel: buildModel || null,
      });
      if (result.error) setError(result.error);
      else setSaved(true);
    });
  };

  const defaultLabel = (id: string) =>
    AGENT_MODEL_CHOICES.find((choice) => choice.id === id)?.label.split(" — ")[0] ?? id;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="space-y-4"
    >
      <p className="text-meta text-muted leading-relaxed">
        the overnight agent runs on your pc at 4am (or on ✦ run agent now).
        pick which model plans your tasks and which one does the work —
        planning and implementation run at high effort; the quick task triage
        stays light.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label
            htmlFor="agent-plan-model"
            className="text-label uppercase text-muted mb-1.5 block"
          >
            planning model
          </label>
          <select
            id="agent-plan-model"
            value={planModel}
            onChange={(e) => setPlanModel(e.target.value)}
            className={INPUT_CLASS}
          >
            <option value="">default ({defaultLabel(DEFAULT_PLAN_MODEL)})</option>
            {AGENT_MODEL_CHOICES.map((choice) => (
              <option key={choice.id} value={choice.id}>
                {choice.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label
            htmlFor="agent-build-model"
            className="text-label uppercase text-muted mb-1.5 block"
          >
            implementation model
          </label>
          <select
            id="agent-build-model"
            value={buildModel}
            onChange={(e) => setBuildModel(e.target.value)}
            className={INPUT_CLASS}
          >
            <option value="">default ({defaultLabel(DEFAULT_BUILD_MODEL)})</option>
            {AGENT_MODEL_CHOICES.map((choice) => (
              <option key={choice.id} value={choice.id}>
                {choice.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "saving…" : "save agent models"}
        </Button>
        {saved && <span className="text-meta text-accent">saved</span>}
        {error && <span className="text-meta text-danger">{error}</span>}
      </div>
    </form>
  );
}
