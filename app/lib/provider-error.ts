// Turn an upstream API error body into one short line that is safe to show the
// user: the provider's own human message when the body is the usual JSON error
// envelope, otherwise nothing. Raw bodies can be HTML gateway pages or echo
// request details, so they are never passed through verbatim.
export function providerErrorMessage(body: string, max = 200): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const error = (parsed as { error?: unknown } | null)?.error;
  const message =
    typeof error === "string"
      ? error
      : typeof (error as { message?: unknown } | null)?.message === "string"
        ? (error as { message: string }).message
        : null;
  if (!message) return null;
  const line = message.replace(/\s+/g, " ").trim();
  if (!line) return null;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
