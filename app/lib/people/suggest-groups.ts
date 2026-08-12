import "server-only";
import Anthropic from "@anthropic-ai/sdk";

import { createClient } from "@/utils/supabase/server";
import { readProviderKey } from "@/app/lib/connections/keys";
import { extractIntro } from "@/app/lib/brain/parse";
import { findNote, getVaultCorpus } from "@/app/lib/brain/vault";
import {
  MAX_PEOPLE_OPS,
  isRankingGroupName,
  type PersonOp,
} from "@/app/lib/mcp/people-ops";
import { proposePeopleUpdateFor } from "@/app/lib/mcp/writes";
import type { Result } from "@/app/lib/mcp/validate";

// "Sort my people into groups" — one forced-tool Claude call on the user's own
// Anthropic key that reads the roster's vault notes and proposes CONTEXTS, then
// hands the result to the ordinary update_people propose → confirm rail. The
// model never writes: it emits a batch, the user confirms a receipt.
//
// NOT in app/actions/people.ts, for the reason sync.ts states: every export of
// a "use server" file is a publicly invocable POST endpoint, so userId-taking
// server logic lives in lib/ and the action supplies the authenticated id.
//
// CREDENTIALS: this runs inside a request (a user-initiated action), so
// getVaultCorpus's own cookie-client path is fine here and is one cached fetch
// instead of N per-note reads — the listEligibleNotes precedent. Only after()
// work has to thread credentials explicitly.

const SUGGEST_MODEL = "claude-haiku-4-5-20251001";
// Enough context to recognise a school or a job, nowhere near the whole note:
// this is a prompt, not an export. Applied to the intro too — extractIntro
// returns however long the note's first paragraph happens to be.
const BODY_CHARS = 400;
export const MAX_SUGGESTED_GROUPS = 6;
const MIN_SUGGESTED_GROUPS = 3;
// Sized so the resulting batch ALWAYS fits: worst case is one create_group per
// suggested group plus one set_group per person. Prompting more people than
// that would spend the API call to produce ops the mapper then has to throw
// away, which reads to the user as the suggester quietly ignoring people.
// Exported so the test can assert the relation rather than the number.
export const MAX_PROMPT_PEOPLE = MAX_PEOPLE_OPS - MAX_SUGGESTED_GROUPS;
// A backstop on the assembled prompt, independent of the per-person caps: a
// roster of 44 maximal blurbs is ~20k characters, and nothing downstream
// bounds the total.
const MAX_ROSTER_CHARS = 24_000;

// Copied, not imported: app/_components/color-picker.tsx is a "use client"
// module and pulling a constant from one into server-only code is an RSC
// footgun. Keep in sync with PALETTE there.
export const GROUP_PALETTE = [
  "#B5FF3C",
  "#7CFF6B",
  "#3CD9FF",
  "#3C8FFF",
  "#C892FF",
  "#FF6BFF",
  "#FF6B9D",
  "#FF6B6B",
  "#FFB73C",
  "#FFE93C",
  "#A0A0A0",
  "#F5F0E8",
];

export type SuggesterPerson = { id: string; name: string };
export type SuggesterGroup = { id: string; name: string };

// The model's tool payload, after JSON parsing but before any trust.
export type GroupSuggestion = {
  name?: unknown;
  members?: unknown;
};

const MAX_NAME_LENGTH = 120;

function cleanName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_NAME_LENGTH) return null;
  return trimmed;
}

// ---------- the pure part ----------

// roster + existing groups + the model's answer → an update_people batch.
//
// Everything that can go wrong with a model's answer is handled by DROPPING,
// never by failing: one hallucinated member name must not kill an otherwise
// good proposal, and the receipt is what the user actually checks. Only a
// completely empty result is an error, and the caller phrases that.
//
// Three rules worth stating outright:
//  1. A person lands in at most one group — the FIRST that claims them — since
//     people.group_id is single-valued.
//  2. A suggested name that already exists is REUSED by id rather than
//     re-created, so re-running the suggester does not collide with the user's
//     own groups (people_groups_user_name_key would reject it anyway).
//  3. The batch is capped at MAX_PEOPLE_OPS. Groups are added whole while they
//     fit and truncated (or skipped) after that, rather than emitting a batch
//     validatePeopleOps would reject after the API call was already paid for.
export function buildGroupSuggestionOps(input: {
  roster: SuggesterPerson[];
  existingGroups: SuggesterGroup[];
  suggestions: GroupSuggestion[];
}): PersonOp[] {
  const byName = new Map<string, SuggesterPerson>();
  for (const person of input.roster) {
    const key = person.name.trim().toLowerCase();
    // A duplicate display name is unresolvable from a name alone, so neither
    // wins: the pair is dropped rather than filed by coin flip.
    if (byName.has(key)) byName.set(key, { id: "", name: person.name });
    else byName.set(key, person);
  }
  const existingByName = new Map<string, SuggesterGroup>();
  for (const group of input.existingGroups) {
    existingByName.set(group.name.trim().toLowerCase(), group);
  }

  const claimed = new Set<string>();
  const seenGroups = new Set<string>();
  type Planned = {
    name: string;
    existingId: string | null;
    memberIds: string[];
  };
  const planned: Planned[] = [];

  for (const suggestion of input.suggestions) {
    if (planned.length >= MAX_SUGGESTED_GROUPS) break;
    const name = cleanName(suggestion.name);
    if (!name) continue;
    // validatePeopleOps REJECTS a ranking name outright; this DROPS it, and the
    // difference is deliberate. Failing here would let one bad suggestion kill
    // an otherwise good proposal the user never got to see, so the mapper
    // discards it and the batch survives. The validator is the backstop that
    // makes sure no path can create one.
    if (isRankingGroupName(name)) continue;
    const key = name.toLowerCase();
    if (seenGroups.has(key)) continue;
    seenGroups.add(key);

    const members = Array.isArray(suggestion.members) ? suggestion.members : [];
    const memberIds: string[] = [];
    for (const raw of members) {
      const memberName = cleanName(raw);
      if (!memberName) continue;
      const person = byName.get(memberName.toLowerCase());
      // Unknown name = the model invented or misspelled someone. Drop it.
      if (!person || !person.id) continue;
      if (claimed.has(person.id)) continue;
      claimed.add(person.id);
      memberIds.push(person.id);
    }
    if (memberIds.length === 0) continue;

    planned.push({
      name,
      existingId: existingByName.get(key)?.id ?? null,
      memberIds,
    });
  }

  // Round-robin from the palette, offset past the groups the user already has
  // so a fresh set does not all land on the first swatch. Deterministic in the
  // inputs, which is what makes it testable.
  let paletteIndex = input.existingGroups.length;
  const ops: PersonOp[] = [];
  for (const group of planned) {
    const creating = group.existingId === null;
    const budget = MAX_PEOPLE_OPS - ops.length - (creating ? 1 : 0);
    if (budget <= 0) continue;
    const members = group.memberIds.slice(0, budget);
    if (members.length === 0) continue;
    let ref = group.existingId;
    if (creating) {
      ops.push({
        op: "create_group",
        name: group.name,
        color: GROUP_PALETTE[paletteIndex % GROUP_PALETTE.length],
      });
      paletteIndex += 1;
      // A pending group is referenced by NAME; the resolver maps it to the
      // create_group op earlier in this same batch.
      ref = group.name;
    }
    for (const personId of members) {
      ops.push({ op: "set_group", person: personId, group: ref });
    }
  }

  return ops;
}

// ---------- the thin shell ----------

const SUGGEST_TOOL: Anthropic.Tool = {
  name: "suggest_groups",
  description:
    "Record the proposed context groups. Always call this exactly once as your final action, with an empty groups array if no clear contexts exist.",
  input_schema: {
    type: "object",
    properties: {
      groups: {
        type: "array",
        maxItems: MAX_SUGGESTED_GROUPS,
        items: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description:
                "The context's real-world name, lowercase, 1-2 words (e.g. family, ubc, work, brazil, climbing).",
            },
            members: {
              type: "array",
              items: { type: "string" },
              description:
                "Names copied EXACTLY from the roster. Never invent a name.",
            },
          },
          required: ["name", "members"],
          additionalProperties: false,
        },
      },
    },
    required: ["groups"],
    additionalProperties: false,
  },
};

const SYSTEM_PROMPT = `You sort a person's contacts into GROUPS THAT NAME A REAL CONTEXT — a place, an institution, a household, a job, a shared activity. Examples of good group names: family, ubc, work, brazil, climbing gym, high school, band.

HARD RULE: never propose a group that ranks people by closeness, importance, or intimacy. "close friends", "inner circle", "acquaintances", "best friends", "favorites", "tier 1", "casual", "distant" and anything like them are FORBIDDEN, no matter how well the notes support them. Groups answer "where do I know them from", never "how much do they matter". A proposal that ranks people is worse than proposing nothing.

Other rules:
- Propose ${MIN_SUGGESTED_GROUPS}-${MAX_SUGGESTED_GROUPS} groups, named after contexts that actually appear in the notes below. Do not invent a context the notes do not support.
- Copy member names EXACTLY as they appear in the roster. Never invent, translate, or reformat a name.
- Each person goes in at most one group — the context they most belong to.
- People who fit no clear context are LEFT OUT. An unassigned person is a correct answer; filing someone somewhere for tidiness is not.
- If the notes are too thin to name any real context, return an empty groups array.

Finish by calling suggest_groups exactly once.`;

export type GroupSuggestionOutcome = Result<{
  proposalId: string;
  preview: string;
}>;

export async function suggestPeopleGroups(
  userId: string,
): Promise<GroupSuggestionOutcome> {
  const supabase = await createClient();

  const [peopleRes, groupsRes] = await Promise.all([
    supabase
      .from("people")
      .select("id, name, vault_path, group_id")
      .eq("user_id", userId)
      .eq("archived", false)
      .order("name", { ascending: true }),
    supabase
      .from("people_groups")
      .select("id, name")
      .eq("user_id", userId)
      .order("name", { ascending: true }),
  ]);
  if (peopleRes.error) return { ok: false, error: peopleRes.error.message };
  if (groupsRes.error) return { ok: false, error: groupsRes.error.message };

  const everyone = (peopleRes.data ?? []) as {
    id: string;
    name: string;
    vault_path: string | null;
    group_id: string | null;
  }[];
  if (everyone.length === 0) {
    return { ok: false, error: "add some people first" };
  }
  // Only ungrouped people are candidates: the suggester is additive, so
  // re-running it never proposes undoing the user's own filing.
  const candidates = everyone.filter((row) => row.group_id === null);
  if (candidates.length === 0) {
    return { ok: false, error: "everyone already has a group" };
  }
  const ungrouped = candidates.slice(0, MAX_PROMPT_PEOPLE);
  // People the model was never shown, as distinct from people it saw and
  // deliberately left unassigned (which is a correct answer, not an overflow).
  const overflow = candidates.length - ungrouped.length;

  const existingGroups = (groupsRes.data ?? []) as SuggesterGroup[];

  // A missing or unreachable vault is normal, not an error (§5): the model
  // then sorts on names alone, which usually finds nothing and says so.
  const notes = new Map<string, string>();
  try {
    const corpus = await getVaultCorpus(userId);
    for (const row of ungrouped) {
      if (!row.vault_path) continue;
      const note = findNote(corpus, row.vault_path);
      if (!note) continue;
      // Both, and the overlap is deliberate: extractIntro returns clean prose
      // with the H1, headings and bullets stripped, and those are exactly
      // where the context words live ("## UBC", "- met at the climbing gym").
      // Both halves are capped: extractIntro returns however long the note's
      // first paragraph happens to be, which for a long-form note is the whole
      // essay.
      const intro = extractIntro(note.body)?.slice(0, BODY_CHARS) ?? null;
      const body = note.body.replace(/\s+/g, " ").trim().slice(0, BODY_CHARS);
      const blurb = [intro, body ? `note: ${body}` : ""]
        .filter(Boolean)
        .join(" · ")
        .trim();
      if (blurb) notes.set(row.id, blurb);
    }
  } catch (error) {
    console.warn("group suggestion vault read failed", error);
  }

  const apiKey = await readProviderKey(supabase, userId, "anthropic");
  if (!apiKey) {
    return {
      ok: false,
      error: "add your anthropic api key in settings to suggest groups",
    };
  }

  // Names are never dropped, only blurbs: a person the model cannot see cannot
  // be filed, so once the budget runs out the remaining entries go in bare.
  const lines: string[] = [];
  let budget = MAX_ROSTER_CHARS;
  for (const row of ungrouped) {
    const blurb = notes.get(row.id);
    const full = blurb ? `- ${row.name}: ${blurb}` : `- ${row.name}`;
    const bare = `- ${row.name}`;
    const line = full.length <= budget ? full : bare;
    lines.push(line);
    budget -= line.length;
  }
  const roster = lines.join("\n");
  const groupLine = existingGroups.length
    ? `\n\nGroups that already exist (reuse these names verbatim when they fit, rather than inventing a near-duplicate): ${existingGroups.map((g) => g.name).join(", ")}`
    : "";

  let suggestions: GroupSuggestion[];
  try {
    const anthropic = new Anthropic({ apiKey });
    const response = await anthropic.messages.create({
      model: SUGGEST_MODEL,
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `People to sort:\n${roster}${groupLine}`,
        },
      ],
      tools: [SUGGEST_TOOL],
      tool_choice: { type: "tool", name: "suggest_groups" },
    });
    const toolUse = response.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
    );
    if (!toolUse) return { ok: false, error: "no clear contexts found in your notes" };
    const raw = (toolUse.input as { groups?: unknown }).groups;
    suggestions = Array.isArray(raw) ? (raw as GroupSuggestion[]) : [];
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Anthropic.APIError
          ? `anthropic: ${error.message}`
          : "could not suggest groups",
    };
  }

  const ops = buildGroupSuggestionOps({
    roster: ungrouped.map((row) => ({ id: row.id, name: row.name })),
    existingGroups,
    suggestions,
  });
  // proposePeopleUpdateFor would reject an empty batch with "operations must be
  // a non-empty array", which is a schema message, not something to show a
  // person who just tapped a button.
  if (ops.length === 0) {
    return { ok: false, error: "no clear contexts found in your notes" };
  }

  const outcome = await proposePeopleUpdateFor(
    supabase,
    userId,
    { operations: ops },
    { source: "assistant" },
  );
  if (!outcome.ok || overflow === 0) return outcome;

  // Appended to the RETURNED preview only, not to the stored proposal summary:
  // the summary is the record of what this batch applies, and these people are
  // exactly the ones it does not touch. Saying so is the difference between a
  // suggester that looks like it silently ignored half the roster and one that
  // tells you to run it again.
  return {
    ok: true,
    value: {
      ...outcome.value,
      preview: `${outcome.value.preview}\n\n…and ${overflow} more ${overflow === 1 ? "person" : "people"} didn't fit this round — run it again after applying`,
    },
  };
}
