"use client";

import { useState } from "react";

import { cancelProposal, confirmProposal } from "@/app/actions/assistant";
import type { ProposalChannel } from "@/app/lib/mcp/approval";

export type PendingProposal = {
  id: string;
  tool: string;
  preview: string;
  at: string;
  channel: ProposalChannel;
  /** requiresAppApproval — no chat client could have confirmed this one. */
  needsYou: boolean;
  /** false for spawn_urc, whose executor only accepts an `mcp:` credential. */
  approvable: boolean;
};

const CHANNEL_LABEL: Record<ProposalChannel, string> = {
  copilot: "plan",
  watch: "watch",
  chat: "chat · mcp",
  unknown: "unknown",
};

type RowState =
  | { kind: "pending" }
  | { kind: "working" }
  | { kind: "approved"; preview: string }
  | { kind: "rejected" }
  // Someone (another tab, the chat, the watch) answered it first. Not an
  // error: the proposal is gone either way, which is what the user wanted.
  | { kind: "gone" }
  | { kind: "failed"; error: string };

// resolveProposal / claimProposal both guard on status='proposed', so a second
// confirm never double-applies — it comes back as this. Shown as "already
// handled", not as a failure.
function alreadyResolved(error: string): boolean {
  return /not found or already resolved|already being confirmed/i.test(error);
}

export function ApprovalsClient({ items }: { items: PendingProposal[] }) {
  // Seeded once on purpose. Each action revalidates the layout, so the server
  // list would drop a row the moment it resolved and the user would never see
  // what happened to it; holding the terminal state here keeps the receipt.
  const [states, setStates] = useState<Record<string, RowState>>({});

  function stateOf(id: string): RowState {
    return states[id] ?? { kind: "pending" };
  }

  function set(id: string, next: RowState) {
    setStates((prev) => ({ ...prev, [id]: next }));
  }

  async function approve(item: PendingProposal) {
    set(item.id, { kind: "working" });
    const result = await confirmProposal(item.id);
    if (!result.error) {
      set(item.id, { kind: "approved", preview: result.preview ?? item.preview });
      return;
    }
    set(
      item.id,
      alreadyResolved(result.error)
        ? { kind: "gone" }
        : { kind: "failed", error: result.error },
    );
  }

  async function reject(item: PendingProposal) {
    set(item.id, { kind: "working" });
    const result = await cancelProposal(item.id);
    if (!result.error) {
      set(item.id, { kind: "rejected" });
      return;
    }
    set(
      item.id,
      alreadyResolved(result.error)
        ? { kind: "gone" }
        : { kind: "failed", error: result.error },
    );
  }

  if (items.length === 0) {
    return (
      <p className="text-body text-muted pt-10 text-center">
        nothing waiting. anything i propose from a chat, the watch or{" "}
        <span className="text-fg">plan</span> shows up here first.
      </p>
    );
  }

  return (
    <ul className="space-y-2">
      {items.map((item) => {
        const state = stateOf(item.id);
        const busy = state.kind === "working";
        const open = state.kind === "pending" || state.kind === "working" || state.kind === "failed";

        return (
          <li
            key={item.id}
            className="glass-panel rounded-pop border-dashed border-line-strong px-3 py-3 space-y-2"
          >
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-label uppercase text-muted">{item.tool}</span>
              {item.needsYou && (
                <span className="text-[10px] tracking-widest uppercase px-2 py-0.5 border rounded-full border-accent text-accent-ink">
                  needs you
                </span>
              )}
              <span className="text-meta text-muted ml-auto">
                {CHANNEL_LABEL[item.channel]} · {item.at}
              </span>
            </div>

            <p className="text-body text-fg leading-relaxed whitespace-pre-wrap">
              {state.kind === "approved" ? state.preview : item.preview}
            </p>

            {!item.approvable && open && (
              <p className="text-meta text-muted leading-relaxed">
                this one can only be confirmed in the chat that asked for it — the
                session is bound to that client. reject it here if you didn&apos;t ask.
              </p>
            )}

            {state.kind === "failed" && (
              <p className="text-action text-danger">{state.error}</p>
            )}

            {state.kind === "approved" && (
              <p className="text-action text-accent-ink">✓ done</p>
            )}
            {state.kind === "rejected" && (
              <p className="text-action text-muted">rejected — nothing was written</p>
            )}
            {state.kind === "gone" && (
              <p className="text-action text-muted">
                already answered somewhere else
              </p>
            )}

            {open && (
              <div className="flex items-center gap-2">
                {item.approvable && (
                  <button
                    type="button"
                    onClick={() => void approve(item)}
                    disabled={busy}
                    className="min-h-11 px-4 text-action lowercase border rounded-full border-accent bg-accent text-accent-fg shadow-[inset_0_1px_0_rgba(255,255,255,0.25)] hover:opacity-90 active:scale-[.98] transition-[opacity,transform] disabled:opacity-50"
                  >
                    {busy ? "…" : "approve"}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void reject(item)}
                  disabled={busy}
                  className="min-h-11 px-4 text-action lowercase border rounded-full border-hairline text-muted hover:text-fg transition-colors disabled:opacity-50"
                >
                  reject
                </button>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
