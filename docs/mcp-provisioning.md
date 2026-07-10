# Provisioning your MCP connection

Mindboard's MCP server is multi-tenant: one URL, and every request is scoped
to the account that authenticated it. You can only ever see and write your own
data — isolation is enforced by per-user row scoping on every tool call, with
Postgres row-level security as the backstop for everything the web app does.

## 1. Get an account

Sign in at the app with Google (`/login`). A brand-new account lands in an
empty workspace — nothing to configure.

## 2. Connect an AI client

The server URL is the same for everyone:

```
https://<app-domain>/api/mcp/mcp
```

(It's shown, with a copy button, on **Settings → connections → mcp
connection**.)

### claude.ai / Claude mobile (OAuth — no token needed)

1. claude.ai → Settings → Connectors → **Add custom connector**.
2. Paste the server URL.
3. When prompted, sign in with the same Google account you use for Mindboard.
   That's the whole handshake — the OAuth token claude.ai receives is bound to
   your user id.

### Claude Desktop / MCP inspector / anything without OAuth

1. App → **Settings → connections → mcp connection → generate token**.
2. Copy the `mbp_…` token immediately — it's shown once and stored only as a
   hash.
3. Send it as a header on every request:

   ```
   Authorization: Bearer mbp_…
   ```

   For Claude Desktop, use an HTTP MCP server entry with that header.

Regenerating replaces the old token instantly; **revoke** disables token
access entirely (OAuth keeps working). Losing the token is fine — just
regenerate.

## 3. What a connected client can do

- Reads (tasks, finance, inventory, schedule, courses, brain notes) run
  immediately, always scoped to you.
- Writes are propose → confirm: the client shows you a preview and nothing
  lands until it calls `confirm_action`. Every executed write is recorded in
  your `ai_audit_log`.
- The brain-vault tools need your own GitHub vault connected on `/brain`
  first; course/audio tools use your own stored API keys from Settings.

## Notes for the deployment owner

- The legacy static `MCP_BEARER_TOKEN` still works and maps to
  `MINDBOARD_OWNER_USER_ID`; the home worker uses the same token for
  `/api/worker`.
- The home worker only claims jobs from allowlisted users: the owner plus the
  comma-separated user ids in `WORKER_ALLOWED_USER_IDS` (Vercel env). Other
  users see worker-backed options declined with a friendly error and use the
  hosted paths (Claude API conversion, Gemini TTS) instead.
