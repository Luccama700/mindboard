// Task 11, the colour schemes. The owner changes the scheme at runtime, and the
// colours that mark each stop are HIS data, so neither side can be checked by
// eye on one screenshot: a scheme has to be readable against every colour a
// group could carry, including the very dark ones real accounts have.
//
// So the whole palette is computed by a pure module and the guarantees are
// arithmetic: every text token clears 4.5:1 on every surface it sits on, every
// identity colour is lifted until it clears 4.5:1 on the card it tints, and the
// stylesheet's own defaults are asserted to BE the derived black and purple.
// A new scheme cannot be added unreadable, and the stylesheet cannot drift from
// the module that is supposed to describe it.

import { readFileSync } from "node:fs";
import path from "node:path";

import postcss from "postcss";
import { describe, expect, test } from "vitest";

import {
  APPEARANCE_COPY,
  CUSTOM_SCHEME_ID,
  DEFAULT_APPEARANCE,
  DEFAULT_SCHEME_ID,
  IDENTITY_TOKEN_NAMES,
  SCHEMES,
  TOKEN_NAMES,
  contrast,
  deriveTokens,
  identityTokens,
  inkOn,
  isDarkBackground,
  mixHex,
  normalizeHex,
  parseAppearance,
  readableOn,
  resolveAppearance,
  schemeById,
  tokensFor,
} from "@/app/lib/v2/view/appearance";

/** The surfaces any text token can land on. */
const SURFACES = ["--v2-page", "--v2-card", "--v2-card-2"] as const;
/** The tokens that are used as TEXT, so 4.5:1 is the bar for each. */
const TEXT_TOKENS = ["--v2-ink", "--v2-ink-2", "--v2-ink-3", "--v2-signal"] as const;

const ROOT = path.resolve(__dirname, "..");
const CSS = readFileSync(path.join(ROOT, "app/v2/v2.css"), "utf8");

/** Colours a real account carries: six bright lanes and three very dark groups. */
const IDENTITY_COLOURS = [
  "#7C9BFF",
  "#2FD6A3",
  "#FFB84D",
  "#FF7A8A",
  "#C58BFF",
  "#B8F15A",
  "#0B1026",
  "#3B2512",
  "#4A0E3A",
];

// -------------------------------------------------------------- the schemes

describe("the built in schemes", () => {
  test("are the four named ones, in order", () => {
    expect(SCHEMES.map((scheme) => scheme.id)).toEqual([
      "black-purple",
      "night-indigo",
      "graphite-teal",
      "paper-ink",
    ]);
    expect(SCHEMES.map((scheme) => scheme.name)).toEqual([
      "Black and purple",
      "Night indigo",
      "Graphite and teal",
      "Paper",
    ]);
    expect(SCHEMES.map((scheme) => [scheme.background, scheme.accent])).toEqual([
      ["#000000", "#A78BFA"],
      ["#171A3D", "#FFFFFF"],
      ["#101314", "#5EEAD4"],
      ["#F6F3EC", "#4338CA"],
    ]);
  });

  test("default to black and purple", () => {
    expect(DEFAULT_SCHEME_ID).toBe("black-purple");
    expect(SCHEMES[0].id).toBe(DEFAULT_SCHEME_ID);
    expect(DEFAULT_APPEARANCE).toEqual({
      schemeId: "black-purple",
      background: null,
      accent: null,
    });
  });

  test("are found by id, and nothing else is", () => {
    expect(schemeById("paper-ink")?.name).toBe("Paper");
    expect(schemeById("nope")).toBeNull();
    expect(schemeById(CUSTOM_SCHEME_ID)).toBeNull();
  });

  test("read light or dark from the background, not from the id", () => {
    expect(isDarkBackground("#000000")).toBe(true);
    expect(isDarkBackground("#171A3D")).toBe(true);
    expect(isDarkBackground("#101314")).toBe(true);
    expect(isDarkBackground("#F6F3EC")).toBe(false);
  });
});

// --------------------------------------------------------------- the contrast

describe("contrast", () => {
  test("is the WCAG ratio", () => {
    expect(contrast("#FFFFFF", "#000000")).toBeCloseTo(21, 5);
    expect(contrast("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
    expect(contrast("#777777", "#777777")).toBeCloseTo(1, 5);
  });

  test("does not care which way round the pair is given", () => {
    expect(contrast("#A78BFA", "#000000")).toBeCloseTo(
      contrast("#000000", "#A78BFA"),
      10,
    );
  });
});

describe("readableOn", () => {
  test("leaves a colour that already clears the ratio alone", () => {
    expect(readableOn("#FFFFFF", "#000000")).toBe("#FFFFFF");
    expect(readableOn("#A78BFA", "#000000")).toBe("#A78BFA");
  });

  test("lifts a very dark colour until it reads on black", () => {
    const lifted = readableOn("#0B1026", "#000000");
    expect(lifted).not.toBe("#0B1026");
    expect(contrast(lifted, "#000000")).toBeGreaterThanOrEqual(4.5);
    // Lighter, not some other hue: the user's colour is recognisable.
    expect(contrast(lifted, "#000000")).toBeGreaterThan(contrast("#0B1026", "#000000"));
  });

  test("darkens a very light colour until it reads on paper", () => {
    const darkened = readableOn("#B8F15A", "#F6F3EC");
    expect(darkened).not.toBe("#B8F15A");
    expect(contrast(darkened, "#F6F3EC")).toBeGreaterThanOrEqual(4.5);
  });

  test("takes the ratio it is asked for", () => {
    const mark = readableOn("#0B1026", "#000000", 3);
    expect(contrast(mark, "#000000")).toBeGreaterThanOrEqual(3);
    // 3:1 is a smaller lift than 4.5:1, so it stays closer to what was chosen.
    expect(contrast(mark, "#000000")).toBeLessThan(
      contrast(readableOn("#0B1026", "#000000", 4.5), "#000000"),
    );
  });

  // A background in the middle of the range cannot carry readable text at all.
  // The honest answer is the best available, not a throw and not a silent pass.
  test("returns the extreme when the ratio is out of reach", () => {
    const best = readableOn("#808080", "#808080", 10);
    expect(["#FFFFFF", "#000000"]).toContain(best);
  });

  test("works on every identity colour against every scheme page", () => {
    for (const scheme of SCHEMES) {
      for (const colour of IDENTITY_COLOURS) {
        const out = readableOn(colour, scheme.background, 4.5);
        expect(out).toMatch(/^#[0-9A-F]{6}$/);
        expect(contrast(out, scheme.background)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

describe("inkOn", () => {
  test("picks whichever of black and white reads on a filled control", () => {
    expect(inkOn("#A78BFA")).toBe("#000000");
    expect(inkOn("#4338CA")).toBe("#FFFFFF");
    expect(contrast(inkOn("#5EEAD4"), "#5EEAD4")).toBeGreaterThanOrEqual(4.5);
  });
});

describe("mixHex", () => {
  test("is a plain channelwise mix, clamped at both ends", () => {
    expect(mixHex("#000000", "#FFFFFF", 0)).toBe("#000000");
    expect(mixHex("#000000", "#FFFFFF", 1)).toBe("#FFFFFF");
    expect(mixHex("#000000", "#FFFFFF", 0.5)).toBe("#808080");
  });
});

describe("normalizeHex", () => {
  test("takes the three spellings and refuses everything else", () => {
    expect(normalizeHex("#a78bfa")).toBe("#A78BFA");
    expect(normalizeHex("a78bfa")).toBe("#A78BFA");
    expect(normalizeHex("#abc")).toBe("#AABBCC");
    expect(normalizeHex("  #A78BFA  ")).toBe("#A78BFA");
    expect(normalizeHex("rebeccapurple")).toBeNull();
    expect(normalizeHex("#12345")).toBeNull();
    expect(normalizeHex(null)).toBeNull();
    expect(normalizeHex(42)).toBeNull();
  });
});

// ------------------------------------------------------------------- the tokens

describe("deriveTokens", () => {
  test("returns every token the stylesheet needs, as hex", () => {
    const tokens = deriveTokens("#000000", "#A78BFA");
    expect(Object.keys(tokens).sort()).toEqual([...TOKEN_NAMES].sort());
    for (const name of TOKEN_NAMES) expect(tokens[name]).toMatch(/^#[0-9A-F]{6}$/);
  });

  test("paints the page with the background it was given", () => {
    expect(deriveTokens("#101314", "#5EEAD4")["--v2-page"]).toBe("#101314");
    expect(deriveTokens("#F6F3EC", "#4338CA")["--v2-page"]).toBe("#F6F3EC");
  });

  // Behaviour 12. This is what makes a new scheme impossible to add unreadable.
  test.each(SCHEMES.map((scheme) => [scheme.id, scheme] as const))(
    "%s: every text token clears 4.5:1 on every surface",
    (_id, scheme) => {
      const tokens = deriveTokens(scheme.background, scheme.accent);
      for (const token of TEXT_TOKENS) {
        for (const surface of SURFACES) {
          expect(contrast(tokens[token], tokens[surface])).toBeGreaterThanOrEqual(4.5);
        }
      }
    },
  );

  test.each(SCHEMES.map((scheme) => [scheme.id, scheme] as const))(
    "%s: the accent clears 3:1 on the page and carries readable text",
    (_id, scheme) => {
      const tokens = deriveTokens(scheme.background, scheme.accent);
      expect(contrast(tokens["--v2-accent"], tokens["--v2-page"])).toBeGreaterThanOrEqual(3);
      expect(
        contrast(tokens["--v2-on-accent"], tokens["--v2-accent"]),
      ).toBeGreaterThanOrEqual(4.5);
    },
  );

  test.each(SCHEMES.map((scheme) => [scheme.id, scheme] as const))(
    "%s: the three ink levels are a hierarchy, not three of the same grey",
    (_id, scheme) => {
      const tokens = deriveTokens(scheme.background, scheme.accent);
      const on = (token: string) => contrast(tokens[token], tokens["--v2-card-2"]);
      expect(on("--v2-ink")).toBeGreaterThan(on("--v2-ink-2"));
      expect(on("--v2-ink-2")).toBeGreaterThan(on("--v2-ink-3"));
    },
  );

  test.each(SCHEMES.map((scheme) => [scheme.id, scheme] as const))(
    "%s: surfaces step away from the page, and stay small steps",
    (_id, scheme) => {
      const tokens = deriveTokens(scheme.background, scheme.accent);
      const page = tokens["--v2-page"];
      expect(tokens["--v2-card"]).not.toBe(page);
      expect(tokens["--v2-card-2"]).not.toBe(tokens["--v2-card"]);
      // A step, not a grey box: a surface never reaches 1.7:1 against the page.
      expect(contrast(tokens["--v2-card"], page)).toBeLessThan(1.7);
      expect(contrast(tokens["--v2-card-2"], page)).toBeLessThan(1.7);
      // The rail is visible without being a line of text.
      expect(contrast(tokens["--v2-edge"], page)).toBeGreaterThan(
        contrast(tokens["--v2-card-2"], page),
      );
    },
  );

  test("works on a dark custom pair", () => {
    const tokens = deriveTokens("#120A1F", "#FF8A3D");
    expect(tokens["--v2-page"]).toBe("#120A1F");
    for (const token of TEXT_TOKENS) {
      for (const surface of SURFACES) {
        expect(contrast(tokens[token], tokens[surface])).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  test("works on a light custom pair", () => {
    const tokens = deriveTokens("#FFFDF5", "#0F766E");
    expect(tokens["--v2-page"]).toBe("#FFFDF5");
    for (const token of TEXT_TOKENS) {
      for (const surface of SURFACES) {
        expect(contrast(tokens[token], tokens[surface])).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  test("falls back rather than throwing on a colour it cannot read", () => {
    const tokens = deriveTokens("not a colour", "neither is this");
    expect(tokens["--v2-page"]).toBe("#000000");
    expect(tokens["--v2-accent"]).toBe("#A78BFA");
  });
});

// --------------------------------------------------------- identity colours

describe("identity colours", () => {
  test("give the four per stop tokens", () => {
    const tokens = deriveTokens("#000000", "#A78BFA");
    const identity = identityTokens("#7C9BFF", tokens);
    expect(Object.keys(identity).sort()).toEqual([...IDENTITY_TOKEN_NAMES].sort());
  });

  // Behaviour 16. A group colour is the user's data, so it can be anything; what
  // carries text or fills a control has to be readable on every scheme.
  test("are readable as text and as a filled control on every scheme", () => {
    for (const scheme of SCHEMES) {
      const tokens = deriveTokens(scheme.background, scheme.accent);
      for (const colour of IDENTITY_COLOURS) {
        const identity = identityTokens(colour, tokens);
        expect(
          contrast(identity["--v2-ident"], identity["--v2-lit"]),
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          contrast(identity["--v2-ident"], tokens["--v2-page"]),
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          contrast(identity["--v2-on-ident"], identity["--v2-ident"]),
        ).toBeGreaterThanOrEqual(4.5);
        // The lit card is a FOURTH surface, and it can be further from the page
        // than card-2 is. Its title takes --v2-ink and everything else on it
        // takes --v2-ink-2 (see .v2-lit in v2.css), so both have to clear it.
        for (const token of ["--v2-ink", "--v2-ink-2"] as const) {
          expect(contrast(tokens[token], identity["--v2-lit"])).toBeGreaterThanOrEqual(
            4.5,
          );
        }
        // The mark on the line is the raw colour where it can be seen, and
        // lifted to 3:1 where it cannot: a deep navy dot on black is no dot.
        // The same dot also sits on a card, in the lane summary, so both.
        expect(
          contrast(identity["--v2-lane"], tokens["--v2-page"]),
        ).toBeGreaterThanOrEqual(3);
        expect(
          contrast(identity["--v2-lane"], tokens["--v2-card"]),
        ).toBeGreaterThanOrEqual(3);
      }
    }
  });

  test("leave a bright colour as the user chose it on a dark scheme", () => {
    const tokens = deriveTokens("#000000", "#A78BFA");
    expect(identityTokens("#7C9BFF", tokens)["--v2-lane"]).toBe("#7C9BFF");
  });

  test("fall back to the scheme accent when a stop has no colour of its own", () => {
    const tokens = deriveTokens("#000000", "#A78BFA");
    const identity = identityTokens(null, tokens);
    expect(identity["--v2-lane"]).toBe(tokens["--v2-edge"]);
    expect(contrast(identity["--v2-ident"], identity["--v2-lit"])).toBeGreaterThanOrEqual(
      4.5,
    );
  });
});

// ------------------------------------------------------------- what is stored

describe("parseAppearance", () => {
  test("takes a built in scheme and drops any colours stored beside it", () => {
    expect(parseAppearance({ schemeId: "graphite-teal", background: "#123456" })).toEqual({
      schemeId: "graphite-teal",
      background: null,
      accent: null,
    });
  });

  test("takes a custom pair", () => {
    expect(
      parseAppearance({ schemeId: "custom", background: "#120a1f", accent: "#ff8a3d" }),
    ).toEqual({ schemeId: "custom", background: "#120A1F", accent: "#FF8A3D" });
  });

  test("reads the stored JSON string too", () => {
    expect(parseAppearance('{"schemeId":"paper-ink"}')).toEqual({
      schemeId: "paper-ink",
      background: null,
      accent: null,
    });
  });

  test.each([
    ["nothing", undefined],
    ["null", null],
    ["a number", 7],
    ["an array", ["black-purple"]],
    ["broken JSON", "{"],
    ["an unknown scheme", { schemeId: "neon-disco" }],
    ["a custom with no colours", { schemeId: "custom" }],
    ["a custom with half a pair", { schemeId: "custom", background: "#000000" }],
    ["a custom with a bad colour", { schemeId: "custom", background: "red", accent: "#FFF" }],
    ["a scheme id that is not a string", { schemeId: 3 }],
  ])("gives the default back for %s", (_name, value) => {
    expect(parseAppearance(value)).toEqual(DEFAULT_APPEARANCE);
  });
});

describe("resolveAppearance", () => {
  test("reads the pair off a built in scheme", () => {
    expect(resolveAppearance({ schemeId: "paper-ink", background: null, accent: null })).toEqual(
      { background: "#F6F3EC", accent: "#4338CA" },
    );
  });

  test("reads a custom pair off the stored colours", () => {
    expect(
      resolveAppearance({ schemeId: "custom", background: "#120A1F", accent: "#FF8A3D" }),
    ).toEqual({ background: "#120A1F", accent: "#FF8A3D" });
  });

  test("tokensFor is deriveTokens on the resolved pair", () => {
    const appearance = { schemeId: "custom", background: "#120A1F", accent: "#FF8A3D" };
    expect(tokensFor(appearance)).toEqual(deriveTokens("#120A1F", "#FF8A3D"));
    expect(tokensFor(DEFAULT_APPEARANCE)).toEqual(deriveTokens("#000000", "#A78BFA"));
  });
});

// -------------------------------------------------------------- the stylesheet

// A stylesheet that does not parse takes the whole route down and no other test
// notices, because nothing here imports it. So it is parsed here.
describe("the stylesheet", () => {
  test("parses", () => {
    expect(() => postcss.parse(CSS, { from: "app/v2/v2.css" })).not.toThrow();
  });

  /** Every custom property declared on the bare [data-v2-root] rule. */
  const defaults = (): Record<string, string> => {
    const out: Record<string, string> = {};
    postcss.parse(CSS, { from: "app/v2/v2.css" }).walkRules((rule) => {
      if (rule.selector !== "[data-v2-root]") return;
      if (rule.parent !== undefined && rule.parent?.type !== "root") return;
      rule.walkDecls((decl) => {
        if (decl.prop.startsWith("--")) out[decl.prop] = decl.value.trim();
      });
    });
    return out;
  };

  // Behaviour 13. The server renders before any script runs, so the stylesheet's
  // own defaults have to BE the black and purple scheme, or the first paint is
  // some other palette and a user who chose nothing sees it change.
  test("defaults to the derived black and purple tokens, value for value", () => {
    const declared = defaults();
    const derived = deriveTokens(SCHEMES[0].background, SCHEMES[0].accent);
    for (const name of TOKEN_NAMES) {
      expect(declared[name]?.toUpperCase()).toBe(derived[name]);
    }
  });

  test("hard codes no colour outside that defaults block", () => {
    const root = postcss.parse(CSS, { from: "app/v2/v2.css" });
    const offenders: string[] = [];
    root.walkDecls((decl) => {
      const onDefaults =
        decl.parent?.type === "rule" &&
        (decl.parent as { selector?: string }).selector === "[data-v2-root]" &&
        decl.parent.parent?.type === "root";
      if (onDefaults && decl.prop.startsWith("--")) return;
      if (/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/.test(decl.value)) {
        offenders.push(`${decl.prop}: ${decl.value}`);
      }
    });
    expect(offenders).toEqual([]);
  });
});

// ------------------------------------------------------------------ the copy

describe("the panel copy", () => {
  const EM_DASH = String.fromCodePoint(0x2014);
  const EN_DASH = String.fromCodePoint(0x2013);

  const everything = [
    ...Object.values(APPEARANCE_COPY),
    ...SCHEMES.map((scheme) => scheme.name),
  ];

  test("has something to walk", () => {
    expect(everything.length).toBeGreaterThan(8);
    for (const text of everything) expect(typeof text).toBe("string");
  });

  test("uses no em dash and no en dash", () => {
    for (const text of everything) {
      expect(text).not.toContain(EM_DASH);
      expect(text).not.toContain(EN_DASH);
    }
  });

  test("says what reset goes back to", () => {
    expect(APPEARANCE_COPY.reset).toBe("Reset to black and purple");
  });
});
