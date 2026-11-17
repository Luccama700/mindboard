"use client";

import Link from "next/link";
import { useInView } from "./use-in-view";

const ENTRIES: { name: string; lines: string[] }[] = [
  {
    name: "name",
    lines: ["mindboard: a board for your mind."],
  },
  {
    name: "synopsis",
    lines: ["open it. type one line. get back to your day."],
  },
  {
    name: "workspace",
    lines: [
      "sign in with any google account and you get your own.",
      "every table is locked to its owner, row by row.",
    ],
  },
  {
    name: "install",
    lines: [
      "add it to your home screen. it opens like an app,",
      "with the dock already under your thumb.",
    ],
  },
  {
    name: "your data",
    lines: [
      "export all of it or delete the account, from settings.",
      "settings also lists every place your data goes.",
    ],
  },
  {
    name: "see also",
    lines: ["claude(mcp), your calendar, your kitchen."],
  },
];

// The facts, in the shape of a man page, and the way in.
export function FinePrint() {
  const { ref, inView } = useInView<HTMLElement>();

  return (
    <section
      ref={ref}
      className={`landing-sec landing-close landing-crt${inView ? " is-in" : ""}`}
    >
      <div className="landing-man">
        <p className="landing-man-head" aria-hidden>
          <span>MINDBOARD(1)</span>
          <span>the fine print</span>
          <span>MINDBOARD(1)</span>
        </p>
        <dl>
          {ENTRIES.map((entry, index) => (
            <div key={entry.name} style={{ ["--i" as string]: index }}>
              <dt>{entry.name}</dt>
              <dd>
                {entry.lines.map((line) => (
                  <span key={line}>{line} </span>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="landing-end">
        <p className="landing-end-line">
          whatever you are holding right now,
          <span>
            put it down.
            <i className="landing-caret" aria-hidden />
          </span>
        </p>
        <Link href="/login" className="landing-cta">
          continue with google <span aria-hidden>→</span>
        </Link>
        <p className="landing-foot">
          built for one person at a time · installs to your home screen ·
          speaks mcp
        </p>
      </div>
    </section>
  );
}
