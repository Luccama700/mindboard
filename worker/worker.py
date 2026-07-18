#!/usr/bin/env python3
"""Mindboard home worker.

Pulls jobs from the Vercel app over HTTPS (no database key on this machine):

    claim -> run MinerU (ocr) or VibeVoice (tts) -> complete/fail

Auth is a single bearer token (the app's MCP_BEARER_TOKEN). Audio results are
PUT directly to a Supabase signed upload URL; markdown returns in the
complete body. See worker/README.md for WSL2 setup.

Env:
  MINDBOARD_URL      e.g. https://mindboard.example.com
  WORKER_TOKEN       the MCP_BEARER_TOKEN value
  MINERU_CMD         default: mineru -p {pdf} -o {outdir} -b hybrid
  VIBEVOICE_CMD      e.g. python /opt/VibeVoice/demo/inference_from_file.py \
                       --model_path /models/VibeVoice-Large-Q8 \
                       --txt_path {text} --output_path {wav} --speaker_names Ava Ben
  WORKER_POLL_SECONDS  default 30
"""

import base64
import json
import os
import platform
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

APP_URL = os.environ.get("MINDBOARD_URL", "").rstrip("/")
TOKEN = os.environ.get("WORKER_TOKEN", "")
MINERU_CMD = os.environ.get("MINERU_CMD", "mineru -p {pdf} -o {outdir} -b hybrid")
VIBEVOICE_CMD = os.environ.get("VIBEVOICE_CMD", "")
POLL_SECONDS = int(os.environ.get("WORKER_POLL_SECONDS", "30"))
HEARTBEAT_SECONDS = 30

# --- Reel capture (docs/reel-capture-plan.md) ---
# yt-dlp download + whisper transcript are command templates (file in/out,
# like MINERU_CMD). Vision (frame describe + OCR) runs through a local Ollama
# VLM over HTTP — set VISION_MODEL empty to skip visuals and keep transcripts.
FFMPEG = os.environ.get("FFMPEG", "ffmpeg")
YTDLP_CMD = os.environ.get(
    "YTDLP_CMD",
    "yt-dlp --no-playlist --no-warnings --write-info-json -o {out}/reel.%(ext)s {url}",
)
# Transcript is the reel's core deliverable — required for reel jobs.
WHISPER_CMD = os.environ.get(
    "WHISPER_CMD",
    "whisper-ctranslate2 {audio} --model large-v3 --output_format txt --output_dir {out}",
)
VISION_MODEL = os.environ.get("VISION_MODEL", "qwen3-vl:8b")  # "" disables visuals
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434").rstrip("/")
REEL_MAX_FRAMES = int(os.environ.get("REEL_MAX_FRAMES", "10"))


def log(message: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {message}", flush=True)


def api(body: dict) -> dict:
    request = urllib.request.Request(
        f"{APP_URL}/api/worker",
        data=json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        return json.loads(response.read().decode())


def download(url: str, dest: Path) -> None:
    with urllib.request.urlopen(url, timeout=600) as response:
        dest.write_bytes(response.read())


def upload_put(url: str, data: bytes, content_type: str) -> None:
    request = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": content_type, "x-upsert": "true"},
        method="PUT",
    )
    with urllib.request.urlopen(request, timeout=1800) as response:
        response.read()


def run_command(template: str, timeout: int | None = None, **paths: str) -> None:
    command = template.format(**paths)
    log(f"  $ {command}")
    # A timeout keeps a stuck child (a hung download/transcode) from blocking
    # the single-worker queue forever; the killed child surfaces as a
    # retryable failure. subprocess.run terminates the child on timeout.
    subprocess.run(command, shell=True, check=True, timeout=timeout)


def wav_duration_seconds(path: Path) -> int:
    with path.open("rb") as f:
        header = f.read(44)
    if len(header) < 44 or header[:4] != b"RIFF":
        return 0
    byte_rate = struct.unpack("<I", header[28:32])[0]
    data_size = path.stat().st_size - 44
    return int(data_size / byte_rate) if byte_rate else 0


def heartbeat_loop(job_id: str, stop: threading.Event) -> None:
    while not stop.wait(HEARTBEAT_SECONDS):
        try:
            api({"op": "heartbeat", "job_id": job_id})
        except Exception as error:  # noqa: BLE001 — heartbeats must never kill the job
            log(f"  heartbeat failed: {error}")


def handle_ocr(claim: dict, workdir: Path) -> dict:
    pdf = workdir / "input.pdf"
    outdir = workdir / "out"
    outdir.mkdir()
    log(f"  downloading {claim['source']['title']}…")
    download(claim["download_url"], pdf)

    run_command(MINERU_CMD, pdf=str(pdf), outdir=str(outdir))

    candidates = sorted(
        outdir.rglob("*.md"), key=lambda p: p.stat().st_size, reverse=True
    )
    if not candidates:
        raise RuntimeError("mineru produced no markdown output")
    markdown = candidates[0].read_text(encoding="utf-8")
    if not markdown.strip():
        raise RuntimeError("mineru produced empty markdown")
    return {"markdown": markdown}


def handle_tts(claim: dict, workdir: Path) -> dict:
    if not VIBEVOICE_CMD:
        raise RuntimeError("VIBEVOICE_CMD is not configured on this worker")

    text_file = workdir / "script.txt"
    wav_file = workdir / "episode.wav"
    text_file.write_text(claim["episode"]["text"], encoding="utf-8")
    log(f"  rendering \"{claim['episode']['title']}\" (this can take a while)…")

    run_command(VIBEVOICE_CMD, text=str(text_file), wav=str(wav_file))

    if not wav_file.exists() or wav_file.stat().st_size < 1000:
        raise RuntimeError("vibevoice produced no audio")

    log("  uploading audio…")
    upload_put(claim["upload_url"], wav_file.read_bytes(), "audio/wav")
    return {"duration_sec": wav_duration_seconds(wav_file)}


def ollama_describe(image_path: Path) -> dict:
    """Ask the local VLM to describe a keyframe and read its on-screen text.
    Returns {'describe': str, 'text': str}; empty dict on any failure so one
    bad frame never sinks the job."""
    prompt = (
        "This is one frame from a short vertical video (an Instagram reel). "
        "Reply with ONLY a JSON object: "
        '{"describe": "<one sentence on what is happening visually>", '
        '"text": "<all on-screen/overlay text, verbatim; empty string if none>"}'
    )
    body = json.dumps(
        {
            "model": VISION_MODEL,
            "prompt": prompt,
            "images": [base64.b64encode(image_path.read_bytes()).decode()],
            "stream": False,
            "format": "json",
            "keep_alive": "30s",  # unload between jobs to free VRAM
        }
    ).encode()
    try:
        request = urllib.request.Request(
            f"{OLLAMA_URL}/api/generate",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=180) as response:
            payload = json.loads(response.read().decode())
        parsed = json.loads(payload.get("response", "{}"))
        return {
            "describe": str(parsed.get("describe", "")).strip(),
            "text": str(parsed.get("text", "")).strip(),
        }
    except Exception as error:  # noqa: BLE001 — visuals are best-effort
        log(f"    vision frame failed: {str(error)[:120]}")
        return {}


def handle_reel(claim: dict, workdir: Path) -> dict:
    if not WHISPER_CMD:
        raise RuntimeError("WHISPER_CMD is not configured on this worker")
    reel = claim["reel"]
    url = reel["url"]
    outdir = workdir / "out"
    outdir.mkdir()
    log(f"  downloading reel {reel.get('shortcode', '')}…")
    run_command(YTDLP_CMD, timeout=300, out=str(outdir), url=url)

    videos = [
        p for p in outdir.iterdir()
        if p.suffix.lower() in (".mp4", ".mkv", ".webm", ".mov")
    ]
    if not videos:
        raise RuntimeError("yt-dlp downloaded no video (private or unavailable reel?)")
    video = videos[0]

    # Metadata from yt-dlp's info json (caption = the post's description).
    title = author = caption = ""
    duration_sec = 0
    info_files = list(outdir.glob("*.info.json"))
    if info_files:
        try:
            info = json.loads(info_files[0].read_text(encoding="utf-8"))
            caption = str(info.get("description") or "").strip()
            author = str(info.get("uploader") or info.get("channel") or "").strip()
            duration_sec = int(info.get("duration") or 0)
            title = str(info.get("title") or "").strip()
        except Exception:  # noqa: BLE001
            pass

    # Audio -> transcript (the core deliverable).
    audio = workdir / "audio.wav"
    run_command(
        FFMPEG + " -y -i {video} -vn -ac 1 -ar 16000 {audio}",
        timeout=300,
        video=str(video),
        audio=str(audio),
    )
    log("  transcribing…")
    run_command(WHISPER_CMD, timeout=1800, audio=str(audio), out=str(outdir))
    txts = sorted(outdir.glob("*.txt"), key=lambda p: p.stat().st_size, reverse=True)
    transcript = txts[0].read_text(encoding="utf-8").strip() if txts else ""

    # Keyframes are ADDITIVE: a valid transcript already exists, so a
    # frame-extraction failure (odd codec, filter, platform quirk) must never
    # sink the job — fall back, then give up on visuals and ship transcript-only.
    frames_dir = workdir / "frames"
    frames_dir.mkdir()
    frame_files: list[Path] = []
    try:
        run_command(
            FFMPEG + " -y -i {video} -vf select='gt(scene\\,0.3)',scale=512:-1 "
            "-vsync vfr -frames:v {n} {frames}/f%03d.jpg",
            timeout=300,
            video=str(video),
            n=str(REEL_MAX_FRAMES),
            frames=str(frames_dir),
        )
        frame_files = sorted(frames_dir.glob("*.jpg"))
        if not frame_files:  # static/short reel: no scene changes — sample evenly
            run_command(
                FFMPEG + " -y -i {video} -vf fps=1/2,scale=512:-1 -frames:v {n} {frames}/f%03d.jpg",
                timeout=300,
                video=str(video),
                n=str(REEL_MAX_FRAMES),
                frames=str(frames_dir),
            )
            frame_files = sorted(frames_dir.glob("*.jpg"))
    except Exception as error:  # noqa: BLE001 — visuals are best-effort
        log(f"  keyframe extraction failed, continuing transcript-only: {str(error)[:120]}")
        frame_files = sorted(frames_dir.glob("*.jpg"))

    frames: list[dict] = []
    if VISION_MODEL and frame_files:
        log(f"  reading {len(frame_files)} frame(s) with {VISION_MODEL}…")
        for index, frame in enumerate(frame_files, start=1):
            described = ollama_describe(frame)
            if described.get("describe") or described.get("text"):
                frames.append({"at": f"frame {index}", **described})

    result: dict = {
        "title": (title or (caption.split("\n")[0][:80] if caption else ""))[:120],
        "caption": caption,
        "author": author,
        "duration_sec": duration_sec,
        "transcript": transcript,
        "frames": frames,
    }
    if frame_files:
        result["thumbnail_base64"] = base64.b64encode(frame_files[0].read_bytes()).decode()
        result["thumbnail_ext"] = "jpg"
    return result


def process(claim: dict) -> None:
    job = claim["job"]
    job_id, kind = job["id"], job["kind"]
    log(f"claimed {kind} job {job_id}")

    stop = threading.Event()
    beat = threading.Thread(target=heartbeat_loop, args=(job_id, stop), daemon=True)
    beat.start()

    workdir = Path(tempfile.mkdtemp(prefix="mindboard-"))
    try:
        if kind == "ocr":
            result = handle_ocr(claim, workdir)
        elif kind == "reel":
            result = handle_reel(claim, workdir)
        else:
            result = handle_tts(claim, workdir)
        api({"op": "complete", "job_id": job_id, **result})
        log(f"done: {kind} job {job_id}")
    except Exception as error:  # noqa: BLE001 — report every failure to the app
        message = str(error)[:500]
        log(f"FAILED: {message}")
        try:
            api({"op": "fail", "job_id": job_id, "error": message})
        except Exception as report_error:  # noqa: BLE001
            log(f"  could not report failure: {report_error}")
    finally:
        stop.set()
        shutil.rmtree(workdir, ignore_errors=True)


def main() -> None:
    if not APP_URL or not TOKEN:
        sys.exit("set MINDBOARD_URL and WORKER_TOKEN first")
    log(f"mindboard worker polling {APP_URL} every {POLL_SECONDS}s")
    while True:
        try:
            claim = api({"op": "claim", "info": {"host": platform.node()}})
            if claim.get("job"):
                process(claim)
                continue  # drain the queue before sleeping
            if claim.get("skipped"):
                log(f"skipped a job: {claim['skipped']}")
        except urllib.error.HTTPError as error:
            log(f"api error {error.code}: {error.read().decode()[:200]}")
        except Exception as error:  # noqa: BLE001 — the loop must survive anything
            log(f"poll error: {error}")
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
