// The in-memory Stores. Engine tests run on this, so it is not a convenience
// double: it has to behave the way the Supabase stores behave, or the tests
// above it stop being about production.
//
// Three things it deliberately emulates rather than simplifies.
//
// 1. Every write goes through the mappers, both ways. That makes the memory
//    store as strict as the table's own check constraints - a bad enum or a
//    malformed options payload is a RowShapeError here too - and it makes the
//    values it reads back normalised the same way PostgREST's are.
// 2. Every uniqueness rule the migration states is enforced here: one ask per
//    dedupe key, one outbox item per dedupe key, one OPEN alert per cause, one
//    account per chat id. A caller that races itself gets the same answer it
//    would get from Postgres.
// 3. Every conditional update is conditional here too. `answer`, `expire`,
//    `remind`, `claim` and `setTime` return null when the row was not in the
//    state the caller assumed, which is what makes a double tap or a retried
//    webhook a no-op rather than a second effect.
//
// No clock and no id generator: every instant and every id arrives as an
// argument, exactly as in the pure modules above.

import { compareText } from "../plan/day";
import {
  type AlertRow,
  type AskRow,
  type BlockRow,
  type ChannelRow,
  type DayRow,
  type ExpectationRow,
  type FeedRunRow,
  type OutboxRow,
  type RulesRow,
  assertChatMessageId,
  assertErrorClass,
  assertOptionId,
  assertPairingHash,
  assertWindow,
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
  parseRulesDocument,
  toAlertRow,
  toAskRow,
  toPlanRows,
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

/** A uuid holds no "|", and a block id holds no "|" either. */
function key(userId: string, rest: string): string {
  return `${userId}|${rest}`;
}

function ms(instant: Instant): number {
  return Date.parse(instant);
}

/** Stands in for a unique violation on a primary key. Never a normal answer. */
class DuplicateIdError extends Error {
  constructor(table: string, id: string) {
    super(`v2 store: ${table} already holds id ${id} for this user`);
    this.name = "DuplicateIdError";
  }
}

/** Stands in for a composite foreign key violation (Postgres 23503). */
class MissingReferenceError extends Error {
  constructor(column: string, id: string) {
    super(`v2 store: ${column} ${id} is not a row of this user`);
    this.name = "MissingReferenceError";
  }
}

export function createMemoryStores(): Stores {
  const rules = new Map<string, RulesRow>();
  const days = new Map<string, DayRow>();
  const blocks = new Map<string, BlockRow>();
  const asks = new Map<string, AskRow>();
  const outbox = new Map<string, OutboxRow>();
  const expectations = new Map<string, ExpectationRow>();
  let runs: FeedRunRow[] = [];
  const alerts = new Map<string, AlertRow>();
  const channels = new Map<string, ChannelRow>();

  const ownBlocks = (userId: string): BlockRow[] =>
    [...blocks.values()].filter((row) => row.user_id === userId);
  const ownAsks = (userId: string): AskRow[] =>
    [...asks.values()].filter((row) => row.user_id === userId);
  const ownOutbox = (userId: string): OutboxRow[] =>
    [...outbox.values()].filter((row) => row.user_id === userId);
  const ownAlerts = (userId: string): AlertRow[] =>
    [...alerts.values()].filter((row) => row.user_id === userId);

  return {
    users: {
      async listEnabled(): Promise<string[]> {
        return [...rules.values()].filter((row) => row.enabled).map((row) => row.user_id);
      },

      async get(userId: string): Promise<EngineUser | null> {
        const row = rules.get(userId);
        return row ? fromRulesRow(row) : null;
      },

      async save(
        userId: string,
        input: { rules: RulesDocument; enabled: boolean },
      ): Promise<void> {
        // The envelope is checked and defaulted; the planner half stays opaque,
        // because parseRules (app/lib/v2/rules.ts) is what interprets that and
        // a key written by a newer version of the app has to survive.
        rules.set(userId, toRulesRow(userId, parseRulesDocument(input.rules), input.enabled));
      },
    },

    days: {
      async get(userId: string, date: DateKey): Promise<DayRecord | null> {
        const row = days.get(key(userId, date));
        return row ? fromDayRow(row) : null;
      },

      async patch(userId: string, date: DateKey, patch: DayPatch): Promise<DayRecord> {
        const current = days.get(key(userId, date)) ?? emptyDayRow(userId, date);
        const next: DayRow = { ...current, ...dayPatchToRow(patch) };
        const record = fromDayRow(next);
        days.set(key(userId, date), next);
        return record;
      },
    },

    blocks: {
      async listForDate(userId: string, date: DateKey): Promise<Block[]> {
        return ownBlocks(userId)
          .filter((row) => row.date === date)
          .sort((a, b) => ms(a.starts_at) - ms(b.starts_at) || compareText(a.id, b.id))
          .map(fromBlockRow);
      },

      async listOpenBefore(userId: string, date: DateKey): Promise<Block[]> {
        return ownBlocks(userId)
          .filter((row) => row.date < date && (row.state === "planned" || row.state === "started"))
          .sort((a, b) => ms(a.starts_at) - ms(b.starts_at) || compareText(a.id, b.id))
          .map(fromBlockRow);
      },

      // The contract is written out in 0066, above
      // public.v2_replace_planned_blocks, which is the one statement the
      // Supabase store issues for this. Every clause below is one of its five
      // numbered promises; keep the two in step.
      async replacePlanned(userId: string, date: DateKey, next: Block[]): Promise<void> {
        // (1) and (5): everything is checked before anything is written - the
        // shape of every block, the day each one claims, and the same id twice
        // - through the one builder the Supabase store also uses, so the two
        // cannot disagree about what a bad plan is.
        const rows = toPlanRows(userId, date, next);

        // (2) and (4): an id is available to this plan only if nothing holds
        // it, or the row that holds it is a planned row of this same day. A
        // row recording what he did is not the planner's to rewrite, and a
        // planned block of another day is not the planner's to drag over here.
        const keep = rows.filter((row) => {
          const current = blocks.get(key(userId, row.id));
          return !current || (current.state === "planned" && current.date === date);
        });
        const keepIds = new Set(keep.map((row) => row.id));

        // (3) Planned rows of this day that the new plan does not mention.
        for (const row of ownBlocks(userId)) {
          if (row.date === date && row.state === "planned" && !keepIds.has(row.id)) {
            blocks.delete(key(userId, row.id));
          }
        }

        // `state` is never written by a plan: a new row starts 'planned' and a
        // kept one is planned already.
        for (const row of keep) {
          blocks.set(key(userId, row.id), { ...row, state: "planned" });
        }
      },

      async setState(
        userId: string,
        blockId: string,
        state: BlockState,
        options?: SetStateOptions,
      ): Promise<Block | null> {
        const current = blocks.get(key(userId, blockId));
        if (!current) return null;
        if (options?.from !== undefined && current.state !== options.from) return null;
        const next: BlockRow = {
          ...current,
          state,
          reason: options?.reason ?? current.reason,
        };
        const block = fromBlockRow(next);
        blocks.set(key(userId, blockId), next);
        return block;
      },

      async setTime(
        userId: string,
        blockId: string,
        start: Instant,
        end: Instant,
      ): Promise<Block | null> {
        assertWindow(start, end);
        const current = blocks.get(key(userId, blockId));
        if (!current || current.state !== "planned") return null;
        const next: BlockRow = { ...current, starts_at: start, ends_at: end };
        const block = fromBlockRow(next);
        blocks.set(key(userId, blockId), next);
        return block;
      },
    },

    asks: {
      async insert(userId: string, ask: Ask): Promise<{ ask: Ask; created: boolean }> {
        // Validated BEFORE the duplicate key is looked at, because Postgres
        // checks the row's shape whatever the conflict resolution is: a
        // malformed ask must not come back as a harmless `created: false`.
        const row = toAskRow(userId, ask);
        const stored = fromAskRow(row);
        const sameKey = ownAsks(userId).find((candidate) => candidate.dedupe_key === ask.dedupeKey);
        if (sameKey) return { ask: fromAskRow(sameKey), created: false };
        if (asks.has(key(userId, ask.id))) throw new DuplicateIdError("v2_asks", ask.id);
        asks.set(key(userId, ask.id), row);
        return { ask: stored, created: true };
      },

      async get(userId: string, askId: string): Promise<Ask | null> {
        const row = asks.get(key(userId, askId));
        return row ? fromAskRow(row) : null;
      },

      async listOpen(userId: string): Promise<Ask[]> {
        return ownAsks(userId)
          .filter((row) => row.status === "open")
          .sort((a, b) => ms(a.opened_at) - ms(b.opened_at) || compareText(a.id, b.id))
          .map(fromAskRow);
      },

      async answer(
        userId: string,
        askId: string,
        optionId: string,
        at: Instant,
      ): Promise<Ask | null> {
        assertOptionId(optionId);
        const current = asks.get(key(userId, askId));
        if (!current || current.status !== "open") return null;
        // The option has to be one this ask offered, checked in the same step
        // as the status, so a stale or forged callback cannot record an answer
        // the ask never had. Null, not an error: it is the same "nothing
        // changed" answer a second tap gets.
        if (!current.options.some((option) => option.id === optionId)) return null;
        const next: AskRow = {
          ...current,
          status: "answered",
          answered_option_id: optionId,
          answered_at: at,
        };
        const stored = fromAskRow(next);
        asks.set(key(userId, askId), next);
        return stored;
      },

      async expire(userId: string, askId: string, at: Instant): Promise<Ask | null> {
        const current = asks.get(key(userId, askId));
        if (!current || current.status !== "open") return null;
        // Nobody answered, so the answer fields stay empty; `assumed` is what
        // says the default was applied. `at` is not stored: expires_at already
        // says when it was due, and the sweep time is the tick's own.
        void at;
        const next: AskRow = { ...current, status: "expired", assumed: true };
        const stored = fromAskRow(next);
        asks.set(key(userId, askId), next);
        return stored;
      },

      async remind(userId: string, askId: string, at: Instant): Promise<Ask | null> {
        const current = asks.get(key(userId, askId));
        if (!current || current.status !== "open" || current.reminded_at !== null) return null;
        const next: AskRow = { ...current, reminded_at: at };
        const stored = fromAskRow(next);
        asks.set(key(userId, askId), next);
        return stored;
      },

      async countUnanswered(userId: string, topic: string, since: Instant): Promise<number> {
        const from = ms(since);
        return ownAsks(userId).filter(
          (row) => row.topic === topic && row.status === "expired" && ms(row.opened_at) >= from,
        ).length;
      },
    },

    outbox: {
      async enqueue(userId: string, item: OutboxItem): Promise<boolean> {
        // Shape first, then the references, then the duplicate key: Postgres
        // checks all of them whatever the conflict resolution is, so a
        // malformed item must not come back as a harmless `false`.
        const row = toOutboxRow(userId, item);
        fromOutboxRow(row);
        // The composite foreign key on (user_id, ask_id). It matters because
        // asks.insert can hand back an EXISTING ask with a different id than
        // the one the caller made, and a message built from the caller's id
        // would then point at nothing.
        if (item.askId !== null && !asks.has(key(userId, item.askId))) {
          throw new MissingReferenceError("v2_outbox.ask_id", item.askId);
        }
        const sameKey = ownOutbox(userId).find(
          (candidate) => candidate.dedupe_key === item.dedupeKey,
        );
        if (sameKey) return false;
        if (outbox.has(key(userId, item.id))) throw new DuplicateIdError("v2_outbox", item.id);
        outbox.set(key(userId, item.id), row);
        return true;
      },

      async listSendable(
        userId: string,
        delivery: OutboxItem["delivery"],
      ): Promise<OutboxItem[]> {
        return ownOutbox(userId)
          .filter(
            (row) => row.sent_at === null && row.claimed_at === null && row.delivery === delivery,
          )
          .sort((a, b) => ms(a.created_at) - ms(b.created_at) || compareText(a.id, b.id))
          .map(fromOutboxRow);
      },

      async listUnsent(userId: string): Promise<OutboxItem[]> {
        // Newest first, like the Supabase read: this list keeps every held
        // digest and every failed send, so oldest-first would eventually stop
        // showing today's.
        return ownOutbox(userId)
          .filter((row) => row.sent_at === null)
          .sort((a, b) => ms(b.created_at) - ms(a.created_at) || compareText(a.id, b.id))
          .map(fromOutboxRow);
      },

      async claim(userId: string, id: string, at: Instant): Promise<OutboxItem | null> {
        const current = outbox.get(key(userId, id));
        if (!current || current.claimed_at !== null) return null;
        const next: OutboxRow = { ...current, claimed_at: at };
        const stored = fromOutboxRow(next);
        outbox.set(key(userId, id), next);
        return stored;
      },

      async markSent(
        userId: string,
        id: string,
        at: Instant,
        chatMessageId: string | null,
      ): Promise<void> {
        assertChatMessageId(chatMessageId);
        const current = outbox.get(key(userId, id));
        if (!current) return;
        const next: OutboxRow = {
          ...current,
          sent_at: at,
          chat_message_id: chatMessageId,
          error: null,
        };
        fromOutboxRow(next);
        outbox.set(key(userId, id), next);
      },

      async markFailed(userId: string, id: string, at: Instant, error: string): Promise<void> {
        assertErrorClass(error);
        const current = outbox.get(key(userId, id));
        if (!current) return;
        // The claim stays, so a message that the provider refused is not retried
        // on every tick for the rest of the day.
        void at;
        const next: OutboxRow = { ...current, error };
        fromOutboxRow(next);
        outbox.set(key(userId, id), next);
      },

      async countInterruptsSince(userId: string, since: Instant): Promise<number> {
        const from = ms(since);
        return ownOutbox(userId).filter(
          (row) =>
            row.kind === "ask" && row.delivery === "interrupt" && ms(row.created_at) >= from,
        ).length;
      },
    },

    feeds: {
      async listExpectations(userId: string): Promise<StoredExpectation[]> {
        return [...expectations.values()]
          .filter((row) => row.user_id === userId)
          .sort((a, b) => compareText(a.feed, b.feed))
          .map(fromExpectationRow);
      },

      async saveExpectation(userId: string, expectation: StoredExpectation): Promise<void> {
        const row = toExpectationRow(userId, expectation);
        fromExpectationRow(row);
        expectations.set(key(userId, expectation.feed), row);
      },

      async addRun(userId: string, run: FeedRun): Promise<void> {
        const row = toFeedRunRow(userId, run);
        fromFeedRunRow(row);
        runs.push(row);
      },

      async listRuns(userId: string, since: Instant): Promise<FeedRun[]> {
        const from = ms(since);
        return runs
          .filter((row) => row.user_id === userId && ms(row.started_at) >= from)
          .sort((a, b) => ms(b.started_at) - ms(a.started_at))
          .map(fromFeedRunRow);
      },

      async prune(userId: string, before: Instant): Promise<number> {
        const cut = ms(before);
        const keep = runs.filter(
          (row) => !(row.user_id === userId && ms(row.started_at) < cut),
        );
        const removed = runs.length - keep.length;
        runs = keep;
        return removed;
      },
    },

    alerts: {
      async listOpen(userId: string): Promise<Alert[]> {
        return ownAlerts(userId)
          .filter((row) => row.status === "open")
          .sort((a, b) => ms(a.since) - ms(b.since) || compareText(a.id, b.id))
          .map(fromAlertRow);
      },

      async save(userId: string, alert: Alert): Promise<boolean> {
        // The partial unique index on (user_id, cause) where status = 'open'.
        if (alert.status === "open") {
          const clash = ownAlerts(userId).find(
            (row) => row.status === "open" && row.cause === alert.cause && row.id !== alert.id,
          );
          if (clash) return false;
        }
        const row = toAlertRow(userId, alert);
        fromAlertRow(row);
        alerts.set(key(userId, alert.id), row);
        return true;
      },

      async lastAnnounced(userId: string, cause: string): Promise<Alert | null> {
        const sent = ownAlerts(userId)
          .filter((row) => row.cause === cause && row.last_sent_at !== null)
          .sort((a, b) => ms(b.last_sent_at as string) - ms(a.last_sent_at as string));
        return sent.length > 0 ? fromAlertRow(sent[0]) : null;
      },
    },

    channels: {
      async get(userId: string): Promise<ChannelLink | null> {
        const row = channels.get(userId);
        return row ? fromChannelRow(row) : null;
      },

      async setPairing(userId: string, codeHash: string, expiresAt: Instant): Promise<void> {
        // 0066's check constraint: 64 lowercase hex characters. The column
        // takes a digest and nothing else, so a raw code cannot land here even
        // by mistake.
        assertPairingHash(codeHash);
        const current = channels.get(userId) ?? {
          user_id: userId,
          chat_id: null,
          linked_at: null,
        };
        channels.set(userId, {
          ...current,
          pairing_hash: codeHash,
          pairing_expires_at: expiresAt,
        });
      },

      async redeemPairing(
        codeHash: string,
        chatId: string,
        at: Instant,
      ): Promise<string | null> {
        const now = ms(at);
        const row = [...channels.values()].find(
          (candidate) =>
            candidate.pairing_hash === codeHash &&
            candidate.pairing_expires_at != null &&
            ms(candidate.pairing_expires_at) > now,
        );
        if (!row) return null;
        // The unique index on chat_id: one account per chat.
        const taken = [...channels.values()].find(
          (candidate) => candidate.chat_id === chatId && candidate.user_id !== row.user_id,
        );
        if (taken) return null;
        channels.set(row.user_id, {
          ...row,
          chat_id: chatId,
          linked_at: at,
          pairing_hash: null,
          pairing_expires_at: null,
        });
        return row.user_id;
      },

      async userForChat(chatId: string): Promise<string | null> {
        const row = [...channels.values()].find((candidate) => candidate.chat_id === chatId);
        return row ? row.user_id : null;
      },
    },
  };
}
