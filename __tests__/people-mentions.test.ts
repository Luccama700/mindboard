import { describe, expect, test } from "vitest";

import {
  buildExcerpt,
  buildPersonMatchers,
  evidenceRef,
  scanSessionsForMentions,
  type ScannablePerson,
  type ScannableSession,
} from "@/app/lib/people/mentions";

const VANCOUVER = "America/Vancouver";
const TOKYO = "Asia/Tokyo";

function person(
  over: Partial<ScannablePerson> & { id: string; name: string },
): ScannablePerson {
  return { aliases: [], archived: false, ...over };
}

function session(
  over: Partial<ScannableSession> & { session_ref: string; user_text: string },
): ScannableSession {
  return {
    provider: "claude_code",
    ended_at: "2026-08-10T18:00:00.000Z",
    ...over,
  };
}

function scan(
  sessions: ScannableSession[],
  people: ScannablePerson[],
  timeZone: string | null = VANCOUVER,
) {
  return scanSessionsForMentions({ sessions, people, timeZone });
}

describe("buildPersonMatchers", () => {
  test("terms are the name plus aliases, deduped case-insensitively", () => {
    const [matcher] = buildPersonMatchers([
      person({
        id: "p1",
        name: "Lucca Martins de Andrade",
        aliases: ["Lucca", "lucca", "Luquinha"],
      }),
    ]);
    expect(matcher.terms.map((t) => t.term)).toEqual([
      "Lucca Martins de Andrade",
      "Lucca",
      "Luquinha",
    ]);
  });

  test("archived people are not matchable", () => {
    expect(
      buildPersonMatchers([person({ id: "p1", name: "Luis", archived: true })]),
    ).toEqual([]);
  });

  test("terms under three characters are dropped", () => {
    const [matcher] = buildPersonMatchers([
      person({ id: "p1", name: "Davi", aliases: ["D", "Dv"] }),
    ]);
    expect(matcher.terms.map((t) => t.term)).toEqual(["Davi"]);
  });

  test("a person with no term over the floor is unmatchable, not a wildcard", () => {
    expect(buildPersonMatchers([person({ id: "p1", name: "Bo" })])).toEqual([]);
  });

  test("terms are capped at ten per person", () => {
    // The chokepoint where an alias becomes a regex run against every session:
    // aliases also arrive unbounded from seedAliases and curated topics, so the
    // defence lives here rather than only on the edit path.
    const [matcher] = buildPersonMatchers([
      person({
        id: "p1",
        name: "Davi",
        aliases: Array.from({ length: 40 }, (_, i) => `alias${i}`),
      }),
    ]);
    expect(matcher.terms).toHaveLength(10);
    expect(matcher.terms[0].term).toBe("Davi");
  });

  test("an absurdly long term is dropped, not compiled", () => {
    const [matcher] = buildPersonMatchers([
      person({ id: "p1", name: "Davi", aliases: ["x".repeat(400)] }),
    ]);
    expect(matcher.terms.map((t) => t.term)).toEqual(["Davi"]);
  });
});

describe("scanSessionsForMentions — matching", () => {
  const davi = person({ id: "p-davi", name: "Davi" });
  const emma = person({ id: "p-emma", name: "Emma", aliases: ["Em"] });

  test("a word-boundary hit produces one candidate with the matched term", () => {
    const { candidates } = scan(
      [session({ session_ref: "s1", user_text: "talked to Davi about his story" })],
      [davi],
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      personId: "p-davi",
      sourceKind: "session",
      sourceRef: "claude_code:s1",
      matchedTerm: "Davi",
    });
  });

  test("the evidence ref is provider-qualified so providers cannot collide", () => {
    // mindspace_sessions is unique on (user_id, provider, session_ref), so a
    // bare ref shared by a claude_ai and a claude_code session would collide on
    // person_mention_candidates_evidence_key and swallow the second candidate.
    const { candidates } = scan(
      [
        session({ provider: "claude_ai", session_ref: "abc", user_text: "Davi called" }),
        session({ provider: "claude_code", session_ref: "abc", user_text: "Davi again" }),
      ],
      [davi],
    );
    expect(candidates.map((c) => c.sourceRef)).toEqual([
      "claude_ai:abc",
      "claude_code:abc",
    ]);
    expect(new Set(candidates.map((c) => c.sourceRef)).size).toBe(2);
  });

  test("evidenceRef is the single definition of that qualification", () => {
    expect(evidenceRef("claude_ai", "abc")).toBe("claude_ai:abc");
  });

  test("matching is case-insensitive but boundary-respecting", () => {
    expect(
      scan([session({ session_ref: "s1", user_text: "DAVI called" })], [davi])
        .candidates,
    ).toHaveLength(1);
    // "Davidson" must not match "Davi".
    expect(
      scan([session({ session_ref: "s1", user_text: "Davidson called" })], [davi])
        .candidates,
    ).toEqual([]);
  });

  test("an alias hit records the alias, not the name", () => {
    const withAlias = person({ id: "p-emma", name: "Emma", aliases: ["Emmy"] });
    const { candidates } = scan(
      [session({ session_ref: "s1", user_text: "Emmy sent the photos" })],
      [withAlias],
    );
    expect(candidates[0].matchedTerm).toBe("Emmy");
  });

  test("a sub-3-char alias never matches (Em does not fire on 'them')", () => {
    const { candidates } = scan(
      [session({ session_ref: "s1", user_text: "I told them about it" })],
      [emma],
    );
    expect(candidates).toEqual([]);
  });

  test("accents are NOT folded — Daví and Davi are distinct terms", () => {
    const davii = person({ id: "p-davii", name: "Daví" });
    expect(
      scan([session({ session_ref: "s1", user_text: "Daví wrote" })], [davi])
        .candidates,
    ).toEqual([]);
    expect(
      scan([session({ session_ref: "s1", user_text: "Daví wrote" })], [davii])
        .candidates,
    ).toHaveLength(1);
  });

  test("one candidate per person per session, however many times they appear", () => {
    // A session is ONE piece of evidence, not five.
    const { candidates } = scan(
      [
        session({
          session_ref: "s1",
          user_text: "Davi and Davi again and Davi once more",
        }),
      ],
      [davi],
    );
    expect(candidates).toHaveLength(1);
  });

  test("two people in one session yield two candidates", () => {
    const { candidates } = scan(
      [session({ session_ref: "s1", user_text: "Davi and Emma came over" })],
      [davi, emma],
    );
    expect(candidates.map((c) => c.personId).sort()).toEqual([
      "p-davi",
      "p-emma",
    ]);
    expect(new Set(candidates.map((c) => c.sourceRef))).toEqual(
      new Set(["claude_code:s1"]),
    );
  });

  test("a roster miss is a clean no-op", () => {
    const { candidates } = scan(
      [session({ session_ref: "s1", user_text: "worked on the proxy all day" })],
      [davi, emma],
    );
    expect(candidates).toEqual([]);
  });

  test("an empty roster scans nothing but still reads the sessions", () => {
    const result = scan([session({ session_ref: "s1", user_text: "Davi" })], []);
    expect(result.candidates).toEqual([]);
    expect(result.watermark).toBe("2026-08-10T18:00:00.000Z");
  });

  test("empty session text is skipped", () => {
    expect(
      scan([session({ session_ref: "s1", user_text: "" })], [davi]).candidates,
    ).toEqual([]);
  });
});

describe("buildExcerpt", () => {
  test("centres on the match and marks both truncations", () => {
    const text = `${"a".repeat(400)} Davi ${"b".repeat(400)}`;
    const index = text.indexOf("Davi");
    const excerpt = buildExcerpt(text, index, 4);
    expect(excerpt.startsWith("…")).toBe(true);
    expect(excerpt.endsWith("…")).toBe(true);
    expect(excerpt).toContain("Davi");
    // ~200 chars of content plus the two ellipses.
    expect(excerpt.length).toBeLessThanOrEqual(210);
  });

  test("a short session is carried whole, with no ellipses", () => {
    const text = "talked to Davi today";
    const excerpt = buildExcerpt(text, text.indexOf("Davi"), 4);
    expect(excerpt).toBe("talked to Davi today");
  });

  test("collapses whitespace so an excerpt stays one readable line", () => {
    const text = "talked   to\n\nDavi\tabout   things";
    expect(buildExcerpt(text, text.indexOf("Davi"), 4)).toBe(
      "talked to Davi about things",
    );
  });

  test("a match at the very start has no leading ellipsis", () => {
    const text = `Davi ${"c".repeat(400)}`;
    expect(buildExcerpt(text, 0, 4).startsWith("…")).toBe(false);
  });

  test("the excerpt is sliced from the ORIGINAL text, preserving case", () => {
    const text = "spoke with DAVI at length";
    expect(buildExcerpt(text, text.indexOf("DAVI"), 4)).toContain("DAVI");
  });
});

describe("scanSessionsForMentions — watermark", () => {
  const davi = person({ id: "p-davi", name: "Davi" });

  test("advances to the newest ended_at in the batch", () => {
    const { watermark } = scan(
      [
        session({ session_ref: "s1", ended_at: "2026-08-01T10:00:00.000Z", user_text: "Davi" }),
        session({ session_ref: "s3", ended_at: "2026-08-09T10:00:00.000Z", user_text: "Davi" }),
        session({ session_ref: "s2", ended_at: "2026-08-05T10:00:00.000Z", user_text: "Davi" }),
      ],
      [davi],
    );
    expect(watermark).toBe("2026-08-09T10:00:00.000Z");
  });

  test("advances even when NOTHING matched", () => {
    // The whole reason the watermark is a stored column: a session that hit
    // nobody leaves no candidate row to derive it from.
    const { candidates, watermark } = scan(
      [
        session({
          session_ref: "s1",
          ended_at: "2026-08-09T10:00:00.000Z",
          user_text: "refactored the proxy",
        }),
      ],
      [davi],
    );
    expect(candidates).toEqual([]);
    expect(watermark).toBe("2026-08-09T10:00:00.000Z");
  });

  test("an empty batch leaves the watermark null", () => {
    expect(scan([], [davi]).watermark).toBeNull();
  });

  test("re-scanning the boundary session is idempotent by evidence ref", () => {
    // The incremental read uses `gte` on the watermark, so the newest session is
    // deliberately re-scanned rather than skipped (a `gt` permanently loses any
    // session sharing that exact instant). Safe only because a repeat yields an
    // IDENTICAL draft, which person_mention_candidates_evidence_key no-ops.
    const boundary = session({
      session_ref: "s1",
      ended_at: "2026-08-09T10:00:00.000Z",
      user_text: "talked to Davi",
    });
    const first = scan([boundary], [davi]);
    const second = scan([boundary], [davi]);
    expect(second.candidates).toEqual(first.candidates);
    expect(second.watermark).toBe(first.watermark);
  });

  test("two sessions sharing an instant both survive the boundary re-scan", () => {
    const at = "2026-08-09T10:00:00.000Z";
    const { candidates, watermark } = scan(
      [
        session({ session_ref: "s1", ended_at: at, user_text: "Davi called" }),
        session({ session_ref: "s2", ended_at: at, user_text: "Davi again" }),
      ],
      [davi],
    );
    expect(candidates.map((c) => c.sourceRef)).toEqual([
      "claude_code:s1",
      "claude_code:s2",
    ]);
    expect(watermark).toBe(at);
  });
});

// ---------------------------------------------------------------------------
// Evidence dates are day-grain facts in the OWNER'S zone — the
// __tests__/timezone-sweep.test.ts table pattern. A session ending at 01:30Z is
// the previous day in Vancouver and the same day in Tokyo, and this value lands
// in a `date` column, so getting it from the process clock would misdate the
// evidence for every user west of UTC.
// ---------------------------------------------------------------------------

describe("evidence date resolves in the owner's zone", () => {
  const davi = person({ id: "p-davi", name: "Davi" });

  type ZoneCase = {
    label: string;
    endedAt: string;
    expected: Record<string, string>;
  };

  const CASES: ZoneCase[] = [
    {
      label: "late evening in Vancouver, already tomorrow in UTC and Tokyo",
      endedAt: "2026-08-11T01:30:00.000Z",
      expected: {
        [VANCOUVER]: "2026-08-10",
        [TOKYO]: "2026-08-11",
        UTC: "2026-08-11",
      },
    },
    {
      label: "morning in UTC is still the previous evening in Vancouver",
      endedAt: "2026-08-11T06:00:00.000Z",
      expected: {
        [VANCOUVER]: "2026-08-10",
        [TOKYO]: "2026-08-11",
        UTC: "2026-08-11",
      },
    },
    {
      label: "midday UTC agrees everywhere",
      endedAt: "2026-08-11T12:00:00.000Z",
      expected: {
        [VANCOUVER]: "2026-08-11",
        [TOKYO]: "2026-08-11",
        UTC: "2026-08-11",
      },
    },
    {
      label: "the US spring-forward instant",
      endedAt: "2026-03-08T10:30:00.000Z",
      expected: {
        [VANCOUVER]: "2026-03-08",
        [TOKYO]: "2026-03-08",
        UTC: "2026-03-08",
      },
    },
  ];

  for (const zone of [VANCOUVER, TOKYO, "UTC"]) {
    test.each(CASES)(`${zone}: $label`, ({ endedAt, expected }) => {
      const { candidates } = scan(
        [session({ session_ref: "s1", ended_at: endedAt, user_text: "saw Davi" })],
        [davi],
        zone,
      );
      expect(candidates[0].occurredAt).toBe(expected[zone]);
    });
  }
});
