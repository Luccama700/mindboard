// Urgency scoring for the NOW board: a single deterministic number per task,
// synthesized from lateness, priority, due-time proximity, and effort. Pure —
// `today` (and the optional wall clock) are injected. The tier thresholds are
// the visual contract the stream client reads to elevate a card.

export type UrgencyTask = {
  due_date: string | null;
  due_time: string | null; // "HH:MM" | "HH:MM:SS"
  priority: "low" | "med" | "high";
  estimated_minutes: number | null;
};

const PRIORITY_BOOST: Record<UrgencyTask["priority"], number> = {
  high: 6,
  med: 3,
  low: 0,
};

// Local copy of the tiny lateness helper (stream.ts has its own, coupled to its
// parseKey); duplicating keeps this module dependency-free and avoids an import
// cycle, since stream.ts imports urgencyScore/urgencyTier from here.
function parseKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function daysLate(dueKey: string, today: string): number {
  return Math.round(
    (parseKey(today).getTime() - parseKey(dueKey).getTime()) / 86_400_000,
  );
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.slice(0, 5).split(":").map(Number);
  return h * 60 + m;
}

// Components:
//   overdue      daysLate × 10
//   priority     high +6 / med +3 / low +0
//   due today    +3, plus (with a wall clock + due_time):
//                  time passed  +8
//                  else within 2h  +5
//   effort       only when due today or late: ≥120m +3 / ≥60m +2 / ≥30m +1
export function urgencyScore(
  task: UrgencyTask,
  today: string,
  nowClock?: string,
): number {
  const { due_date, due_time, priority, estimated_minutes } = task;
  let score = PRIORITY_BOOST[priority];

  const late = due_date && due_date < today ? daysLate(due_date, today) : 0;
  if (late > 0) score += late * 10;

  const dueToday = due_date === today;
  if (dueToday) {
    score += 3;
    if (due_time && nowClock) {
      const due = toMinutes(due_time);
      const now = toMinutes(nowClock);
      if (due <= now) score += 8;
      else if (due - now <= 120) score += 5;
    }
  }

  if ((dueToday || late > 0) && estimated_minutes) {
    if (estimated_minutes >= 120) score += 3;
    else if (estimated_minutes >= 60) score += 2;
    else if (estimated_minutes >= 30) score += 1;
  }

  return score;
}

// Tier thresholds — the stream client's elevation contract:
//   3 focus    ≥ 14
//   2 elevated ≥ 8
//   1 standard ≥ 1
//   0          else
export function urgencyTier(score: number): 0 | 1 | 2 | 3 {
  if (score >= 14) return 3;
  if (score >= 8) return 2;
  if (score >= 1) return 1;
  return 0;
}
