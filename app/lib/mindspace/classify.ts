// The M1 fast-path classifier: deterministic, zero-LLM. Items are matched to
// topics through the signals the user already produced — capture frontmatter
// `topics:` lists, resolved [[wikilinks]], task group membership, and
// word-boundary name/alias matches in title or body. Structured signals score
// higher than free-text hits; an item's label weights are its topic scores
// normalized to sum to 1. Pure and unit-tested.

import type {
  ClassifiedItem,
  ItemLabel,
  MindspaceItem,
  MindspaceTopic,
} from "@/app/lib/mindspace/types";

const SCORE_STRUCTURED = 3; // frontmatter topic, wikilink to seed page, task group
const SCORE_TITLE = 2;
const SCORE_BODY = 1;

// Free-text matching skips terms shorter than this: two-letter names and
// acronyms ("EA", "AI") hit far too much prose to be a trustworthy signal.
const MIN_TERM_LENGTH = 3;

type TopicMatcher = {
  topic: MindspaceTopic;
  terms: string[]; // lowercased name + aliases
  termPatterns: RegExp[];
  seedVaultPath: string | null;
  seedGroupId: string | null;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Exported for the People mention scan (app/lib/people/mentions.ts), which
// needs the identical boundary semantics — two matchers disagreeing about what
// counts as a name hit would make /mindspace and the candidate stream tell
// different stories about the same sentence. `flags` exists because the default
// has no `g`, so it answers PRESENCE, not how many; a counting caller passes
// "giu". Callers must not mutate the returned regex's lastIndex expectations.
export function termPattern(term: string, flags = "iu"): RegExp {
  // Word-boundary match that tolerates non-word characters inside the term
  // ("span 202", "best buy"). \b misbehaves around accents, so boundaries are
  // "not a letter/digit" lookarounds.
  return new RegExp(
    `(?<![\\p{L}\\p{N}])${escapeRegExp(term)}(?![\\p{L}\\p{N}])`,
    flags,
  );
}

export function buildMatchers(topics: MindspaceTopic[]): TopicMatcher[] {
  return topics
    .filter((topic) => topic.status !== "archived")
    .map((topic) => {
      const terms = [
        ...new Set(
          [topic.name, ...topic.aliases]
            .map((t) => t.trim().toLowerCase())
            .filter((t) => t.length >= MIN_TERM_LENGTH),
        ),
      ];
      return {
        topic,
        terms,
        // Wrapped, not point-free: termPattern's second parameter is `flags`,
        // and map would pass the array index into it.
        termPatterns: terms.map((term) => termPattern(term)),
        seedVaultPath: topic.seedVaultPath?.toLowerCase() ?? null,
        seedGroupId: topic.seedGroupId,
      };
    });
}

function scoreItem(item: MindspaceItem, matcher: TopicMatcher): number {
  let score = 0;

  if (matcher.seedGroupId && item.groupId === matcher.seedGroupId) {
    score += SCORE_STRUCTURED;
  }

  if (item.frontmatterTopics.length > 0 && matcher.terms.length > 0) {
    const tagged = item.frontmatterTopics.some((t) =>
      matcher.terms.includes(t.trim().toLowerCase()),
    );
    if (tagged) score += SCORE_STRUCTURED;
  }

  if (matcher.seedVaultPath && item.wikilinkPaths.length > 0) {
    const linked = item.wikilinkPaths.some(
      (path) => path.toLowerCase() === matcher.seedVaultPath,
    );
    if (linked) score += SCORE_STRUCTURED;
  }

  if (matcher.termPatterns.length > 0) {
    const inTitle = matcher.termPatterns.some((re) => re.test(item.title));
    if (inTitle) {
      score += SCORE_TITLE;
    } else {
      const inBody = matcher.termPatterns.some((re) => re.test(item.text));
      if (inBody) score += SCORE_BODY;
    }
  }

  return score;
}

export function classifyItem(
  item: MindspaceItem,
  matchers: TopicMatcher[],
): ItemLabel[] {
  const scored = matchers
    .map((matcher) => ({
      topicId: matcher.topic.id,
      score: scoreItem(item, matcher),
    }))
    .filter((entry) => entry.score > 0);
  const total = scored.reduce((sum, entry) => sum + entry.score, 0);
  if (total === 0) return [];
  return scored.map((entry) => ({
    topicId: entry.topicId,
    weight: entry.score / total,
  }));
}

export function classifyItems(
  items: MindspaceItem[],
  topics: MindspaceTopic[],
): ClassifiedItem[] {
  const matchers = buildMatchers(topics);
  return items.map((item) => ({
    ...item,
    labels: classifyItem(item, matchers),
    salience: 1,
  }));
}

// Fingerprint of everything the LLM classifier's verdict depends on. A stored
// verdict whose hash no longer matches was made against a different taxonomy
// and re-classifies on the next pass. FNV-1a, hex.
export function taxonomyHash(topics: MindspaceTopic[]): string {
  const canonical = topics
    .filter((topic) => topic.status !== "archived")
    .map(
      (topic) =>
        `${topic.id}|${topic.name.toLowerCase()}|${[...topic.aliases]
          .map((alias) => alias.toLowerCase())
          .sort()
          .join(",")}`,
    )
    .sort()
    .join(";");
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

export type PersistedVerdict = {
  salience: number;
  labels: ItemLabel[];
  taxonomyHash: string | null;
  classified: boolean;
};

// Merge freshly gathered items with cached LLM verdicts: a classified item
// whose verdict matches the current taxonomy keeps its LLM labels + salience;
// everything else falls back to the fast path and joins the pending queue.
// Labels pointing at deleted topics are dropped; if that empties an LLM
// verdict, the fast path fills in so the item isn't silently unclassified.
export function mergeClassifications(
  items: MindspaceItem[],
  topics: MindspaceTopic[],
  persisted: Map<string, PersistedVerdict>,
  currentHash: string,
): { classified: ClassifiedItem[]; pending: MindspaceItem[] } {
  const matchers = buildMatchers(topics);
  const topicIds = new Set(topics.map((topic) => topic.id));
  const classified: ClassifiedItem[] = [];
  const pending: MindspaceItem[] = [];

  for (const item of items) {
    const verdict = persisted.get(`${item.source}:${item.ref}`);
    const fresh =
      verdict?.classified === true && verdict.taxonomyHash === currentHash;
    if (!fresh) pending.push(item);

    const cachedLabels = fresh
      ? verdict!.labels.filter((label) => topicIds.has(label.topicId))
      : [];
    classified.push({
      ...item,
      labels:
        cachedLabels.length > 0 ? cachedLabels : classifyItem(item, matchers),
      salience: fresh ? verdict!.salience : 1,
    });
  }

  return { classified, pending };
}
