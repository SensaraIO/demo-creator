/**
 * Thin wrappers around the two Gemini agents this pipeline uses, kept as two
 * separate processes on purpose: the one that drives the device
 * (gemini-computer.py, Computer Use) never sees the verdict, and the one that
 * judges the recording (scripts/gemini-video.py, agentic video understanding)
 * never sees the driver's context. Each call is one fresh interaction.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT } from "./project.mjs";
import { die, which } from "./util.mjs";

export const GEMINI_VIDEO = path.join(ROOT, "scripts", "gemini-video.py");
export const DEFAULT_VIDEO_MODEL = "gemini-3.7-flash";

export function geminiComputerPath() {
  const found = which("gemini-computer.py");
  if (found) return found;
  const local = path.join(os.homedir(), ".local", "bin", "gemini-computer.py");
  if (fs.existsSync(local)) return local;
  return null;
}

export function uvPath() {
  return which("uv") ?? (fs.existsSync(path.join(os.homedir(), ".local", "bin", "uv")) ? path.join(os.homedir(), ".local", "bin", "uv") : null);
}

function videoArgs(video, promptFile, { model, thinking, json, outFile, processing, schemaFile } = {}) {
  const args = ["run", "--script", GEMINI_VIDEO, "--video", video, "--prompt-file", promptFile];
  if (model) args.push("--model", model);
  if (thinking) args.push("--thinking-level", thinking);
  if (processing) args.push("--processing", processing);
  if (json) args.push("--json");
  if (schemaFile) args.push("--schema", schemaFile);
  if (outFile) args.push("--out", outFile);
  return args;
}

function parseVideoResult(code, stdout, stderr, json) {
  const result = { code, stderr, text: stdout, json: null };
  if (json && code === 0) {
    try {
      result.json = JSON.parse(stdout);
    } catch (e) {
      result.code = 4;
      result.stderr += `\ncould not parse JSON from gemini-video: ${e.message}`;
    }
  }
  return result;
}

/** Ask Gemini a question about a video, blocking. */
export function askVideo(video, promptFile, opts = {}) {
  const uv = uvPath();
  if (!uv) die("uv is required to run scripts/gemini-video.py (https://docs.astral.sh/uv/)");
  const r = spawnSync(uv, videoArgs(video, promptFile, opts), { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error) die(`failed to run gemini-video: ${r.error.message}`);
  return parseVideoResult(r.status, r.stdout ?? "", r.stderr ?? "", opts.json);
}

/** Same as askVideo, as a promise, so several clips can be judged at once. */
export function askVideoAsync(video, promptFile, opts = {}) {
  const uv = uvPath();
  if (!uv) die("uv is required to run scripts/gemini-video.py (https://docs.astral.sh/uv/)");
  return new Promise((resolve) => {
    const child = spawn(uv, videoArgs(video, promptFile, opts), { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve(parseVideoResult(code, out, err, opts.json)));
  });
}

/**
 * Run one Gemini Computer Use session against the Android device. Every line
 * the driver prints is echoed and written to `logFile` prefixed with the
 * seconds elapsed since `t0` (the capture's start epoch), so a reviewer can
 * line the action log up with the video. Resolves with the exit code and the
 * driver's final report.
 */
export function runComputerUse(task, { serial, thinking = "medium", maxTurns = 60, model, logFile, t0 = Date.now() / 1000, echo = true } = {}) {
  const gc = geminiComputerPath();
  if (!gc) die("gemini-computer.py not found on PATH or in ~/.local/bin");
  const uv = uvPath();
  if (!uv) die("uv is required to run gemini-computer.py");
  const args = ["run", "--script", gc, "--mobile", "--thinking-level", thinking, "--max-turns", String(maxTurns)];
  if (model) args.push("--model", model);
  if (serial) args.push("--device-id", serial);
  args.push(task);

  const log = logFile ? fs.openSync(logFile, "a") : null;
  const stamp = (line) => `[+${(Date.now() / 1000 - t0).toFixed(1)}s] ${line}`;
  return new Promise((resolve) => {
    const child = spawn(uv, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PYTHONUNBUFFERED: "1" } });
    let report = "";
    let stderr = "";
    let turns = 0;
    let buf = "";
    const handle = (chunk, isErr) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (/^Turn \d+/.test(line)) turns++;
        if (line.startsWith("Agent finished:")) report = line.slice("Agent finished:".length).trim();
        if (isErr) stderr += line + "\n";
        const s = stamp(line);
        if (log !== null) fs.writeSync(log, s + "\n");
        if (echo) process.stdout.write(`  ${s}\n`);
      }
    };
    child.stdout.on("data", (d) => handle(String(d), false));
    child.stderr.on("data", (d) => handle(String(d), true));
    child.on("close", (code) => {
      if (buf) handle("\n", false);
      if (log !== null) fs.closeSync(log);
      resolve({ code, report, stderr, turns });
    });
  });
}

/** Fill `{{KEY}}` placeholders in an agent brief. Unknown keys are left as-is. */
export function fillTemplate(file, vars) {
  let text = fs.readFileSync(file, "utf8");
  for (const [k, v] of Object.entries(vars)) text = text.replaceAll(`{{${k}}}`, String(v ?? ""));
  return text;
}
