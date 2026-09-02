/**
 * Android device control and capture. The counterpart of record.mjs for the
 * emulator: adb for app lifecycle, scrcpy for one continuous h264 master
 * capture, and a marker file the splitter cuts by.
 */
import fs from "node:fs";
import path from "node:path";
import { die, ensureDir, readJson, run, runOrDie, spawnDetached, warn, which, writeJson } from "./util.mjs";
import { probeDuration } from "./record.mjs";

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function adbDevices() {
  const r = run("adb", ["devices", "-l"]);
  if (r.code !== 0) die(`adb devices failed:\n${r.stderr.trim()}`);
  return r.stdout
    .split("\n")
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("*"))
    .map((l) => {
      const [serial, state, ...rest] = l.split(/\s+/);
      const model = rest.find((x) => x.startsWith("model:"))?.slice(6) ?? "";
      return { serial, state, model };
    });
}

/** Pick the device to drive: explicit serial, $ANDROID_SERIAL, or the only one attached. */
export function resolveSerial(override) {
  if (override) return String(override);
  if (process.env.ANDROID_SERIAL) return process.env.ANDROID_SERIAL;
  const devs = adbDevices().filter((d) => d.state === "device");
  if (!devs.length) die("no Android device attached (adb devices is empty). Boot an emulator first");
  if (devs.length > 1) die(`several devices attached (${devs.map((d) => d.serial).join(", ")}); pass --serial`);
  return devs[0].serial;
}

export function adb(serial, args, { orDie = false } = {}) {
  return (orDie ? runOrDie : run)("adb", ["-s", serial, ...args]);
}

/** Install (optional), optionally wipe, and cold-launch the app under test. */
export function prepApp(serial, { pkg, apk, reset = true, launch = true } = {}) {
  if (!pkg) die("an Android package name is required");
  if (apk) {
    if (!fs.existsSync(apk)) die(`no APK at ${apk}`);
    adb(serial, ["install", "-r", "-d", apk], { orDie: true });
  }
  adb(serial, ["shell", "am", "force-stop", pkg]);
  if (reset) adb(serial, ["shell", "pm", "clear", pkg]);
  if (launch) launchApp(serial, pkg);
}

/** Cold-start the app's launcher activity. */
export function launchApp(serial, pkg) {
  const installed = adb(serial, ["shell", "pm", "path", pkg]);
  if (installed.code !== 0 || !/package:/.test(installed.stdout)) die(`${pkg} is not installed on ${serial}`);
  const resolved = adb(serial, ["shell", "cmd", "package", "resolve-activity", "--brief", pkg]);
  const activity = resolved.stdout.split("\n").map((l) => l.trim()).find((l) => l.includes("/"));
  let r;
  if (activity && activity !== "No activity found") r = adb(serial, ["shell", "am", "start", "-W", "-n", activity]);
  else r = adb(serial, ["shell", "monkey", "-p", pkg, "-c", "android.intent.category.LAUNCHER", "1"]);
  if (r.code !== 0 || /Error|No activities found/.test(r.stdout + r.stderr)) die(`could not launch ${pkg}:\n${(r.stdout + r.stderr).trim().slice(-400)}`);
  sleep(1500);
}

/** Pin the status bar (clock 9:41, full battery/signal) the way sim prep does on iOS. */
export function demoStatusBar(serial, on = true) {
  if (!on) {
    adb(serial, ["shell", "am", "broadcast", "-a", "com.android.systemui.demo", "-e", "command", "exit"]);
    return;
  }
  adb(serial, ["shell", "settings", "put", "global", "sysui_demo_allowed", "1"]);
  const send = (...kv) => adb(serial, ["shell", "am", "broadcast", "-a", "com.android.systemui.demo", ...kv]);
  send("-e", "command", "enter");
  send("-e", "command", "clock", "-e", "hhmm", "0941");
  send("-e", "command", "battery", "-e", "level", "100", "-e", "plugged", "false");
  send("-e", "command", "network", "-e", "wifi", "show", "-e", "level", "4", "-e", "fully", "true");
  send("-e", "command", "network", "-e", "mobile", "show", "-e", "datatype", "none", "-e", "level", "4");
  send("-e", "command", "notifications", "-e", "visible", "false");
}

export function screenshot(serial, outFile) {
  const r = run("adb", ["-s", serial, "exec-out", "screencap", "-p"], { encoding: "buffer" });
  if (r.code !== 0 || !r.stdout?.length) die("adb screencap failed");
  fs.writeFileSync(outFile, r.stdout);
  return outFile;
}

/**
 * Start one continuous scrcpy capture into `outFile`. Writes the epoch at
 * which scrcpy reported "Recording started" next to it as `rec-start.txt`
 * (the marker file's time base) and a state file the stop command reads.
 */
export function startCapture({ serial, outFile, stateFile, maxFps = 30 }) {
  if (!which("scrcpy")) die("scrcpy is required for Android capture: brew install scrcpy");
  ensureDir(path.dirname(outFile));
  ensureDir(path.dirname(stateFile));
  if (fs.existsSync(stateFile)) {
    const prev = readJson(stateFile);
    if (isAlive(prev.pid)) die(`a capture is already running (pid ${prev.pid}, ${prev.outFile}). Stop it first`);
    fs.rmSync(stateFile);
  }
  if (fs.existsSync(outFile)) fs.rmSync(outFile);
  const logFile = outFile.replace(/\.mp4$/, "") + ".scrcpy.log";
  fs.writeFileSync(logFile, "");
  const pid = spawnDetached(
    "scrcpy",
    ["--serial", serial, "--no-playback", "--no-audio", "--video-codec=h264", `--max-fps=${maxFps}`, `--record=${outFile}`],
    { logFile },
  );
  // scrcpy's log is block-buffered when it is not a tty and its mp4 writes
  // are buffered too, so neither "Recording started" nor the file size says
  // when the first frame was captured. On a static screen the encoder also
  // produces nothing at all. So: wait for the device-side server to be up,
  // then force one screen change (a shade flick, cut away later since it is
  // before the first start marker) and take that instant as the time base.
  let serverUp = false;
  for (let i = 0; i < 150; i++) {
    sleep(100);
    if (!isAlive(pid)) break;
    // scrcpy forks `adb shell … com.genymobile.scrcpy.Server` once the server
    // is pushed; that child appearing means the device connection is up.
    const kids = run("/usr/bin/pgrep", ["-P", String(pid)]);
    if (kids.code === 0 && kids.stdout.trim()) {
      serverUp = true;
      break;
    }
  }
  if (!isAlive(pid)) die(`scrcpy exited immediately:\n${fs.readFileSync(logFile, "utf8").trim()}`);
  if (!serverUp) warn("scrcpy server not seen on the device within 15s; the time base may be early");
  sleep(600);
  adb(serial, ["shell", "cmd", "statusbar", "expand-notifications"]);
  const started = Date.now() / 1000;
  sleep(300);
  adb(serial, ["shell", "cmd", "statusbar", "collapse"]);
  const recStartFile = path.join(path.dirname(outFile), "rec-start.txt");
  fs.writeFileSync(recStartFile, `${started.toFixed(6)}\n`);
  const markersFile = path.join(path.dirname(outFile), "markers.jsonl");
  fs.writeFileSync(markersFile, "");
  writeJson(stateFile, { pid, serial, outFile, logFile, recStartFile, markersFile, startedAt: new Date(started * 1000).toISOString() });
  return { pid, recStart: started, outFile, recStartFile, markersFile };
}

/** Stop the capture started with startCapture and wait for scrcpy to finalise the file. */
export function stopCapture(stateFile, { settleMs = 2500 } = {}) {
  if (!fs.existsSync(stateFile)) die("no capture is running (no state file)");
  const st = readJson(stateFile);
  // Let the last screen sit for a moment so the final frame is in the file.
  sleep(settleMs);
  // A windowless scrcpy ignores SIGINT/SIGTERM sent to it alone, and SIGKILL
  // leaves an mp4 without its moov atom. Signalling its whole process group
  // (it is the group leader, spawned detached) also stops its adb child; the
  // device disconnect makes scrcpy shut down gracefully and finalise the file.
  if (isAlive(st.pid)) {
    try {
      process.kill(-st.pid, "SIGTERM");
    } catch {
      try {
        process.kill(st.pid, "SIGTERM");
      } catch {
        /* gone */
      }
    }
  }
  for (let i = 0; i < 200 && isAlive(st.pid); i++) sleep(100);
  if (isAlive(st.pid)) {
    warn("scrcpy ignored SIGTERM for 20s; sending SIGKILL (the recording is probably lost)");
    try {
      process.kill(st.pid, "SIGKILL");
    } catch {
      /* ignore */
    }
  }
  let last = -1;
  for (let i = 0; i < 100; i++) {
    if (fs.existsSync(st.outFile)) {
      const size = fs.statSync(st.outFile).size;
      if (size > 0 && size === last) break;
      last = size;
    }
    sleep(200);
  }
  if (!fs.existsSync(st.outFile) || fs.statSync(st.outFile).size === 0) die(`capture produced no video at ${st.outFile}`);
  fs.rmSync(stateFile);
  const duration = probeDuration(st.outFile);
  if (duration === null) die(`scrcpy did not finalise ${st.outFile} (no moov atom); the recording is unreadable. Log:\n${fs.readFileSync(st.logFile, "utf8").trim().slice(-600)}`);
  return { file: st.outFile, bytes: fs.statSync(st.outFile).size, duration, recStartFile: st.recStartFile, markersFile: st.markersFile };
}

/** Append a section marker in the time base of rec-start.txt. */
export function mark(markersFile, clipId, event, { t = Date.now() / 1000 } = {}) {
  if (!["start", "end"].includes(event)) die(`marker event must be start or end, not "${event}"`);
  ensureDir(path.dirname(markersFile));
  fs.appendFileSync(markersFile, JSON.stringify({ t: Number(t.toFixed(6)), clipId, event }) + "\n");
  return { t, clipId, event };
}

export function captureRunning(stateFile) {
  if (!fs.existsSync(stateFile)) return null;
  const st = readJson(stateFile);
  return isAlive(st.pid) ? st : null;
}
