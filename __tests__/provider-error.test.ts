import { describe, expect, test } from "vitest";

import { providerErrorMessage } from "@/app/lib/provider-error";

describe("providerErrorMessage", () => {
  test("reads the OpenAI / Google error envelope", () => {
    expect(
      providerErrorMessage(JSON.stringify({ error: { message: "Billing hard limit reached", code: 400 } })),
    ).toBe("Billing hard limit reached");
    expect(providerErrorMessage(JSON.stringify({ error: "invalid_grant" }))).toBe("invalid_grant");
  });

  test("never passes a non-JSON body through", () => {
    expect(providerErrorMessage("<html><body>502 Bad Gateway</body></html>")).toBeNull();
    expect(providerErrorMessage("")).toBeNull();
    expect(providerErrorMessage(JSON.stringify({ detail: "x" }))).toBeNull();
  });

  test("collapses whitespace and caps the length", () => {
    const long = "word ".repeat(100);
    const line = providerErrorMessage(JSON.stringify({ error: { message: long } }), 50);
    expect(line).not.toBeNull();
    expect(line!.length).toBe(50);
    expect(line!.endsWith("…")).toBe(true);
  });
});
