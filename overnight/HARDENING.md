# Hardening the home PC's agents

The overnight harness (`run.mjs`), the home worker (`worker/worker.py`) and the
URC agent all run on one Windows machine. The code fences what each agent is
*told* it may do. The real boundary is the operating system: an agent with a
shell can read any file its Windows user can read. These steps close that gap.
None of them is automated, because each one changes the machine itself.

## What an agent with a shell could reach today

The worst file is `mindboard\.env.local`. It holds
`SUPABASE_SERVICE_ROLE_KEY` (bypasses RLS for every account),
`ASSISTANT_KEY_SECRET` (decrypts every account's stored API keys) and
`MCP_BEARER_TOKEN`. Besides that:

- `worker\worker.env`: the worker bearer.
- `worker\urc.env`: the URC device token.
- `overnight\.env`: the owner's PAT. URC refuses PATs, but the PAT is still a
  full read/write MCP credential.
- `%USERPROFILE%\.claude.json`: Claude Code's state and trusted folders.
- The Git Credential Manager, `gh` auth and SSH keys of the logged-in user.

## 1. Keep the production service-role key off this PC

Nothing that runs unattended needs it. `run.mjs` uses the PAT, `worker.py` uses
the worker bearer, and `urc-agent.mjs` uses its device token. The only things
that read `SUPABASE_SERVICE_ROLE_KEY` locally are:

- `next dev`;
- `scripts\urc-register-device.mjs`;
- the isolation probe.

**Option A (recommended).** Point local dev at a local stack (`npx supabase
start`, with Docker) or a Supabase branch, and keep only that environment's
keys in `.env.local`.

**Option B.** Keep the prod key in Windows Credential Manager (or a password
manager) and paste it into a shell variable only for the one command that
needs it.

## 2. Run the agents as a separate, low-privilege Windows user

Create a standard (non-admin) local account, e.g. `mb-agent`. Then:

1. Give it read/write on the agent workspace (`mindboard-agent-workspace`) and
   on its own clone of the repo used for `ai/*` builds. Give it nothing else
   under your profile. Deny it `mindboard\.env.local` and your `%USERPROFILE%`
   outright with `icacls`.
2. Sign it into Claude Code once with its own credentials (`claude` → `/login`).
   Give it no `gh` login, and a Git credential that can push only `ai/*`. A
   fine-grained GitHub token scoped to the one repo works.
3. Point the scheduled tasks (`install-task.ps1`, `install-digests.ps1`) and the
   worker's startup shortcut at that user: Task Scheduler → *Run whether user
   is logged on or not* → change user to `mb-agent`.
4. Put `overnight\.env` and `worker\worker.env` in `mb-agent`'s profile, not
   yours, and remove the copies from the repo folder.

The URC agent is the exception. It must keep running as **you**, because the
sessions it opens are yours to drive. It runs no prompts of its own and needs
none of the secrets above except its device token.

## 3. Secrets at rest

Move the remaining `.env` values into DPAPI-protected storage, readable only
by the account that uses them. For example, PowerShell
`ConvertFrom-SecureString`, or Credential Manager plus a small loader. The
.env files then hold references, not values.

## 4. After any suspected agent misbehaviour

Rotate, in this order:

1. `SUPABASE_SERVICE_ROLE_KEY` (Supabase → Settings → API);
2. `WORKER_BEARER_TOKEN` (and `MCP_BEARER_TOKEN` if the legacy static path is
   still enabled);
3. the owner PAT (`/settings` → regenerate);
4. the URC device token (`node scripts\urc-register-device.mjs --rotate`).

`ASSISTANT_KEY_SECRET` can't simply be rotated: it would orphan every stored
API key. Re-enter the keys under a new secret instead.
