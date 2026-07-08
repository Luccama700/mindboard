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


def run_command(template: str, **paths: str) -> None:
    command = template.format(**paths)
    log(f"  $ {command}")
    subprocess.run(command, shell=True, check=True)


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


def process(claim: dict) -> None:
    job = claim["job"]
    job_id, kind = job["id"], job["kind"]
    log(f"claimed {kind} job {job_id}")

    stop = threading.Event()
    beat = threading.Thread(target=heartbeat_loop, args=(job_id, stop), daemon=True)
    beat.start()

    workdir = Path(tempfile.mkdtemp(prefix="mindboard-"))
    try:
        result = handle_ocr(claim, workdir) if kind == "ocr" else handle_tts(claim, workdir)
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
