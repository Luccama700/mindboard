// The storage seam for the v2 engine. Everything above this file is pure: the
// planner, the asks, the watchdog and the message builders all take values and
// return values. Everything below it is one of two implementations of the same
// interface, an in-memory one for tests and a Supabase one for production, and
// `__tests__/v2-store-memory.test.ts` is where their shared semantics are
// pinned.
//
// Three rules shape every method here.
//
// 1. The tenant comes first. Every method takes `userId` as its first argument,
//    with exactly three exceptions, all of which resolve WHICH account is
//    calling and return an id and nothing else: `users.listEnabled`,
//    `channels.userForChat` and `channels.redeemPairing`. The Supabase
//    implementation runs on the RLS-bypassing service client, so that explicit
//    user_id is the whole tenant boundary (see AGENTS.md, "Multi-tenant MCP
//    invariant"). The three exceptions each carry an entry in
//    __tests__/tenant-scope-invariant.test.ts saying why.
//
// 2. Anything that must survive two ticks running at once is one conditional
//    statement, not a read followed by a write. `asks.answer`, `asks.expire`,
//    `asks.remind`, `outbox.claim`, `blocks.setState` with a `from` guard and
//    `blocks.setTime` all return the updated row, or null when the row was not
//    in the state the caller assumed. Null is the normal answer to a double tap
//    or a retried webhook, not an error.
//
// 3. Instants are compared as instants. The stored value may come back with any
//    zone offset, so every instant a store returns has been normalised by the
//    mappers to a canonical ISO string in UTC. Never compare two instants as
//    strings without going through a store or a mapper first.

import type {
  Alert,
  Ask,
  Block,
  BlockState,
  DateKey,
  Energy,
  Expectation,
  FeedRun,
  Instant,
  LaneKey,
  OutgoingMessage,
  PlanMode,
  PlanOutput,
  PlannerRules,
} from "../types";

// ---------------------------------------------------------------- documents

/**
 * Everything the user configures, in one jsonb column.
 *
 * `planner` is a PARTIAL PlannerRules and is stored exactly as given: this file
 * never validates its contents, because `parseRules` (app/lib/v2/rules.ts)
 * merges it over the spec defaults and is the only door it comes through. A key
 * written by a newer version of the app therefore survives an older read.
 */
export interface RulesDocument {
  planner: Partial<PlannerRules>;
  lanes: Array<{
    key: LaneKey;
    label: string;
    color: string;
    groupIds: string[];
    /**
     * Whether a dated task in this lane is a real deadline. False, the default
     * for a stored document that predates the field, means a date in this lane
     * is a soft intention: the planner may move it, and it does not pull work
     * into the hard window.
     */
    hardDates: boolean;
  }>;
  feedLabels: Record<string, string>;
}

/**
 * One account the engine runs for.
 *
 * `timeZone` is a projection of `rules.planner.timeZone`, defaulted to "UTC"
 * when it is absent or not a zone this runtime knows, so that one bad field
 * cannot stop the engine reading the account. It is deliberately NOT a second
 * source of truth.
 *
 * `parseRules` is stricter: it THROWS on a zone this runtime does not know. So
 * build the planner rules as
 *
 *     parseRules({ ...user.rules.planner, timeZone: user.timeZone })
 *
 * which is the one spelling in which the store's zone and the planner's zone
 * cannot disagree.
 *
 * Whatever surface lets a user switch the engine on should seed
 * `planner.timeZone` from `user_settings.timezone`, or the account plans its
 * day in UTC.
 */
export interface EngineUser {
  userId: string;
  timeZone: string;
  rules: RulesDocument;
}

/** One local day. Created by the first patch of the day, never by hand. */
export interface DayRecord {
  userId: string;
  date: DateKey;
  /** null until he answers. The planner then uses "ok" and says it assumed. */
  energy: Energy | null;
  energyAssumed: boolean;
  mode: PlanMode;
  plannedAt: Instant | null;
  morningSentAt: Instant | null;
  dropped: PlanOutput["dropped"];
  leaveBy: PlanOutput["leaveBy"];
}

/** One message the channel will send, or has sent. */
export interface OutboxItem {
  id: string;
  userId: string;
  kind: "morning" | "ask" | "alert" | "note";
  /** Two items with the same key are the same message. Enqueued once, ever. */
  dedupeKey: string;
  /** A held ask is never queued, so "hold" is not a stored value. */
  delivery: "interrupt" | "digest";
  message: OutgoingMessage;
  askId: string | null;
  createdAt: Instant;
  claimedAt: Instant | null;
  sentAt: Instant | null;
  chatMessageId: string | null;
  /** A short stable class such as "bot-blocked". Never a provider message. */
  error: string | null;
}

/** The Telegram link for one account. A pairing hash never leaves the store. */
export interface ChannelLink {
  userId: string;
  chatId: string | null;
  linkedAt: Instant | null;
}

/**
 * A stored `Expectation`, plus the two things only storage knows: the name to
 * show the user, and when this expectation started counting. A feed cannot be
 * judged late before it has been enabled for one interval plus its grace.
 */
export interface StoredExpectation extends Expectation {
  label: string;
  enabledAt: Instant;
}

/** The fields of a day a caller may write. Absent fields are left alone. */
export type DayPatch = Partial<Omit<DayRecord, "userId" | "date">>;

/** Options for `blocks.setState`. */
export interface SetStateOptions {
  /** Stored on the block, so Today can say why it looks like that. */
  reason?: string;
  /** When given, the update applies only if the block is still in this state. */
  from?: BlockState;
}

// ---------------------------------------------------------------- stores

export interface UsersStore {
  /**
   * The ids of every account with the engine switched on. The ONE read that
   * crosses accounts by design, and it returns ids only: the rules document of
   * an account is never read here, only through `get(userId)`.
   */
  listEnabled(): Promise<string[]>;
  get(userId: string): Promise<EngineUser | null>;
  /** Creates or replaces the whole rules row. */
  save(userId: string, input: { rules: RulesDocument; enabled: boolean }): Promise<void>;
}

export interface DaysStore {
  get(userId: string, date: DateKey): Promise<DayRecord | null>;
  /**
   * Creates the day if it is not there and writes only the fields given, so the
   * tick and an incoming answer can both touch the row without either erasing
   * what the other wrote. Returns the day as it now stands.
   */
  patch(userId: string, date: DateKey, patch: DayPatch): Promise<DayRecord>;
}

export interface BlocksStore {
  listForDate(userId: string, date: DateKey): Promise<Block[]>;
  /**
   * Blocks dated before `date` that are still `planned` or `started`: what an
   * earlier day left open and the tick has to close out.
   */
  listOpenBefore(userId: string, date: DateKey): Promise<Block[]>;
  /**
   * Stores a plan for one day. Rows still in state `planned` are replaced by
   * the given blocks; rows in `started`, `done` or `skipped` are left exactly
   * as they are, and an incoming block whose id matches one of them is ignored.
   * A plan is therefore never able to undo something the user already did.
   */
  replacePlanned(userId: string, date: DateKey, blocks: Block[]): Promise<void>;
  setState(
    userId: string,
    blockId: string,
    state: BlockState,
    options?: SetStateOptions,
  ): Promise<Block | null>;
  /** Moves a block that is still `planned`. Returns null for any other state. */
  setTime(userId: string, blockId: string, start: Instant, end: Instant): Promise<Block | null>;
}

export interface AsksStore {
  /**
   * Opens an ask, once per dedupe key, ever. When the key has been used before,
   * the stored ask comes back unchanged with `created: false` - whatever its
   * status is now. That is what lets the tick ask "is there already an ask for
   * this block?" and "open one" in a single call.
   */
  insert(userId: string, ask: Ask): Promise<{ ask: Ask; created: boolean }>;
  get(userId: string, askId: string): Promise<Ask | null>;
  listOpen(userId: string): Promise<Ask[]>;
  /** One conditional update on an open ask. Null for a second tap or a retry. */
  answer(userId: string, askId: string, optionId: string, at: Instant): Promise<Ask | null>;
  /** Marks an open ask expired and assumed. The caller applies the default. */
  expire(userId: string, askId: string, at: Instant): Promise<Ask | null>;
  /** Records the one reminder. Null when it has already been reminded. */
  remind(userId: string, askId: string, at: Instant): Promise<Ask | null>;
  /**
   * How many asks on this topic expired unanswered since `since`. The backoff
   * signal: a topic nobody answers goes quiet.
   */
  countUnanswered(userId: string, topic: string, since: Instant): Promise<number>;
}

export interface OutboxStore {
  /**
   * False when the dedupe key was already queued, having written nothing. A
   * non-null `askId` must name an ask of the same account: the column is a
   * composite foreign key, so this throws rather than storing a dangling link.
   */
  enqueue(userId: string, item: OutboxItem): Promise<boolean>;
  /**
   * What the sender should try now: unsent, unclaimed, that delivery, oldest
   * first. Bounded by construction - a claimed item never comes back - which
   * is why this and not `listUnsent` is what the tick sends from.
   */
  listSendable(userId: string, delivery: OutboxItem["delivery"]): Promise<OutboxItem[]>;
  /**
   * Everything not yet sent, NEWEST first and capped: held digests and failed
   * sends stay here forever, so an oldest-first page would eventually stop
   * showing today's. For display and diagnosis, never for sending.
   */
  listUnsent(userId: string): Promise<OutboxItem[]>;
  /** One conditional update. Null when another tick already claimed it. */
  claim(userId: string, id: string, at: Instant): Promise<OutboxItem | null>;
  markSent(userId: string, id: string, at: Instant, chatMessageId: string | null): Promise<void>;
  markFailed(userId: string, id: string, at: Instant, error: string): Promise<void>;
  /**
   * Interrupting asks queued since `since`, which is the day's interrupt
   * budget. Counted at enqueue time, not at send time, so two asks opened in
   * one tick both count against it.
   */
  countInterruptsSince(userId: string, since: Instant): Promise<number>;
}

export interface FeedsStore {
  listExpectations(userId: string): Promise<StoredExpectation[]>;
  saveExpectation(userId: string, expectation: StoredExpectation): Promise<void>;
  addRun(userId: string, run: FeedRun): Promise<void>;
  /**
   * Every run started at or after `since`, newest first. Paged internally, so
   * a feed that runs once a day is not hidden behind a page of tick runs.
   */
  listRuns(userId: string, since: Instant): Promise<FeedRun[]>;
  /** Deletes this account's feed runs started before `before`. Returns how many. */
  prune(userId: string, before: Instant): Promise<number>;
}

export interface AlertsStore {
  listOpen(userId: string): Promise<Alert[]>;
  /**
   * Stores an alert, new or changed. False when another alert is already open
   * for the same cause, which is a database fact rather than a re-check: the
   * tick that loses that race must not announce.
   */
  save(userId: string, alert: Alert): Promise<boolean>;
  /** The newest alert for this cause that was actually sent, open or closed. */
  lastAnnounced(userId: string, cause: string): Promise<Alert | null>;
}

export interface ChannelsStore {
  get(userId: string): Promise<ChannelLink | null>;
  /** Stores the SHA-256 hash of a one-time code. The code is never stored. */
  setPairing(userId: string, codeHash: string, expiresAt: Instant): Promise<void>;
  /**
   * Links a chat to whichever account holds this unexpired hash, and clears the
   * hash in the same statement, so a code works once. Returns that account's
   * id, or null when the hash is unknown, expired, or the chat already belongs
   * to someone else.
   *
   * One of the three methods that does not take a userId: the code IS the
   * identity here, exactly like the PAT hash lookup in app/lib/mcp/pat.ts.
   */
  redeemPairing(codeHash: string, chatId: string, at: Instant): Promise<string | null>;
  /** Which account a Telegram chat belongs to. Returns an id and nothing else. */
  userForChat(chatId: string): Promise<string | null>;
}

export interface Stores {
  users: UsersStore;
  days: DaysStore;
  blocks: BlocksStore;
  asks: AsksStore;
  outbox: OutboxStore;
  feeds: FeedsStore;
  alerts: AlertsStore;
  channels: ChannelsStore;
}
