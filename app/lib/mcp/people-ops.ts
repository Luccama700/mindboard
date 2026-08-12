// Pure people-update batch logic shared by the MCP server and the in-app
// assistant. One batch = one proposal = one confirm.
//
// Flow: validatePeopleOps (shape) → resolvePeopleOps (names → ids against a live
// roster) → the resolved ops are what gets stored on the proposal (ids, not
// names, so a rename between propose and confirm can't retarget a write) →
// renderPeopleReceipt (preview). Execution lives in writes.ts.
//
// Mirrors inventory-ops.ts deliberately, including the pendingItem pattern: a
// create_person earlier in the batch can be logged against or given a cadence
// later in the SAME batch, with the executor filling the id in after the insert.

import type { Result } from "./validate";

export const MAX_PEOPLE_OPS = 50;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
// Interaction summaries are one line about a conversation, not a transcript.
const MAX_SUMMARY = 500;
const MAX_CHECKIN_DAYS = 3650;
// Matches inventory-ops.ts:208's cap on created item names. One constant for
// person and group names alike — same column shape, same write surfaces.
const MAX_NAME_LENGTH = 120;
// The colour lands in a `text` column that the UI feeds straight to an inline
// style, so it is validated rather than trusted; omitted means the database
// default (the first palette swatch).
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

// The one rule this feature cannot bend: groups are CONTEXTS, never closeness
// tiers (docs/people-plan.md §3.1 "no streaks, no counters", §3.6 "no
// product-imposed cadences" — both are the same refusal to rank people).
//
// It lives HERE, in the shared validation layer, rather than in the group
// suggester alone: every agent path — MCP update_people, the in-app assistant,
// the suggester — funnels through validatePeopleOps, so this is the only place
// that catches all three. A model that ignores the tool description would
// otherwise land "acquaintances" in the roster with a confirm button under it.
//
// Patterns are word-anchored so real contexts survive ("closet organizers" is
// a group; "closest people" is not).
const RANKING_PATTERNS = [
  /\b(inner|outer)\s+circle\b/i,
  /\bclos(e|er|est)\s+(friends?|people|ones?)\b/i,
  /\bbest\s+friends?\b/i,
  /\bacquaintances?\b/i,
  /\bfavou?rites?\b/i,
  /\btier\s*\d*\b/i,
  /\bvip\b/i,
  /\ba-?list\b/i,
  /\bcasual\s+(friends?|contacts?)\b/i,
  /\bdistant\b/i,
  /\bstrangers?\b/i,
  /\b(top|core)\s+(people|friends?)\b/i,
];

export function isRankingGroupName(name: string): boolean {
  return RANKING_PATTERNS.some((re) => re.test(name));
}

export type PersonOp =
  // date omitted = "today", resolved at EXECUTE time in the user's zone, so a
  // proposal confirmed after midnight still lands on the right day.
  | {
      op: "log_interaction";
      person: string;
      summary?: string;
      date?: string;
      approx?: boolean;
    }
  | { op: "create_person"; name: string }
  // null clears the cadence (this person stops generating attention).
  | { op: "set_checkin"; person: string; days: number | null }
  | { op: "archive"; person: string }
  | { op: "restore"; person: string }
  // A group is a CONTEXT (family / ubc / work), never a closeness tier —
  // docs/people-plan.md §3.1/§3.6 forbid ranking people, and grouping them is
  // still ranking them if the axis is intimacy. Nothing here can enforce that;
  // the tool descriptions and the suggester prompt carry the constraint.
  | { op: "create_group"; name: string; color?: string }
  // null clears the group (this person stops belonging to any context).
  | { op: "set_group"; person: string; group: string | null };

// What gets stored on the proposal and executed on confirm.
//
// personId null + pendingPerson set means the person is created by a
// create_person op earlier in the same batch; the executor resolves the id
// after that insert (inventory-ops.ts's pendingGroup/pendingItem pattern).
export type ResolvedPersonOp =
  | {
      kind: "log";
      personId: string | null;
      name: string;
      summary: string | null;
      // null = resolve to the user's today at execute time.
      date: string | null;
      precision: "exact" | "approx";
      pendingPerson?: string | null;
    }
  | { kind: "create"; name: string }
  | {
      kind: "checkin";
      personId: string | null;
      name: string;
      days: number | null;
      pendingPerson?: string | null;
    }
  | { kind: "archive"; personId: string; name: string }
  | { kind: "restore"; personId: string; name: string }
  // color null = let the column default decide.
  | { kind: "create_group"; name: string; color: string | null }
  // Three distinguishable states, and the executor needs all three:
  // groupId set = an existing group; pendingGroup set = a create_group op
  // earlier in this batch; both null = clear the person's group.
  | {
      kind: "set_group";
      personId: string | null;
      name: string;
      groupId: string | null;
      groupName: string | null;
      pendingPerson?: string | null;
      pendingGroup?: string | null;
    };

export type ResolvablePerson = {
  id: string;
  name: string;
  archived: boolean;
};

export type ResolvableGroup = {
  id: string;
  name: string;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function refString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s : null;
}

function checkinDays(v: unknown): number | null {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0 || n > MAX_CHECKIN_DAYS) return null;
  return n;
}

// ---------- shape validation ----------

export function validatePeopleOps(raw: unknown): Result<PersonOp[]> {
  const operations = isRecord(raw) ? raw.operations : undefined;
  if (!Array.isArray(operations) || operations.length === 0) {
    return { ok: false, error: "operations must be a non-empty array" };
  }
  if (operations.length > MAX_PEOPLE_OPS) {
    return { ok: false, error: `too many operations (max ${MAX_PEOPLE_OPS})` };
  }

  const ops: PersonOp[] = [];
  for (let i = 0; i < operations.length; i++) {
    const entry = operations[i];
    if (!isRecord(entry)) {
      return { ok: false, error: `operation ${i + 1} must be an object` };
    }
    const op = entry.op;
    switch (op) {
      case "log_interaction": {
        const person = refString(entry.person);
        if (!person) {
          return {
            ok: false,
            error: `operation ${i + 1} (log_interaction): person is required`,
          };
        }
        let summary: string | undefined;
        if (entry.summary !== undefined && entry.summary !== null) {
          if (typeof entry.summary !== "string") {
            return {
              ok: false,
              error: `operation ${i + 1} (log_interaction ${person}): summary must be a string`,
            };
          }
          const trimmed = entry.summary.trim();
          if (trimmed.length > MAX_SUMMARY) {
            return {
              ok: false,
              error: `operation ${i + 1} (log_interaction ${person}): summary is too long (max ${MAX_SUMMARY} characters)`,
            };
          }
          if (trimmed) summary = trimmed;
        }
        let date: string | undefined;
        if (entry.date !== undefined && entry.date !== null) {
          const value = refString(entry.date);
          if (!value || !ISO_DATE.test(value)) {
            return {
              ok: false,
              error: `operation ${i + 1} (log_interaction ${person}): date must be YYYY-MM-DD`,
            };
          }
          date = value;
        }
        const approx = entry.approx === true;
        // An approximate date has to be approximate ABOUT something. Omitting
        // the date means "today", which is exact by construction — silently
        // marking that approx would put fabricated uncertainty on a known day.
        if (approx && !date) {
          return {
            ok: false,
            error: `operation ${i + 1} (log_interaction ${person}): approx needs an explicit date to be approximate about (omit approx for today)`,
          };
        }
        ops.push({ op, person, summary, date, approx });
        break;
      }
      case "create_person": {
        const name = refString(entry.name);
        if (!name) {
          return {
            ok: false,
            error: `operation ${i + 1} (create_person): name is required`,
          };
        }
        if (name.length > MAX_NAME_LENGTH) {
          return {
            ok: false,
            error: `operation ${i + 1} (create_person): name too long`,
          };
        }
        ops.push({ op, name });
        break;
      }
      case "set_checkin": {
        const person = refString(entry.person);
        if (!person) {
          return {
            ok: false,
            error: `operation ${i + 1} (set_checkin): person is required`,
          };
        }
        if (entry.days === undefined) {
          return {
            ok: false,
            error: `operation ${i + 1} (set_checkin ${person}): days is required (null clears the cadence)`,
          };
        }
        if (entry.days === null) {
          ops.push({ op, person, days: null });
          break;
        }
        const days = checkinDays(entry.days);
        if (days === null) {
          return {
            ok: false,
            error: `operation ${i + 1} (set_checkin ${person}): days must be a positive whole number of days, or null to clear`,
          };
        }
        ops.push({ op, person, days });
        break;
      }
      case "archive":
      case "restore": {
        const person = refString(entry.person);
        if (!person) {
          return {
            ok: false,
            error: `operation ${i + 1} (${op}): person is required`,
          };
        }
        ops.push({ op, person });
        break;
      }
      case "create_group": {
        const name = refString(entry.name);
        if (!name) {
          return {
            ok: false,
            error: `operation ${i + 1} (create_group): name is required`,
          };
        }
        if (name.length > MAX_NAME_LENGTH) {
          return {
            ok: false,
            error: `operation ${i + 1} (create_group): name too long`,
          };
        }
        if (isRankingGroupName(name)) {
          return {
            ok: false,
            error: `operation ${i + 1} (create_group ${name}): groups are CONTEXTS — where the user knows someone from (family, ubc, work, brazil) — never closeness tiers. "${name}" ranks people, and this app does not rank people.`,
          };
        }
        let color: string | undefined;
        if (entry.color !== undefined && entry.color !== null) {
          const value = refString(entry.color);
          if (!value || !HEX_COLOR.test(value)) {
            return {
              ok: false,
              error: `operation ${i + 1} (create_group ${name}): color must be a hex color like #B5FF3C`,
            };
          }
          color = value;
        }
        ops.push({ op, name, color });
        break;
      }
      case "set_group": {
        const person = refString(entry.person);
        if (!person) {
          return {
            ok: false,
            error: `operation ${i + 1} (set_group): person is required`,
          };
        }
        // Same contract as set_checkin: an omitted field is a mistake, an
        // explicit null is the clear.
        if (entry.group === undefined) {
          return {
            ok: false,
            error: `operation ${i + 1} (set_group ${person}): group is required (null clears it)`,
          };
        }
        if (entry.group === null) {
          ops.push({ op, person, group: null });
          break;
        }
        const group = refString(entry.group);
        if (!group) {
          return {
            ok: false,
            error: `operation ${i + 1} (set_group ${person}): group must be a group id or name, or null to clear`,
          };
        }
        ops.push({ op, person, group });
        break;
      }
      default:
        return { ok: false, error: `operation ${i + 1}: unknown op "${String(op)}"` };
    }
  }

  return { ok: true, value: ops };
}

// ---------- name → id resolution ----------

// id → exact name → unique substring; ambiguity fails loudly with candidates.
// Same contract as resolveItemRef (inventory-ops.ts:387).
export function resolvePersonRef(
  ref: string,
  pool: ResolvablePerson[],
): Result<ResolvablePerson> {
  const byId = pool.find((p) => p.id === ref);
  if (byId) return { ok: true, value: byId };

  const needle = ref.toLowerCase();
  const exact = pool.filter((p) => p.name.toLowerCase() === needle);
  if (exact.length === 1) return { ok: true, value: exact[0] };
  if (exact.length > 1) {
    return {
      ok: false,
      error: `"${ref}" matches multiple people: ${exact.map((p) => `${p.name} (${p.id})`).join(", ")} — use an id`,
    };
  }

  const partial = pool.filter((p) => p.name.toLowerCase().includes(needle));
  if (partial.length === 1) return { ok: true, value: partial[0] };
  if (partial.length > 1) {
    return {
      ok: false,
      error: `"${ref}" is ambiguous: ${partial.map((p) => `${p.name} (${p.id})`).join(", ")} — use an id`,
    };
  }
  return { ok: false, error: `no person matching "${ref}"` };
}

// Deliberately the SAME machinery as resolvePersonRef — id → exact → unique
// substring, ambiguity fails loudly with candidates — and not inventory's
// exact-only matchGroup. "put davi in fam" should work the way "log davi"
// does; one resolution contract across the feature is the point.
export function resolveGroupRef(
  ref: string,
  pool: ResolvableGroup[],
): Result<ResolvableGroup> {
  const byId = pool.find((g) => g.id === ref);
  if (byId) return { ok: true, value: byId };

  const needle = ref.toLowerCase();
  const exact = pool.filter((g) => g.name.toLowerCase() === needle);
  // people_groups_user_name_key makes an exact duplicate impossible, so a
  // multi-match here can only be a caller passing a stale pool — still
  // reported rather than silently taking the first.
  if (exact.length === 1) return { ok: true, value: exact[0] };
  if (exact.length > 1) {
    return {
      ok: false,
      error: `"${ref}" matches multiple groups: ${exact.map((g) => `${g.name} (${g.id})`).join(", ")} — use an id`,
    };
  }

  const partial = pool.filter((g) => g.name.toLowerCase().includes(needle));
  if (partial.length === 1) return { ok: true, value: partial[0] };
  if (partial.length > 1) {
    return {
      ok: false,
      error: `"${ref}" is ambiguous: ${partial.map((g) => `${g.name} (${g.id})`).join(", ")} — use an id`,
    };
  }
  return {
    ok: false,
    error: `no group matching "${ref}"${pool.length ? ` (groups: ${pool.map((g) => g.name).join(", ")})` : ""}`,
  };
}

// Resolves a whole batch or nothing: any ambiguity or miss fails the proposal so
// the caller can retry precisely.
//
// `groups` is REQUIRED, not defaulted: an omitted pool would silently turn
// every set_group into "no group matching …" at the one call site that forgot
// to fetch it. Required arguments are this repo's mechanism for making tsc
// enumerate callers (see the timezone convention in AGENTS.md).
export function resolvePeopleOps(
  ops: PersonOp[],
  people: ResolvablePerson[],
  groups: ResolvableGroup[],
): Result<ResolvedPersonOp[]> {
  const active = people.filter((p) => !p.archived);
  const archived = people.filter((p) => p.archived);
  // People created earlier in the same batch: lowercased ref → display name.
  // Later log/set_checkin/set_group ops resolve against these as pendingPerson.
  const createdNames = new Map<string, string>();
  // Groups created earlier in the same batch (name, no id yet); a later
  // set_group referencing one resolves to pendingGroup and the executor fills
  // the id in after the insert (inventory-ops.ts's pendingGroup pattern).
  const createdGroups = new Map<string, string>();

  // Shared by log and set_checkin: a pending create wins, then the active
  // roster. An archived match is reported as such rather than silently
  // resurrected — restoring is the user's call, not the batch's.
  const personRef = (
    ref: string,
  ): Result<{
    personId: string | null;
    name: string;
    pendingPerson: string | null;
  }> => {
    const pending = createdNames.get(ref.toLowerCase());
    if (pending) {
      return {
        ok: true,
        value: { personId: null, name: pending, pendingPerson: pending },
      };
    }
    const found = resolvePersonRef(ref, active);
    if (!found.ok) {
      const inArchive = resolvePersonRef(ref, archived);
      if (inArchive.ok) {
        return {
          ok: false,
          error: `"${inArchive.value.name}" is not being tracked — add a restore op first`,
        };
      }
      return found;
    }
    return {
      ok: true,
      value: { personId: found.value.id, name: found.value.name, pendingPerson: null },
    };
  };

  const groupRef = (
    ref: string,
  ): Result<{
    groupId: string | null;
    groupName: string;
    pendingGroup: string | null;
  }> => {
    const pending = createdGroups.get(ref.toLowerCase());
    if (pending) {
      return {
        ok: true,
        value: { groupId: null, groupName: pending, pendingGroup: pending },
      };
    }
    const found = resolveGroupRef(ref, groups);
    if (!found.ok) return found;
    return {
      ok: true,
      value: {
        groupId: found.value.id,
        groupName: found.value.name,
        pendingGroup: null,
      },
    };
  };

  const resolved: ResolvedPersonOp[] = [];
  for (const op of ops) {
    switch (op.op) {
      case "log_interaction": {
        const target = personRef(op.person);
        if (!target.ok) return target;
        resolved.push({
          kind: "log",
          personId: target.value.personId,
          name: target.value.name,
          summary: op.summary ?? null,
          date: op.date ?? null,
          precision: op.approx ? "approx" : "exact",
          pendingPerson: target.value.pendingPerson,
        });
        break;
      }
      case "create_person": {
        const key = op.name.toLowerCase();
        if (createdNames.has(key)) {
          return { ok: false, error: `"${op.name}" is created twice in this batch` };
        }
        // Archived rows deliberately do NOT block a name: people_user_name_key
        // is partial on `not archived`, so the live roster is the only pool a
        // create can collide with.
        const clash = active.find((p) => p.name.toLowerCase() === key);
        if (clash) {
          return {
            ok: false,
            error: `you already have a ${clash.name} (${clash.id}) — add a distinguishing name`,
          };
        }
        createdNames.set(key, op.name);
        resolved.push({ kind: "create", name: op.name });
        break;
      }
      case "set_checkin": {
        const target = personRef(op.person);
        if (!target.ok) return target;
        resolved.push({
          kind: "checkin",
          personId: target.value.personId,
          name: target.value.name,
          days: op.days,
          pendingPerson: target.value.pendingPerson,
        });
        break;
      }
      case "archive": {
        const found = resolvePersonRef(op.person, active);
        if (!found.ok) {
          const inArchive = resolvePersonRef(op.person, archived);
          if (inArchive.ok) {
            return {
              ok: false,
              error: `"${inArchive.value.name}" is already not being tracked`,
            };
          }
          return found;
        }
        resolved.push({ kind: "archive", personId: found.value.id, name: found.value.name });
        break;
      }
      case "restore": {
        const found = resolvePersonRef(op.person, archived);
        if (!found.ok) {
          const inActive = resolvePersonRef(op.person, active);
          if (inActive.ok) {
            return {
              ok: false,
              error: `"${inActive.value.name}" is already being tracked`,
            };
          }
          return found;
        }
        resolved.push({ kind: "restore", personId: found.value.id, name: found.value.name });
        break;
      }
      case "create_group": {
        const key = op.name.toLowerCase();
        if (createdGroups.has(key)) {
          return { ok: false, error: `"${op.name}" is created twice in this batch` };
        }
        const clash = groups.find((g) => g.name.toLowerCase() === key);
        if (clash) {
          return {
            ok: false,
            error: `you already have a ${clash.name} group (${clash.id})`,
          };
        }
        createdGroups.set(key, op.name);
        resolved.push({ kind: "create_group", name: op.name, color: op.color ?? null });
        break;
      }
      case "set_group": {
        // Routed through personRef, so create_person → set_group works in one
        // batch exactly as create_group → set_group does.
        const target = personRef(op.person);
        if (!target.ok) return target;
        if (op.group === null) {
          resolved.push({
            kind: "set_group",
            personId: target.value.personId,
            name: target.value.name,
            groupId: null,
            groupName: null,
            pendingPerson: target.value.pendingPerson,
            pendingGroup: null,
          });
          break;
        }
        const group = groupRef(op.group);
        if (!group.ok) return group;
        resolved.push({
          kind: "set_group",
          personId: target.value.personId,
          name: target.value.name,
          groupId: group.value.groupId,
          groupName: group.value.groupName,
          pendingPerson: target.value.pendingPerson,
          pendingGroup: group.value.pendingGroup,
        });
        break;
      }
    }
  }

  return { ok: true, value: resolved };
}

// ---------- receipt preview ----------

// An 'approx' date carries the finance module's estimate prefix rather than
// being rendered as a firm day (docs/people-plan.md §2.4). A null date renders
// as the literal word "today": the day is resolved at execute time, so naming a
// concrete one here could be wrong by the time the user confirms.
// Exported so the EXECUTOR's applied-receipt lines render a date exactly as the
// proposal did. The assistant reads that receipt back as fact, so a bare date
// there would assert precision the row does not carry — the same fabricated
// precision §2.4 refuses, arriving one step later in the flow.
export function dateLabel(
  date: string | null,
  precision: "exact" | "approx",
): string {
  if (!date) return "today";
  return precision === "approx" ? `~${date} (approx)` : date;
}

export function receiptLine(op: ResolvedPersonOp): string {
  switch (op.kind) {
    case "log": {
      const when = dateLabel(op.date, op.precision);
      return `${op.name}  talked · ${when}${op.summary ? ` · "${op.summary}"` : ""}`;
    }
    case "create":
      return `${op.name}  new person`;
    case "checkin":
      return op.days === null
        ? `${op.name}  check-in cadence cleared`
        : `${op.name}  check in every ${op.days} days`;
    case "archive":
      return `${op.name}  stop tracking`;
    case "restore":
      return `${op.name}  tracking again`;
    case "create_group":
      return `${op.name}  new group`;
    case "set_group":
      // groupName carries a pending group's display name too, so a
      // create_group → set_group batch previews the destination by name
      // rather than as a placeholder the user cannot check.
      return op.groupName
        ? `${op.name}  moved to ${op.groupName}`
        : `${op.name}  no group`;
  }
}

export function renderPeopleReceipt(ops: ResolvedPersonOp[]): string {
  return ops.map(receiptLine).join("\n");
}

// Structural re-validation of proposal input at execute time (the stored shape
// is ours, but the audit row is data — never trust it blindly).
export function validateResolvedPeopleOps(
  raw: unknown,
): Result<ResolvedPersonOp[]> {
  const operations = isRecord(raw) ? raw.operations : undefined;
  if (!Array.isArray(operations) || operations.length === 0) {
    return { ok: false, error: "stored proposal has no operations" };
  }
  if (operations.length > MAX_PEOPLE_OPS) {
    return { ok: false, error: "stored proposal has too many operations" };
  }

  const ops: ResolvedPersonOp[] = [];
  for (const entry of operations) {
    if (!isRecord(entry)) {
      return { ok: false, error: "malformed stored operation" };
    }
    switch (entry.kind) {
      case "log": {
        const pendingPerson = refString(entry.pendingPerson);
        const personId = typeof entry.personId === "string" ? entry.personId : null;
        if (!personId && !pendingPerson) {
          return { ok: false, error: "malformed log operation" };
        }
        const date = entry.date === null || entry.date === undefined
          ? null
          : refString(entry.date);
        if (date !== null && !ISO_DATE.test(date ?? "")) {
          return { ok: false, error: "malformed log operation" };
        }
        const precision = entry.precision === "approx" ? "approx" : "exact";
        if (precision === "approx" && !date) {
          return { ok: false, error: "malformed log operation" };
        }
        ops.push({
          kind: "log",
          personId,
          name: String(entry.name ?? ""),
          summary: refString(entry.summary),
          date,
          precision,
          pendingPerson,
        });
        break;
      }
      case "create": {
        const name = refString(entry.name);
        if (!name) return { ok: false, error: "malformed create operation" };
        ops.push({ kind: "create", name });
        break;
      }
      case "checkin": {
        const pendingPerson = refString(entry.pendingPerson);
        const personId = typeof entry.personId === "string" ? entry.personId : null;
        if (!personId && !pendingPerson) {
          return { ok: false, error: "malformed checkin operation" };
        }
        const days = entry.days === null ? null : checkinDays(entry.days);
        if (entry.days !== null && days === null) {
          return { ok: false, error: "malformed checkin operation" };
        }
        ops.push({
          kind: "checkin",
          personId,
          name: String(entry.name ?? ""),
          days,
          pendingPerson,
        });
        break;
      }
      case "archive":
      case "restore": {
        if (typeof entry.personId !== "string" || !entry.personId) {
          return { ok: false, error: `malformed ${entry.kind} operation` };
        }
        ops.push({
          kind: entry.kind,
          personId: entry.personId,
          name: String(entry.name ?? ""),
        });
        break;
      }
      case "create_group": {
        const name = refString(entry.name);
        if (!name) return { ok: false, error: "malformed create_group operation" };
        const color = refString(entry.color);
        if (color !== null && !HEX_COLOR.test(color)) {
          return { ok: false, error: "malformed create_group operation" };
        }
        ops.push({ kind: "create_group", name, color });
        break;
      }
      case "set_group": {
        const pendingPerson = refString(entry.pendingPerson);
        const personId = typeof entry.personId === "string" ? entry.personId : null;
        if (!personId && !pendingPerson) {
          return { ok: false, error: "malformed set_group operation" };
        }
        const groupId = typeof entry.groupId === "string" ? entry.groupId : null;
        const pendingGroup = refString(entry.pendingGroup);
        // A stored op that names both an id and a pending create is
        // contradictory — the executor would have to pick one silently.
        if (groupId && pendingGroup) {
          return { ok: false, error: "malformed set_group operation" };
        }
        ops.push({
          kind: "set_group",
          personId,
          name: String(entry.name ?? ""),
          groupId,
          groupName: refString(entry.groupName),
          pendingPerson,
          pendingGroup,
        });
        break;
      }
      default:
        return { ok: false, error: "malformed stored operation" };
    }
  }

  return { ok: true, value: ops };
}
