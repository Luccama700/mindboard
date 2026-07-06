import { describe, expect, test } from "vitest";

import { normalizeVaultSettingsInput } from "@/app/lib/brain/settings";

describe("normalizeVaultSettingsInput", () => {
  test("accepts owner/name with branch and token", () => {
    expect(
      normalizeVaultSettingsInput({
        repo: "Luccama700/2ndBrain",
        branch: "main",
        token: "github_pat_abc123",
      }),
    ).toEqual({
      ok: true,
      repo: "Luccama700/2ndBrain",
      branch: "main",
      token: "github_pat_abc123",
    });
  });

  test("trims fields and defaults branch to main", () => {
    expect(
      normalizeVaultSettingsInput({
        repo: "  owner/repo.name  ",
        branch: "  ",
        token: " tok ",
      }),
    ).toEqual({ ok: true, repo: "owner/repo.name", branch: "main", token: "tok" });
  });

  test("empty token becomes null (keep existing)", () => {
    const result = normalizeVaultSettingsInput({
      repo: "owner/repo",
      branch: "dev",
      token: "",
    });
    expect(result).toEqual({ ok: true, repo: "owner/repo", branch: "dev", token: null });
  });

  test("rejects missing or malformed repo", () => {
    expect(normalizeVaultSettingsInput({ repo: "", branch: "", token: "" }).ok).toBe(false);
    expect(
      normalizeVaultSettingsInput({ repo: "just-a-name", branch: "", token: "" }).ok,
    ).toBe(false);
    expect(
      normalizeVaultSettingsInput({
        repo: "https://github.com/owner/repo",
        branch: "",
        token: "",
      }).ok,
    ).toBe(false);
    expect(
      normalizeVaultSettingsInput({ repo: "owner/repo/extra", branch: "", token: "" }).ok,
    ).toBe(false);
  });

  test("rejects whitespace in branch or token", () => {
    expect(
      normalizeVaultSettingsInput({ repo: "o/r", branch: "my branch", token: "" }).ok,
    ).toBe(false);
    expect(
      normalizeVaultSettingsInput({ repo: "o/r", branch: "main", token: "a b" }).ok,
    ).toBe(false);
  });
});
