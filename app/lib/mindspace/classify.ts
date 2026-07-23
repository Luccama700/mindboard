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

function termPattern(term: string): RegExp {
  // Word-boundary match that tolerates non-word characters inside the term
  // ("span 202", "best buy"). \b misbehaves around accents, so boundaries are
  // "not a letter/digit" lookarounds.
  return new RegExp(
    `(?<![\\p{L}\\p{N}])${escapeRegExp(term)}(?![\\p{L}\\p{N}])`,
    "iu",
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
        termPatterns: terms.map(termPattern),
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
  }));
}
