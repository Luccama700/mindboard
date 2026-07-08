import { describe, expect, it } from "vitest";
import {
  scriptSystemPrompt,
  scriptToGeminiPrompt,
  scriptToVibeVoiceText,
  scriptWordCount,
  speakersUsed,
  validateScript,
  type ScriptLine,
} from "@/app/lib/learn/podcast-script";
import { pcmDurationSeconds, pcmToWav } from "@/app/lib/learn/audio";
import { validateGenerateEpisode } from "@/app/lib/learn/episodes";

const LINES: ScriptLine[] = [
  { speaker: "A", text: "Welcome back." },
  { speaker: "B", text: "So what are eigenvalues, really?" },
];

describe("validateScript", () => {
  it("accepts a typed script and trims lines", () => {
    const r = validateScript({
      title: "  Eigenvalues, demystified  ",
      lines: [
        { speaker: "A", text: " a " },
        { speaker: "B", text: "b" },
        { speaker: "A", text: "c" },
        { speaker: "B", text: "d" },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.title).toBe("Eigenvalues, demystified");
      expect(r.value.lines[0]).toEqual({ speaker: "A", text: "a" });
    }
  });

  it("rejects missing titles, unknown speakers, and too-short scripts", () => {
    expect(validateScript(null).ok).toBe(false);
    expect(validateScript({ title: "t", lines: LINES }).ok).toBe(false);
    expect(
      validateScript({
        title: "t",
        lines: [
          { speaker: "C", text: "x" },
          { speaker: "A", text: "y" },
          { speaker: "B", text: "z" },
          { speaker: "A", text: "w" },
        ],
      }).ok,
    ).toBe(false);
  });

  it("drops blank lines but still enforces the minimum", () => {
    const r = validateScript({
      title: "t",
      lines: [
        { speaker: "A", text: "  " },
        { speaker: "B", text: "b" },
        { speaker: "A", text: "c" },
        { speaker: "B", text: "d" },
      ],
    });
    expect(r.ok).toBe(false);
  });
});

describe("engine renderings", () => {
  it("formats the gemini prompt with named hosts", () => {
    const prompt = scriptToGeminiPrompt(LINES);
    expect(prompt).toContain("Ava (warm, quick, wry)");
    expect(prompt).toContain("Ava: Welcome back.");
    expect(prompt).toContain("Ben: So what are eigenvalues, really?");
  });

  it("formats vibevoice speaker lines without tags", () => {
    expect(scriptToVibeVoiceText(LINES)).toBe(
      "Speaker 1: Welcome back.\nSpeaker 2: So what are eigenvalues, really?",
    );
  });

  it("counts spoken words", () => {
    expect(scriptWordCount(LINES)).toBe(7);
  });
});

describe("pcmToWav", () => {
  it("writes a valid 44-byte RIFF header around the pcm", () => {
    const pcm = new Uint8Array([1, 2, 3, 4]);
    const wav = pcmToWav(pcm, 24_000);
    expect(wav.length).toBe(48);
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...wav.slice(8, 12))).toBe("WAVE");
    const view = new DataView(wav.buffer);
    expect(view.getUint32(4, true)).toBe(36 + 4); // RIFF size
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(24_000); // sample rate
    expect(view.getUint32(40, true)).toBe(4); // data size
    expect(wav.slice(44)).toEqual(pcm);
  });

  it("estimates duration from byte count (16-bit mono)", () => {
    expect(pcmDurationSeconds(24_000 * 2 * 60)).toBe(60);
  });
});

describe("solo flavor", () => {
  const SOLO_LINES: ScriptLine[] = [
    { speaker: "A", text: "First line." },
    { speaker: "A", text: "Second line." },
  ];

  it("detects the speakers a script actually uses", () => {
    expect(speakersUsed(SOLO_LINES)).toEqual(["A"]);
    expect(speakersUsed(LINES)).toEqual(["A", "B"]);
  });

  it("renders a single-narrator gemini prompt without host names", () => {
    const prompt = scriptToGeminiPrompt(SOLO_LINES);
    expect(prompt).toContain("narrator voice");
    expect(prompt).not.toContain("Ava:");
    expect(prompt).toContain("First line.");
  });

  it("keeps the two-host gemini prompt for mixed scripts", () => {
    expect(scriptToGeminiPrompt(LINES)).toContain("Ava:");
  });

  it("has a dedicated solo system prompt with no second host", () => {
    const solo = scriptSystemPrompt("solo");
    expect(solo).toContain("single-narrator");
    expect(solo).not.toContain("HOST B");
    expect(scriptSystemPrompt("deep-dive")).toContain("HOST B (Ben)");
  });

  it("accepts an all-A script through validation", () => {
    const r = validateScript({
      title: "solo",
      lines: [
        { speaker: "A", text: "a" },
        { speaker: "A", text: "b" },
        { speaker: "A", text: "c" },
        { speaker: "A", text: "d" },
      ],
    });
    expect(r.ok).toBe(true);
  });
});

describe("validateGenerateEpisode", () => {
  it("accepts the solo flavor", () => {
    const r = validateGenerateEpisode({ course: "m", flavor: "solo" });
    expect(r.ok && r.value.flavor).toBe("solo");
  });

  it("defaults flavor and engine", () => {
    const r = validateGenerateEpisode({ course: "Math" });
    expect(r).toEqual({
      ok: true,
      value: { course: "Math", sourceIds: null, flavor: "deep-dive", engine: "gemini" },
    });
  });

  it("rejects unknown flavors and engines", () => {
    expect(validateGenerateEpisode({ course: "m", flavor: "opera" }).ok).toBe(false);
    expect(validateGenerateEpisode({ course: "m", engine: "kokoro" }).ok).toBe(false);
  });

  it("treats an empty source_ids array as all sources", () => {
    const r = validateGenerateEpisode({ course: "m", source_ids: [] });
    expect(r.ok && r.value.sourceIds).toBe(null);
  });
});
