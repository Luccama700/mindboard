import "server-only";
import { homeDb, resolveMember } from "./db";
import { describeChore, feedingSlot, vanTime, vanToday, type HomeChore, type HomeMember } from "./logic";

type Feeding = { fed_by: string; fed_at: string; slot: "morning" | "evening" };
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
    db.from("household_settings").select("morning_time, evening_time").eq("id", 1).single(),
    db.from("feedings").select("fed_by, fed_at, slot").eq("fed_on", today).order("fed_at", { ascending: false }),
    loadChores(),
  ]);
  if (settingsRes.error) throw new Error(settingsRes.error.message);
  if (feedingsRes.error) throw new Error(feedingsRes.error.message);
  const settings = settingsRes.data as { morning_time: string; evening_time: string };
  const feedings = (feedingsRes.data ?? []) as Feeding[];

  const slot = (s: "morning" | "evening") => {
    const f = feedings.find((x) => x.slot === s);
    return f ? { fedBy: nameOf(members, f.fed_by), at: vanTime(f.fed_at) } : null;
  };

  return {
    you: member.name,
    today,
    taiga: {
      currentSlot: feedingSlot(now, settings.morning_time, settings.evening_time),
      morning: slot("morning"),
      evening: slot("evening"),
      feedingTimes: { morning: settings.morning_time.slice(0, 5), evening: settings.evening_time.slice(0, 5) },
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
