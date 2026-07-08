"use client";

import { useInView } from "./use-in-view";

const DOORS: { input: string; chips: string[]; note: string }[] = [
  {
    input: "buy milk today",
    chips: ["task", "✓ today"],
    note: "a task, dated, filed",
  },
  {
    input: "$4.50 coffee",
    chips: ["spend", "→ forecast"],
    note: "logged, categorized, forecast updated",
  },
  {
    input: "? what should i do tonight",
    chips: ["copilot"],
    note: "a conversation with everything above",
  },
];

// The capture grammar, spelled out: one input, three kinds of thought.
export function GrammarDoors() {
  const { ref, inView } = useInView<HTMLDivElement>();

  return (
    <section className="px-6 py-24">
      <div ref={ref} className="max-w-xl mx-auto">
        <p
          className={`text-label uppercase text-muted mb-2 text-center landing-reveal ${
            inView ? "landing-in" : ""
          }`}
        >
          the bar
        </p>
        <p
          className={`text-title text-fg text-center mb-12 landing-reveal ${
            inView ? "landing-in" : ""
          }`}
        >
          one input. three doors.
        </p>

        <div className="space-y-4">
          {DOORS.map((door, index) => (
            <div
              key={door.input}
              className={`landing-reveal ${inView ? "landing-in" : ""}`}
              style={{ transitionDelay: `${index * 140}ms` }}
            >
              <div className="flex items-center gap-3 border border-line bg-popover px-4 py-3">
                <span className="text-accent" aria-hidden>
                  ›
                </span>
                <span className="text-sm text-fg truncate">{door.input}</span>
                <span className="ml-auto flex items-center gap-1.5">
                  {door.chips.map((chip) => (
                    <span
                      key={chip}
                      className="px-2 py-1 text-[10px] tracking-widest uppercase bg-accent text-accent-fg whitespace-nowrap"
                    >
                      {chip}
                    </span>
                  ))}
                </span>
              </div>
              <p className="mt-1.5 pl-8 text-meta text-muted">{door.note}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
