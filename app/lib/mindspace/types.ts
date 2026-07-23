// Shared Mindspace types (docs/mindspace-plan.md). Pure data — no fetching.

export type TopicKind =
  | "person"
  | "project"
  | "work"
  | "course"
  | "area"
  | "emergent";

export type TopicStatus = "active" | "muted" | "archived";

export type MindspaceTopic = {
  id: string;
  name: string;
  kind: TopicKind;
  description: string | null;
  aliases: string[];
  seedVaultPath: string | null;
  seedGroupId: string | null;
  status: TopicStatus;
  pinned: boolean;
  color: string | null;
};

export type MindspaceSource =
  | "capture"
  | "journal"
  | "note"
  | "task"
  | "ai_chat"
  | "daily_log"
  | "spend"
  | "event";

// One countable trace, before classification. `mass` is the common currency:
// estimated minutes of engagement (reading time for notes, session span for
// chats, flat constants for tasks/spend rows).
export type MindspaceItem = {
  source: MindspaceSource;
  ref: string;
  title: string;
  href: string | null;
  occurredAt: number; // UTC ms
  mass: number;
  wordCount: number;
  text: string;
  frontmatterTopics: string[];
  wikilinkPaths: string[];
  groupId: string | null;
};

export type ItemLabel = { topicId: string; weight: number };

// Emotional salience, the "weight on mind" half of the score (LLM-assigned in
// M2): 0 routine · 1 engaged · 2 charged · 3 intense. Fast-path items default 1.
export type ClassifiedItem = MindspaceItem & {
  labels: ItemLabel[];
  salience: number;
};

export type WindowDays = 3 | 7 | 30;

export type TopicEvidence = {
  title: string;
  href: string | null;
  source: MindspaceSource;
  occurredAt: number;
  massMinutes: number;
};

export type TopicShare = {
  topicId: string;
  share: number; // 0..1 of the window's total effective (salience-weighted) mass
  massMinutes: number; // effective minutes
  rawMassMinutes: number; // unweighted minutes — the "volume" half
  meanSalience: number; // mass-weighted mean salience — the "charge" half
  itemCount: number;
  topItems: TopicEvidence[];
};

export type MindspaceWindowView = {
  days: WindowDays;
  totalMassMinutes: number;
  totalItems: number;
  shares: TopicShare[]; // active topics above the fold threshold (or pinned), sorted desc
  foldedShare: number; // active topics below threshold, folded together
  mutedShare: number; // muted topics (hidden rows, honest denominator)
  unclassifiedShare: number; // mass matching no topic
  sparse: boolean; // too few items for percentages to be honest
};

// Fast (3d) vs slow (30d) share comparison, one arrow per topic across windows.
export type TopicTrend = "up" | "down" | "flat";

export type MindspaceView = {
  windows: MindspaceWindowView[];
  trends: Record<string, TopicTrend>;
};

export type MindspaceObservation = {
  id: string;
  topicId: string | null;
  text: string;
  createdAt: string;
};
