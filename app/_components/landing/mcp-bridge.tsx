"use client";

import { useInView } from "./use-in-view";

// The MCP pitch: mindboard lives inside whatever AI you already talk to.
// A staged chat transcript — Claude calling real Mindboard tools with the
// propose → confirm flow — plays out as the section scrolls into view.

const TOOL_CHIPS = [
  "list_tasks",
  "log_spend",
  "update_stock",
  "update_finance",
  "capture_to_brain",
  "finance_forecast",
  "create_event",
  "inventory_forecast",
  "log_daily",
  "schedule_snapshot",
];

function delay(inView: boolean, ms: number): React.CSSProperties {
  return { transitionDelay: inView ? `${ms}ms` : "0ms" };
}

export function McpBridge() {
  const { ref, inView } = useInView<HTMLDivElement>();
  const reveal = (extra = "") =>
    `landing-reveal ${inView ? "landing-in" : ""} ${extra}`;

  return (
    <section className="px-6 py-28">
      <div ref={ref} className="max-w-xl mx-auto">
        <p className={reveal("text-label uppercase text-muted mb-2 text-center")}>
          mcp
        </p>
        <p className={reveal("text-title text-fg text-center")}>
          you don&apos;t even have to open the app.
        </p>
        <p
          className={reveal("text-body text-muted text-center mt-3 mb-12 max-w-md mx-auto leading-relaxed")}
          style={delay(inView, 120)}
        >
          mindboard speaks mcp — plug it into claude, chatgpt, or any ai
          that supports it, and your chats grow hands. paste a bank
          statement screenshot into claude and it lands in your ledger.
          mention you bought milk and the shelf updates.
        </p>

        <div className="border border-line bg-popover p-4 space-y-4">
          <p
            className={reveal("text-label uppercase text-muted")}
            style={delay(inView, 200)}
          >
            any ai chat · connected to your board
          </p>

          <p className={reveal("text-body text-fg")} style={delay(inView, 350)}>
            <span className="text-accent" aria-hidden>
              ›{" "}
            </span>
            got groceries — 2 milk, a dozen eggs. card said $34.20
          </p>

          <p
            className={reveal("text-meta text-muted")}
            style={delay(inView, 650)}
          >
            ⛁ update_stock · log_spend
          </p>

          <div
            className={reveal("border border-line bg-card px-3 py-2.5")}
            style={delay(inView, 900)}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="text-meta text-muted space-y-0.5">
                <p className="text-sm text-fg">inventory: +2 milk · +12 eggs</p>
                <p>spend: −$34.20 · groceries</p>
              </div>
              <span className="px-3 py-2 text-[10px] tracking-widest uppercase bg-accent text-accent-fg whitespace-nowrap">
                ✓ confirm
              </span>
            </div>
          </div>

          <p
            className={reveal("text-body text-muted leading-relaxed")}
            style={delay(inView, 1200)}
          >
            done — shelf and ledger updated. at this rate the milk runs out
            thursday; want a reminder on the board?
          </p>
        </div>

        <p
          className={reveal("text-meta text-muted text-center mt-6")}
          style={delay(inView, 1350)}
        >
          nothing is ever written without a ✓ from you.
        </p>

        <div
          className={reveal("mt-8 flex flex-wrap justify-center gap-1.5")}
          style={delay(inView, 1450)}
        >
          {TOOL_CHIPS.map((tool) => (
            <span
              key={tool}
              className="px-2 py-1 text-[10px] tracking-widest lowercase border border-line text-muted whitespace-nowrap"
            >
              {tool}
            </span>
          ))}
          <span className="px-2 py-1 text-[10px] tracking-widest lowercase text-muted whitespace-nowrap">
            + 30 more
          </span>
        </div>
      </div>
    </section>
  );
}
