#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["google-genai>=2.7.0"]
# ///
"""
Ask Gemini (agentic video understanding) a question about a local video.

    gemini-video.py --video clip.mp4 --prompt-file prompt.md [--json] [--out result.json]

Uploads the file through the Files API, waits until it is ACTIVE, runs one
interaction with `processing: "agentic"`, prints the model's text (or, with
--json, the parsed JSON object) to stdout, and deletes the upload. Reads the
API key the same way gemini-computer.py does: $GEMINI_API_KEY, then
~/.config/gemini/api_key, then the macOS keychain item "gemini-api-key".
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

from google import genai

DEFAULT_MODEL = "gemini-3.8-flash"


def load_api_key() -> bool:
    if os.environ.get("GEMINI_API_KEY"):
        return True
    key_file = Path.home() / ".config" / "gemini" / "api_key"
    try:
        key = key_file.read_text().strip()
        if key:
            os.environ["GEMINI_API_KEY"] = key
            return True
    except OSError:
        pass
    if sys.platform != "darwin":
        return False
    r = subprocess.run(
        ["security", "find-generic-password", "-a", os.environ.get("USER", ""), "-s", "gemini-api-key", "-w"],
        capture_output=True, text=True, check=False,
    )
    if r.returncode == 0 and r.stdout.strip():
        os.environ["GEMINI_API_KEY"] = r.stdout.strip()
        return True
    return False


def output_text(interaction) -> str:
    direct = getattr(interaction, "output_text", None)
    if direct:
        return direct
    chunks = []
    for step in getattr(interaction, "steps", []) or []:
        if getattr(step, "type", None) != "model_output":
            continue
        for block in getattr(step, "content", []) or []:
            if getattr(block, "type", None) == "text":
                chunks.append(getattr(block, "text", ""))
    return "\n".join(c for c in chunks if c)


def parse_json(text: str):
    text = text.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else text[3:]
        if text.rstrip().endswith("```"):
            text = text.rstrip()[:-3]
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end == -1:
        raise ValueError("no JSON object in model output")
    return json.loads(text[start:end + 1])


def usage_dict(interaction) -> dict:
    u = getattr(interaction, "usage", None)
    if not u:
        return {}
    keys = {
        "total_input_tokens": "input",
        "total_output_tokens": "output",
        "total_thought_tokens": "thought",
        "total_tool_use_tokens": "tool_use",
        "total_cached_tokens": "cached",
        "total_tokens": "total",
    }
    out = {}
    for k, short in keys.items():
        v = getattr(u, k, None)
        if v is not None:
            out[short] = v
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--video", required=True)
    ap.add_argument("--prompt-file", required=True)
    ap.add_argument("--system-file")
    ap.add_argument("--model", "-m", default=DEFAULT_MODEL)
    ap.add_argument("--thinking-level", "-t", choices=["minimal", "low", "medium", "high"], default="medium")
    ap.add_argument("--processing", choices=["agentic", "static"], default="agentic")
    ap.add_argument("--json", action="store_true", help="require a JSON object in the reply and print it parsed")
    ap.add_argument("--schema", help="JSON schema file the reply must conform to (implies --json)")
    ap.add_argument("--out", help="write the reply (text, or the JSON object) to this file")
    ap.add_argument("--keep-upload", action="store_true")
    ap.add_argument("--retries", type=int, default=3, help="retries on transient 'too many tool calls' / 5xx errors")
    ap.add_argument("--no-fallback", action="store_true", help="do not fall back to static processing after the retries are exhausted")
    args = ap.parse_args(argv)
    if args.schema:
        args.json = True

    if not load_api_key():
        print("Error: no Gemini API key (set GEMINI_API_KEY or ~/.config/gemini/api_key)", file=sys.stderr)
        return 1
    video = Path(args.video)
    if not video.is_file():
        print(f"Error: no such video: {video}", file=sys.stderr)
        return 1
    prompt = Path(args.prompt_file).read_text()
    system = Path(args.system_file).read_text() if args.system_file else None

    t0 = time.time()
    with genai.Client() as client:
        uploaded = client.files.upload(file=str(video), config={"mime_type": "video/mp4", "display_name": video.name})
        try:
            while getattr(uploaded.state, "name", str(uploaded.state)).upper().endswith("PROCESSING"):
                time.sleep(2)
                uploaded = client.files.get(name=uploaded.name)
            state = getattr(uploaded.state, "name", str(uploaded.state)).upper()
            if not state.endswith("ACTIVE"):
                print(f"Error: upload ended in state {state}", file=sys.stderr)
                return 1
            print(f"[gemini-video] uploaded {video.name} ({video.stat().st_size / 1e6:.1f} MB) in {time.time() - t0:.0f}s", file=sys.stderr)

            kwargs = {}
            if system:
                kwargs["system_instruction"] = system
            # A JSON response_format makes the agentic video loop fail with
            # "Model generated too many tool calls" (observed 2026-09-02), so
            # under agentic processing the JSON contract lives in the prompt and
            # the reply is parsed out of the text. Static processing accepts a
            # real response_format, and rejects the `name` field.
            schema = json.loads(Path(args.schema).read_text()) if args.schema else None
            if args.json:
                prompt_text = prompt + "\n\nReply with a single JSON object and nothing else."
                if schema:
                    prompt_text += " It must conform to this JSON schema:\n" + json.dumps(schema)
            else:
                prompt_text = prompt
            def ask(processing):
                block = {"type": "video", "uri": uploaded.uri, "mime_type": "video/mp4", "processing": processing}
                if processing == "agentic":
                    block["name"] = video.name
                extra = dict(kwargs)
                if args.json and processing == "static":
                    fmt = {"type": "text", "mime_type": "application/json"}
                    if schema:
                        fmt["schema_"] = schema
                    extra["response_format"] = fmt
                return client.interactions.create(
                    model=args.model,
                    input=[block, {"type": "text", "text": prompt_text}],
                    generation_config={"thinking_level": args.thinking_level},
                    **extra,
                )

            processing = args.processing
            interaction = None
            last_error = None
            attempts = max(1, args.retries + 1)
            for attempt in range(1, attempts + 1):
                try:
                    interaction = ask(processing)
                    break
                except Exception as error:  # noqa: BLE001
                    msg = str(error)
                    transient = "too many tool calls" in msg or "Error code: 5" in msg or "RESOURCE_EXHAUSTED" in msg or "429" in msg
                    last_error = error
                    if not transient:
                        raise
                    print(f"[gemini-video] attempt {attempt}/{attempts} ({processing}) failed: {msg.splitlines()[0][:160]}", file=sys.stderr)
                    if attempt < attempts:
                        time.sleep(3 * attempt)
            if interaction is None and processing == "agentic" and not args.no_fallback:
                print("[gemini-video] agentic processing kept failing; falling back to static processing", file=sys.stderr)
                processing = "static"
                interaction = ask(processing)
            if interaction is None:
                raise last_error  # type: ignore[misc]
            text = output_text(interaction)
            usage = usage_dict(interaction)
            print(f"[gemini-video] {args.model} {processing} answered in {time.time() - t0:.0f}s {json.dumps(usage) if usage else ''}", file=sys.stderr)
        finally:
            if not args.keep_upload:
                try:
                    client.files.delete(name=uploaded.name)
                except Exception:  # noqa: BLE001
                    pass

    if args.json:
        try:
            obj = parse_json(text)
        except ValueError as e:
            print(f"Error: {e}\n--- raw output ---\n{text}", file=sys.stderr)
            return 4
        obj.setdefault("_meta", {}).update({"model": args.model, "processing": processing, "usage": usage, "video": str(video)})
        rendered = json.dumps(obj, indent=2)
    else:
        rendered = text
    if args.out:
        Path(args.out).write_text(rendered + "\n")
    print(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
