import "server-only";
import { cache } from "react";

import { createClient } from "@/utils/supabase/server";
import {
  GoogleCalendarConnectionError,
  listEvents,
  type CalendarEvent,
} from "@/utils/google/calendar";
import {
  getVaultCorpus,
  VaultConnectionError,
  type VaultNote,
} from "@/app/lib/brain/vault";
import { noteHref } from "@/app/lib/brain/parse";
import { zonedWallTimeToUtcMs } from "@/app/lib/snapshots/zoned-time";
import { countWords, readingMinutes } from "@/app/lib/mindspace/aggregate";
import type {
  MindspaceItem,
  MindspaceSource,
  MindspaceTopic,
  TopicKind,
  TopicStatus,
} from "@/app/lib/mindspace/types";

// Item gathering for the read-time Mindspace computation: every dated trace
// from the last `windowDays` days becomes a MindspaceItem. Vault notes without
// a parseable date (entity pages, templates, reel imports) are taxonomy
// anchors, not activity, and are skipped by design.

const WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const SESSION_GAP_MS = 60 * 60 * 1000;
const SESSION_MIN_MINUTES = 2;
const SESSION_MAX_MINUTES = 120;
const TASK_MASS = 3;
const SPEND_MASS = 1;
const EVENT_MAX_MINUTES = 240;
const MATCH_TEXT_CAP = 20_000;
const ROW_LIMIT = 2000;

const CREATED_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?/;
const TITLE_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{2})(\d{2}))?(?:\s|$)/;

export function parseNoteTimestamp(
  note: Pick<VaultNote, "title" | "frontmatter">,
  timeZone: string | null,
): number | null {
  const match =
    note.frontmatter.created?.match(CREATED_RE) ??
    note.title.match(TITLE_DATE_RE);
  if (!match) return null;
  const [, y, m, d, hh, mm] = match;
  return zonedWallTimeToUtcMs(
    `${y}-${m}-${d}`,
    hh !== undefined ? Number(hh) : 12,
    mm !== undefined ? Number(mm) : 0,
    timeZone,
  );
}

// Frontmatter `topics:` values arrive as the raw string `["Emma", "wellbeing"]`.
export function parseTopicsList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .split(",")
    .map((entry) => entry.trim().replace(/^["']|["']$/g, "").trim())
    .filter((entry) => entry.length > 0);
}

function noteSource(note: VaultNote): MindspaceSource {
  if (note.folder === "Journal") return "journal";
  if (note.frontmatter.type === "capture") return "capture";
  return "note";
}

function vaultItems(
  notes: VaultNote[],
  timeZone: string | null,
  cutoffMs: number,
  nowMs: number,
): MindspaceItem[] {
  const items: MindspaceItem[] = [];
  for (const note of notes) {
    const occurredAt = parseNoteTimestamp(note, timeZone);
    if (occurredAt === null || occurredAt < cutoffMs || occurredAt > nowMs) {
      continue;
    }
    const wordCount = countWords(note.body);
    items.push({
      source: noteSource(note),
      ref: note.path,
      title: note.title,
      href: noteHref(note.path),
      occurredAt,
      mass: readingMinutes(wordCount),
      wordCount,
      text: `${note.title}\n${note.body}`.slice(0, MATCH_TEXT_CAP),
      frontmatterTopics: parseTopicsList(note.frontmatter.topics),
      wikilinkPaths: note.outgoing,
      groupId: null,
    });
  }
  return items;
}

type SessionMessage = {
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
};

// ai_messages grouped into sessions: same conversation, gaps over an hour
// split. Mass is the session's wall-clock span; the matcher only sees the
// user's own words — the assistant's prose says little about whose mind this is.
export function chatSessions(
  messages: SessionMessage[],
  titles: Map<string, string | null>,
): MindspaceItem[] {
  const byConversation = new Map<string, SessionMessage[]>();
  for (const message of messages) {
    const bucket = byConversation.get(message.conversation_id);
    if (bucket) bucket.push(message);
    else byConversation.set(message.conversation_id, [message]);
  }

  const items: MindspaceItem[] = [];
  for (const [conversationId, bucket] of byConversation) {
    bucket.sort(
      (a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
    let sessionStart = 0;
    while (sessionStart < bucket.length) {
      let end = sessionStart;
      while (
        end + 1 < bucket.length &&
        new Date(bucket[end + 1].created_at).getTime() -
          new Date(bucket[end].created_at).getTime() <=
          SESSION_GAP_MS
      ) {
        end++;
      }
      const session = bucket.slice(sessionStart, end + 1);
      const startMs = new Date(session[0].created_at).getTime();
      const endMs = new Date(session[session.length - 1].created_at).getTime();
      const spanMinutes = Math.round((endMs - startMs) / 60_000);
      const userText = session
        .filter((m) => m.role === "user")
        .map((m) => m.content)
        .join("\n");
      const title = titles.get(conversationId) ?? null;
      items.push({
        source: "ai_chat",
        // Keyed by session start so the ref stays stable as older messages
        // age out of the fetch window (an ordinal would shift and orphan the
        // cached classification).
        ref: `${conversationId}:${startMs}`,
        title: title?.trim() ? title : "copilot chat",
        href: "/plan",
        occurredAt: endMs,
        mass: Math.min(
          SESSION_MAX_MINUTES,
          Math.max(SESSION_MIN_MINUTES, spanMinutes),
        ),
        wordCount: countWords(userText),
        text: `${title ?? ""}\n${userText}`.slice(0, MATCH_TEXT_CAP),
        frontmatterTopics: [],
        wikilinkPaths: [],
        groupId: null,
      });
      sessionStart = end + 1;
    }
  }
  return items;
}

export type MindspaceGather = {
  items: MindspaceItem[];
  vaultConnected: boolean;
  nowMs: number;
};

export const gatherMindspaceItems = cache(
  async (
    userId: string,
    timeZone: string | null,
  ): Promise<MindspaceGather> => {
    const nowMs = Date.now();
    const cutoffMs = nowMs - WINDOW_DAYS * DAY_MS;
    const cutoffIso = new Date(cutoffMs).toISOString();
    const cutoffDate = cutoffIso.slice(0, 10);
    const supabase = await createClient();

    const vaultPromise = getVaultCorpus(userId)
      .then((corpus) => ({
        notes: [...corpus.notes.values()],
        connected: true,
      }))
      .catch((error) => {
        if (error instanceof VaultConnectionError) {
          return { notes: [] as VaultNote[], connected: false };
        }
        throw error;
      });

    const eventsPromise: Promise<CalendarEvent[]> = listEvents(userId, {
      timeMin: cutoffIso,
      timeMax: new Date(nowMs).toISOString(),
    }).catch((error) => {
      if (error instanceof GoogleCalendarConnectionError) return [];
      console.error("mindspace listEvents failed", error);
      return [];
    });

    const [
      vault,
      events,
      groupsRes,
      tasksRes,
      messagesRes,
      conversationsRes,
      logsRes,
      spendRes,
      sessionsRes,
    ] = await Promise.all([
        vaultPromise,
        eventsPromise,
        supabase
          .from("groups")
          .select("id, google_calendar_id")
          .eq("user_id", userId)
          .not("google_calendar_id", "is", null),
        // Every capped read below is ordered descending: without ORDER BY,
        // Postgres row order is unspecified, so ROW_LIMIT would truncate an
        // arbitrary slice at any volume and the corpus would be built from it
        // silently. Each order ends in `id` so it is TOTAL — `created_at`
        // defaults to now(), which is transaction time, so a bulk import gives
        // every row the same timestamp and ties would otherwise be arbitrary.
        //
        // Tasks sort on created_at: a row can also qualify via completed_at, so
        // an old task completed yesterday drops before a task created
        // yesterday. max(created_at, completed_at) isn't expressible here, and
        // creation recency is the closer proxy for what the corpus wants.
        supabase
          .from("tasks")
          .select(
            "id, title, notes, group_id, estimated_minutes, created_at, completed_at",
          )
          .eq("user_id", userId)
          .or(`created_at.gte.${cutoffIso},completed_at.gte.${cutoffIso}`)
          .order("created_at", { ascending: false })
          .order("id", { ascending: true })
          .limit(ROW_LIMIT),
        supabase
          .from("ai_messages")
          .select("conversation_id, role, content, created_at")
          .eq("user_id", userId)
          .gte("created_at", cutoffIso)
          .order("created_at", { ascending: true })
          .limit(ROW_LIMIT),
        supabase
          .from("ai_conversations")
          .select("id, title")
          .eq("user_id", userId)
          .gte("updated_at", cutoffIso),
        supabase
          .from("daily_logs")
          .select("log_date, note")
          .eq("user_id", userId)
          .gte("log_date", cutoffDate)
          .not("note", "is", null),
        supabase
          .from("balance_changes")
          .select("id, note, occurred_at, spending_categories(name)")
          .eq("user_id", userId)
          .gte("occurred_at", cutoffDate)
          .not("note", "is", null)
          .order("occurred_at", { ascending: false })
          .order("created_at", { ascending: false })
          .order("id", { ascending: true })
          .limit(ROW_LIMIT),
        supabase
          .from("mindspace_sessions")
          .select(
            "provider, session_ref, title, project, started_at, ended_at, duration_min, word_count, user_text",
          )
          .eq("user_id", userId)
          .gte("ended_at", cutoffIso)
          .order("ended_at", { ascending: false })
          .order("id", { ascending: true })
          .limit(ROW_LIMIT),
      ]);

    const items: MindspaceItem[] = vaultItems(
      vault.notes,
      timeZone,
      cutoffMs,
      nowMs,
    );

    type TaskRow = {
      id: string;
      title: string;
      notes: string | null;
      group_id: string | null;
      estimated_minutes: number | null;
      created_at: string;
      completed_at: string | null;
    };
    for (const task of (tasksRes.data ?? []) as TaskRow[]) {
      const text = `${task.title}\n${task.notes ?? ""}`.slice(
        0,
        MATCH_TEXT_CAP,
      );
      const base = {
        title: task.title,
        href: "/tasks",
        wordCount: countWords(text),
        text,
        frontmatterTopics: [],
        wikilinkPaths: [],
        groupId: task.group_id,
      };
      const createdMs = new Date(task.created_at).getTime();
      if (createdMs >= cutoffMs && createdMs <= nowMs) {
        items.push({
          ...base,
          source: "task",
          ref: `task:${task.id}:created`,
          occurredAt: createdMs,
          mass: TASK_MASS,
        });
      }
      if (task.completed_at) {
        const completedMs = new Date(task.completed_at).getTime();
        if (completedMs >= cutoffMs && completedMs <= nowMs) {
          items.push({
            ...base,
            source: "task",
            ref: `task:${task.id}:completed`,
            occurredAt: completedMs,
            mass:
              TASK_MASS +
              Math.min(SESSION_MAX_MINUTES, task.estimated_minutes ?? 0),
          });
        }
      }
    }

    const titles = new Map<string, string | null>(
      ((conversationsRes.data ?? []) as { id: string; title: string | null }[]).map(
        (row) => [row.id, row.title],
      ),
    );
    items.push(
      ...chatSessions((messagesRes.data ?? []) as SessionMessage[], titles),
    );

    for (const log of (logsRes.data ?? []) as {
      log_date: string;
      note: string | null;
    }[]) {
      const note = log.note?.trim();
      if (!note) continue;
      items.push({
        source: "daily_log",
        ref: `daily:${log.log_date}`,
        title: `check-in ${log.log_date}`,
        href: null,
        occurredAt: zonedWallTimeToUtcMs(log.log_date, 12, 0, timeZone),
        mass: readingMinutes(countWords(note), 1, 10),
        wordCount: countWords(note),
        text: note.slice(0, MATCH_TEXT_CAP),
        frontmatterTopics: [],
        wikilinkPaths: [],
        groupId: null,
      });
    }

    type SpendRow = {
      id: string;
      note: string | null;
      occurred_at: string;
      spending_categories:
        | { name: string }
        | { name: string }[]
        | null;
    };
    for (const change of (spendRes.data ?? []) as SpendRow[]) {
      const note = change.note?.trim();
      if (!note) continue;
      const category = Array.isArray(change.spending_categories)
        ? (change.spending_categories[0] ?? null)
        : change.spending_categories;
      items.push({
        source: "spend",
        ref: `spend:${change.id}`,
        title: note,
        href: "/finance",
        occurredAt: zonedWallTimeToUtcMs(change.occurred_at, 12, 0, timeZone),
        mass: SPEND_MASS,
        wordCount: countWords(note),
        text: `${note}\n${category?.name ?? ""}`,
        frontmatterTopics: [],
        wikilinkPaths: [],
        groupId: null,
      });
    }

    // Imported external AI sessions (claude.ai export, Claude Code sync).
    // The item ref carries the word count so a session that grew on re-sync
    // gets a fresh ref and re-classifies; the old verdict ages out via cleanup.
    type SessionRow = {
      provider: "claude_ai" | "claude_code";
      session_ref: string;
      title: string | null;
      project: string | null;
      started_at: string;
      ended_at: string;
      duration_min: number;
      word_count: number;
      user_text: string;
    };
    for (const session of (sessionsRes.data ?? []) as SessionRow[]) {
      const endedMs = Date.parse(session.ended_at);
      if (Number.isNaN(endedMs) || endedMs < cutoffMs || endedMs > nowMs) {
        continue;
      }
      const title =
        session.title?.trim() ||
        (session.provider === "claude_code"
          ? `code session${session.project ? ` — ${session.project}` : ""}`
          : "claude.ai chat");
      items.push({
        source: session.provider,
        ref: `${session.session_ref}#${session.word_count}`,
        title,
        href: null,
        occurredAt: endedMs,
        mass: Math.min(
          SESSION_MAX_MINUTES,
          Math.max(SESSION_MIN_MINUTES, session.duration_min),
        ),
        wordCount: session.word_count,
        text: `${title}\n${session.project ?? ""}\n${session.user_text}`.slice(
          0,
          MATCH_TEXT_CAP,
        ),
        frontmatterTopics: [],
        wikilinkPaths: [],
        groupId: null,
      });
    }

    // Attended calendar time: timed events that already ended, weighted by
    // duration. An event on a group-linked calendar inherits that group for
    // the fast-path topic match.
    const calendarGroups = new Map(
      ((groupsRes.data ?? []) as {
        id: string;
        google_calendar_id: string | null;
      }[]).map((row) => [row.google_calendar_id as string, row.id]),
    );
    for (const event of events) {
      if (event.allDay) continue;
      const startMs = Date.parse(event.start);
      const endMs = Date.parse(event.end);
      if (Number.isNaN(startMs) || Number.isNaN(endMs)) continue;
      if (endMs > nowMs || endMs < cutoffMs) continue;
      const durationMinutes = Math.round((endMs - startMs) / 60_000);
      if (durationMinutes <= 0) continue;
      const title = event.summary || "untitled event";
      items.push({
        source: "event",
        ref: `event:${event.calendarId}:${event.eventId}`,
        title,
        href: "/week",
        occurredAt: startMs,
        mass: Math.min(EVENT_MAX_MINUTES, durationMinutes),
        wordCount: countWords(title),
        text: `${title}\n${event.calendarSummary}`,
        frontmatterTopics: [],
        wikilinkPaths: [],
        groupId: calendarGroups.get(event.calendarId) ?? null,
      });
    }

    return { items, vaultConnected: vault.connected, nowMs };
  },
);

type TopicRow = {
  id: string;
  name: string;
  kind: TopicKind;
  description: string | null;
  aliases: string[] | null;
  seed_ref: { vaultPath?: string; groupId?: string } | null;
  status: TopicStatus;
  pinned: boolean;
  color: string | null;
};

export const getMindspaceTopics = cache(
  async (userId: string): Promise<MindspaceTopic[]> => {
    const supabase = await createClient();
    const { data } = await supabase
      .from("mindspace_topics")
      .select(
        "id, name, kind, description, aliases, seed_ref, status, pinned, color",
      )
      .eq("user_id", userId)
      .neq("status", "archived")
      .order("created_at", { ascending: true });
    return ((data ?? []) as TopicRow[]).map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      description: row.description,
      aliases: row.aliases ?? [],
      seedVaultPath: row.seed_ref?.vaultPath ?? null,
      seedGroupId: row.seed_ref?.groupId ?? null,
      status: row.status,
      pinned: row.pinned,
      color: row.color,
    }));
  },
);
