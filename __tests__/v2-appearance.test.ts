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

import { readFileSync, readdirSync } from "node:fs";
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
  LIT_INK_TOKENS as LIT_INKS,
  LIT_TINT,
  VISIBLE_PAGE_MOVE,
  normalizeHex,
  pageAdjustment,
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

/**
 * Every stylesheet the v2 screens load. Only v2.css may spell out a colour, in
 * its defaults block; the others say which token each thing uses and nothing
 * more, so a scheme the owner picks reaches them too.
 */
// Found by reading the folder, so a stylesheet nobody registered is still held
// to the rule.
const SHEETS = readdirSync(path.join(ROOT, "app/v2"))
  .filter((name) => name.endsWith(".css"))
  .sort()
  .map((name) => `app/v2/${name}`)
  .map((file) => ({
  file,
  css: readFileSync(path.join(ROOT, file), "utf8"),
}));

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
    for (const { file, css } of SHEETS) {
      expect(() => postcss.parse(css, { from: file }), file).not.toThrow();
    }
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
    const offenders: string[] = [];
    for (const { file, css } of SHEETS) {
      const root = postcss.parse(css, { from: file });
      root.walkDecls((decl) => {
        const onDefaults =
          file === "app/v2/v2.css" &&
          decl.parent?.type === "rule" &&
          (decl.parent as { selector?: string }).selector === "[data-v2-root]" &&
          decl.parent.parent?.type === "root";
        if (onDefaults && decl.prop.startsWith("--")) return;
        if (/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/.test(decl.value)) {
          offenders.push(`${file} ${decl.prop}: ${decl.value}`);
        }
      });
    }
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

// ===========================================================================
// Round 2: the guarantee by construction, not by sampling
//
// The independent review found that the contrast guarantee held only for the
// pairs this file happened to try. A custom background in the middle of the
// range cannot carry readable text at all, so `readableOn` clamped to the
// extreme and every ink came out under 4.5:1 with nothing saying so. The fix
// moves the PAINTED page away from the ink until the extreme reaches the bar
// (ruling R1), and the lit card's tint is now the largest one at which the inks
// the stylesheet prints on it still clear the bar (R2).
//
// So the test is a sweep rather than a handful of pairs. No epsilon: both the
// implementation and these assertions call the same `contrast` on the same hex
// strings, so the two sides agree bit for bit.
// ===========================================================================

/** HSL to hex, so the sweep can walk hues rather than only greys. */
function hsl(hue: number, saturation: number, lightness: number): string {
  const s = saturation / 100;
  const l = lightness / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const h = (((hue % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const rgb =
    h < 1
      ? [c, x, 0]
      : h < 2
        ? [x, c, 0]
        : h < 3
          ? [0, c, x]
          : h < 4
            ? [0, x, c]
            : h < 5
              ? [x, 0, c]
              : [c, 0, x];
  const m = l - c / 2;
  const byte = (value: number) =>
    Math.round((value + m) * 255)
      .toString(16)
      .padStart(2, "0")
      .toUpperCase();
  return `#${byte(rgb[0])}${byte(rgb[1])}${byte(rgb[2])}`;
}

/**
 * Every background the sweep walks: the whole grey ramp in steps of 5, the four
 * mid greys the reviewer measured, and saturated colours around the wheel at
 * three lightnesses.
 */
function sweepBackgrounds(): string[] {
  const out: string[] = [];
  for (let value = 0; value <= 255; value += 5) {
    const byte = value.toString(16).padStart(2, "0").toUpperCase();
    out.push(`#${byte}${byte}${byte}`);
  }
  out.push("#FFFFFF", "#777777", "#808080", "#6B6B6B", "#8A8A8A");
  for (let hue = 0; hue < 360; hue += 30) {
    for (const lightness of [30, 50, 70]) out.push(hsl(hue, 80, lightness));
  }
  return Array.from(new Set(out));
}

/** The accents: the default, both extremes, a mid grey, and the page itself. */
const sweepAccents = (background: string) => [
  "#A78BFA",
  "#FFFFFF",
  "#000000",
  "#808080",
  background,
];

/** Identity colours: none, both extremes, a mid grey, a dark navy, a bright yellow. */
const SWEEP_IDENTITIES: Array<string | null> = [
  null,
  "#FFFFFF",
  "#000000",
  "#808080",
  "#1E3A8A",
  "#FDE047",
];

/**
 * The inks the stylesheet prints INSIDE a lit card, and nothing else. Read off
 * v2.css: --v2-ink by inheritance on the card's h3, --v2-ink-2 on .v2-lit p,
 * .v2-lit .v2-detail, .v2-stop .v2-leave and the .v2-quiet buttons, and
 * --v2-signal through the @keyframes v2-moved flash on .v2-lit .v2-when.
 * --v2-ink-3 is NOT one: .v2-lit p and .v2-lit .v2-detail both override it, and
 * .v2-tag is not rendered in the lit branch of stop-card.tsx.
 */
// Imported from the module, not restated, so the list the tint search holds and
// the list this sweep measures cannot drift apart.
const LIT_INK_TOKENS = LIT_INKS;

/** The plain surfaces the stylesheet prints --v2-ident on. See the report. */
const IDENT_SURFACES = ["--v2-page", "--v2-card"] as const;

describe("the whole range of custom pairs", () => {
  const backgrounds = sweepBackgrounds();

  test("has something to sweep", () => {
    expect(backgrounds.length).toBeGreaterThan(80);
    expect(backgrounds).toContain("#808080");
    expect(backgrounds).toContain("#000000");
    expect(backgrounds).toContain("#FFFFFF");
  });

  test("gives readable text on every background, accent and identity colour", () => {
    const failures: string[] = [];
    const fail = (
      background: string,
      accent: string,
      identity: string | null,
      token: string,
      surface: string,
      ratio: number,
      min: number,
    ) => {
      failures.push(
        `bg ${background} accent ${accent} identity ${identity ?? "none"}: ` +
          `${token} on ${surface} is ${ratio.toFixed(2)} to 1, wanted ${min} to 1`,
      );
    };

    for (const background of backgrounds) {
      for (const accent of sweepAccents(background)) {
        const tokens = deriveTokens(background, accent);

        for (const token of TEXT_TOKENS) {
          for (const surface of SURFACES) {
            const ratio = contrast(tokens[token], tokens[surface]);
            if (ratio < 4.5) fail(background, accent, null, token, surface, ratio, 4.5);
          }
        }
        const onAccent = contrast(tokens["--v2-on-accent"], tokens["--v2-accent"]);
        if (onAccent < 4.5) {
          fail(background, accent, null, "--v2-on-accent", "--v2-accent", onAccent, 4.5);
        }
        const accentMark = contrast(tokens["--v2-accent"], tokens["--v2-page"]);
        if (accentMark < 3) {
          fail(background, accent, null, "--v2-accent", "--v2-page", accentMark, 3);
        }
        // The feed dots. They sit in a pill whose background is --v2-card and
        // nowhere else, and they are marks with their own text labels.
        for (const token of ["--v2-ok", "--v2-warn"] as const) {
          const ratio = contrast(tokens[token], tokens["--v2-card"]);
          if (ratio < 3) fail(background, accent, null, token, "--v2-card", ratio, 3);
        }

        for (const identity of SWEEP_IDENTITIES) {
          const own = identityTokens(identity, tokens);

          for (const token of LIT_INK_TOKENS) {
            const ratio = contrast(tokens[token], own["--v2-lit"]);
            if (ratio < 4.5) {
              fail(background, accent, identity, token, "--v2-lit", ratio, 4.5);
            }
          }

          const identOn = contrast(own["--v2-ident"], own["--v2-lit"]);
          if (identOn < 4.5) {
            fail(background, accent, identity, "--v2-ident", "--v2-lit", identOn, 4.5);
          }
          for (const surface of IDENT_SURFACES) {
            const ratio = contrast(own["--v2-ident"], tokens[surface]);
            if (ratio < 4.5) {
              fail(background, accent, identity, "--v2-ident", surface, ratio, 4.5);
            }
          }

          // The focus ring drawn INSIDE a lit card. It is the identity colour,
          // which is held at 4.5:1 on exactly that fill, so 3:1 for a mark is
          // covered twice over; it is named here because the ring is a separate
          // use of the token and the bar for it is the mark's bar.
          const ring = contrast(own["--v2-ident"], own["--v2-lit"]);
          if (ring < 3) {
            fail(background, accent, identity, "--v2-ident", "--v2-lit (ring)", ring, 3);
          }

          const onIdent = contrast(own["--v2-on-ident"], own["--v2-ident"]);
          if (onIdent < 4.5) {
            fail(background, accent, identity, "--v2-on-ident", "--v2-ident", onIdent, 4.5);
          }

          // The mark is a non-text graphic, printed on the page (the dot on the
          // line) and on a card (the dot in the lane summary). A stop with no
          // colour of its own takes the hairline, which is not a mark.
          if (identity !== null) {
            for (const surface of IDENT_SURFACES) {
              const ratio = contrast(own["--v2-lane"], tokens[surface]);
              if (ratio < 3) {
                fail(background, accent, identity, "--v2-lane", surface, ratio, 3);
              }
            }
          }
        }
      }
    }

    expect(failures.slice(0, 12)).toEqual([]);
    expect(failures).toHaveLength(0);
  });
});

describe("the built in schemes are untouched by the repair", () => {
  test("paint the page exactly the colour the scheme names", () => {
    for (const scheme of SCHEMES) {
      expect(deriveTokens(scheme.background, scheme.accent)["--v2-page"]).toBe(
        scheme.background,
      );
    }
  });

  test("still tint the lit card by the full amount, for every sample colour", () => {
    for (const scheme of SCHEMES) {
      const tokens = deriveTokens(scheme.background, scheme.accent);
      for (const colour of IDENTITY_COLOURS) {
        const own = identityTokens(colour, tokens);
        expect(own["--v2-lit"]).toBe(
          mixHex(tokens["--v2-card"], own["--v2-lane"], LIT_TINT),
        );
      }
    }
  });
});

describe("pageAdjustment", () => {
  test("says nothing for the four built in schemes", () => {
    for (const scheme of SCHEMES) {
      expect(pageAdjustment(scheme.background, scheme.accent)).toBeNull();
    }
  });

  test("says nothing for a clearly dark or clearly light custom pair", () => {
    expect(pageAdjustment("#120A1F", "#FF8A3D")).toBeNull();
    expect(pageAdjustment("#FFFDF5", "#0F766E")).toBeNull();
  });

  // The largest difference on any one channel, which is what the helper counts.
  const moved = (a: string, b: string) =>
    Math.max(
      ...[1, 3, 5].map((at) =>
        Math.abs(
          Number.parseInt(a.slice(at, at + 2), 16) -
            Number.parseInt(b.slice(at, at + 2), 16),
        ),
      ),
    );

  // A mid grey cannot carry readable text at all. #777777 reads as a light
  // background (black ink contrasts better than white), so the page is pushed
  // toward white until black ink reaches the bar.
  test("says what it did for a mid grey, and the page really moved", () => {
    expect(pageAdjustment("#777777", "#A78BFA")).toBe("lightened");
    const painted = deriveTokens("#777777", "#A78BFA")["--v2-page"];
    expect(moved(painted, "#777777")).toBeGreaterThanOrEqual(VISIBLE_PAGE_MOVE);
  });

  test("says what it did for a grey that reads as dark", () => {
    expect(pageAdjustment("#6B6B6B", "#A78BFA")).toBe("darkened");
  });

  // #808080 needs one byte of lightening to hold the guarantee. The page is
  // moved (the sweep above depends on it) and nothing is said, because nobody
  // can see one byte and a sentence about it would read as a fault.
  test("keeps the guarantee silently when the move is too small to see", () => {
    const painted = deriveTokens("#808080", "#A78BFA")["--v2-page"];
    expect(painted).not.toBe("#808080");
    expect(moved(painted, "#808080")).toBeLessThan(VISIBLE_PAGE_MOVE);
    expect(pageAdjustment("#808080", "#A78BFA")).toBeNull();
  });

  test("speaks exactly when the painted page is visibly not the picked one", () => {
    for (const grey of ["#6B6B6B", "#777777", "#808080", "#8A8A8A"]) {
      const painted = deriveTokens(grey, "#A78BFA")["--v2-page"];
      const said = pageAdjustment(grey, "#A78BFA");
      expect(said !== null).toBe(moved(painted, grey) >= VISIBLE_PAGE_MOVE);
      if (said !== null) expect(["darkened", "lightened"]).toContain(said);
    }
  });

  test("falls back rather than throwing on a colour it cannot read", () => {
    expect(pageAdjustment("not a colour", "#A78BFA")).toBeNull();
  });
});

describe("readableOn, pinned at the edges", () => {
  test.each([
    ["black on black", "#000000", "#000000"],
    ["white on paper", "#FFFFFF", "#F6F3EC"],
    ["an unreadable colour", "zzz", "#000000"],
    ["an unreadable background", "#A78BFA", "zzz"],
  ])(
    "%s comes back readable against the background as read",
    (_name, colour, background) => {
      const out = readableOn(colour, background);
      expect(out).toMatch(/^#[0-9A-F]{6}$/);
      // Against the background AS THE FUNCTION READS IT: an unparseable value is
      // black, which is what the rest of the module falls back to as well.
      const page = normalizeHex(background) ?? "#000000";
      expect(contrast(out, page)).toBeGreaterThanOrEqual(4.5);
    },
  );
});

// M4. The two feed-health colours are derived now rather than fixed, because on
// Paper they measured 1.42:1 and 1.31:1 against the card they sit in. The hue is
// still fixed: only the lightness is allowed to move, and only as far as it has
// to, so the three dark schemes keep the exact colours they had.
describe("the feed dots", () => {
  const SEED = { "--v2-ok": "#2FD6A3", "--v2-warn": "#FFB84D" } as const;

  test.each(["black-purple", "night-indigo", "graphite-teal"])(
    "%s keeps the state colours exactly as they were",
    (id) => {
      const scheme = schemeById(id);
      const tokens = deriveTokens(scheme!.background, scheme!.accent);
      expect(tokens["--v2-ok"]).toBe(SEED["--v2-ok"]);
      expect(tokens["--v2-warn"]).toBe(SEED["--v2-warn"]);
    },
  );

  test("paper darkens them until the dot can be seen on its card", () => {
    const paper = SCHEMES[3];
    const tokens = deriveTokens(paper.background, paper.accent);
    for (const token of ["--v2-ok", "--v2-warn"] as const) {
      expect(tokens[token]).not.toBe(SEED[token]);
      expect(contrast(tokens[token], tokens["--v2-card"])).toBeGreaterThanOrEqual(3);
      // Darkened, not recoloured: it moved toward the scheme's own ink.
      expect(contrast(tokens[token], "#FFFFFF")).toBeGreaterThan(
        contrast(SEED[token], "#FFFFFF"),
      );
    }
  });

  test("are not text, so they are not in the text sweep", () => {
    expect(TEXT_TOKENS).not.toContain("--v2-ok");
    expect(TEXT_TOKENS).not.toContain("--v2-warn");
    expect(TOKEN_NAMES).toContain("--v2-ok");
    expect(TOKEN_NAMES).toContain("--v2-warn");
  });
});
