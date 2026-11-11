// Does the Host header of this request name the machine the server runs on?
//
// A LEAF, AND THAT IS THE WHOLE POINT OF THE FILE. The gate
// (app/lib/v2/source.ts) needs this answer to refuse a request that is not from
// this machine. It used to live in the snapshot loader, and with it there the
// gate and the loader imported each other, and a cycle held up by a comment is a
// trap for whoever edits next. Here it is one function with no imports at all:
// nothing to cycle with, and nothing server only pulled into anything that reads
// it.

/**
 * A SPEED BUMP, NOT A GATE, and the difference matters: a Host header is sent
 * by the client, so anyone who can reach the server can send `Host: localhost`.
 * The thing that actually keeps the owner's data off the network is binding the
 * server to the loopback address (`next dev -H 127.0.0.1`), which nothing in
 * this app can do or check. This only turns the accident, a browser or a scanner
 * elsewhere on the network reaching a server someone started on 0.0.0.0, into a
 * 404.
 *
 * The three spellings a loopback request carries, and nothing else: an IPv6 host
 * is bracketed in a Host header, a port is optional, and the whole value is
 * compared in lower case. The value itself is never reported anywhere, so a
 * refused host cannot write a stranger's text into a log or onto the page.
 */
export function isLoopbackHost(host: string | null | undefined): boolean {
  if (host === null || host === undefined) return false;
  const value = host.trim().toLowerCase();
  if (value.length === 0) return false;

  const bracketed = /^\[([0-9a-f:]+)\](?::\d+)?$/.exec(value);
  if (bracketed !== null) return bracketed[1] === "::1";
  if (value === "::1") return true;

  const colon = value.indexOf(":");
  if (colon === -1) return value === "localhost" || value === "127.0.0.1";
  // A port is digits. Anything else is not a host this can read, so it is not
  // one of the three.
  if (!/^\d+$/.test(value.slice(colon + 1))) return false;
  const name = value.slice(0, colon);
  return name === "localhost" || name === "127.0.0.1";
}
