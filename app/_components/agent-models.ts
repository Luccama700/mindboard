// Overnight-agent model choices (docs/overnight-agent-plan.md). The ids are
// what user_settings stores and what the orchestrator maps to CLI invocations
// (overnight/lib.mjs MODEL_CHOICES) — keep the three lists in sync.
export const AGENT_MODEL_CHOICES = [
  { id: "fable-5", label: "fable 5 — deepest reasoning" },
  { id: "opus-5", label: "opus 5 — near-fable at half price" },
  { id: "opus-4.8", label: "opus 4.8 — strong all-rounder" },
  { id: "gpt-5.6-sol", label: "gpt-5.6-sol — via the pc's claudex proxy" },
] as const;

export type AgentModelId = (typeof AGENT_MODEL_CHOICES)[number]["id"];

export const DEFAULT_PLAN_MODEL: AgentModelId = "fable-5";
export const DEFAULT_BUILD_MODEL: AgentModelId = "gpt-5.6-sol";

export function isAgentModelId(value: string | null): value is AgentModelId {
  return value !== null && AGENT_MODEL_CHOICES.some((choice) => choice.id === value);
}
