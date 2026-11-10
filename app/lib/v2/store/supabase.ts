import "server-only";
import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";

import {
  type BlockRow,
  dayPatchToRow,
  emptyDayRow,
  fromAlertRow,
  fromAskRow,
  fromBlockRow,
  fromChannelRow,
  fromDayRow,
  fromExpectationRow,
  fromFeedRunRow,
  fromOutboxRow,
  fromRulesRow,
  toAlertRow,
  toAskRow,
  toBlockRow,
  toExpectationRow,
  toFeedRunRow,
  toOutboxRow,
  toRulesRow,
} from "./mappers";
import type {
  Alert,
  Ask,
  Block,
  BlockState,
  DateKey,
  FeedRun,
  Instant,
} from "../types";
import type {
  ChannelLink,
  DayPatch,
  DayRecord,
  EngineUser,
  OutboxItem,
  RulesDocument,
  SetStateOptions,
  StoredExpectation,
  Stores,
} from "./types";

// The production Stores, on the service client.
//
// The service client BYPASSES row level security, so the explicit user_id in
// every statement below IS the tenant boundary - the same invariant the MCP
// tool layer runs on (AGENTS.md, "Multi-tenant MCP invariant"), and the one
// __tests__/tenant-scope-invariant.test.ts reads this file to enforce. Three
// statements here carry no user_id, all three resolve WHICH account is calling
// and return an id and nothing else, and all three have an allowlist entry in
// that test saying why.
//
// Two shapes repeat and are worth knowing before reading on.
//
// A conditional update. `.update(...).eq("user_id", ...).eq("id", ...)` plus a
// guard on the column that must not have moved, then `.select(...)` and
// `.maybeSingle()`. One statement, so two overlapping ticks cannot both pass
// the guard; null means the row was not in the state the caller assumed, which
// is the normal answer to a double tap or a retried webhook, not an error.
//
// An insert that must happen once. `.upsert(..., { onConflict: "<the unique
// key>", ignoreDuplicates: true })` with `.select().maybeSingle()`: a row comes
// back when this call was the one that wrote it, and null when the key was
// already there. ON CONFLICT DO NOTHING is not reached by a conflict on a
// DIFFERENT constraint, so a reused id still raises 23505 and is thrown rather
// than mistaken for a duplicate key.
//
// Every error is thrown. A store that answers "nothing found" to a transport
// failure would make the tick quietly plan an empty day.
//
// Every write is also run through the mappers BOTH ways before it is sent, the
// way the memory store does. That is not belt and braces: Postgres happily
// accepts a 13 character option id or an empty error class, and the row would
// then throw a RowShapeError on every subsequent read for that account. Better
// to refuse the write.

const RULES_COLUMNS = "user_id, enabled, rules";
const DAY_COLUMNS =
  "user_id, date, energy, energy_assumed, mode, planned_at, morning_sent_at, dropped, leave_by";
const BLOCK_COLUMNS =
  "user_id, id, date, starts_at, ends_at, kind, lane, task_id, title, state, reason";
const ASK_COLUMNS =
  "user_id, id, kind, topic, text, options, default_option_id, time_critical, opened_at, remind_at, reminded_at, expires_at, status, answered_option_id, answered_at, assumed, dedupe_key";
const OUTBOX_COLUMNS =
  "user_id, id, kind, dedupe_key, delivery, message, ask_id, created_at, claimed_at, sent_at, chat_message_id, error";
const EXPECTATION_COLUMNS =
  "user_id, feed, label, every_minutes, grace_minutes, min_count, active_from, active_to, enabled_at";
const FEED_RUN_COLUMNS = "feed, started_at, finished_at, status, item_count, error_class";
const ALERT_COLUMNS = "user_id, id, cause, feeds, since, step, last_sent_at, status";
const CHANNEL_COLUMNS = "user_id, chat_id, linked_at";

// PostgREST caps a response at 1000 rows, so every list here is explicitly
// bounded and says what happens at the boundary.
/** One page of feed runs, and the most pages one watchdog pass will read. */
const RUN_PAGE = 1000;
const RUN_PAGES = 10;
/** Items the sender takes in one tick. Bounded set: a claim never returns. */
const SENDABLE_LIMIT = 50;
/** The display list, newest first, so the cap drops the oldest stuck items. */
const UNSENT_LIMIT = 200;

const UNIQUE_VIOLATION = "23505";

function raise(what: string, error: PostgrestError): never {
  throw new Error(`v2 store: ${what} failed (${error.code ?? "unknown"}): ${error.message}`);
}

/**
 * The columns a plan may rewrite. `state` is not one of them, which is the
 * point: the update that uses this is guarded on `state = 'planned'` and must
 * leave that state alone. The mapper is borrowed for the column names only, so
 * the empty user id it is handed is dropped before the statement is built.
 */
function plannedFields(block: Block): Omit<BlockRow, "user_id" | "id" | "state"> {
  const row = toBlockRow("", block);
  return {
    date: row.date,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    kind: row.kind,
    lane: row.lane,
    task_id: row.task_id,
    title: row.title,
    reason: row.reason,
  };
}

export function createSupabaseStores(client: SupabaseClient): Stores {
  return {
    users: {
      async listEnabled(): Promise<string[]> {
        // Crosses accounts by design: the tick has to know who to run for.
        // Returns ids and nothing else, so no account's rules, chat or day is
        // read here. Allowlisted in the tenant-scope test.
        const { data, error } = await client.from("v2_rules").select("user_id").eq("enabled", true);
        if (error) raise("users.listEnabled", error);
        return (data ?? []).map((row) => (row as { user_id: string }).user_id);
      },

      async get(userId: string): Promise<EngineUser | null> {
        const { data, error } = await client
          .from("v2_rules")
          .select(RULES_COLUMNS)
          .eq("user_id", userId)
          .maybeSingle();
        if (error) raise("users.get", error);
        return data ? fromRulesRow(data) : null;
      },

      async save(
        userId: string,
        input: { rules: RulesDocument; enabled: boolean },
      ): Promise<void> {
        const { error } = await client
          .from("v2_rules")
          .upsert({ ...toRulesRow(userId, input.rules, input.enabled), user_id: userId }, { onConflict: "user_id" });
        if (error) raise("users.save", error);
      },
    },

    days: {
      async get(userId: string, date: DateKey): Promise<DayRecord | null> {
        const { data, error } = await client
          .from("v2_days")
          .select(DAY_COLUMNS)
          .eq("user_id", userId)
          .eq("date", date)
          .maybeSingle();
        if (error) raise("days.get", error);
        return data ? fromDayRow(data) : null;
      },

      async patch(userId: string, date: DateKey, patch: DayPatch): Promise<DayRecord> {
        const fields = dayPatchToRow(patch);
        fromDayRow({ ...emptyDayRow(userId, date), ...fields });
        // One upsert naming only the patched columns: on insert the rest take
        // their table defaults, on conflict only these are assigned. So the
        // tick and an incoming answer can both write the row without either
        // erasing what the other wrote.
        const { data, error } = await client
          .from("v2_days")
          .upsert({ ...fields, user_id: userId, date }, { onConflict: "user_id,date" })
          .select(DAY_COLUMNS)
          .single();
        if (error) raise("days.patch", error);
        return fromDayRow(data);
      },
    },

    blocks: {
      async listForDate(userId: string, date: DateKey): Promise<Block[]> {
        const { data, error } = await client
          .from("v2_blocks")
          .select(BLOCK_COLUMNS)
          .eq("user_id", userId)
          .eq("date", date)
          .order("starts_at", { ascending: true })
          .order("id", { ascending: true });
        if (error) raise("blocks.listForDate", error);
        return (data ?? []).map(fromBlockRow);
      },

      async listOpenBefore(userId: string, date: DateKey): Promise<Block[]> {
        const { data, error } = await client
          .from("v2_blocks")
          .select(BLOCK_COLUMNS)
          .eq("user_id", userId)
          .lt("date", date)
          .in("state", ["planned", "started"])
          .order("starts_at", { ascending: true })
          .order("id", { ascending: true });
        if (error) raise("blocks.listOpenBefore", error);
        return (data ?? []).map(fromBlockRow);
      },

      async replacePlanned(userId: string, date: DateKey, next: Block[]): Promise<void> {
        for (const block of next) fromBlockRow(toBlockRow(userId, block));
        // Read what is there, then issue only statements a block the user has
        // touched cannot match. Nothing here is a blanket delete-and-reinsert:
        // a row that flips to 'started' between the read and the writes is
        // protected by the `state = 'planned'` guard on every one of them.
        const current = await client
          .from("v2_blocks")
          .select("id, state")
          .eq("user_id", userId)
          .eq("date", date);
        if (current.error) raise("blocks.replacePlanned read", current.error);
        const rows = (current.data ?? []) as Array<{ id: string; state: string }>;
        const locked = new Set(rows.filter((row) => row.state !== "planned").map((row) => row.id));
        const planned = new Set(rows.filter((row) => row.state === "planned").map((row) => row.id));

        const incoming = next.filter((block) => !locked.has(block.id));
        const incomingIds = new Set(incoming.map((block) => block.id));
        const stale = [...planned].filter((id) => !incomingIds.has(id));

        if (stale.length > 0) {
          // `.in` quotes each id, which matters: a block id is
          // <date>:<kind>:<task> and a hand-built `not.in.(...)` would break on
          // the colons.
          const { error } = await client
            .from("v2_blocks")
            .delete()
            .eq("user_id", userId)
            .eq("date", date)
            .eq("state", "planned")
            .in("id", stale);
          if (error) raise("blocks.replacePlanned delete", error);
        }

        const fresh = incoming.filter((block) => !planned.has(block.id));
        if (fresh.length > 0) {
          const { error } = await client
            .from("v2_blocks")
            .upsert(fresh.map((block) => ({ ...toBlockRow(userId, block), user_id: userId })), { onConflict: "user_id,id", ignoreDuplicates: true });
          if (error) raise("blocks.replacePlanned insert", error);
        }

        for (const block of incoming.filter((candidate) => planned.has(candidate.id))) {
          const { error } = await client
            .from("v2_blocks")
            .update(plannedFields(block))
            .eq("user_id", userId)
            .eq("id", block.id)
            .eq("state", "planned");
          if (error) raise("blocks.replacePlanned update", error);
        }
      },

      async setState(
        userId: string,
        blockId: string,
        state: BlockState,
        options?: SetStateOptions,
      ): Promise<Block | null> {
        const fields: { state: BlockState; reason?: string } = { state };
        if (options?.reason !== undefined) fields.reason = options.reason;
        let query = client
          .from("v2_blocks")
          .update(fields)
          .eq("user_id", userId)
          .eq("id", blockId);
        if (options?.from !== undefined) query = query.eq("state", options.from);
        const { data, error } = await query.select(BLOCK_COLUMNS).maybeSingle();
        if (error) raise("blocks.setState", error);
        return data ? fromBlockRow(data) : null;
      },

      async setTime(
        userId: string,
        blockId: string,
        start: Instant,
        end: Instant,
      ): Promise<Block | null> {
        const { data, error } = await client
          .from("v2_blocks")
          .update({ starts_at: start, ends_at: end })
          .eq("user_id", userId)
          .eq("id", blockId)
          .eq("state", "planned")
          .select(BLOCK_COLUMNS)
          .maybeSingle();
        if (error) raise("blocks.setTime", error);
        return data ? fromBlockRow(data) : null;
      },
    },

    asks: {
      async insert(userId: string, ask: Ask): Promise<{ ask: Ask; created: boolean }> {
        const row = toAskRow(userId, ask);
        fromAskRow(row);
        const inserted = await client
          .from("v2_asks")
          .upsert({ ...row, user_id: userId }, { onConflict: "user_id,dedupe_key", ignoreDuplicates: true })
          .select(ASK_COLUMNS)
          .maybeSingle();
        if (inserted.error) raise("asks.insert", inserted.error);
        if (inserted.data) return { ask: fromAskRow(inserted.data), created: true };

        // The key has been used before. Whatever that ask's status is now, it is
        // the answer: a dedupe key is asked once, ever.
        const existing = await client
          .from("v2_asks")
          .select(ASK_COLUMNS)
          .eq("user_id", userId)
          .eq("dedupe_key", ask.dedupeKey)
          .maybeSingle();
        if (existing.error) raise("asks.insert read-back", existing.error);
        if (!existing.data) {
          throw new Error(`v2 store: asks.insert wrote nothing for key ${ask.dedupeKey}`);
        }
        return { ask: fromAskRow(existing.data), created: false };
      },

      async get(userId: string, askId: string): Promise<Ask | null> {
        const { data, error } = await client
          .from("v2_asks")
          .select(ASK_COLUMNS)
          .eq("user_id", userId)
          .eq("id", askId)
          .maybeSingle();
        if (error) raise("asks.get", error);
        return data ? fromAskRow(data) : null;
      },

      async listOpen(userId: string): Promise<Ask[]> {
        const { data, error } = await client
          .from("v2_asks")
          .select(ASK_COLUMNS)
          .eq("user_id", userId)
          .eq("status", "open")
          .order("opened_at", { ascending: true })
          .order("id", { ascending: true });
        if (error) raise("asks.listOpen", error);
        return (data ?? []).map(fromAskRow);
      },

      async answer(
        userId: string,
        askId: string,
        optionId: string,
        at: Instant,
      ): Promise<Ask | null> {
        const { data, error } = await client
          .from("v2_asks")
          .update({ status: "answered", answered_option_id: optionId, answered_at: at })
          .eq("user_id", userId)
          .eq("id", askId)
          .eq("status", "open")
          .select(ASK_COLUMNS)
          .maybeSingle();
        if (error) raise("asks.answer", error);
        return data ? fromAskRow(data) : null;
      },

      async expire(userId: string, askId: string, at: Instant): Promise<Ask | null> {
        // `at` is the sweep's own time and is not stored: expires_at already
        // records when the ask was due, and the answer fields stay empty
        // because nobody answered. `assumed` is what says the default applied.
        void at;
        const { data, error } = await client
          .from("v2_asks")
          .update({ status: "expired", assumed: true })
          .eq("user_id", userId)
          .eq("id", askId)
          .eq("status", "open")
          .select(ASK_COLUMNS)
          .maybeSingle();
        if (error) raise("asks.expire", error);
        return data ? fromAskRow(data) : null;
      },

      async remind(userId: string, askId: string, at: Instant): Promise<Ask | null> {
        const { data, error } = await client
          .from("v2_asks")
          .update({ reminded_at: at })
          .eq("user_id", userId)
          .eq("id", askId)
          .eq("status", "open")
          .is("reminded_at", null)
          .select(ASK_COLUMNS)
          .maybeSingle();
        if (error) raise("asks.remind", error);
        return data ? fromAskRow(data) : null;
      },

      async countUnanswered(userId: string, topic: string, since: Instant): Promise<number> {
        const { count, error } = await client
          .from("v2_asks")
          .select("id", { count: "exact", head: true })
          .eq("user_id", userId)
          .eq("topic", topic)
          .eq("status", "expired")
          .gte("opened_at", since);
        if (error) raise("asks.countUnanswered", error);
        return count ?? 0;
      },
    },

    outbox: {
      async enqueue(userId: string, item: OutboxItem): Promise<boolean> {
        const row = toOutboxRow(userId, item);
        fromOutboxRow(row);
        // A non-null ask_id is a composite foreign key, so Postgres refuses a
        // dangling or cross-account link with a 23503 and this throws.
        const { data, error } = await client
          .from("v2_outbox")
          .upsert({ ...row, user_id: userId }, { onConflict: "user_id,dedupe_key", ignoreDuplicates: true })
          .select("id")
          .maybeSingle();
        if (error) raise("outbox.enqueue", error);
        return data !== null;
      },

      async listSendable(
        userId: string,
        delivery: OutboxItem["delivery"],
      ): Promise<OutboxItem[]> {
        const { data, error } = await client
          .from("v2_outbox")
          .select(OUTBOX_COLUMNS)
          .eq("user_id", userId)
          .eq("delivery", delivery)
          .is("sent_at", null)
          .is("claimed_at", null)
          .order("created_at", { ascending: true })
          .order("id", { ascending: true })
          .limit(SENDABLE_LIMIT);
        if (error) raise("outbox.listSendable", error);
        return (data ?? []).map(fromOutboxRow);
      },

      async listUnsent(userId: string): Promise<OutboxItem[]> {
        // Newest first on purpose. Held digests and failed sends never leave
        // this set, so an oldest-first page would eventually stop showing
        // today's messages once enough had piled up.
        const { data, error } = await client
          .from("v2_outbox")
          .select(OUTBOX_COLUMNS)
          .eq("user_id", userId)
          .is("sent_at", null)
          .order("created_at", { ascending: false })
          .order("id", { ascending: true })
          .limit(UNSENT_LIMIT);
        if (error) raise("outbox.listUnsent", error);
        return (data ?? []).map(fromOutboxRow);
      },

      async claim(userId: string, id: string, at: Instant): Promise<OutboxItem | null> {
        const { data, error } = await client
          .from("v2_outbox")
          .update({ claimed_at: at })
          .eq("user_id", userId)
          .eq("id", id)
          .is("claimed_at", null)
          .select(OUTBOX_COLUMNS)
          .maybeSingle();
        if (error) raise("outbox.claim", error);
        return data ? fromOutboxRow(data) : null;
      },

      async markSent(
        userId: string,
        id: string,
        at: Instant,
        chatMessageId: string | null,
      ): Promise<void> {
        const { error } = await client
          .from("v2_outbox")
          .update({ sent_at: at, chat_message_id: chatMessageId, error: null })
          .eq("user_id", userId)
          .eq("id", id);
        if (error) raise("outbox.markSent", error);
      },

      async markFailed(userId: string, id: string, at: Instant, message: string): Promise<void> {
        // The claim deliberately stays, so a message the provider refused is
        // not retried on every tick for the rest of the day.
        void at;
        const { error } = await client
          .from("v2_outbox")
          .update({ error: message })
          .eq("user_id", userId)
          .eq("id", id);
        if (error) raise("outbox.markFailed", error);
      },

      async countInterruptsSince(userId: string, since: Instant): Promise<number> {
        // Counted at enqueue time, not at send time: two asks opened in one
        // tick both have to count against the day's budget.
        const { count, error } = await client
          .from("v2_outbox")
          .select("id", { count: "exact", head: true })
          .eq("user_id", userId)
          .eq("kind", "ask")
          .eq("delivery", "interrupt")
          .gte("created_at", since);
        if (error) raise("outbox.countInterruptsSince", error);
        return count ?? 0;
      },
    },

    feeds: {
      async listExpectations(userId: string): Promise<StoredExpectation[]> {
        const { data, error } = await client
          .from("v2_feed_expectations")
          .select(EXPECTATION_COLUMNS)
          .eq("user_id", userId)
          .order("feed", { ascending: true });
        if (error) raise("feeds.listExpectations", error);
        return (data ?? []).map(fromExpectationRow);
      },

      async saveExpectation(userId: string, expectation: StoredExpectation): Promise<void> {
        const row = toExpectationRow(userId, expectation);
        fromExpectationRow(row);
        const { error } = await client
          .from("v2_feed_expectations")
          .upsert({ ...row, user_id: userId }, { onConflict: "user_id,feed" });
        if (error) raise("feeds.saveExpectation", error);
      },

      async addRun(userId: string, run: FeedRun): Promise<void> {
        const row = toFeedRunRow(userId, run);
        fromFeedRunRow(row);
        const { error } = await client
          .from("v2_feed_runs")
          .insert({ ...row, user_id: userId });
        if (error) raise("feeds.addRun", error);
      },

      async listRuns(userId: string, since: Instant): Promise<FeedRun[]> {
        // Paged, not capped. The watchdog judges EVERY feed from this list, and
        // a feed that runs once a day would otherwise sit behind a thousand
        // newer tick runs and read as blind. Newest first with the id as a
        // tiebreaker, so the pages do not overlap or skip.
        const out: FeedRun[] = [];
        for (let page = 0; page < RUN_PAGES; page += 1) {
          const from = page * RUN_PAGE;
          const { data, error } = await client
            .from("v2_feed_runs")
            .select(FEED_RUN_COLUMNS)
            .eq("user_id", userId)
            .gte("started_at", since)
            .order("started_at", { ascending: false })
            .order("id", { ascending: true })
            .range(from, from + RUN_PAGE - 1);
          if (error) raise("feeds.listRuns", error);
          const rows = data ?? [];
          out.push(...rows.map(fromFeedRunRow));
          if (rows.length < RUN_PAGE) break;
        }
        return out;
      },

      async prune(userId: string, before: Instant): Promise<number> {
        const { data, error } = await client
          .from("v2_feed_runs")
          .delete()
          .eq("user_id", userId)
          .lt("started_at", before)
          .select("id");
        if (error) raise("feeds.prune", error);
        return (data ?? []).length;
      },
    },

    alerts: {
      async listOpen(userId: string): Promise<Alert[]> {
        const { data, error } = await client
          .from("v2_alerts")
          .select(ALERT_COLUMNS)
          .eq("user_id", userId)
          .eq("status", "open")
          .order("since", { ascending: true })
          .order("id", { ascending: true });
        if (error) raise("alerts.listOpen", error);
        return (data ?? []).map(fromAlertRow);
      },

      async save(userId: string, alert: Alert): Promise<boolean> {
        const row = toAlertRow(userId, alert);
        fromAlertRow(row);
        const { error } = await client
          .from("v2_alerts")
          .upsert({ ...row, user_id: userId }, { onConflict: "user_id,id" });
        // The only unique constraint this upsert does NOT target is the partial
        // index on (user_id, cause) where status = 'open', so a 23505 here says
        // exactly one thing: another tick already opened an alert for this
        // cause. The tick that loses that race must not announce.
        if (error && error.code === UNIQUE_VIOLATION) return false;
        if (error) raise("alerts.save", error);
        return true;
      },

      async lastAnnounced(userId: string, cause: string): Promise<Alert | null> {
        const { data, error } = await client
          .from("v2_alerts")
          .select(ALERT_COLUMNS)
          .eq("user_id", userId)
          .eq("cause", cause)
          .not("last_sent_at", "is", null)
          .order("last_sent_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (error) raise("alerts.lastAnnounced", error);
        return data ? fromAlertRow(data) : null;
      },
    },

    channels: {
      async get(userId: string): Promise<ChannelLink | null> {
        const { data, error } = await client
          .from("v2_channels")
          .select(CHANNEL_COLUMNS)
          .eq("user_id", userId)
          .maybeSingle();
        if (error) raise("channels.get", error);
        return data ? fromChannelRow(data) : null;
      },

      async setPairing(userId: string, codeHash: string, expiresAt: Instant): Promise<void> {
        // Only the pairing columns, so an account that is already linked keeps
        // its chat while a new code is outstanding.
        const { error } = await client
          .from("v2_channels")
          .upsert({ user_id: userId, pairing_hash: codeHash, pairing_expires_at: expiresAt }, { onConflict: "user_id" });
        if (error) raise("channels.setPairing", error);
      },

      async redeemPairing(
        codeHash: string,
        chatId: string,
        at: Instant,
      ): Promise<string | null> {
        // One conditional update, keyed on the hash rather than on a user,
        // because the code IS the identity here - the same shape as the PAT
        // lookup in app/lib/mcp/pat.ts and the device-token lookup in
        // app/lib/urc/device.ts. It clears the hash in the statement that
        // writes the chat, so the code works once, with no window between a
        // read and a write. It returns a user id and nothing else.
        // Allowlisted in the tenant-scope test.
        const { data, error } = await client.from("v2_channels").update({ chat_id: chatId, linked_at: at, pairing_hash: null, pairing_expires_at: null }).eq("pairing_hash", codeHash).gt("pairing_expires_at", at).select("user_id").maybeSingle();
        // A chat already linked to another account trips the unique index on
        // chat_id. The code stays unredeemed and the caller is told no, rather
        // than one account quietly taking over another's chat.
        if (error && error.code === UNIQUE_VIOLATION) return null;
        if (error) raise("channels.redeemPairing", error);
        return data ? (data as { user_id: string }).user_id : null;
      },

      async userForChat(chatId: string): Promise<string | null> {
        // Resolves which account an incoming Telegram update belongs to, so
        // there is no user id to filter by yet. Returns an id and nothing else.
        // Allowlisted in the tenant-scope test.
        const { data, error } = await client.from("v2_channels").select("user_id").eq("chat_id", chatId).maybeSingle();
        if (error) raise("channels.userForChat", error);
        return data ? (data as { user_id: string }).user_id : null;
      },
    },
  };
}
