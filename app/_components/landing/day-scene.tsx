"use client";

import {
  CHAPTERS,
  chapterAt,
  chapterFade,
  lerp,
  seg,
  typedCount,
} from "./day-script";
import { useReducedMotion } from "./use-in-view";
import { useScrollProgress } from "./use-scroll-progress";

const BALANCE_BEFORE = 1240.5;
const BALANCE_AFTER = 1236.0;

function money(value: number): string {
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function rise(t: number): React.CSSProperties {
  return {
    opacity: t,
    transform: `translateY(${(1 - t) * 12}px)`,
  };
}

function StreamRow({
  t,
  title,
  meta,
  done,
  accentMeta,
}: {
  t: number;
  title: string;
  meta: string;
  done?: boolean;
  accentMeta?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 bg-card rounded-xl px-3 py-2.5" style={rise(t)}>
      <span
        className={`inline-flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center border text-[9px] leading-none ${
          done
            ? "border-accent bg-accent text-accent-fg"
            : "border-line-subtle text-transparent"
        }`}
      >
        ✓
      </span>
      <span
        className={`text-sm truncate ${done ? "text-muted line-through" : "text-fg"}`}
      >
        {title}
      </span>
      <span
        className={`ml-auto text-meta whitespace-nowrap ${
          accentMeta ? "text-accent" : "text-muted"
        }`}
      >
        {meta}
      </span>
    </div>
  );
}

function CaptureBar({
  text,
  full,
  chips,
  hint,
}: {
  text: string;
  full: string;
  chips: { label: string; t: number }[];
  hint?: string | null;
}) {
  return (
    <div>
      {hint && <p className="text-meta text-muted mb-2">{hint}</p>}
      <div className="flex flex-wrap items-center gap-1.5 mb-2 min-h-6">
        {chips.map((chip) => (
          <span
            key={chip.label}
            className="px-2 py-1 text-[10px] tracking-widest uppercase rounded-full bg-accent text-accent-fg"
            style={{
              opacity: chip.t,
              transform: `scale(${0.85 + chip.t * 0.15})`,
            }}
          >
            {chip.label}
          </span>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <div className="flex-1 bg-glass-well rounded-field border border-line-strong px-3 py-2.5 text-sm text-fg min-h-[2.6rem]">
          {text}
          {text.length > 0 && text.length < full.length && (
            <span className="landing-caret text-accent">▮</span>
          )}
          {text.length === 0 && <span className="text-muted">new task…</span>}
        </div>
        <span className="rounded-full bg-accent text-accent-fg text-sm font-bold px-3 py-2.5">
          add
        </span>
      </div>
    </div>
  );
}

// Chapter content, all values derived from local progress so the scene
// scrubs both directions. Shared by the pinned scene and the reduced-motion
// static frames.
function ChapterContent({ index, local }: { index: number; local: number }) {
  switch (CHAPTERS[index].key) {
    case "wake":
      return (
        <div className="space-y-px">
          <StreamRow
            t={seg(local, 0.12, 0.3)}
            title="call the landlord"
            meta="today"
          />
          <StreamRow
            t={seg(local, 0.32, 0.5)}
            title="stats lecture"
            meta="14:00"
          />
          <StreamRow
            t={seg(local, 0.52, 0.7)}
            title="outline the essay"
            meta="fri"
          />
          <p
            className="pt-3 text-meta text-muted text-center"
            style={rise(seg(local, 0.72, 0.88))}
          >
            3 due · 2 events · all held
          </p>
        </div>
      );
    case "capture": {
      const typed = "buy milk today".slice(
        0,
        typedCount("buy milk today", seg(local, 0.08, 0.5)),
      );
      const chipT = seg(local, 0.52, 0.62);
      const rowT = seg(local, 0.68, 0.84);
      return (
        <div className="space-y-4">
          <div className="space-y-px">
            <StreamRow t={rowT} title="buy milk" meta="today" />
            <StreamRow t={1} title="call the landlord" meta="today" />
          </div>
          <CaptureBar
            text={rowT > 0 ? "" : typed}
            full="buy milk today"
            chips={chipT > 0 && rowT === 0 ? [{ label: "today", t: chipT }] : []}
          />
        </div>
      );
    }
    case "money": {
      const typed = "$4.50 coffee".slice(
        0,
        typedCount("$4.50 coffee", seg(local, 0.06, 0.38)),
      );
      const draw = seg(local, 0.45, 0.92);
      return (
        <div className="space-y-4">
          <CaptureBar
            text={draw > 0 ? "" : typed}
            full="$4.50 coffee"
            chips={[]}
            hint={
              typed.startsWith("$") && draw === 0
                ? "log spend — enter to review"
                : null
            }
          />
          <div style={rise(seg(local, 0.42, 0.55))}>
            <svg viewBox="0 0 280 90" className="w-full" aria-hidden>
              <polyline
                points="0,38 55,34 90,30 110,62 150,58 185,54 205,18 250,14 280,10"
                fill="none"
                stroke="var(--accent)"
                strokeWidth="2"
                strokeDasharray="420"
                strokeDashoffset={420 * (1 - draw)}
              />
              <text x="100" y="80" fill="var(--muted)" fontSize="9">
                rent
              </text>
              <text x="196" y="10" fill="var(--muted)" fontSize="9">
                payday
              </text>
            </svg>
            <p className="mt-1 text-meta text-muted text-right">
              ~ forecast to end of month
            </p>
          </div>
        </div>
      );
    }
    case "shelf": {
      const bars = [
        { name: "milk", to: 0.1, pin: true },
        { name: "rice", to: 0.45, pin: false },
        { name: "coffee", to: 0.25, pin: false },
      ];
      const drain = seg(local, 0.12, 0.72);
      const pinT = seg(local, 0.75, 0.88);
      return (
        <div className="space-y-3">
          {bars.map((bar) => (
            <div key={bar.name}>
              <div className="flex items-center justify-between text-meta text-muted mb-1">
                <span>{bar.name}</span>
                {bar.pin && (
                  <span className="text-fg" style={{ opacity: pinT }}>
                    buy by thu
                  </span>
                )}
              </div>
              <div className="h-2 bg-card border border-line rounded-full overflow-hidden">
                <div
                  className="h-full bg-accent origin-left"
                  style={{
                    transform: `scaleX(${lerp(0.96, bar.to, drain)})`,
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      );
    }
    case "night": {
      const dots: [number, number][] = [
        [30, 20],
        [110, 12],
        [200, 30],
        [70, 62],
        [160, 70],
        [240, 58],
      ];
      const links: [number, number][] = [
        [0, 1],
        [1, 2],
        [0, 3],
        [3, 4],
        [1, 4],
        [4, 5],
      ];
      const lineT = (i: number) => seg(local, 0.08 + i * 0.07, 0.3 + i * 0.07);
      return (
        <div>
          <svg viewBox="0 0 270 84" className="w-full" aria-hidden>
            {links.map(([a, b], i) => (
              <line
                key={i}
                x1={dots[a][0]}
                y1={dots[a][1]}
                x2={dots[b][0]}
                y2={dots[b][1]}
                stroke="var(--border-subtle)"
                strokeWidth="1"
                strokeDasharray="200"
                strokeDashoffset={200 * (1 - lineT(i))}
              />
            ))}
            {dots.map(([x, y], i) => (
              <circle
                key={i}
                cx={x}
                cy={y}
                r="3.5"
                fill="var(--accent)"
                opacity={seg(local, 0.05 + i * 0.05, 0.15 + i * 0.05)}
              />
            ))}
          </svg>
          <p
            className="mt-4 text-body text-fg text-center"
            style={rise(seg(local, 0.72, 0.9))}
          >
            the day is kept.
          </p>
        </div>
      );
    }
  }
}

function balanceAt(index: number, local: number): number {
  if (index < 2) return BALANCE_BEFORE;
  if (index > 2) return BALANCE_AFTER;
  return lerp(BALANCE_BEFORE, BALANCE_AFTER, seg(local, 0.4, 0.55));
}

function Board({
  index,
  local,
}: {
  index: number;
  local: number;
}) {
  const nightDim = CHAPTERS[index].key === "night" ? 1 - seg(local, 0, 0.25) * 0.55 : 1;
  return (
    <div className="w-[min(24rem,92vw)] glass-panel p-4">
      <div
        className="flex items-baseline justify-between mb-4"
        style={{ opacity: nightDim }}
      >
        <p className="text-body text-fg">
          tuesday <span className="text-muted">· {CHAPTERS[index].time}</span>
        </p>
        <p className="text-meta text-muted tabular-nums">
          {money(balanceAt(index, local))}
        </p>
      </div>
      <div style={{ opacity: chapterFade(index, local) }}>
        <ChapterContent index={index} local={local} />
      </div>
    </div>
  );
}

function ChapterLabel({
  index,
  local,
}: {
  index: number;
  local: number;
}) {
  const chapter = CHAPTERS[index];
  const fade = chapterFade(index, local);
  return (
    <div
      className="text-center lg:text-left"
      style={{ opacity: fade, transform: `translateY(${(1 - fade) * 10}px)` }}
    >
      <p className="text-5xl sm:text-6xl font-bold tracking-tight text-fg tabular-nums">
        {chapter.time}
      </p>
      <p className="mt-1 text-label uppercase text-accent">{chapter.title}</p>
      <p className="mt-3 text-body text-muted max-w-[16rem] mx-auto lg:mx-0">
        {chapter.caption}
      </p>
    </div>
  );
}

// The pinned scene: one board living through one day, scrubbed by scroll.
// ~150vh of scroll per chapter — roomy enough to watch each beat land;
// scrolling back rewinds the day.
export function DayScene() {
  const { ref, progress } = useScrollProgress<HTMLDivElement>();
  const reduced = useReducedMotion();

  if (reduced) {
    return (
      <section>
        {CHAPTERS.map((chapter, index) => (
          <div
            key={chapter.key}
            className="min-h-[80svh] flex flex-col lg:flex-row items-center justify-center gap-10 px-6 py-16"
          >
            <ChapterLabel index={index} local={0.5} />
            <Board index={index} local={0.85} />
          </div>
        ))}
      </section>
    );
  }

  const { index, local } = chapterAt(progress);
  // The accent "sun": rises out of the pre-dawn dark, crosses the sky as
  // the day passes, and sets fully at night — it fades at both ends so the
  // scene blends seamlessly into the sections around it.
  const sunX = lerp(-28, 28, progress);
  const sunY = 18 - Math.sin(progress * Math.PI) * 14;
  const sunOpacity =
    0.1 * seg(progress, 0.02, 0.1) * (1 - seg(progress, 0.72, 0.92));

  return (
    <section ref={ref} className="relative h-[850svh]">
      <div className="sticky top-0 h-[100svh] overflow-hidden">
        <div
          aria-hidden
          className="absolute rounded-full bg-accent blur-3xl pointer-events-none"
          style={{
            width: "58vmin",
            height: "58vmin",
            left: `calc(50% + ${sunX}vw)`,
            top: `${sunY}%`,
            transform: "translate(-50%, -50%)",
            opacity: sunOpacity,
          }}
        />

        <div className="relative h-full flex flex-col lg:flex-row items-center justify-center gap-8 lg:gap-20 px-6">
          <ChapterLabel index={index} local={local} />
          <Board index={index} local={local} />
        </div>

        <div
          aria-hidden
          className="absolute right-4 top-1/2 -translate-y-1/2 hidden sm:flex flex-col gap-2"
        >
          {CHAPTERS.map((chapter, i) => (
            <span
              key={chapter.key}
              className={`w-1 transition-all duration-300 ${
                i === index ? "h-8 bg-accent" : "h-3 bg-card-hover"
              }`}
            />
          ))}
        </div>

        <p
          aria-hidden
          className="absolute bottom-5 inset-x-0 text-center text-meta text-muted transition-opacity duration-500"
          style={{ opacity: progress < 0.03 ? 1 : 0 }}
        >
          keep scrolling — the day plays as you go ▼
        </p>
      </div>
    </section>
  );
}
