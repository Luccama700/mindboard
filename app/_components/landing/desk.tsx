"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  EXAMPLES,
  FORECAST_MARKS,
  LANES,
  MAX_CAPTURE,
  SUGGESTIONS,
  fileCapture,
  forecast,
  initialDesk,
  money,
  readCapture,
  sparkline,
  toggleTask,
  type DeskState,
  type Lane,
} from "./desk-demo";
import { useReducedMotion } from "./use-in-view";

export const DOCK_INPUT_ID = "landing-dock-input";

// The board a visitor starts from, and the one a visitor who asked for less
// motion starts from: the same three lines the page would have typed, already
// filed, so the story is told without anything moving.
const INITIAL = initialDesk();
const SEEDED = EXAMPLES.reduce<DeskState>(fileCapture, INITIAL);

const SHELF = [
  { name: "milk", left: "2 days", level: 0.12, flag: "buy by thu" },
  { name: "coffee", left: "6 days", level: 0.36, flag: null },
  { name: "rice", left: "19 days", level: 0.8, flag: null },
];

const SPARK = { width: 240, height: 54 };

// Per typed character, and the beat between the last character and enter.
const KEY_MS = 46;
const ENTER_MS = 420;

type Stamp = { seconds: number | null; mine: boolean };

// A working miniature of the product: a dock at the bottom, four panes above
// it. One line goes in; the pane it belongs to lights up and takes it. The
// page types three lines itself, then hands over the moment it is touched.
export function Desk() {
  const reduced = useReducedMotion();
  const base = reduced ? SEEDED : INITIAL;

  const [state, setState] = useState<DeskState | null>(null);
  const desk = state ?? base;
  const [text, setText] = useState("");
  const [front, setFront] = useState<Lane>("today");
  const [stamp, setStamp] = useState<Stamp | null>(null);

  const baseRef = useRef(base);
  const timers = useRef<number[]>([]);
  const typing = useRef(false);
  const startedAt = useRef<number | null>(null);

  useEffect(() => {
    baseRef.current = base;
  }, [base]);

  const clearTimers = useCallback(() => {
    for (const timer of timers.current) window.clearTimeout(timer);
    timers.current = [];
  }, []);

  const file = useCallback((line: string, mine: boolean) => {
    const value = line.trim();
    if (!value) return;
    const seconds =
      startedAt.current === null
        ? null
        : (performance.now() - startedAt.current) / 1000;
    startedAt.current = null;
    setState((prev) => fileCapture(prev ?? baseRef.current, value));
    setFront(readCapture(value).lane);
    setStamp({ seconds, mine });
    setText("");
  }, []);

  // The page typing a line: one character at a time, then enter.
  const typeLine = useCallback(
    (line: string, then?: () => void) => {
      clearTimers();
      typing.current = true;
      startedAt.current = performance.now();
      for (let i = 1; i <= line.length; i++) {
        timers.current.push(
          window.setTimeout(() => setText(line.slice(0, i)), i * KEY_MS),
        );
      }
      timers.current.push(
        window.setTimeout(
          () => {
            typing.current = false;
            file(line, false);
            then?.();
          },
          line.length * KEY_MS + ENTER_MS,
        ),
      );
    },
    [clearTimers, file],
  );

  // The visitor takes over: whatever the page was doing stops mid-word.
  const takeOver = useCallback(() => {
    if (timers.current.length === 0) return;
    clearTimers();
    if (typing.current) {
      typing.current = false;
      startedAt.current = null;
      setText("");
    }
  }, [clearTimers]);

  useEffect(() => {
    if (reduced) return;
    let index = 0;
    const next = () => {
      const line = EXAMPLES[index++];
      const last = index >= EXAMPLES.length;
      typeLine(line, () => {
        timers.current.push(
          last
            ? // Rest on the day, which is where the app opens.
              window.setTimeout(() => setFront("today"), 5600)
            : window.setTimeout(next, 1500),
        );
      });
    };
    const start = window.setTimeout(next, 1300);
    return () => {
      window.clearTimeout(start);
      clearTimers();
    };
  }, [reduced, typeLine, clearTimers]);

  const reading = text.trim() ? readCapture(text) : null;
  const open = desk.tasks.filter((task) => !task.done).length;
  const outlook = forecast(desk.balance);
  const line = sparkline(outlook.series, SPARK.width, SPARK.height);
  const hit = desk.last?.ok ? desk.last.lane : null;

  const tabNote: Record<Lane, string> = {
    today: String(open),
    money: outlook.survives ? "ok" : "low",
    shelf: "1",
    copilot: "?",
  };

  function paneProps(lane: Lane) {
    return {
      className: "landing-pane",
      "data-lane": lane,
      "data-front": front === lane ? "true" : undefined,
    };
  }

  function flash(lane: Lane) {
    return hit === lane ? (
      <span
        key={`flash-${desk.seq}`}
        className="landing-pane-flash"
        aria-hidden
      />
    ) : null;
  }

  return (
    <div
      className="landing-desk-wrap"
      onPointerDownCapture={takeOver}
      onKeyDownCapture={takeOver}
    >
      <div
        className="landing-desk"
        role="group"
        aria-label="a working miniature of mindboard. nothing typed here leaves this page."
      >
        <div className="landing-desk-status" aria-hidden>
          <span>
            <i className="landing-led" /> tue 09:41
          </span>
          <span>demo · stays on this page</span>
        </div>

        <div className="landing-tabs">
          {LANES.map((lane) => (
            <button
              key={lane}
              type="button"
              className="landing-tab"
              aria-pressed={front === lane}
              onClick={() => setFront(lane)}
            >
              {lane}
              <span>{tabNote[lane]}</span>
            </button>
          ))}
        </div>

        <div className="landing-panes">
          <section {...paneProps("today")}>
            {flash("today")}
            <header className="landing-pane-head">
              <h3>today</h3>
              <span>{open} open</span>
            </header>
            <ul className="landing-rows">
              {desk.tasks.slice(0, 6).map((task) => (
                <li key={task.id}>
                  <button
                    type="button"
                    className={`landing-row${task.fresh ? " is-fresh" : ""}`}
                    aria-pressed={task.done}
                    onClick={() =>
                      setState((prev) => toggleTask(prev ?? base, task.id))
                    }
                  >
                    <span className="landing-check" aria-hidden>
                      ✓
                    </span>
                    <span className="landing-row-title">{task.title}</span>
                    <span className="landing-row-meta">
                      <em>{task.group}</em>
                      {task.meta}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="landing-free">
              <p>
                <span>free today</span>
                <strong>15:30 to 18:00</strong>
              </p>
              <div className="landing-vig-track" aria-hidden>
                <i style={{ left: "10%", width: "15%" }} />
                <i style={{ left: "50%", width: "15%" }} />
                <em style={{ left: "65%", width: "25%" }} />
              </div>
            </div>
          </section>

          <section {...paneProps("money")}>
            {flash("money")}
            <header className="landing-pane-head">
              <h3>money</h3>
              <span>next 14 days</span>
            </header>
            <p className="landing-balance">
              <span key={desk.balance}>{money(desk.balance)}</span>
              {desk.spends[0] && (
                <small key={desk.spends[0].id}>
                  {money(-desk.spends[0].amount)} {desk.spends[0].label}
                </small>
              )}
            </p>
            <svg
              className="landing-spark"
              viewBox={`0 0 ${SPARK.width} ${SPARK.height}`}
              preserveAspectRatio="none"
              aria-hidden
            >
              {line.zeroY !== null && (
                <line
                  className="landing-spark-zero"
                  x1="0"
                  x2={SPARK.width}
                  y1={line.zeroY}
                  y2={line.zeroY}
                />
              )}
              {[FORECAST_MARKS.rent, FORECAST_MARKS.payday].map((day) => (
                <line
                  key={day}
                  className="landing-spark-mark"
                  x1={line.xs[day]}
                  x2={line.xs[day]}
                  y1="0"
                  y2={SPARK.height}
                />
              ))}
              <polyline
                className={outlook.survives ? undefined : "is-short"}
                points={line.points}
              />
            </svg>
            <p className="landing-spark-marks" aria-hidden>
              <span>rent fri</span>
              <span>payday</span>
            </p>
            <p className="landing-pane-foot">
              <span className={outlook.survives ? "is-ok" : "is-short"}>
                {outlook.survives ? "holds through rent" : "short before payday"}
              </span>
              <strong>low {money(outlook.low)}</strong>
            </p>
          </section>

          <section {...paneProps("shelf")}>
            <header className="landing-pane-head">
              <h3>shelf</h3>
              <span>runs out in</span>
            </header>
            <ul className="landing-shelf">
              {SHELF.map((item) => (
                <li key={item.name}>
                  <span>{item.name}</span>
                  <span className="landing-bar">
                    <i style={{ transform: `scaleX(${item.level})` }} />
                  </span>
                  <span>
                    {item.flag ? <strong>{item.flag}</strong> : item.left}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section {...paneProps("copilot")}>
            {flash("copilot")}
            <header className="landing-pane-head">
              <h3>copilot</h3>
              <span>reads the board</span>
            </header>
            {desk.ask ? (
              <div className="landing-ask" key={`ask-${desk.ask.id}`}>
                <p>? {desk.ask.question}</p>
                <p>{desk.ask.answer}</p>
              </div>
            ) : (
              <p className="landing-ask-empty">
                start a line with <kbd>?</kbd> and it answers from what is on
                the board.
              </p>
            )}
          </section>
        </div>

        <form
          className="landing-dock"
          onSubmit={(event) => {
            event.preventDefault();
            file(text, true);
          }}
        >
          <div className="landing-dock-read" aria-hidden>
            {reading ? (
              reading.chips.map((chip, index) => (
                <span key={`${index}-${chip}`} className="landing-chip">
                  {chip}
                </span>
              ))
            ) : (
              <span className="landing-dock-hint">
                a line is a task <b>·</b> <kbd>$</kbd> spend <b>·</b>{" "}
                <kbd>?</kbd> question
              </span>
            )}
          </div>
          <div className="landing-dock-line">
            <span className="landing-dock-glyph" aria-hidden>
              {reading?.glyph ?? "›"}
            </span>
            <label className="landing-sr" htmlFor={DOCK_INPUT_ID}>
              capture a task, a spend or a question
            </label>
            <input
              id={DOCK_INPUT_ID}
              className="landing-dock-input"
              value={text}
              maxLength={MAX_CAPTURE}
              placeholder="type one line"
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="done"
              onFocus={takeOver}
              onChange={(event) => {
                const value = event.target.value;
                if (!text && value) startedAt.current = performance.now();
                if (!value) startedAt.current = null;
                setText(value);
              }}
            />
            <button
              type="submit"
              className="landing-dock-send"
              aria-label="file it"
              disabled={!text.trim()}
            >
              ↵
            </button>
          </div>
        </form>
      </div>

      {/* Announced only for the visitor's own lines, not the page's. */}
      <p className="landing-receipt" aria-live={stamp?.mine ? "polite" : "off"}>
        {desk.last && stamp ? (
          desk.last.ok ? (
            <>
              <b>✓</b> {desk.last.text}
              {stamp.seconds !== null && (
                <>
                  {" "}
                  <i>
                    {stamp.seconds.toFixed(1)}s
                    {stamp.mine ? ", and you are done." : ""}
                  </i>
                </>
              )}
            </>
          ) : (
            desk.last.text
          )
        ) : (
          "a toy. nothing typed here leaves the page."
        )}
      </p>

      <div className="landing-tries">
        <span>try</span>
        {SUGGESTIONS.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            className="landing-try"
            onClick={() => typeLine(suggestion)}
          >
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  );
}
