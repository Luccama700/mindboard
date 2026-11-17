"use client";

import { STOPS, type StopKey } from "./day-script";
import { START_BALANCE, forecast, sparkline } from "./desk-demo";
import { useInView } from "./use-in-view";

const SPARK = { width: 200, height: 56 };
const OUTLOOK = sparkline(
  forecast(START_BALANCE).series,
  SPARK.width,
  SPARK.height,
);

// Six dots and the lines between them: notes, and what links them.
const NODES: [number, number][] = [
  [22, 18],
  [78, 10],
  [132, 26],
  [52, 46],
  [106, 50],
  [176, 40],
];
const LINKS: [number, number][] = [
  [0, 1],
  [1, 2],
  [0, 3],
  [3, 4],
  [1, 4],
  [4, 5],
  [2, 5],
];

function Vignette({ stop }: { stop: StopKey }) {
  switch (stop) {
    case "stream":
      return (
        <ul className="landing-vig-list">
          <li>
            <b>now</b>call the landlord
          </li>
          <li>
            <b>next</b>stats lecture <i>14:00</i>
          </li>
          <li>
            <b>later</b>outline the essay
          </li>
        </ul>
      );
    case "calendar":
      return (
        <div className="landing-vig-cal">
          <div className="landing-vig-track">
            <i style={{ left: "10%", width: "15%" }} />
            <i style={{ left: "50%", width: "15%" }} />
            <em style={{ left: "65%", width: "25%" }} />
          </div>
          <div className="landing-vig-hours">
            <span style={{ left: "0%" }}>9</span>
            <span style={{ left: "30%" }}>12</span>
            <span style={{ left: "60%" }}>15</span>
            <span style={{ left: "90%" }}>18</span>
          </div>
          <p>
            free <strong>15:30 to 18:00</strong>
          </p>
        </div>
      );
    case "money":
      return (
        <div className="landing-vig-money">
          <svg
            viewBox={`0 0 ${SPARK.width} ${SPARK.height}`}
            preserveAspectRatio="none"
          >
            <polyline points={OUTLOOK.points} pathLength={1} />
          </svg>
          <p>
            <span>rent</span>
            <span>payday</span>
          </p>
        </div>
      );
    case "shelf":
      return (
        <ul className="landing-shelf">
          <li>
            <span>milk</span>
            <span className="landing-bar">
              <i style={{ transform: "scaleX(0.12)" }} />
            </span>
            <span>
              <strong>thu</strong>
            </span>
          </li>
          <li>
            <span>coffee</span>
            <span className="landing-bar">
              <i style={{ transform: "scaleX(0.36)" }} />
            </span>
            <span>6d</span>
          </li>
          <li>
            <span>rice</span>
            <span className="landing-bar">
              <i style={{ transform: "scaleX(0.8)" }} />
            </span>
            <span>19d</span>
          </li>
        </ul>
      );
    case "people":
      return (
        <ul className="landing-vig-people">
          <li>
            <i style={{ opacity: 1 }} />
            dani<span>2 days</span>
          </li>
          <li>
            <i style={{ opacity: 0.5 }} />
            mum<span>3 weeks</span>
          </li>
          <li>
            <i style={{ opacity: 0.18 }} />
            theo<span>2 months</span>
          </li>
        </ul>
      );
    case "brain":
      return (
        <svg className="landing-vig-brain" viewBox="0 0 200 60">
          {LINKS.map(([a, b], index) => (
            <line
              key={index}
              x1={NODES[a][0]}
              y1={NODES[a][1]}
              x2={NODES[b][0]}
              y2={NODES[b][1]}
              pathLength={1}
              style={{ ["--i" as string]: index }}
            />
          ))}
          {NODES.map(([x, y], index) => (
            <circle
              key={index}
              cx={x}
              cy={y}
              r={index === 4 ? 4.5 : 3}
              className={index === 4 ? "is-new" : undefined}
            />
          ))}
        </svg>
      );
  }
}

// The day as a line of stops: down the page on a phone, across it on a desk.
export function DayLine() {
  const { ref, inView } = useInView<HTMLElement>();

  return (
    <section
      ref={ref}
      className={`landing-sec landing-day${inView ? " is-in" : ""}`}
    >
      <div className="landing-sec-head">
        <p className="landing-kicker">the day</p>
        <h2 className="landing-h2">
          it holds the whole day. you just live it.
        </h2>
      </div>

      <ol className="landing-line">
        {STOPS.map((stop, index) => (
          <li
            key={stop.key}
            className="landing-stop"
            style={{ ["--i" as string]: index }}
          >
            <time className="landing-stop-time">{stop.time}</time>
            <span className="landing-stop-dot" aria-hidden />
            <div className="landing-stop-body">
              <h3 className="landing-stop-lane">{stop.lane}</h3>
              <div className="landing-vig" aria-hidden>
                <Vignette stop={stop.key} />
              </div>
              <p className="landing-stop-cap">{stop.caption}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
