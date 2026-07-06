"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { cancelProposal, confirmProposal } from "@/app/actions/assistant";
import { AssistantKeyForm } from "@/app/_components/assistant-key-form";
import { ProposalCard } from "@/app/_components/proposal-card";
import { INPUT_CLASS } from "@/app/_components/ui";

const MODEL_OPTIONS = [
  { id: "claude-opus-4-8", label: "opus (default)" },
  { id: "claude-sonnet-5", label: "sonnet (cheaper)" },
  { id: "claude-haiku-4-5", label: "haiku (cheapest)" },
] as const;

type ProposalState = "pending" | "confirming" | "confirmed" | "skipped" | "failed";

type TranscriptItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; names: string[] }
  | {
      kind: "proposal";
      proposalId: string;
      preview: string;
      state: ProposalState;
      error?: string;
    }
  | { kind: "error"; text: string };

export type InitialMessage = { role: "user" | "assistant"; content: string };

function readStoredModel(): string {
  if (typeof window === "undefined") return "claude-opus-4-8";
  try {
    const stored = localStorage.getItem("assistant-model");
    if (stored && MODEL_OPTIONS.some((m) => m.id === stored)) return stored;
  } catch {
    // ignore
  }
  return "claude-opus-4-8";
}

export function PlanClient({
  hasKey,
  initialQuery,
  conversationId: initialConversationId,
  initialMessages,
  goals,
}: {
  hasKey: boolean;
  initialQuery: string | null;
  conversationId: string | null;
  initialMessages: InitialMessage[];
  goals: { id: string; title: string; horizon: string; target_date: string | null }[];
}) {
  const [items, setItems] = useState<TranscriptItem[]>(
    initialMessages.map((m) =>
      m.role === "user"
        ? { kind: "user", text: m.content }
        : { kind: "assistant", text: m.content },
    ),
  );
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [model, setModel] = useState(readStoredModel);
  const conversationRef = useRef<string | null>(initialConversationId);
  const bottomRef = useRef<HTMLDivElement>(null);
  const sentInitial = useRef(false);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [items]);

  async function send(message: string) {
    if (!message.trim() || busy) return;
    setBusy(true);
    setItems((prev) => [...prev, { kind: "user", text: message }]);

    try {
      const response = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          conversationId: conversationRef.current,
          model,
        }),
      });

      if (!response.ok || !response.body) {
        const payload = await response.json().catch(() => null);
        setItems((prev) => [
          ...prev,
          {
            kind: "error",
            text:
              (payload as { error?: string } | null)?.error ??
              `request failed (${response.status})`,
          },
        ]);
        setBusy(false);
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const handle = (event: Record<string, unknown>) => {
        switch (event.type) {
          case "conversation":
            conversationRef.current = event.conversationId as string;
            break;
          case "text": {
            const delta = event.delta as string;
            setItems((prev) => {
              const last = prev[prev.length - 1];
              if (last?.kind === "assistant") {
                return [
                  ...prev.slice(0, -1),
                  { kind: "assistant", text: last.text + delta },
                ];
              }
              return [...prev, { kind: "assistant", text: delta }];
            });
            break;
          }
          case "tool": {
            const name = event.name as string;
            setItems((prev) => {
              const last = prev[prev.length - 1];
              if (last?.kind === "tool") {
                return [
                  ...prev.slice(0, -1),
                  { kind: "tool", names: [...last.names, name] },
                ];
              }
              return [...prev, { kind: "tool", names: [name] }];
            });
            break;
          }
          case "proposal":
            setItems((prev) => [
              ...prev,
              {
                kind: "proposal",
                proposalId: event.proposalId as string,
                preview: event.preview as string,
                state: "pending",
              },
            ]);
            break;
          case "error":
            setItems((prev) => [
              ...prev,
              { kind: "error", text: event.message as string },
            ]);
            break;
        }
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            handle(JSON.parse(line.slice(6)));
          } catch {
            // skip malformed frame
          }
        }
      }
    } catch {
      setItems((prev) => [
        ...prev,
        { kind: "error", text: "connection dropped — try again" },
      ]);
    }
    setBusy(false);
  }

  // A `?` capture handoff sends itself once.
  useEffect(() => {
    if (initialQuery && hasKey && !sentInitial.current) {
      sentInitial.current = true;
      void send(initialQuery);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function setProposalState(
    proposalId: string,
    state: ProposalState,
    error?: string,
  ) {
    setItems((prev) =>
      prev.map((item) =>
        item.kind === "proposal" && item.proposalId === proposalId
          ? { ...item, state, error }
          : item,
      ),
    );
  }

  async function onConfirm(proposalId: string) {
    setProposalState(proposalId, "confirming");
    const result = await confirmProposal(proposalId);
    setProposalState(
      proposalId,
      result.error ? "failed" : "confirmed",
      result.error ?? undefined,
    );
  }

  async function onSkip(proposalId: string) {
    setProposalState(proposalId, "confirming");
    const result = await cancelProposal(proposalId);
    setProposalState(
      proposalId,
      result.error ? "failed" : "skipped",
      result.error ?? undefined,
    );
  }

  const pendingProposals = items.filter(
    (item): item is Extract<TranscriptItem, { kind: "proposal" }> =>
      item.kind === "proposal" && item.state === "pending",
  );

  async function confirmAll() {
    for (const proposal of pendingProposals) {
      // sequential on purpose: each confirm may depend on the previous state
      await onConfirm(proposal.proposalId);
    }
  }

  if (!hasKey) {
    return (
      <div className="space-y-6">
        <div className="border border-hairline px-4 py-6 space-y-2">
          <p className="text-body text-fg">
            the copilot plans with your own anthropic api key.
          </p>
          <p className="text-meta text-muted leading-relaxed">
            it reads your tasks, money, stock, and schedule, and proposes plans
            you confirm — nothing is ever written without your tap.
          </p>
        </div>
        <AssistantKeyForm connected={false} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {goals.length > 0 && (
        <details className="border border-hairline px-3 py-2">
          <summary className="text-label uppercase text-muted cursor-pointer min-h-11 flex items-center">
            goals · {goals.length}
          </summary>
          <ul className="pb-2 space-y-1">
            {goals.map((goal) => (
              <li key={goal.id} className="text-body text-fg">
                <span className="text-muted" aria-hidden>
                  ★{" "}
                </span>
                {goal.title}
                <span className="text-meta text-muted">
                  {" "}
                  · {goal.horizon}
                  {goal.target_date ? ` · ${goal.target_date}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="space-y-3 min-h-[30vh]">
        {items.length === 0 && (
          <p className="text-muted text-body pt-8 text-center">
            ask for a plan — “plan my evening”, “what should i do next?”,
            “schedule the essay for tomorrow morning”.
          </p>
        )}
        {items.map((item, index) => {
          switch (item.kind) {
            case "user":
              return (
                <p key={index} className="text-body text-fg">
                  <span className="text-accent" aria-hidden>
                    ›{" "}
                  </span>
                  {item.text}
                </p>
              );
            case "assistant":
              return (
                <p
                  key={index}
                  className="text-body text-fg whitespace-pre-wrap leading-relaxed"
                >
                  {item.text}
                  {busy && index === items.length - 1 && (
                    <span className="animate-pulse" aria-hidden>
                      ▮
                    </span>
                  )}
                </p>
              );
            case "tool":
              return (
                <p key={index} className="text-meta text-muted">
                  ⛁ {item.names.join(" · ")}
                </p>
              );
            case "proposal":
              return (
                <div key={item.proposalId}>
                  {item.state === "confirmed" ? (
                    <p className="text-action text-accent">
                      ✓ {item.preview}
                    </p>
                  ) : item.state === "skipped" ? (
                    <p className="text-action text-muted line-through">
                      {item.preview}
                    </p>
                  ) : (
                    <ProposalCard
                      title="proposal"
                      onConfirm={() => onConfirm(item.proposalId)}
                      onSkip={() => onSkip(item.proposalId)}
                      pending={item.state === "confirming"}
                      error={item.state === "failed" ? (item.error ?? "failed") : null}
                    >
                      <p className="text-body text-fg">{item.preview}</p>
                    </ProposalCard>
                  )}
                </div>
              );
            case "error":
              return (
                <p key={index} className="text-action text-danger">
                  {item.text}
                </p>
              );
          }
        })}
        {pendingProposals.length > 1 && (
          <button
            type="button"
            onClick={confirmAll}
            className="min-h-11 px-4 text-action lowercase border border-accent text-fg hover:bg-accent hover:text-accent-fg transition-colors"
          >
            confirm all ({pendingProposals.length})
          </button>
        )}
        <div ref={bottomRef} />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          const message = input;
          setInput("");
          void send(message);
        }}
        className="space-y-2"
      >
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={busy ? "thinking…" : "plan something…"}
            disabled={busy}
            maxLength={2000}
            className={INPUT_CLASS}
          />
          <button
            type="submit"
            disabled={busy || !input.trim()}
            className="min-h-11 px-4 text-action lowercase border border-accent bg-accent text-accent-fg hover:opacity-90 transition-opacity disabled:opacity-40"
          >
            send
          </button>
        </div>
        <div className="flex items-center justify-between">
          <select
            value={model}
            onChange={(e) => {
              setModel(e.target.value);
              try {
                localStorage.setItem("assistant-model", e.target.value);
              } catch {
                // ignore
              }
            }}
            aria-label="model"
            className="bg-surface-0 border border-hairline text-muted text-meta px-2 py-1.5 focus:outline-none focus:border-accent"
          >
            {MODEL_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
          <Link
            href="/settings"
            className="text-meta text-muted hover:text-fg transition-colors min-h-11 inline-flex items-center"
          >
            key settings →
          </Link>
        </div>
      </form>
    </div>
  );
}
