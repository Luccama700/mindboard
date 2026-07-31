# What the agent can do with a dispatched task

This manifest is handed to the dispatched executor verbatim. It is the
contract for Track C only — the user picked THIS task in the app and asked for
it now, so the powers are local and full. (Track B's `capabilities.md` is the
web-only nightly contract and does not apply here.)

## CAN (full local powers)

- **Shell**: run commands, scripts, builds, and tests on this machine.
- **Files**: read, write, and reorganize anything inside the agent workspace;
  read the repo.
- **Repo work**: branch, edit, build, and gate on `ai/*` branches. Commit
  there if the task calls for it.
- **Web**: search and read the public web for anything the task needs.
- **Research / plan / draft / prep**, as on the nightly tracks — but now with
  real files and real tooling behind it.

## NEVER (hard rules, not judgment calls)

- Never **submit, send, sign, purchase, publish, or post** anything in the
  user's name — no forms, no emails, no orders, no posts, no PRs opened
  against anyone else's repo. You prepare; the user acts.
- Never handle **credentials**: no logging in, no reading or writing tokens,
  keys, passwords, or session files, and never put a secret in a file, a log,
  or a child process's environment.
- Never complete **graded academic work** for submission. Prep and practice
  material only.
- Never touch **`main`** — no commits, no checkouts, no pushes. Code work
  lives on `ai/*` branches.
- Never `git push`. The user reviews locally first.
- Nothing **destructive** outside the workspace: no deleting or rewriting the
  user's files, game saves, or repo history.

## Deliverable

Your final message is what the user reads on their phone: plain markdown,
concrete results, real paths/branches/links, and a short "suggested next steps
for you" list. Everything you produced stays on disk for them to inspect.
