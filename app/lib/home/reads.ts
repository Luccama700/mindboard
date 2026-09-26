import "server-only";
import { homeDb, resolveMember } from "./db";
import { describeChore, mealLate, nextMeal, vanTime, vanToday, type HomeChore, type HomeMember } from "./logic";

type Feeding = { fed_by: string; fed_at: string; slot: "lunch" | "dinner" };
type Windows = { lunch_from: string; lunch_to: string; dinner_from: string; dinner_to: string };
type Completion = { chore_name: string; completed_by: string; completed_at: string };

const nameOf = (members: HomeMember[], id: string) => members.find((m) => m.id === id)?.name ?? "someone";

async function loadChores(): Promise<HomeChore[]> {
  const { data, error } = await homeDb()
    .from("chores")
    .select("id, name, frequency, interval_days, assigned_to, assignees, due_date")
    .order("due_date")
    .order("name");
  if (error) throw new Error(error.message);
  return (data ?? []) as HomeChore[];
}

async function recentCompletions(members: HomeMember[], limit: number) {
  const { data, error } = await homeDb()
    .from("chore_completions")
    .select("chore_name, completed_by, completed_at")
    .order("completed_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return ((data ?? []) as Completion[]).map((c) => ({
    chore: c.chore_name,
    by: nameOf(members, c.completed_by),
    at: c.completed_at,
  }));
}

export async function getHomeStatus(userId: string) {
  const { member, members } = await resolveMember(userId);
  const db = homeDb();
  const now = new Date();
  const today = vanToday(now);

  const [settingsRes, feedingsRes, chores] = await Promise.all([
    db.from("household_settings").select("lunch_from, lunch_to, dinner_from, dinner_to").eq("id", 1).single(),
    db.from("feedings").select("fed_by, fed_at, slot").eq("fed_on", today).order("fed_at", { ascending: false }),
    loadChores(),
  ]);
  if (settingsRes.error) throw new Error(settingsRes.error.message);
  if (feedingsRes.error) throw new Error(feedingsRes.error.message);
  const w = settingsRes.data as Windows;
  const feedings = (feedingsRes.data ?? []) as Feeding[];

  const meal = (s: "lunch" | "dinner", from: string, to: string) => {
    const f = feedings.find((x) => x.slot === s);
    return {
      fed: f ? { by: nameOf(members, f.fed_by), at: vanTime(f.fed_at) } : null,
      usually: `${from.slice(0, 5)}-${to.slice(0, 5)}`,
      late: mealLate(now, to, Boolean(f)),
    };
  };
  const lunch = meal("lunch", w.lunch_from, w.lunch_to);
  const dinner = meal("dinner", w.dinner_from, w.dinner_to);

  return {
    you: member.name,
    today,
    taiga: {
      // By order, not clock: the next feeding logged today will count as this meal.
      nextFeedingCountsAs: nextMeal(feedings.length),
      lunch,
      dinner,
      feedingsToday: feedings.length,
    },
    choresDue: chores.filter((c) => c.due_date <= today).map((c) => describeChore(c, members, today)),
  };
}

export async function listHomeChores(userId: string) {
  const { members } = await resolveMember(userId);
  const today = vanToday();
  const [chores, history] = await Promise.all([loadChores(), recentCompletions(members, 10)]);
  return {
    today,
    members: members.map((m) => ({ name: m.name, role: m.role, inDefaultRotation: m.in_rotation })),
    chores: chores.map((c) => describeChore(c, members, today)),
    recentCompletions: history,
  };
}
