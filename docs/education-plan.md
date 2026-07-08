# Mindboard `/learn` — courses, NotebookLM-style study engine, and audio overviews

Kickoff plan. Drafted 2026-07-08 after three research rounds (NotebookLM feature
inventory · PDF→markdown feasibility · audio-overview + local-voice landscape).
This document is the durable record of the design; implementation logs append
below as milestones ship, in the `docs/second-brain-plan.md` convention.

## Vision

A `/learn` section where each **course** is a NotebookLM-style notebook: course
files (PDFs, lecture slides, notes) become clean Markdown in the 2ndBrain vault,
grounded chat cites exact passages, study artifacts (guides, flashcards) are one
tap away — and the headline feature, **audio overviews**: two-host podcast
episodes generated from any course's sources, listenable from the PWA.

The owner's stated priority order: **audio overviews first-class** (the main
reason this section exists), ingestion that is cheap by default (subscription
tokens or the home GPU, not API dollars), grounded chat + artifacts after.

## Locked decisions (owner, 2026-07-08)

1. **The vault stays the knowledge layer.** Converted markdown and generated
   artifacts live in the GitHub vault under `Courses/`; Postgres holds only
   operational metadata (courses, sources, jobs, episodes). This preserves the
   2026-07-02 strategic redirection (no second knowledge store).
2. **Three ingestion paths, one contract** (any path ends with: markdown in the
   vault, `course_sources` row updated, original PDF in a private bucket):
   - **Chat-AI transcription over MCP** (default; uses claude.ai subscription
     tokens, not API dollars) via chunked upload tools.
   - **Home worker: WSL2 + MinerU 3.x hybrid** (free, ~1–3 min per 50-page
     deck on the 16 GB card; best formulas/tables in class).
   - **Claude API native** (kept as the in-app/away fallback; Sonnet ≈ $1.10,
     Haiku ≈ $0.35 per 50 pages on the stored key).
3. **Audio overviews render two ways**: hosted **Gemini Flash TTS** (native
   two-speaker in one request, ≈ $0.18/episode, free tier; instant) and local
   **VibeVoice-Large at Q8** (~12 GB) on the worker (MIT, $0, ~20–45
   min/episode). Scripts are always Claude-written, engine chosen per episode.
   The engine field is deliberately pluggable: VibeVoice's official weights
   were pulled by Microsoft in Sept 2025 (MIT mirror + community fork are the
   supported path), and **MOSS-TTSD-8B** (Apache 2.0, actively maintained,
   overlapping speech, cloning shared with a realtime sibling) is the
   designated A/B challenger once episodes are flowing.
4. **Google AI API key is approved** and stored encrypted server-side (same
   AES-256-GCM path as the Anthropic key) — TTS jobs run async on the server,
   so browser-localStorage keys don't work for this.
5. **Settings gets a unified "connections" redesign** — every key/credential in
   one section, one card pattern, plain-language "what this powers".
6. **Voice interaction is a fenced future direction** (not a milestone here).
   Research settled the architecture: cascade (local STT → Claude + tools →
   local streaming TTS); native speech-to-speech models cannot use Claude as
   their brain. We only lay groundwork (see "Voice-later" section).

## Research summary (key numbers)

**NotebookLM** (what we mirror): notebooks → sources → grounded chat with
click-to-passage citations (the trust loop, universally ranked the killer
feature) → studio artifacts. Limits for shape reference: 50 sources/notebook,
500k words/source, per-query source-subset toggle. Audio Overviews: the viral
feature; two hosts, ~10 min default. Skipped as gimmicks: video overviews,
infographics, slide decks, sharing.

**PDF→markdown**: Claude API ingests PDFs natively (~2,300 tokens/page, 32 MB
/request; split large PDFs with `pdf-lib`, probe scanned-vs-text with `unpdf` —
both pure-JS). Local: **MinerU 3.x hybrid** (1.2B VLM, huge headroom on 16 GB,
OmniDocBench ≈ 95 with best-in-class LaTeX/tables; WSL2 + vLLM). Runner-up if
WSL2 ever annoys: Marker + Surya 2 via native-Windows llama.cpp. Vercel
constraints: 4.5 MB body limit → client uploads go direct to Supabase Storage;
fluid compute allows 800 s functions.

**Audio**: every NotebookLM clone is the same two-stage pipeline — LLM writes a
two-host dialogue script (where ~90% of the quality lives), TTS renders it.
Hosted: Gemini Flash TTS is the only one with native 2-speaker dialogue in a
single request (≈$0.18/12-min episode; returns PCM → 20-line JS WAV wrapper, no
ffmpeg on Vercel). ElevenLabs v3 dialogue ($1–2) is the quality escape hatch.
Local: **VibeVoice-Large** (9B; Q8 ≈ 12 GB, BF16 does NOT fit 16 GB) remains
the English two-host quality reference — one pass, consistent voices, native
Windows CUDA via the ComfyUI node; community consensus says quantized-Large ≫
full-precision-1.5B (which injects random chimes). Known caveats: official
weights pulled Sept 2025 (use the MIT `aoi-ot` mirror + `vibevoice-community`
fork), occasional background-music hallucination, EN/ZH only, no overlapping
speech. Challenger: the **MOSS-TTS family** (Apache 2.0, releases through Jun
2026) — MOSS-TTSD-8B podcasts with 1–5 speakers incl. overlap, ~60-min
coherence, 20 languages, and one reference clip shared with its realtime
sibling; needs quant/GGUF on 16 GB and lacks a public English head-to-head vs
VibeVoice, hence A/B later rather than default now. Script craft: expert host + curious host,
prompted disfluencies, one em-dash interruption, one resolved disagreement,
1,900–2,200 words ≈ 13 min, outline-first past ~8 min, strict source grounding,
output as typed JSON `[{speaker, text}]` reformattable per engine (VibeVoice
takes plain `Speaker 1:` lines, no bracket tags; Gemini takes a style preamble
+ named lines).

**Voice-later (fenced)**: Anthropic has no voice API → cascade is the only
Claude-brained path, and it's the practitioner consensus for tool-calling
assistants anyway. 16 GB stack with verified numbers: NVIDIA
nemotron-3.5-asr-streaming-0.6b or parakeet-unified (STT, ~2–3 GB, 80–160 ms
chunks) → Claude (TTFT dominates) → **Kokoro-82M via Kokoro-FastAPI** (TTS,
~300 ms first audio, ~1–3 GB, Apache 2.0, easiest Windows Docker install);
expressive upgrade path Qwen3-TTS-1.7B (Apache 2.0, incremental text-in).
Orchestration when we get there: Speaches (OpenAI-compatible STT/TTS server) for
push-to-talk v1, Pipecat/LiveKit Agents (both have first-party Anthropic
plugins) for true barge-in. iPhone-away reality: Tailscale direct or a managed
WebRTC edge; iOS PWA voice is foreground/tap-to-talk only. Batch bonus:
Parakeet v3 transcribes a 2 h lecture recording in under a minute — a future
`/learn` source type.

## Architecture

### Data model (new migration)

- `courses` — id, user_id, name, code, term, color, archived, created_at.
- `course_sources` — id, user_id, course_id, title, kind
  (`pdf`/`markdown`/`text`/`url`), storage_path (nullable — original file),
  vault_path (nullable — set on commit), status (`registered`/`uploaded`/
  `queued`/`converting`/`converted`/`failed`), page_count, error, created_at.
- `course_source_parts` — staging for chunked MCP upload: source_id,
  part_index, markdown; deleted after finalize.
- `jobs` — id, user_id, kind (`ocr`/`tts`), payload jsonb, status (`queued`/
  `processing`/`done`/`failed`), attempts, claimed_at, heartbeat_at, error,
  result jsonb, created_at. Claimed via a `claim_next_job()` SQL function using
  `FOR UPDATE SKIP LOCKED` with stale-heartbeat reclaim; `attempts >= 3` →
  failed (poison-job dead-letter).
- `worker_status` — single heartbeat row per user: last_seen_at, info jsonb.
- `audio_episodes` — id, user_id, course_id, title, source_ids uuid[], engine
  (`gemini`/`vibevoice`), flavor (`deep-dive`/`brief`/`debate`), status,
  duration_sec, storage_path, script jsonb, error, created_at.
- `user_settings.google_ai_api_key` — encrypted, nullable (0015 pattern).

All RLS user-scoped. Two new **private** buckets: `course-files` (originals;
client uploads direct to Storage — never through a route handler) and
`course-audio` (episodes; served via signed URLs).

### Vault layout (`Courses/` fence)

```
Courses/
  <Course Name>/
    <Course Name>.md          ← index note: [[links]] to sources + artifacts
    Sources/<source title>.md ← converted markdown, <!-- p.N --> page anchors
    Study Guide.md, FAQ.md, … ← generated artifacts (L5)
```

The vault writer extends `app/lib/mcp/capture.ts`'s proven create-only GitHub
PUT (collision retry, no `sha`, never updates) with a second allowed fence:
`Courses/`. Same structural propose→confirm exception as `Inbox/`: it cannot
touch Mindboard data, is create-only by construction, and the vault review
flow is the confirmation. Conversion prompt contract (all three paths): GFM,
`$…$`/`$$…$$` LaTeX, markdown tables, `<!-- p.N -->` page anchors, faithful
transcription — never summarize.

### Ingestion paths

**Path 1 — chat-AI over MCP (default).** New MCP tools (also in the assistant
catalog): `begin_source_upload` (course ref, title, page_count → source id) →
`append_source_markdown` (source id, part_index, ≤20k chars — the
`capture_to_brain` cap discipline; a 50-page transcript is ~100–200 KB and no
single tool call carries that) → `finalize_source` (assembles parts in order,
validates contiguity, commits to vault, updates the row). Tool descriptions
steer the calling model: "transcribe pages N–M verbatim…". The original PDF is
attached in-app afterward (row shows `awaiting original`) or the source stays
markdown-only. A matching how-to note ships into the vault so every Claude
surface knows the workflow.

**Path 2 — home worker (MinerU).** In-app "convert on home PC" queues an `ocr`
job. Worker downloads the PDF via signed URL, runs `mineru -b hybrid`, uploads
markdown (+ extracted figure images into `course-files`), commits to the vault,
marks done.

**Path 3 — Claude API (fallback button).** `unpdf` triage (page count,
scanned-vs-text) → `pdf-lib` ~20-page slices → Messages API per slice on the
stored key (document block, model pickable: Sonnet default / Haiku cheap) →
stitch on 1-page overlap → vault commit. Only new deps: `unpdf`, `pdf-lib`.

### Audio overview pipeline

1. **Script (always Claude, stored key):** selected sources' markdown → outline
   pass (if >8 min) → dialogue pass with the naturalness directives → typed
   JSON script persisted on the episode row (regenerate voices without paying
   for a new script).
2. **Voices (per-episode engine choice):**
   - `gemini`: one `generateContent` call with `multiSpeakerVoiceConfig`, PCM →
     WAV in JS, upload to `course-audio`. Runs in a route handler
     (`maxDuration` raised; well under fluid-compute limits).
   - `vibevoice`: queue a `tts` job; worker renders via VibeVoice-Large 4/8-bit
     (plain `Speaker 1:` lines), encodes MP3 with local ffmpeg, uploads, marks
     done. Jobs run serially so OCR and TTS never contend for VRAM.
3. **Playback:** episode list per course with `<audio>` player (signed URL),
   duration, engine badge, and a download for offline. `generate_audio_overview`
   MCP tool lets any chat surface request an episode (propose → confirm, since
   it spends money/compute and writes app data).

### The worker (one Windows service, two superpowers)

Pull-based; zero inbound ports; no tunnels. A small daemon on the PC (WSL2)
polls `claim_next_job()` every ~30 s via a **dedicated named secret key**
(`sb_secret_…`, independently revocable; legacy service-role JWTs are
deprecated end of 2026), with Supabase Realtime as an instant wake-up hint
(poll remains the source of truth — Realtime delivery isn't guaranteed).
Heartbeats every 30–60 s while processing and into `worker_status` while idle.
Failure UX: PC off → job waits, UI shows "queued — home worker offline" +
queue position; crash → stale-heartbeat reclaim; 3 strikes → failed with error
and a "run in cloud instead" button that flips the same job to the hosted path.

Setup (owner, one evening): WSL2 Ubuntu → `uv pip install "mineru[all]"` →
ComfyUI + VibeVoice node (4-bit) → the worker daemon (Node or Python, lives in
this repo under `worker/`) → auto-start via WSL2 systemd.

### Settings redesign — "connections"

Today keys are scattered and inconsistent: Anthropic under "copilot"
(encrypted DB), GitHub PAT under "brain vault" (DB), OpenAI/Google image keys
inside "appearance" (localStorage-only). Redesign: one **connections** section
on `/settings`, one `ConnectionCard` component per credential:

- **Header row:** provider name · status dot (`connected` / `not set` /
  `error`) · key fingerprint (`…x4Kd`) when connected.
- **"Powers" line** in plain language, e.g. anthropic → "planning copilot ·
  PDF conversion · podcast scripts · stock capture"; google ai → "podcast
  voices · icon generation"; github vault → "brain notes · course files";
  home worker → "free PDF conversion · free podcast voices" (status-only card:
  last-seen heartbeat + setup guide link, nothing to paste).
- **Storage note** per card ("encrypted, server-side only, never sent to the
  browser") and an expandable edit body: masked input + show/hide, save /
  replace / remove, verify-on-save (each provider gets a cheap test call —
  the vault form already does this against `GET /repos`).
- **Migration:** image-gen keys move from localStorage to encrypted
  `user_settings` columns so every key follows one model (one-time re-paste;
  icon-gen server action reads server-side thereafter). The old
  appearance-panel key UI is removed.

## Milestones

| # | What | Gate |
|---|---|---|
| **L0** | Migration + `/learn` route (course CRUD, source list, direct-to-storage upload) + **connections redesign** (incl. encrypted `google_ai_api_key`) | Courses visible on phone; all keys managed in one section |
| **L1** | Ingestion: chunked MCP tools + `Courses/` vault writer + Claude-API converter | Drag a PDF into claude.ai → "add to my course" → note appears in `/brain`; in-app convert button works |
| **L2** | **Audio overviews, hosted**: script gen + Gemini TTS + episodes UI + `generate_audio_overview` MCP tool | Pick a course on the phone → episode playing < 2 min later |
| **L3** | **Worker**: jobs/claim/heartbeat migration + WSL2 daemon (MinerU `ocr` + VibeVoice `tts`) + engine picker + offline/fallback UX | PC renders an episode overnight for $0; PDF converts in ~2 min free |
| **L4** | Grounded chat: per-course chat (reuses `/plan` machinery) over converted markdown with Claude citations API, source toggles, citation chips → `/brain` deep links | Ask a question, tap a citation, land on the passage |
| **L5** | Study artifacts: study guide / FAQ / briefing / timeline as vault notes; flashcards + quiz with progress (`course_cards`) and cited "explain" | |
| **L6** | Extras (each optional): course mind map (reuse force-graph), cross-course chat, episode flavors, lecture-audio transcription via worker (Parakeet v3), podcast-engine A/B (MOSS-TTSD vs VibeVoice) | |

Audio lands at L2 (hosted, zero worker infrastructure) so episodes exist before
the worker does; L3 then makes them free.

## Voice-later groundwork (fenced: only if Lucca opens it)

Decisions already banked by this plan that make voice cheap later: the worker
daemon + jobs pattern (a voice session server is "just" another long-lived
process on the same PC), the encrypted multi-provider key section, and Kokoro
(~1–3 GB) fitting beside MinerU/VibeVoice. **One-voice option:** no single
local model does both long-form podcasts and sub-500 ms conversation; the
bridge is a shared 5–15 s reference clip. If the podcast engine A/B lands on
MOSS-TTSD, its realtime sibling (MOSS-TTS-Realtime-1.7B, ~180 ms TTFB, same
cloning workflow) can give the assistant the same voice as the podcast hosts. First voice milestone when opened:
push-to-talk in the PWA → Speaches (faster-whisper + Kokoro) over
`tailscale serve` → the existing `/api/assistant` loop, sentence-chunked into
TTS. Not before: barge-in/duplex (Pipecat/LiveKit), wake words (iOS PWA can't),
in-browser WebGPU STT on iPhone (transformers.js still crashes on iOS Safari).

## Cost picture (typical month: 8 PDFs converted, 10 episodes, chat)

| Item | Chat-AI path | Worker path | API path |
|---|---|---|---|
| PDF→markdown (50 p) | subscription tokens | $0 | ~$1.10 Sonnet / ~$0.35 Haiku |
| Episode script | — (API: ~$0.05–0.15) | same | same |
| Episode voices | — | $0 (VibeVoice) | ~$0.18 (Gemini) |
| Grounded chat | — | — | pennies/question (markdown, not PDF, in context) |

## Implementation log — L0–L5 (2026-07-08)

All six milestones shipped in one session. Verified: `npm run lint` clean,
`npm run test` 415 pass (+42 new across course-ops / convert-plan /
podcast-script), `npm run build` green with `/learn`, `/learn/[id]/chat`,
`/learn/[id]/study`, `/api/course-chat`, `/api/worker` registered.
Migrations 0024/0026/0027/0028 are applied to the live DB (0025 belongs to a
concurrent onboarding session working in the same tree).

**Shipped, by milestone:**

- **L0** — migration 0024 (`courses`, `course_sources`, `course_source_parts`,
  `user_settings.google_ai_api_key`/`openai_api_key`, private `course-files`
  bucket with own-folder policies); `/learn` (course CRUD + ColorPicker,
  per-course source list, browser→storage direct PDF upload keyed
  `{user}/{source}/`); Dock ≡ sheet gains `learn`. **Connections redesign**:
  `ConnectionShell`/`KeyConnectionCard` (status dot · last-4 hint · "powers"
  line · storage note · verify-on-save), one `saveProviderKey` write path
  (shape check + one live provider call + AES-GCM encrypt); the old copilot
  key form and appearance-panel image keys are gone — icon-gen keys moved
  server-side (`generateItemIcon` reads `readProviderKey`; localStorage keeps
  only provider/model prefs; one-time re-paste needed).
- **L1** — the create-only PUT loop was extracted to
  `createVaultFileWithRetry` (capture.ts, 35 tests still green) and reused by
  the `Courses/<course>/Sources/<title>.md` writer. MCP + assistant tools:
  `list_courses`, `begin_source_upload` (new source, or `source_id` to fill an
  uploaded PDF), `append_source_markdown` (1-based contiguous parts ≤20k
  chars), `finalize_source` (assemble → vault → row). Claude-API converter:
  `unpdf` probe → `pdf-lib` ~20-page slices with 1-page overlap → per-slice
  document-block calls (sonnet/haiku/opus picker) → anchor-based overlap
  trim → vault. Pure logic unit-tested (`course-ops`, `convert-plan`).
- **L2** — migration 0026 (`audio_episodes` + private `course-audio`);
  `podcast-script.ts` (typed `[{speaker,text}]` script contract, flavor specs,
  naturalness directives, per-engine renderings) + `pcmToWav`; pipeline:
  vault markdown → Claude forced-tool script → Gemini Flash TTS
  (one multi-speaker request, PCM→WAV in JS) → storage → `<audio>` player
  with signed URLs in `/learn`. MCP `generate_audio_overview` is
  **propose → confirm** (it spends money); in-app the tap is the confirmation.
- **L3** — migration 0027 (`jobs`, `worker_status`, `claim_next_job()` with
  FOR UPDATE SKIP LOCKED + 10-min stale-heartbeat reclaim + 3-attempt
  dead-letter, execute revoked from client roles). **Design deviation from
  the plan, deliberate:** the worker holds no database key — it polls
  `POST /api/worker` (bearer = `MCP_BEARER_TOKEN`, constant-time compare) for
  claim/heartbeat/complete/fail; PDFs come down via signed URLs, audio goes
  up via signed upload URLs (never through Vercel's 4.5 MB limit), and ALL
  vault/Postgres finalization stays in the app's TypeScript. `worker/worker.py`
  (stdlib-only) + `worker/README.md` (WSL2 + MinerU + VibeVoice setup,
  systemd unit). VibeVoice engine live end-to-end: script on Vercel → `tts`
  job → worker renders → episode done. Settings worker card shows
  online/idle/queue-depth from the heartbeat.
- **L4** — `/api/course-chat`: selected sources ride as citation-enabled text
  documents (`citations:{enabled:true}`, cache_control on the last block),
  system prompt pins answers to the sources; SSE streams text deltas, then a
  flattened numbered citation list (passage quote + `noteHref` deep link into
  `/brain`). `/learn/[id]/chat`: source-toggle chips, mono transcript,
  citation chips with expandable quoted passages. Ephemeral transcript (v1);
  persistence via `ai_conversations` is a later nicety.
- **L5** — migration 0028 (`course_cards` with got/miss counts);
  `artifacts.ts`: study guide / FAQ / briefing / timeline generators → vault
  notes under `Courses/<course>/<Label>.md` (`type: course-artifact`
  frontmatter), and forced-tool flashcard generation with grounded `explain`.
  `/learn/[id]/study`: shuffled deck, reveal → got-it/missed-it (persisted),
  retest-missed, weak-cards deck, drop card, "+20 cards", artifact generator
  with an "open in /brain →" link.

**Owner-gated (can't be done from this session):**

1. Paste the **Google AI key** in settings → connections (Gemini TTS +
   icon gen). Re-paste the OpenAI key there too if icon generation on
   OpenAI is still wanted (the localStorage copy is no longer read).
2. **Worker setup** on the PC per `worker/README.md` (WSL2 → MinerU →
   VibeVoice quant → `worker.py` with `MINDBOARD_URL` + `WORKER_TOKEN`).
3. Deploy: push to `main`; no new Vercel env vars are required
   (`MCP_BEARER_TOKEN`, `ASSISTANT_KEY_SECRET`, service key already set).
4. Toggle the claude.ai Mindboard connector off/on so it re-fetches the five
   new tools; then the phone check: create a course → upload a PDF →
   convert → generate an episode → play it.

**Post-ship additions (2026-07-08, same day):** Option B worker installed and
verified end-to-end on the PC (Marker OCR + ComfyUI VibeVoice via
`worker/render_vibevoice.py`; full-precision Large hardlinked from the HF
cache, LLM-only 8-bit, reference-anchored voices — the pre-quantized-4bit
first attempt sounded eerie and is kept only as fallback). Owner's cloned
voice (`exurb1a.wav` in ComfyUI input, `COMFY_VOICE_1`) is the default host.
Migration 0029 adds the **solo** flavor: single-narrator lecture episodes,
solo-aware script prompt and Gemini `voiceConfig` (multi-speaker config
requires exactly two speakers).

**Notes / deferred:** episode "generating…" blocks the button for ~2 min
(fine for v1; a background poll would be nicer); chat transcripts are
ephemeral; the course index note (`Courses/<course>/<course>.md`) is not
auto-written yet; L6 extras (mind map, cross-course chat, MOSS-TTSD A/B,
lecture-audio transcription) remain open by design.

## Out of scope

Video overviews, infographics, slide decks, sharing/multi-user, NotebookLM-style
source discovery, pgvector/RAG (source-subset selection is the context strategy,
honoring the cancelled Phase 3), audio episode editing, voice interaction (fenced
above), Anthropic-key-free operation.
