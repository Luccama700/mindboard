# Mindboard home worker

The always-on PC's job runner: free PDF→markdown conversion (MinerU) and free
podcast rendering (VibeVoice) for `/learn`, and reel transcription (yt-dlp +
whisper + a local VLM) for the second brain. Pull-based — it polls the app's
`/api/worker` endpoint with a bearer token, so **no inbound ports, no tunnels,
and no database key on this machine**. If the PC is off, jobs simply wait in
the queue; the settings → connections card shows online/offline from the
worker's heartbeat.

Two setup options. **A (WSL2 + MinerU + VibeVoice)** is the max-quality pick —
best formulas/tables in class. **B (fully native Windows, no WSL2/Ubuntu)**
trades a little scanned-math fidelity for a friendlier install. The worker
doesn't care which you pick: the OCR/TTS invocations are env-var command
templates, so switching later means changing two variables, not code.
(Ollama specifically fits neither job: it can serve a vision model but not a
PDF *pipeline* — layout, reading order, tables, LaTeX — and llama.cpp has no
audio output, so no VibeVoice.)

## Option A — one-time setup (Windows 11 → WSL2)

1. **WSL2** (PowerShell as admin): `wsl --install -d Ubuntu`, reboot, open
   Ubuntu. The NVIDIA Windows driver passes CUDA through automatically — do
   not install a Linux driver inside WSL.
2. **MinerU** (PDF→markdown, ~1–3 min per 50-page deck on a 16 GB card):

   ```bash
   sudo apt update && sudo apt install -y python3-pip ffmpeg
   pip install uv
   uv pip install --system -U "mineru[all]"
   mineru --version   # first run downloads the 1.2B model
   ```

3. **VibeVoice-Large quantized** (podcast voices, ~20–45 min per episode):
   use the community fork + a low-VRAM quant so it fits 16 GB:

   ```bash
   git clone https://github.com/vibevoice-community/VibeVoice /opt/VibeVoice
   cd /opt/VibeVoice && pip install -e .
   # weights: aoi-ot/VibeVoice-Large mirror (or DevParker/VibeVoice7b-low-vram
   # for ready-made Q8/nf4) via `huggingface-cli download`
   ```

   Then set `VIBEVOICE_CMD` to whatever invocation renders a
   `Speaker 1:`/`Speaker 2:` text file to a wav on your install, e.g.:

   ```bash
   export VIBEVOICE_CMD='python /opt/VibeVoice/demo/inference_from_file.py --model_path /models/VibeVoice-Large --txt_path {text} --output_path {wav}'
   ```

   The `{text}` and `{wav}` placeholders are filled by the worker. TTS jobs
   fail with a clear message until this is set — OCR works without it.

3b. **Reel capture** (optional; `docs/reel-capture-plan.md`) — transcribe +
   describe Instagram reels the user shares into the vault. Three pieces:

   ```bash
   # download + transcription (ffmpeg is already installed):
   pip install -U yt-dlp
   pip install -U whisper-ctranslate2      # or any whisper CLI

   # visuals (frame description + on-screen-text OCR) via a local VLM.
   # Qwen3-VL is the current best fit for reels — strong OCR on stylized
   # overlays, ~6 GB at Q4, and Ollama unloads it between jobs:
   ollama pull qwen3-vl:8b                  # or qwen3-vl:4b on tighter VRAM
   ```

   Env the worker reads (all have defaults):

   ```bash
   # WHISPER_CMD is REQUIRED for reel jobs (like VIBEVOICE_CMD for TTS).
   # {audio} and {out} are filled; the worker reads the largest .txt in {out}.
   export WHISPER_CMD='whisper-ctranslate2 {audio} --model large-v3 --output_format txt --output_dir {out}'
   export YTDLP_CMD='yt-dlp --no-playlist --no-warnings --write-info-json -o {out}/reel.%(ext)s {url}'
   export VISION_MODEL='qwen3-vl:8b'        # "" → transcript only, no visuals
   export OLLAMA_URL='http://localhost:11434'
   export REEL_MAX_FRAMES=10
   ```

   Transcript is the core deliverable (fails clearly without `WHISPER_CMD`);
   visuals are additive and skipped when `VISION_MODEL` is empty or Ollama
   isn't reachable. Private-account reels that yt-dlp can't fetch fail the job
   with a clear message — no Instagram login is ever used.

4. **The worker itself** (pure stdlib, Python ≥ 3.10):

   ```bash
   export MINDBOARD_URL=https://<your-vercel-domain>
   export WORKER_TOKEN=<MCP_BEARER_TOKEN from Vercel env>
   python3 worker/worker.py
   ```

5. **Run at boot**: enable WSL systemd (`/etc/wsl.conf` → `[boot]
   systemd=true`), then install a unit:

   ```ini
   # /etc/systemd/system/mindboard-worker.service
   [Unit]
   Description=Mindboard home worker
   After=network-online.target

   [Service]
   Environment=MINDBOARD_URL=https://<domain>
   Environment=WORKER_TOKEN=<token>
   Environment=VIBEVOICE_CMD=<command with {text} {wav}>
   ExecStart=/usr/bin/python3 /path/to/mindboard/worker/worker.py
   Restart=always
   RestartSec=30

   [Install]
   WantedBy=multi-user.target
   ```

   `sudo systemctl enable --now mindboard-worker`. Keep Windows from
   sleeping (Settings → Power → never sleep when plugged in).

## Option B — fully native Windows (no WSL2) — **installed 2026-07-08**

This is the configured setup on the current PC. Components:

1. **OCR: Marker + Surya 2** — `pip install marker-pdf` into the system
   Python (Store Python puts `marker_single.exe` in
   `%LOCALAPPDATA%\Packages\...\LocalCache\local-packages\Python313\Scripts`,
   which is off-PATH — `MINERU_CMD` uses the full path). First run downloads
   the Surya models (~2 GB). The variable is still called MINERU_CMD — it's
   just "the OCR command":

   ```
   MINERU_CMD = "<full path>\marker_single.exe" {pdf} --output_dir {outdir}
   ```

2. **TTS: VibeVoice via ComfyUI Desktop** — the Enemyx-net
   **VibeVoice-ComfyUI** node in `custom_nodes` (its requirements installed
   into the Desktop app's real env at `ComfyUI\ComfyUI\.venv`, NOT
   `standalone-env`; note the node pins `transformers<5`), plus:
   - weights: `models/vibevoice/VibeVoice-Large-4bit/` (DevParker Q4 quant,
     ~6.3 GB — fits the 16 GB card with headroom);
   - the Qwen2.5-1.5B tokenizer files in `models/vibevoice/tokenizer/`
     (required by the node, downloaded separately).

   Headless rendering goes through **`worker/render_vibevoice.py`** (run
   under the ComfyUI venv python): it reuses a running ComfyUI (Desktop app
   on :8000, or headless :8188), boots its own headless server if none is up,
   converts the script's `Speaker N:` lines to the node's `[N]:` format,
   submits a MultipleSpeakers→SaveAudio workflow over the API, and converts
   the FLAC output to WAV.

   ```
   VIBEVOICE_CMD = "<ComfyUI .venv python>" "<repo>\worker\render_vibevoice.py" --text {text} --out {wav}
   ```

3. **Env vars** are set at user level (`MINDBOARD_URL`, `MINERU_CMD`,
   `VIBEVOICE_CMD`). `WORKER_TOKEN` must be set manually to the value of
   `MCP_BEARER_TOKEN` from Vercel → project → Settings → Environment
   Variables:

   ```powershell
   [Environment]::SetEnvironmentVariable('WORKER_TOKEN', '<paste>', 'User')
   ```

4. **Run the worker**: `python worker\worker.py` (new terminal so it sees
   the env vars).
5. **Run at boot**: Task Scheduler → Create Task → trigger "At log on",
   action `pythonw.exe C:\path\to\worker\worker.py`. Keep Windows from
   sleeping (Settings → Power → never sleep when plugged in).

## How it behaves

- Polls every 30 s; drains the queue before sleeping again.
- Heartbeats every 30 s while processing; if the process dies mid-job, the
  app reclaims the job after 10 minutes of silence. Three failed attempts
  dead-letter it and surface the error on the source/episode in `/learn`.
- OCR: downloads the PDF via a short-lived signed URL, runs MinerU hybrid,
  posts the markdown back; the app writes the vault note.
- TTS: receives the episode's speaker-tagged script, renders with VibeVoice,
  PUTs the wav straight to storage via a signed upload URL (never through
  the app), then reports the duration.
