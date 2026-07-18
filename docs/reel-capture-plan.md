# Reel Capture Plan

Turn Instagram reels saved into the second brain into searchable text: a
spoken **transcript**, a short **visual summary** of key moments, and the
**on-screen text** (reels lean on overlays). The record lands back in the
vault note so the reel becomes knowledge, not a dead link.

Decided 2026-07-18 with the user:

- Reels arrive as **Instagram links** (a note whose body holds the URL, via
  the existing `/api/capture` share-sheet flow). The worker downloads the
  video itself.
- **Full record**: transcript + visual frame descriptions + on-screen-text
  OCR.
- Runs **local + free on the home worker** (the always-on GPU PC that already
  does OCR/TTS), not a paid API.

## Scope + the line we don't cross

Only reels the user **explicitly shares into Mindboard** are processed —
individual items the user already has access to, for private study. We do
**not** log into the user's Instagram account, and we do **not** pull their
"Saved" collection: that violates Instagram's ToS, needs stored IG
credentials, and risks the account. `yt-dlp` fetching a public reel the user
saved is the gray-but-defensible path for personal use; private-account reels
may simply fail to download, and that's an acceptable, clearly-reported
outcome (the note keeps the link and a "couldn't fetch" note).

## Architecture — one new job kind

This is the third `jobs.kind` alongside `ocr`/`tts`, reusing the entire
pull-based worker chassis (`worker/worker.py`, `/api/worker`, signed URLs, no
DB key or inbound port on the PC — see `worker/README.md`).

### Ingestion (app)

- **Auto**: on `/api/capture`, detect an Instagram URL
  (`instagram.com/(reel|reels|p|tv)/…`) in the shared text. After the note is
  written to `Inbox/`, enqueue a `reel` job whose payload is
  `{ url, notePath }`. Allowlist-gated like the other enqueue paths
  (`queueReelJob`, refusing non-serviced users up front).
- **Manual / re-run**: an MCP tool + in-app action `process_reel(notePath)`
  to (re)queue a reel note already in the vault — covers the backlog and
  retries.

Migration `0040_reel_jobs.sql`: extend the `jobs.kind` check to
`('ocr','tts','reel')`, plus a private `reel-media` bucket. **v1 keeps the
cover thumbnail in the vault itself** (committed jpg attachment, like
share-sheet images — it embeds in markdown with no signed-URL expiry and
needs no note-viewer changes); the `reel-media` bucket is provisioned but
**reserved** for a later "archive every keyframe" pass, not used in v1.

### Worker (`handle_reel`)

Pluggable command templates (env vars, exactly like `MINERU_CMD` /
`VIBEVOICE_CMD`), so model choice is config, not code, and each stage
degrades gracefully:

1. **Download** — `yt-dlp` → `reel.mp4` + `--write-info-json` for the caption,
   author, duration. Private/unavailable → fail the job with a clear message.
2. **Audio** — `ffmpeg` (already installed) → 16 kHz mono wav.
3. **Transcript** — `WHISPER_CMD` (faster-whisper or whisper.cpp) → timestamped
   text. This is the core deliverable; the rest is additive.
4. **Keyframes** — `ffmpeg` scene-change sample, capped (~8–12 frames) so a
   30-second reel doesn't explode into hundreds of images.
5. **Vision + OCR** — `VISION_CMD` (a local VLM: Qwen2.5-VL / moondream via
   llama.cpp or ollama; OCR via the same model or easyocr) → per-frame
   description + extracted overlay text. **Unset → skipped**, transcript-only
   (same "works without the optional model" contract as TTS).
6. **Assemble** — one markdown block: source link, caption/author, transcript,
   "what's on screen" (frame notes + OCR), and a thumbnail embed. Keyframes +
   thumbnail PUT to the `reel-media` bucket via signed upload URLs.

### Finalization (app)

On `complete`, the app writes a **new** `Reels/<title>.md` note via the
create-only vault writer (same fenced exception as course conversion +
`capture_to_brain` — no in-place update, so the safety fence holds): the
cover thumbnail commits first as a `Reels/attachments/` jpg and its
`![[embed]]` goes in the note, followed by frontmatter (`type: reel`,
`source`, `author`, `duration_sec`), the source link, caption, transcript,
and the "On screen" frame notes. `/brain` surfaces and searches it by the
`reel` type. A reel with neither speech nor caption fails the job (retryable)
rather than committing an empty record.

## Worker setup the user installs (one-time, like MinerU/VibeVoice)

```bash
pip install -U yt-dlp faster-whisper           # download + transcription
# WHISPER_CMD e.g.: whisper-ctranslate2 {audio} --model large-v3 --output_dir {out}
# a local VLM for frames+OCR (optional; transcript works without it):
#   VISION_CMD e.g.: python describe_frames.py --frames {frames} --out {out}
```

`ffmpeg` is already required by the worker. The connections card in settings
shows the reel capability alongside OCR/TTS once the worker reports it.

## Non-goals

- No IG login, no Saved-collection scraping, no bulk import.
- No video re-hosting/redistribution — we keep transcripts + a thumbnail, the
  source link stays the source of truth.
- Not real-time: processing is queued and lands when the PC is on, like every
  other worker job.

## Files (planned)

`supabase/migrations/0040_reel_jobs.sql`, `app/api/capture/route.ts`
(detection + enqueue), `app/lib/reels/*` (URL detect, note finalize),
`app/lib/mcp/*` (`process_reel` tool), `worker/worker.py` (`handle_reel` +
templates), `worker/README.md` (setup), `docs/reel-capture-plan.md` (this).
