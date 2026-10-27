# URC — remote-control sessions on this PC, from a claude.ai chat

URC lets a chat on claude.ai start a Claude Code **remote-control session** on
this Windows PC through Mindboard's MCP server, and hand back the private
`https://claude.ai/code/session_…` link that drives it. The session starts
**idle with no prompt** — it does nothing until Lucca types into it from his own
claude.ai account.

Nothing in Mindboard can reach into this machine. Like the home worker, the PC
**pulls**: `worker/urc-agent.mjs` polls `POST /api/urc/device` every 5s with its
own device token.

**What the server knows about paths.** The agent reports a folder **label** for
each key in its heartbeat — in practice the full local path — and that is stored
(`urc_devices.folder_labels`) purely so the `spawn_urc` preview can show the
folder a session will open. The direction is what matters: the server only ever
hands back a **key**, and the agent resolves it through its own
`urc.folders.json`. A path coming from the server is never accepted, never
echoed back into a command, and a key the PC does not have is refused. If you
would rather the server not hold the paths at all, shorten the labels — the
agent is the only thing that needs the real ones.

## The three gates

A session starts only when all three agree — one per layer, so a break in any
one of them is not enough.

1. **Server env** — `URC_OWNER_USER_ID` names the single user who may use the
   four URC tools (`spawn_urc`, `get_urc_status`, `list_urc_sessions`,
   `stop_urc`). Every handler refuses anyone else, and all four refuse the
   shared static `MCP_BEARER_TOKEN`: URC accepts only an OAuth connection
   (claude.ai) or a per-user `mbp_` PAT. Starting a session is also
   propose → confirm, and the confirm dies after 5 minutes.
2. **Database** — `urc_devices` binds a device to one user. The device token is
   stored as a SHA-256 hash, compared in constant time, and works on
   `/api/urc/device` only. `urc_devices`/`urc_jobs` have RLS on with **no**
   policies (service role only); `urc_log` is read-own.
3. **This PC** — the agent acts only when `URC_ENABLED=true` and only on jobs
   whose `user_id` is exactly `URC_OWNER_USER_ID`. It also refuses a folder key
   it doesn't have, a path that no longer exists, and a folder Claude Code
   hasn't been trusted in.

## Setup

1. **Apply the migration** (Lucca, manually): `supabase/migrations/0054_urc.sql`.
2. **Set the server env** on Vercel: `URC_OWNER_USER_ID=<your Supabase user id>`
   (production + preview), then redeploy. Without it the four tools are not
   even registered.
3. **Register this PC** (prints the token once):

   ```powershell
   node scripts\urc-register-device.mjs --user <your-supabase-user-uuid> --name "home-pc"
   ```

4. **Fill in the config**: copy `worker\urc.env.example` to `worker\urc.env`
   (gitignored) and paste the token into `URC_DEVICE_TOKEN`; copy
   `worker\urc.folders.example.json` to `worker\urc.folders.json` and map each
   key to a real path. Keys are what the chat sees and must match
   `[A-Za-z0-9][A-Za-z0-9._-]{0,47}` — no spaces, no paths.
5. **Pre-trust every folder**, once, by hand: open a terminal in the folder, run
   `claude`, and accept "Do you trust this folder?". A session launched into an
   untrusted folder parks on that prompt and never registers with the bridge, so
   the agent refuses the job up front rather than waiting out its 60s timeout.
   The agent only ever **reads** `~/.claude.json`; it never edits it.
6. **Start the agent**: `worker\run-urc-agent.cmd` in a console to watch it, or
   put a shortcut to `worker\urc-agent-hidden.vbs` in `shell:startup` for a
   windowless start at logon (same pattern as the home worker).

Logs land in `worker\logs\urc-agent.log` (and stdout in `urc-agent.out`). The
device token is never logged; the session link is.

**One agent per PC.** Startup takes a lock at `worker\urc-agent.pid`; a second
copy exits with "another urc-agent is already running (pid N)" and a lock left
behind by a crash is cleared automatically. Two agents would double every limit
and, worse, neither one's kill switch would know the other's PIDs.

**Credentials, a note.** URC accepts only an OAuth connection (claude.ai).
Personal access tokens are refused: a user has exactly one PAT, and the
owner's sits in `overnight\.env` on this PC, next to agents that run shell
commands, so anything that read it off disk could otherwise start a session.
The shared static bearer is refused too.

## The kill switch

Set `URC_ENABLED=false` in `worker\urc.env`. The agent re-reads that file every
poll, so within ~5s it:

- kills the sessions **it** started (only PIDs it recorded itself — never a pid
  the server sent), closing their windows,
- reports them `stopped`,
- stops heartbeating and stops claiming, and idles until the flag flips back.

Stopping the heartbeat is the second layer of the same switch: `last_seen` ages
past the server's 20s window, so `spawn_urc` starts answering "Your PC is
offline or the URC agent isn't running" without needing to know about the flag.
Closing the terminal window, or killing the agent process, is the third.

The switch is also honored **during** a spawn: the 60-second wait for a new
session to register re-reads `urc.env` on every poll, so flipping the flag while
a window is coming up tears it down instead of letting it through. And the sweep
only forgets a session once it has *confirmed* the process is gone — if the
process query itself fails, nothing is reported stopped and the sweep runs again
on the next poll (a session is never dropped unkilled).

## Permissions and bypass

`URC_BYPASS_PERMISSIONS` in `worker\urc.env` is the **only** place the
permission mode can be set:

- `false` (the example default) — the spawn command carries **no permission
  flags at all** and the session asks before acting.
- `true` — the command gains `--dangerously-skip-permissions`, and the session
  acts without asking in the folder it was started in.

The value is read from `urc.env` at spawn time and passed to
`buildSpawnArgs({ sessionName, bypass })`, which never sees the job. A job (or a
compromised server) carrying `bypass_permissions: true` changes nothing — that
is asserted in `__tests__/urc-agent-guards.test.ts`. The PC *reports* its mode
in the heartbeat so the `spawn_urc` preview can show the true command and either
`Permissions: BYPASS (set on the PC)` or
`Permissions: normal; the session asks before acting`, and reports the mode it
actually used when the session starts (`urc_jobs.bypass_permissions`, surfaced
by `get_urc_status`) so the chat can state which mode it is driving rather than
guessing from a possibly-since-changed device setting.

**Why bypass is acceptable here.** A spawned session starts **idle**: there is
no starting prompt in v1, so nothing runs until a human types into it, and the
only way to type into it is the private `claude.ai/code/session_…` link, which
is returned exclusively to Lucca's own authenticated account (owner-gated tools,
OAuth/PAT only, and `get_urc_status` only hands the link over while the session
is live). Bypass therefore means "the session Lucca is personally driving
doesn't nag him", not "an autonomous agent is loose on the PC".

> **Do not add a starting prompt while bypass can be on.** A prompt plus bypass
> turns a spawn into remote arbitrary code execution driven by whatever text
> reached the MCP server — including text a model was talked into writing. If a
> starting prompt is ever added, it must be refused whenever the device reports
> `bypass_permissions: true`.

## Using it from a chat

1. `list_urc_sessions` — is the PC online, and which folder keys does it offer?
2. `spawn_urc { folder: "mindboard" }` — returns a preview (device, folder, the
   literal command, permission mode) + a `proposalId`. Nothing has run yet.
3. `confirm_action { proposalId }` — queues the job (expires in 2 minutes) and
   returns its `jobId`.
4. `get_urc_status { jobId }` a few seconds later — `running` plus the private
   session link. Open it to drive the session.
5. `stop_urc { jobId }` — closes the window within a few seconds. No confirm
   step; stopping is the safe direction.

Limits: 4 live sessions, 5 spawns an hour — enforced on the server **and**
locally by the agent (`worker/urc-state.json`).

## How to test

Offline, no database, no session spawned:

```powershell
npm test -- urc            # server guards, device endpoint, PC guards
node --check worker\urc-agent.mjs
node --check scripts\urc-register-device.mjs
```

Tenant isolation against live Supabase (creates and deletes two throwaway
users; skips the URC checks with a message if 0054 isn't applied yet):

```powershell
node test\isolation-proof.mjs
# or, with a dev server running, to include the MCP checks:
$env:MCP_URL="http://localhost:3000/api/mcp/mcp"; node test\isolation-proof.mjs
```

End-to-end, after the migration is applied and the env is set:

1. Start the agent with `URC_ENABLED=true` and watch `worker\logs\urc-agent.log`
   for `heartbeat` activity (one line per refused/claimed job; a quiet log means
   a quiet queue).
2. From a claude.ai chat on the Mindboard connector: `list_urc_sessions` should
   show `online: true` and your folder keys.
3. `spawn_urc` → `confirm_action` → `get_urc_status`. A new Windows Terminal
   window should appear within a few seconds and the status should flip to
   `running` with a link.
4. `stop_urc` — the window closes and the status reads `stopped`.

Negative checks worth doing once by hand: rename a folder key in
`urc.folders.json` and spawn the old one (expect a clear refusal in
`get_urc_status`); stop the agent and spawn (expect the offline error); set
`URC_ENABLED=false` with a session live (expect the window to close within ~5s).

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| "Your PC is offline or the URC agent isn't running" | agent not running, `URC_ENABLED=false`, wrong `MINDBOARD_URL`, or a bad device token (the heartbeat 401s — check the log) |
| status goes `failed` with "did not register … within 60s" | folder not trusted, or `claude.exe` too old for the model (`claude update`; the agent runs `%USERPROFILE%\.local\bin\claude.exe`) |
| status goes `failed` with "Windows Terminal (wt.exe) not found" | URC launches only through `wt.exe` — there is deliberately no fallback window |
| status stays `queued` then `expired` | the PC never claimed it within 2 minutes — it was offline or disabled |
| status goes `failed` with "claimed the job but never started it" | the agent died or the PC rebooted mid-spawn; the job is swept so it stops holding a session slot |
| "another urc-agent is already running" in the log | a second copy was started; the first one still holds `worker\urc-agent.pid` |
| "URC can't be driven with the shared static MCP token" | the chat is authenticated with `MCP_BEARER_TOKEN`; connect over OAuth or use an `mbp_` PAT |
| "URC isn't available for this account" | `URC_OWNER_USER_ID` is unset on the server, or this is not that account |

Never kill `WindowsTerminal.exe` to clean up a session — it hosts every tab on
this machine (that mistake once took down the Minecraft server console). The
agent kills the session's own powershell PID with `taskkill /T /F`, which closes
just that window.
