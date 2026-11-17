"use client";

import { useState } from "react";
import { useInView } from "./use-in-view";

type Verdict = "pending" | "written" | "declined";

// Real tool names from the Mindboard MCP server, laid out like `ls`.
const TOOLS = [
  "get_snapshot",
  "list_tasks",
  "create_task",
  "complete_task",
  "create_event",
  "log_spend",
  "finance_forecast",
  "update_stock",
  "inventory_forecast",
  "shopping_list",
  "list_people",
  "capture_to_brain",
  "log_daily",
  "confirm_action",
];

// The MCP pitch, as the thing itself: Claude proposes a change, and the
// visitor is the one holding the ✓. Both answers are real endings.
export function McpApprove() {
  const { ref, inView } = useInView<HTMLElement>();
  const [verdict, setVerdict] = useState<Verdict>("pending");

  return (
    <section
      ref={ref}
      className={`landing-sec landing-mcp${inView ? " is-in" : ""}`}
    >
      <div className="landing-sec-head">
        <p className="landing-kicker">mcp</p>
        <h2 className="landing-h2">
          claude can read all of it. it writes when you say yes.
        </h2>
        <p className="landing-sec-lede">
          mindboard is also an mcp server. connect claude, or any assistant
          that speaks mcp, and it can read your day, your ledger, your shelf
          and your notes from any chat. when it wants to change something it
          has to ask, and nothing moves until you press ✓.
        </p>
        <div className="landing-tools">
          <p>
            <span aria-hidden>$</span> mindboard tools
          </p>
          <ul>
            {TOOLS.map((tool) => (
              <li key={tool}>{tool}</li>
            ))}
            <li>and more</li>
          </ul>
        </div>
      </div>

      <div className="landing-chat" data-verdict={verdict}>
        <p className="landing-chat-bar" aria-hidden>
          <span>a chat with claude</span>
          <span>mindboard connected</span>
        </p>

        <p className="landing-chat-you" style={{ ["--i" as string]: 1 }}>
          <b>you</b>
          got groceries. 2 milk, a dozen eggs. the card said $34.20
        </p>

        <p className="landing-chat-call" style={{ ["--i" as string]: 2 }}>
          <b>claude</b>
          <span>update_stock</span>
          <span>log_spend</span>
        </p>

        <div className="landing-proposal" style={{ ["--i" as string]: 3 }}>
          <p className="landing-proposal-state">
            {verdict === "pending" && (
              <>
                <i aria-hidden /> waiting for you
              </>
            )}
            {verdict === "written" && <>✓ written</>}
            {verdict === "declined" && <>declined · nothing changed</>}
          </p>
          <dl>
            <div>
              <dt>shelf</dt>
              <dd>+2 milk · +12 eggs</dd>
            </div>
            <div>
              <dt>ledger</dt>
              <dd>−$34.20 · groceries</dd>
            </div>
          </dl>
          {verdict === "pending" ? (
            <div className="landing-proposal-actions">
              <button
                type="button"
                className="landing-yes"
                onClick={() => setVerdict("written")}
              >
                ✓ confirm
              </button>
              <button
                type="button"
                className="landing-no"
                onClick={() => setVerdict("declined")}
              >
                decline
              </button>
            </div>
          ) : (
            <div className="landing-proposal-actions">
              <button
                type="button"
                className="landing-no"
                onClick={() => setVerdict("pending")}
              >
                ↺ ask me again
              </button>
            </div>
          )}
        </div>

        <p
          className="landing-chat-reply"
          role="status"
          style={{ ["--i" as string]: 4 }}
        >
          {verdict === "pending" && (
            <span className="landing-chat-wait">
              nothing has been written yet.
            </span>
          )}
          {verdict === "written" && (
            <span key="written">
              <b>claude</b>
              done. shelf and ledger are updated, and the milk now lasts until
              next wednesday.
            </span>
          )}
          {verdict === "declined" && (
            <span key="declined">
              <b>claude</b>
              okay, i left everything as it was.
            </span>
          )}
        </p>
      </div>
    </section>
  );
}
