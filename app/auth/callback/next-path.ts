// Where /auth/callback may send the browser after a successful code exchange.
//
// Audit 2026-10-26, finding L3: the `next` query parameter was interpolated
// straight into `${origin}${next}`, so `next=@evil.com` produced
// `https://app@evil.com` — the app's own origin demoted to a userinfo prefix
// and the browser sent off-site. The only guard was in client code, which a
// hand-built callback URL never runs, so the check has to happen here.
//
// Three conditions, each catching something the others miss: a single leading
// slash rejects absolute URLs and scheme-relative ones; the explicit `//`
// and `/\` prefixes reject protocol-relative targets (browsers treat the
// backslash form as the slash form); and resolving against the origin catches
// what the string checks cannot, including `/\t/evil.com`, since WHATWG URL
// parsing strips tabs and newlines before resolution.
//
// Pure on purpose — no request state, no framework import — so it is unit
// testable on its own.
export function safeNextPath(
  next: string | null | undefined,
  origin: string,
): string {
  const fallback = "/";
  if (!next || !next.startsWith("/")) return fallback;
  if (next.startsWith("//") || next.startsWith("/\\")) return fallback;
  let resolved: URL;
  try {
    resolved = new URL(next, origin);
  } catch {
    return fallback;
  }
  return resolved.origin === origin ? next : fallback;
}
