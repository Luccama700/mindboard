# capture_to_brain — conversation capture into the second brain

**Version 1.0.0** · anchored to commit `c742828` ("MCP: capture_to_brain — save conversation summaries into the vault Inbox") · 2026-07-06

Versioning convention: this document tracks the feature, and its version bumps with the git history of the implementing files (`app/lib/mcp/capture.ts`, `app/lib/mcp/brain.ts`, plus their registrations). A commit that changes behavior bumps minor (1.1.0), a fix bumps patch (1.0.1), a breaking change to the tool's contract bumps major. Every entry in the Version history table at the bottom names its commit.

## What it is

`capture_to_brain` lets any AI surface with Mindboard access — a claude.ai chat with the Mindboard connector, or the in-app assistant — distill the current conversation into a Markdown note and commit it to the user's vault repository on GitHub, under a staging `Inbox/` folder. The vault's normal review flow (morning brief, Cowork sessions, manual filing) then decides what becomes durable vault knowledge.

It is a **capture**, not a transcript: the calling model is instructed to write what was discussed, decisions made, new facts about the user's life worth keeping, and open questions — plain Markdown, `[[wikilinks]]` welcome when confident, AI-concluded claims marked `(inferred)`.

## Where it is exposed

| Surface | Registration | Execution identity |
|---|---|---|
| Remote MCP server (claude.ai connector, MCP inspector, Claude Desktop) | `app/api/mcp/[transport]/route.ts` | Service-role Supabase client scoped to `MINDBOARD_OWNER_USER_ID`, like every other MCP tool |
| In-app assistant | `ASSISTANT_TOOLS` + `runAssistantTool` in `app/lib/assistant/tools.ts` | The caller's RLS session client |

Both surfaces call the same executor. The MCP entry point is `captureToBrain(raw)`; the assistant entry point is `captureToBrainFor(supabase, userId, raw)` (both in `app/lib/mcp/brain.ts`).

## Why it executes directly (no propose → confirm)

Mindboard's locked rule is that assistant writes are propose → confirm. This tool is the one deliberate exception, and the fence is structural rather than procedural:

- It **cannot touch Mindboard data at all** — no Supabase table is written, only a file in the user's GitHub vault repo.
- It is **create-only by construction**: the GitHub Contents API `PUT` payload never includes a `sha`, and without a `sha` GitHub refuses to update an existing file. There is no code path that updates or deletes.
- Writes land **only under `Inbox/`** — the staging area whose entire purpose is human review. The review-and-file flow *is* the confirmation step, just deferred.

## Credential and user resolution

- The MCP server resolves the acting user the same way as every other MCP tool: the OAuth/bearer layer authenticates the caller, and queries run on the service-role client explicitly filtered to `ownerUserId()` (`app/lib/mcp/config.ts`).
- Vault credentials (repo, branch, GitHub token) come from the **same `vault_settings` read `/brain` uses** — `readVaultCredentials()` in `app/lib/brain/vault.ts`. There is no parallel storage and **no env-var fallback**; the token is per-user, RLS-protected, and never logged or returned to a client.
- If no vault is connected, the tool returns: `vault not connected; set it up in /settings`.

## Tool contract

### Parameters

| Parameter | Type | Required | Constraint |
|---|---|---|---|
| `title` | string | yes | ≤ 80 chars after trimming |
| `summary_markdown` | string | yes | ≤ 20,000 chars after trimming |
| `source` | string | yes | e.g. `"claude.ai chat, 2026-07-06"` |
| `topics` | string[] | no | reviewer hints for filing; entries trimmed, empties dropped |

Limits are enforced twice: in the MCP route's zod schema (`.max(...)`) and in the pure validator (`validateCapture`), which is the enforcement the assistant path relies on. Over-limit input is rejected with a clear error naming the limit and the actual length.

### Return value

On success: `{ path, message }` — the committed repo path and a one-line confirmation, e.g.

```json
{
  "path": "Inbox/2026-07-06 1930 Career planning chat.md",
  "message": "Captured \"Career planning chat\" to Inbox/2026-07-06 1930 Career planning chat.md for review."
}
```

### Tool description (what steers the calling model)

> Save a distilled summary of the current conversation into Lucca's second brain for later review and filing. Write a summary, not a transcript: what was discussed, decisions made, new facts about the user's life worth keeping, and open questions. Plain markdown; [[wikilinks]] to vault notes welcome when confident. Mark any AI-concluded (not user-stated) claim with (inferred). The capture lands in a staging Inbox/ and is reviewed before becoming vault knowledge.

## Behavior

### Filename

```
Inbox/YYYY-MM-DD HHmm <sanitized title>.md
```

- The timestamp is **America/Vancouver** local time (computed with `Intl.DateTimeFormat`, DST-correct in both directions).
- Title sanitization: a `..` path segment anywhere in the raw title is rejected outright as traversal; path separators (`/`, `\`) and control characters become spaces; whitespace collapses to single spaces; leading dots are stripped (a dot-file would be invisible to the vault reader). A title with nothing filename-safe left is rejected.

### Collision handling

If the path already exists (GitHub answers 422, or 409 on a ref race), the write retries as ` -2`, then ` -3`, … up to 10 attempts, then fails with a clear error. It never fetches the existing file's `sha` to overwrite — collisions always produce a new file.

### File content

```markdown
---
type: capture
created: 2026-07-06 19:30
source: "claude.ai chat, 2026-07-06"
topics: ["career", "co-op"]
---

<summary_markdown>
```

`created` is Vancouver local time; `source` and `topics` values are YAML-quoted with escaping; the `topics` line is omitted when there are none.

### Commit

- Message: `Capture: <title> (via MCP)`.
- No committer override is sent, so **GitHub attributes the commit to the owner of the vault token** — the user's own name, email, and avatar (changed from a "Mindboard MCP" identity during review of the initial implementation).
- One capture = one commit on the configured branch.

## Error modes

| Condition | Tool error |
|---|---|
| No `vault_settings` row | `vault not connected; set it up in /settings` |
| Missing/oversized/mistyped input | Specific validation message (e.g. `title must be at most 80 characters (got 93)`) |
| Traversal in title | `title must not contain path traversal` |
| GitHub 401 | `vault token was rejected by GitHub` |
| GitHub 403 | `vault token lacks Contents write permission on that repo` |
| GitHub 404 | `vault repo or branch not found (or the token lacks Contents write access)` |
| 10 straight collisions | `could not find a free filename for this capture (too many collisions)` |
| Network failure | `could not reach GitHub` |
| Other GitHub status | `vault write failed (<status>)` |

Note the PAT requirement: `/settings` verifies **Contents read** at save time, but this tool needs **Contents read + write**. A read-only token connects fine and fails only at capture time with the 403 message above.

## Implementation map

| File | Role |
|---|---|
| `app/lib/mcp/capture.ts` | All pure logic: validation, sanitization, Vancouver stamping, frontmatter assembly, create-only PUT loop with injectable `fetch`. No server imports — unit-tests directly. |
| `app/lib/mcp/brain.ts` | Server glue: owner + credential resolution for both surfaces. |
| `app/lib/brain/vault.ts` | `readVaultCredentials(supabase, userId)` — the single token read path, shared with `/brain`. |
| `app/api/mcp/[transport]/route.ts` | MCP tool registration (zod schema, fenced-direct-write section). |
| `app/lib/assistant/tools.ts` | Assistant catalog entry + dispatch (returns a `result` outcome, not a proposal). |
| `__tests__/mcp-capture.test.ts` | Unit tests: sanitization, traversal, size caps, stamping (PDT/PST/midnight), collision suffixing, frontmatter shape, not-configured path, mocked create-only conflict retry, GitHub error mapping. |

## Testing

- **Unit:** `npm run test -- --run __tests__/mcp-capture.test.ts` (35 tests, no network).
- **Local end-to-end:** `npm run dev`, then connect the MCP inspector (`npx @modelcontextprotocol/inspector`) to `http://localhost:3000/api/mcp/mcp` with `Authorization: Bearer <MCP_BEARER_TOKEN>` and call the tool. Expect a real commit on the vault repo.
- **Production:** in a claude.ai chat with the Mindboard connector, say "summarize this conversation into my second brain", then verify the file under `Inbox/` and the commit attribution. If the tool is missing from the connector, toggle the connector off/on so claude.ai re-fetches the tool list.

## Explicitly out of scope

No reads of vault content (the `/brain` viewer owns that), no writes outside `Inbox/`, no updates or deletes of existing files, no changes to other MCP tools, no bypassing per-user vault settings, no `ai_audit_log` row (nothing to confirm; the capture file itself is the record).

## Version history

| Version | Commit | Date | Change |
|---|---|---|---|
| 1.0.0 | `c742828` | 2026-07-06 | Initial implementation: MCP + assistant registration, create-only GitHub write with collision retry, Vancouver-stamped filenames, per-user vault credentials, 35 unit tests. Commits attributed to the vault token's owner (no committer override). |
