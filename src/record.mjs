/**
 * Simulator capture. `simctl io … recordVideo` writes until it receives SIGINT,
 * so recording is a start/stop pair rather than a single blocking call — which
 * is exactly what a driving agent needs: start, perform the flow with the
 * simulator control tools, stop.
 */
import fs from "node:fs";
import path from "node:path";
import { die, ensureDir, info, ok, readJson, run, runOrDie, spawnDetached, warn, writeJson } from "./util.mjs";

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function statePath(cfg, clipId) {
  return path.join(cfg.state, `${clipId}.json`);
}

export function bootedUdid() {
  const r = run("xcrun", ["simctl", "list", "devices", "booted", "-j"]);
  if (r.code !== 0) return null;
  try {
    const data = JSON.parse(r.stdout);
    for (const devices of Object.values(data.devices ?? {})) {
      const booted = devices.find((d) => d.state === "Booted");
      if (booted) return booted.udid;
    }
  } catch {
    /* fall through */
  }
  return null;
}

export function resolveUdid(cfg, override) {
  const udid = override || cfg.udid || bootedUdid();
  if (!udid) die("no booted simulator found — boot one, or pass --udid");
  return udid;
}

/** Freeze the status bar to the Apple marketing state so clips look intentional. */
export function cleanStatusBar(udid) {
  const r = run("xcrun", [
    "simctl", "status_bar", udid, "override",
    "--time", "9:41",
    "--dataNetwork", "wifi",
    "--wifiMode", "active",
    "--wifiBars", "3",
    "--cellularMode", "active",
    "--cellularBars", "4",
    "--batteryState", "charged",
    "--batteryLevel", "100",
  ]);
  return r.code === 0;
}

export function startRecording(cfg, clipId, { udid, codec = "h264" } = {}) {
  const target = resolveUdid(cfg, udid);
  ensureDir(cfg.raw);
  ensureDir(cfg.state);

  const existing = statePath(cfg, clipId);
  if (fs.existsSync(existing)) {
    const prev = readJson(existing);
    if (isAlive(prev.pid)) die(`clip "${clipId}" is already recording (pid ${prev.pid}). Stop it first.`);
    fs.rmSync(existing);
  }

  const rawFile = path.join(cfg.raw, `${clipId}.mov`);
  if (fs.existsSync(rawFile)) fs.rmSync(rawFile);
  const logFile = path.join(cfg.state, `${clipId}.log`);

  // Clear any orphaned recorder from a previously aborted clip, or simctl will
  // reject this capture with "Host recording is already in progress".
  clearStrayRecorders(target);

  const pid = spawnDetached(
    "xcrun",
    ["simctl", "io", target, "recordVideo", "--codec", codec, "--force", rawFile],
    { logFile },
  );

  // simctl needs a moment to open the stream; returning before it does would
  // drop the first second of every clip.
  sleep(1200);
  if (!isAlive(pid)) {
    const why = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").trim() : "";
    die(`recorder exited immediately${why ? `:\n${why}` : ""}`);
  }

  writeJson(existing, { clipId, pid, rawFile, udid: target, startedAt: new Date().toISOString() });
  return { pid, rawFile, udid: target };
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function stopRecording(cfg, clipId, { trimStart = 0, trimEnd = 0, keepRaw = true } = {}) {
  const sp = statePath(cfg, clipId);
  if (!fs.existsSync(sp)) die(`no active recording for clip "${clipId}"`);
  const state = readJson(sp);

  // A tail buffer stops the last interaction being clipped mid-animation.
  sleep(700);

  if (isAlive(state.pid)) {
    try {
      process.kill(state.pid, "SIGINT");
    } catch {
      /* already gone */
    }
  }
  for (let i = 0; i < 100 && isAlive(state.pid); i++) sleep(100);
  if (isAlive(state.pid)) {
    try {
      process.kill(state.pid, "SIGKILL");
    } catch {
      /* ignore */
    }
    warn(`recorder for ${clipId} needed SIGKILL — the tail of the clip may be truncated`);
    sleep(500);
  }

  // Wait for the file size to settle before handing it to ffmpeg.
  let last = -1;
  for (let i = 0; i < 60; i++) {
    if (!fs.existsSync(state.rawFile)) {
      sleep(200);
      continue;
    }
    const size = fs.statSync(state.rawFile).size;
    if (size > 0 && size === last) break;
    last = size;
    sleep(200);
  }

  if (!fs.existsSync(state.rawFile) || fs.statSync(state.rawFile).size === 0) {
    die(`recording for "${clipId}" produced no video (${state.rawFile})`);
  }

  const result = postProcess(cfg, clipId, state.rawFile, { trimStart, trimEnd });
  fs.rmSync(sp);
  if (!keepRaw) fs.rmSync(state.rawFile, { force: true });
  return result;
}

/**
 * Clear any dangling `simctl … recordVideo` process for a device. A hard kill
 * of the xcrun wrapper can orphan the CoreSimulator recording session, which
 * then blocks the next capture with "Host recording is already in progress".
 * pkill on the udid-scoped command line clears it.
 */
export function clearStrayRecorders(udid) {
  run("/usr/bin/pkill", ["-INT", "-f", `simctl io ${udid} recordVideo`]);
  sleep(400);
  run("/usr/bin/pkill", ["-9", "-f", `simctl io ${udid} recordVideo`]);
}

export function abortRecording(cfg, clipId) {
  const sp = statePath(cfg, clipId);
  if (!fs.existsSync(sp)) {
    // No tracked recording, but a prior hard-kill may have orphaned one.
    const udid = bootedUdid();
    if (udid) clearStrayRecorders(udid);
    return false;
  }
  const state = readJson(sp);
  // SIGINT first so simctl releases the recording session cleanly; only then
  // escalate. A bare SIGKILL is what leaves the lock stuck.
  if (isAlive(state.pid)) {
    try {
      process.kill(state.pid, "SIGINT");
    } catch {
      /* ignore */
    }
    for (let i = 0; i < 20 && isAlive(state.pid); i++) sleep(100);
    if (isAlive(state.pid)) {
      try {
        process.kill(state.pid, "SIGKILL");
      } catch {
        /* ignore */
      }
    }
  }
  clearStrayRecorders(state.udid);
  fs.rmSync(sp);
  fs.rmSync(state.rawFile, { force: true });
  return true;
}

export function probeDuration(file) {
  const r = run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    file,
  ]);
  const d = Number.parseFloat(r.stdout.trim());
  return Number.isFinite(d) ? d : null;
}

/**
 * Normalise a raw simulator capture into something a browser will actually play
 * inline: h264 + yuv420p + faststart, capped height, plus a poster frame.
 */
export function postProcess(cfg, clipId, rawFile, { trimStart = 0, trimEnd = 0, maxHeight = 1560 } = {}) {
  ensureDir(cfg.recordings);
  const outFile = path.join(cfg.recordings, `${clipId}.mp4`);
  const posterFile = path.join(cfg.recordings, `${clipId}.jpg`);

  const rawDuration = probeDuration(rawFile);
  const args = ["-v", "error", "-y"];
  if (trimStart > 0) args.push("-ss", String(trimStart));
  args.push("-i", rawFile);
  if (trimEnd > 0 && rawDuration) {
    const dur = Math.max(0.5, rawDuration - trimStart - trimEnd);
    args.push("-t", String(dur));
  }
  args.push(
    "-vf", `scale=-2:'min(${maxHeight},ih)':flags=lanczos`,
    // simctl emits variable-frame-rate video — it only writes a frame when the
    // screen changes, so a static screen produces almost none. Without forcing
    // CFR here, the encoder reads those sparse frames as back-to-back and a
    // 40-second flow collapses into a couple of seconds.
    "-fps_mode", "cfr",
    "-r", "30",
    "-c:v", "libx264",
    "-preset", "veryslow",
    "-crf", "23",
    "-pix_fmt", "yuv420p",
    "-profile:v", "high",
    "-movflags", "+faststart",
    "-an",
    outFile,
  );
  runOrDie("ffmpeg", args);

  // Poster at ~1s in: frame zero is usually a blank or mid-transition frame.
  const duration = probeDuration(outFile) ?? 0;
  const posterAt = Math.min(1.0, Math.max(0, duration - 0.2));
  run("ffmpeg", ["-v", "error", "-y", "-ss", String(posterAt), "-i", outFile, "-frames:v", "1", "-q:v", "3", posterFile]);

  return {
    clipId,
    file: outFile,
    poster: fs.existsSync(posterFile) ? posterFile : null,
    duration,
    bytes: fs.statSync(outFile).size,
  };
}

/** Sample evenly spaced frames so a verifier can check what the clip shows. */
export function extractFrames(cfg, clipId, count = 6) {
  const video = path.join(cfg.recordings, `${clipId}.mp4`);
  if (!fs.existsSync(video)) die(`no recording for clip "${clipId}" — expected ${video}`);
  const duration = probeDuration(video);
  if (!duration) die(`could not read duration of ${video}`);

  const dir = ensureDir(path.join(cfg.frames, clipId));
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f));

  const files = [];
  for (let i = 0; i < count; i++) {
    // Inset from both ends — the very first and last frames are rarely useful.
    const t = duration * ((i + 0.5) / count);
    const out = path.join(dir, `${String(i + 1).padStart(2, "0")}-${t.toFixed(1)}s.jpg`);
    const r = run("ffmpeg", [
      "-v", "error", "-y",
      "-ss", String(t),
      "-i", video,
      "-frames:v", "1",
      "-vf", "scale=-2:900",
      "-q:v", "4",
      out,
    ]);
    if (r.code === 0 && fs.existsSync(out)) files.push(out);
  }
  return { dir, files, duration };
}

/** Reset the app to a clean state so each clip starts from the same place. */
export function resetApp(udid, bundleId, { reinstallFrom } = {}) {
  run("xcrun", ["simctl", "terminate", udid, bundleId]);
  if (reinstallFrom) {
    run("xcrun", ["simctl", "uninstall", udid, bundleId]);
    runOrDie("xcrun", ["simctl", "install", udid, reinstallFrom]);
  }
  info(`reset ${bundleId}`);
}
