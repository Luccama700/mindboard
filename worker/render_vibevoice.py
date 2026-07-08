#!/usr/bin/env python3
"""Headless VibeVoice render via ComfyUI, for the Mindboard worker (Option B).

Run under the ComfyUI Desktop .venv python (it has soundfile + the node deps):

    VIBEVOICE_CMD = "<comfy .venv python> render_vibevoice.py --text {text} --out {wav}"

Reuses a running ComfyUI server (the Desktop app, port 8000, or a headless one
on 8188); if none is reachable it boots its own headless server and shuts it
down afterwards. The episode script arrives as "Speaker 1: …" lines and is
converted to the Enemyx node's "[1]: …" format.

Env (all optional):
  COMFY_URL       explicit server, e.g. http://127.0.0.1:8000
  COMFY_HOME      ComfyUI app dir (the one containing main.py)
  COMFY_MODEL     model folder name under models/vibevoice (default VibeVoice-Large)
  COMFY_QUANT     quantize_llm: "full precision" | "8bit" | "4bit" (default 8bit —
                  only the LLM is quantized; the audio components stay full
                  precision, which is what keeps the voices clean on 16 GB)
  COMFY_STEPS     diffusion steps (default 40; more = cleaner, slower)
  COMFY_VOICE_1   speaker-1 reference wav in ComfyUI/input (default en-Alice_woman.wav)
  COMFY_VOICE_2   speaker-2 reference wav in ComfyUI/input (default en-Carter_man.wav)
  COMFY_TIMEOUT   render timeout seconds (default 7200)
"""

import argparse
import io
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

DEFAULT_COMFY_HOME = (
    r"C:\Users\U\AppData\Local\Comfy-Desktop\ComfyUI-Installs\ComfyUI\ComfyUI"
)
COMFY_HOME = Path(os.environ.get("COMFY_HOME", DEFAULT_COMFY_HOME))
MODEL = os.environ.get("COMFY_MODEL", "VibeVoice-Large")
QUANT = os.environ.get("COMFY_QUANT", "8bit")
STEPS = int(os.environ.get("COMFY_STEPS", "40"))
VOICE_1 = os.environ.get("COMFY_VOICE_1", "en-Alice_woman.wav")
VOICE_2 = os.environ.get("COMFY_VOICE_2", "en-Carter_man.wav")
VOICE_3 = os.environ.get("COMFY_VOICE_3", "")
VOICE_4 = os.environ.get("COMFY_VOICE_4", "")
TIMEOUT = int(os.environ.get("COMFY_TIMEOUT", "7200"))
HEADLESS_PORT = 8188


def log(message: str) -> None:
    print(f"[render_vibevoice] {message}", flush=True)


def get_json(url: str, timeout: int = 10) -> dict:
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return json.loads(response.read().decode())


def server_alive(base: str) -> bool:
    try:
        get_json(f"{base}/system_stats", timeout=3)
        return True
    except Exception:  # noqa: BLE001
        return False


def find_or_start_server() -> tuple[str, subprocess.Popen | None]:
    candidates = []
    if os.environ.get("COMFY_URL"):
        candidates.append(os.environ["COMFY_URL"].rstrip("/"))
    candidates += ["http://127.0.0.1:8000", f"http://127.0.0.1:{HEADLESS_PORT}"]

    for base in candidates:
        if server_alive(base):
            log(f"using running ComfyUI at {base}")
            return base, None

    python = COMFY_HOME / ".venv" / "Scripts" / "python.exe"
    log("no server found — booting headless ComfyUI (this takes a minute)…")
    process = subprocess.Popen(
        [str(python), "main.py", "--port", str(HEADLESS_PORT), "--listen", "127.0.0.1"],
        cwd=str(COMFY_HOME),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    base = f"http://127.0.0.1:{HEADLESS_PORT}"
    for _ in range(120):
        if server_alive(base):
            log("headless ComfyUI is up")
            return base, process
        if process.poll() is not None:
            raise RuntimeError("ComfyUI failed to start (check the install)")
        time.sleep(2)
    process.terminate()
    raise RuntimeError("ComfyUI did not come up within 4 minutes")


SPEAKER_RE = re.compile(r"^\s*Speaker\s+(\d)\s*:\s*", re.IGNORECASE)


def to_bracket_format(text: str) -> str:
    lines = []
    for line in text.splitlines():
        if not line.strip():
            continue
        match = SPEAKER_RE.match(line)
        if match:
            lines.append(f"[{match.group(1)}]: {line[match.end():].strip()}")
        elif re.match(r"^\s*\[\d\]\s*:", line):
            lines.append(line.strip())
        else:
            # Continuation of the previous speaker's line.
            if lines:
                lines[-1] += " " + line.strip()
            else:
                lines.append(f"[1]: {line.strip()}")
    return "\n".join(lines)


def submit(base: str, text: str) -> str:
    # Reference clips anchor the two hosts to real voices — without them
    # VibeVoice invents "synthetic" voices, the main source of eerie output.
    workflow = {
        "1": {
            "class_type": "VibeVoiceMultipleSpeakersNode",
            "inputs": {
                "text": text,
                "model": MODEL,
                "attention_type": "auto",
                "quantize_llm": QUANT,
                "free_memory_after_generate": True,
                "diffusion_steps": STEPS,
                "seed": 42,
                "cfg_scale": 1.3,
                "use_sampling": False,
                "speaker1_voice": ["3", 0],
                "speaker2_voice": ["4", 0],
            },
        },
        "2": {
            "class_type": "SaveAudio",
            "inputs": {"audio": ["1", 0], "filename_prefix": "mindboard/episode"},
        },
        "3": {"class_type": "LoadAudio", "inputs": {"audio": VOICE_1}},
        "4": {"class_type": "LoadAudio", "inputs": {"audio": VOICE_2}},
    }
    for index, voice in ((5, VOICE_3), (6, VOICE_4)):
        if voice:
            workflow[str(index)] = {
                "class_type": "LoadAudio",
                "inputs": {"audio": voice},
            }
            workflow["1"]["inputs"][f"speaker{index - 2}_voice"] = [str(index), 0]
    payload = json.dumps(
        {"prompt": workflow, "client_id": str(uuid.uuid4())},
    ).encode()
    request = urllib.request.Request(
        f"{base}/prompt",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            result = json.loads(response.read().decode())
    except urllib.error.HTTPError as error:
        detail = error.read().decode()[:500]
        raise RuntimeError(f"ComfyUI rejected the workflow: {detail}") from error
    prompt_id = result.get("prompt_id")
    if not prompt_id:
        raise RuntimeError(f"no prompt_id in response: {result}")
    return prompt_id


def wait_for_output(base: str, prompt_id: str) -> dict:
    deadline = time.time() + TIMEOUT
    while time.time() < deadline:
        history = get_json(f"{base}/history/{prompt_id}", timeout=30)
        entry = history.get(prompt_id)
        if entry:
            status = entry.get("status", {})
            if status.get("status_str") == "error":
                messages = json.dumps(status.get("messages", []))[:500]
                raise RuntimeError(f"ComfyUI workflow failed: {messages}")
            for output in entry.get("outputs", {}).values():
                for value in output.values():
                    if isinstance(value, list):
                        for item in value:
                            if isinstance(item, dict) and item.get("filename"):
                                return item
        time.sleep(5)
    raise RuntimeError(f"render timed out after {TIMEOUT}s")


def download_audio(base: str, item: dict) -> bytes:
    query = urllib.parse.urlencode(
        {
            "filename": item["filename"],
            "subfolder": item.get("subfolder", ""),
            "type": item.get("type", "output"),
        },
    )
    with urllib.request.urlopen(f"{base}/view?{query}", timeout=120) as response:
        return response.read()


def write_wav(audio_bytes: bytes, out_path: Path) -> None:
    import soundfile as sf  # from the ComfyUI venv

    data, sample_rate = sf.read(io.BytesIO(audio_bytes))
    sf.write(str(out_path), data, sample_rate, subtype="PCM_16", format="WAV")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--text", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    text = to_bracket_format(Path(args.text).read_text(encoding="utf-8"))
    if not text.strip():
        sys.exit("script text is empty")
    log(
        f"{len(text.splitlines())} dialogue lines, model {MODEL} "
        f"(llm {QUANT}, {STEPS} steps, voices {VOICE_1} + {VOICE_2})",
    )

    base, owned = find_or_start_server()
    try:
        prompt_id = submit(base, text)
        log(f"queued prompt {prompt_id}; rendering (long-form takes a while)…")
        item = wait_for_output(base, prompt_id)
        log(f"render done: {item['filename']}")
        audio = download_audio(base, item)
        write_wav(audio, Path(args.out))
        log(f"wrote {args.out}")
    finally:
        if owned is not None:
            owned.terminate()
            log("stopped headless ComfyUI")


if __name__ == "__main__":
    main()
