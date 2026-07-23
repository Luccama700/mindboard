"use client";

import Link from "next/link";
import { useState, useTransition } from "react";

import {
  deleteMindspaceTopic,
  mergeMindspaceTopics,
  updateMindspaceTopic,
} from "@/app/actions/mindspace";
import type {
  MindspaceSource,
  MindspaceTopic,
  MindspaceView,
  TopicShare,
} from "@/app/lib/mindspace/types";

const WINDOW_LABELS = ["3d", "week", "month"] as const;

const SOURCE_LABELS: Record<MindspaceSource, string> = {
  capture: "note",
  journal: "journal",
  note: "note",
  task: "task",
  ai_chat: "chat",
  daily_log: "check-in",
  spend: "spend",
};

function pct(share: number): string {
  return `${Math.round(share * 100)}%`;
}

function massLabel(minutes: number): string {
  if (minutes < 90) return `${Math.round(minutes)}m`;
  return `${(minutes / 60).toFixed(1)}h`;
}

function agoLabel(occurredAt: number, nowMs: number): string {
  const days = Math.floor((nowMs - occurredAt) / (24 * 60 * 60 * 1000));
  if (days <= 0) return "today";
  if (days === 1) return "1d ago";
  return `${days}d ago`;
}

function TrendArrow({ trend }: { trend: "up" | "down" | "flat" }) {
  if (trend === "flat") {
    return <span className="text-muted text-[10px]">→</span>;
  }
  return (
    <span className={`text-[10px] ${trend === "up" ? "text-accent" : "text-muted"}`}>
      {trend === "up" ? "↑" : "↓"}
    </span>
  );
}

function TopicPanel({
  topic,
  others,
  onClose,
}: {
  topic: MindspaceTopic;
  others: MindspaceTopic[];
  onClose: () => void;
}) {
  const [name, setName] = useState(topic.name);
  const [aliases, setAliases] = useState(topic.aliases.join(", "));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pending, startTransition] = useTransition();

  function save() {
    startTransition(async () => {
      await updateMindspaceTopic({
        id: topic.id,
        name,
        aliases: aliases.split(",").map((alias) => alias.trim()),
      });
    });
  }

  return (
    <div className="mt-3 space-y-3 border-t border-line pt-3">
      <div className="flex gap-2">
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          onBlur={save}
          aria-label="topic name"
          className="min-h-11 flex-1 rounded-lg bg-card px-3 text-sm outline-none border border-line focus:border-accent"
        />
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              await updateMindspaceTopic({
                id: topic.id,
                pinned: !topic.pinned,
              });
            })
          }
          className={`min-h-11 px-3 rounded-lg border border-line text-label uppercase transition-colors ${
            topic.pinned ? "text-accent" : "text-muted hover:text-fg"
          }`}
        >
          {topic.pinned ? "pinned" : "pin"}
        </button>
      </div>
      <div>
        <p className="text-[10px] tracking-widest uppercase text-muted mb-1">
          also matches (comma-separated)
        </p>
        <input
          value={aliases}
          onChange={(event) => setAliases(event.target.value)}
          onBlur={save}
          placeholder="nicknames, abbreviations…"
          aria-label="topic aliases"
          className="min-h-11 w-full rounded-lg bg-card px-3 text-sm outline-none border border-line focus:border-accent"
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              await updateMindspaceTopic({
                id: topic.id,
                status: topic.status === "muted" ? "active" : "muted",
              });
              onClose();
            })
          }
          className="min-h-11 px-3 rounded-lg border border-line text-label uppercase text-muted hover:text-fg transition-colors"
        >
          {topic.status === "muted" ? "unmute" : "mute"}
        </button>
        {others.length > 0 && (
          <select
            aria-label="merge into"
            defaultValue=""
            disabled={pending}
            onChange={(event) => {
              const intoId = event.target.value;
              if (!intoId) return;
              startTransition(async () => {
                await mergeMindspaceTopics({ fromId: topic.id, intoId });
                onClose();
              });
            }}
            className="min-h-11 rounded-lg bg-card px-2 text-label uppercase text-muted border border-line"
          >
            <option value="">merge into…</option>
            {others.map((other) => (
              <option key={other.id} value={other.id}>
                {other.name}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            if (!confirmDelete) {
              setConfirmDelete(true);
              return;
            }
            startTransition(async () => {
              await deleteMindspaceTopic(topic.id);
              onClose();
            });
          }}
          className="min-h-11 px-3 rounded-lg border border-line text-label uppercase text-danger/80 hover:text-danger transition-colors ml-auto"
        >
          {confirmDelete ? "confirm delete" : "delete"}
        </button>
      </div>
      {topic.status === "muted" && (
        <p className="text-xs text-muted leading-relaxed">
          muted — still counted in the total so the other numbers stay honest,
          just not shown.
        </p>
      )}
    </div>
  );
}

export function MindspaceClient({
  view,
  topics,
  nowMs,
  vaultConnected,
}: {
  view: MindspaceView;
  topics: MindspaceTopic[];
  nowMs: number;
  vaultConnected: boolean;
}) {
  const [windowIndex, setWindowIndex] = useState(1);
  const [expanded, setExpanded] = useState<string | null>(null);

  const current = view.windows[windowIndex];
  const topicById = new Map(topics.map((topic) => [topic.id, topic]));
  const mutedTopics = topics.filter((topic) => topic.status === "muted");

  return (
    <div>
      <div
        className="flex items-center gap-1 mb-8"
        role="tablist"
        aria-label="window"
      >
        {WINDOW_LABELS.map((label, index) => (
          <button
            key={label}
            type="button"
            role="tab"
            aria-selected={windowIndex === index}
            onClick={() => {
              setWindowIndex(index);
              setExpanded(null);
            }}
            className={`min-h-11 px-4 rounded-lg text-label uppercase transition-colors ${
              windowIndex === index
                ? "bg-card text-fg"
                : "text-muted hover:text-fg"
            }`}
          >
            {label}
          </button>
        ))}
        <span className="ml-auto text-[10px] text-muted">
          {current.totalItems} traces · {massLabel(current.totalMassMinutes)}
        </span>
      </div>

      {current.totalItems === 0 ? (
        <p className="text-sm text-muted leading-relaxed">
          nothing captured in this window yet. notes, chats, tasks, and
          check-ins all count.
        </p>
      ) : current.sparse ? (
        <p className="text-sm text-muted leading-relaxed mb-8">
          only {current.totalItems} traces in this window — too few for honest
          percentages. what&apos;s there:{" "}
          {current.shares
            .map(
              (share) =>
                `${topicById.get(share.topicId)?.name ?? "?"} (${share.itemCount})`,
            )
            .join(", ") || "nothing classified yet"}
          .
        </p>
      ) : (
        <>
          <div
            className="flex h-3 w-full overflow-hidden rounded-full mb-8"
            aria-hidden
          >
            {current.shares.map((share) => (
              <div
                key={share.topicId}
                style={{
                  width: `${share.share * 100}%`,
                  backgroundColor:
                    topicById.get(share.topicId)?.color ?? "#6b6b6b",
                }}
              />
            ))}
            <div
              className="bg-card"
              style={{
                width: `${
                  (current.foldedShare +
                    current.mutedShare +
                    current.unclassifiedShare) * 100
                }%`,
              }}
            />
          </div>

          <ul>
            {current.shares.map((share: TopicShare) => {
              const topic = topicById.get(share.topicId);
              if (!topic) return null;
              const isOpen = expanded === topic.id;
              return (
                <li key={topic.id} className="border-b border-line py-2">
                  <button
                    type="button"
                    onClick={() => setExpanded(isOpen ? null : topic.id)}
                    aria-expanded={isOpen}
                    className="w-full text-left"
                  >
                    <span className="flex items-center gap-3 min-h-11">
                      <span
                        aria-hidden
                        className="inline-block h-2 w-2 rounded-full shrink-0"
                        style={{ backgroundColor: topic.color ?? "#6b6b6b" }}
                      />
                      <span className="text-sm">{topic.name}</span>
                      {topic.pinned && (
                        <span className="text-[10px] text-muted">◆</span>
                      )}
                      <TrendArrow trend={view.trends[topic.id] ?? "flat"} />
                      <span className="ml-auto text-sm tabular-nums">
                        {pct(share.share)}
                      </span>
                    </span>
                    <span className="block h-1 w-full rounded-full bg-card">
                      <span
                        className="block h-1 rounded-full"
                        style={{
                          width: `${Math.max(share.share * 100, 1)}%`,
                          backgroundColor: topic.color ?? "#6b6b6b",
                        }}
                      />
                    </span>
                    <span className="block text-[10px] text-muted mt-1">
                      {share.itemCount} traces · {massLabel(share.massMinutes)}
                    </span>
                  </button>

                  {isOpen && (
                    <div>
                      <ul className="mt-2 space-y-1">
                        {share.topItems.map((item) => (
                          <li key={`${item.title}-${item.occurredAt}`}>
                            {item.href ? (
                              <Link
                                href={item.href}
                                className="flex items-baseline gap-2 min-h-8 text-xs hover:text-accent transition-colors"
                              >
                                <span className="text-muted shrink-0">
                                  {SOURCE_LABELS[item.source]}
                                </span>
                                <span className="truncate">{item.title}</span>
                                <span className="ml-auto text-muted shrink-0">
                                  {agoLabel(item.occurredAt, nowMs)}
                                </span>
                              </Link>
                            ) : (
                              <span className="flex items-baseline gap-2 min-h-8 text-xs">
                                <span className="text-muted shrink-0">
                                  {SOURCE_LABELS[item.source]}
                                </span>
                                <span className="truncate">{item.title}</span>
                                <span className="ml-auto text-muted shrink-0">
                                  {agoLabel(item.occurredAt, nowMs)}
                                </span>
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                      <TopicPanel
                        topic={topic}
                        others={topics.filter(
                          (other) =>
                            other.id !== topic.id &&
                            other.status === "active",
                        )}
                        onClose={() => setExpanded(null)}
                      />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>

          {(current.foldedShare > 0 || current.unclassifiedShare > 0) && (
            <p className="text-[10px] text-muted mt-3">
              everything else {pct(current.foldedShare)} · unmatched{" "}
              {pct(current.unclassifiedShare)}
              {current.mutedShare > 0 && <> · muted {pct(current.mutedShare)}</>}
            </p>
          )}
        </>
      )}

      {mutedTopics.length > 0 && (
        <div className="mt-8">
          <p className="text-[10px] tracking-widest uppercase text-muted mb-1">
            muted ({mutedTopics.length})
          </p>
          <ul>
            {mutedTopics.map((topic) => {
              const isOpen = expanded === topic.id;
              return (
                <li key={topic.id} className="border-b border-line py-1">
                  <button
                    type="button"
                    onClick={() => setExpanded(isOpen ? null : topic.id)}
                    aria-expanded={isOpen}
                    className="flex w-full items-center gap-3 min-h-11 text-sm text-muted hover:text-fg transition-colors"
                  >
                    <span
                      aria-hidden
                      className="inline-block h-2 w-2 rounded-full opacity-40"
                      style={{ backgroundColor: topic.color ?? "#6b6b6b" }}
                    />
                    {topic.name}
                  </button>
                  {isOpen && (
                    <TopicPanel
                      topic={topic}
                      others={topics.filter(
                        (other) =>
                          other.id !== topic.id && other.status === "active",
                      )}
                      onClose={() => setExpanded(null)}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <p className="mt-12 border-t border-line pt-4 text-xs text-muted leading-relaxed">
        based on what you captured — notes, chats, tasks, check-ins. quiet
        things are under-counted; a concern can be loud in your head and absent
        from the page.
        {!vaultConnected && " (vault not connected — notes aren't counted.)"}
      </p>
    </div>
  );
}
