/**
 * Cut one continuous master capture into per-clip videos by the markers the
 * driver logged. Deterministic, so it lives in the CLI rather than in a brief;
 * every rule here has cost a re-cut when done by hand.
 */
import fs from "node:fs";
import path from "node:path";
import { probeDuration } from "./record.mjs";
import { die, ensureDir, run, runOrDie, warn } from "./util.mjs";

/** Read markers.jsonl + rec-start.txt into {clipId: {start, end}} offsets (seconds into the master). */
export function readMarkers(recordingsDir) {
  const markersFile = path.join(recordingsDir, "markers.jsonl");
  const recStartFile = path.join(recordingsDir, "rec-start.txt");
  if (!fs.existsSync(markersFile)) die(`no markers at ${markersFile}`);
  if (!fs.existsSync(recStartFile)) die(`no rec-start.txt at ${recStartFile}`);
  const recStart = Number.parseFloat(fs.readFileSync(recStartFile, "utf8").trim());
  if (!Number.isFinite(recStart)) die("rec-start.txt does not hold an epoch");

  const lines = fs
    .readFileSync(markersFile, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l, i) => {
      try {
        return JSON.parse(l);
      } catch {
        die(`markers.jsonl line ${i + 1} is not JSON: ${l}`);
      }
    });

  // The last start/end pair for a clipId wins: a redone section overrides.
  const ranges = new Map();
  const order = [];
  for (const m of lines) {
    if (!m.clipId || !Number.isFinite(m.t)) continue;
    const cur = ranges.get(m.clipId) ?? {};
    if (m.event === "start") {
      cur.start = m.t - recStart;
      cur.end = undefined;
      if (!order.includes(m.clipId)) order.push(m.clipId);
      else {
        order.splice(order.indexOf(m.clipId), 1);
        order.push(m.clipId);
      }
    } else if (m.event === "end") cur.end = m.t - recStart;
    ranges.set(m.clipId, cur);
  }
  return { recStart, ranges, order };
}

/**
 * Normalise a raw capture to constant 30fps h264. Raw simctl and scrcpy
 * output is sparse VFR (a frame only on screen change) and can carry bogus
 * DTS, which makes ffmpeg shift timestamps mid-stream when cutting; every
 * clip must come from this file, never from the raw master.
 */
export function normaliseMaster(src, out, { maxWidth = 780, crf = 24 } = {}) {
  if (!fs.existsSync(src)) die(`no master at ${src}`);
  runOrDie("ffmpeg", [
    "-v", "error", "-y",
    "-fflags", "+igndts",
    "-i", src,
    "-vf", `fps=30,scale=trunc(min(iw\\,${maxWidth})/2)*2:-2:flags=lanczos`,
    "-c:v", "libx264", "-crf", String(crf), "-preset", "medium",
    "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an",
    out,
  ]);
  return { file: out, duration: probeDuration(out) };
}

function cut(src, start, end, out, { crf = 24 } = {}) {
  runOrDie("ffmpeg", [
    "-v", "error", "-y",
    "-ss", start.toFixed(3), "-to", end.toFixed(3),
    "-i", src,
    "-c:v", "libx264", "-crf", String(crf), "-preset", "medium",
    "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an",
    out,
  ]);
}

export function frameAt(video, t, out, { height = 900 } = {}) {
  ensureDir(path.dirname(out));
  const r = run("ffmpeg", ["-v", "error", "-y", "-ss", String(Math.max(0, t)), "-i", video, "-frames:v", "1", "-vf", `scale=-2:${height}`, "-q:v", "4", out]);
  return r.code === 0 && fs.existsSync(out) ? out : null;
}

export function lastFrame(video, out, { height = 900 } = {}) {
  ensureDir(path.dirname(out));
  const r = run("ffmpeg", ["-v", "error", "-y", "-sseof", "-0.5", "-i", video, "-update", "1", "-frames:v", "1", "-vf", `scale=-2:${height}`, "-q:v", "4", out]);
  return r.code === 0 && fs.existsSync(out) ? out : null;
}

/**
 * Split projects/<p>/recordings/master.mp4 by markers into <clipId>.mp4 (+ poster
 * and boundary frames), and write the trimmed continuous master-full.mp4.
 */
export function splitMaster(cfg, { pad = 0.5, only = null, master = null, force = false } = {}) {
  const rec = cfg.recordings;
  const src = master ?? path.join(rec, "master.mp4");
  const cfr = path.join(rec, "master-cfr.mp4");
  if (force || !fs.existsSync(cfr) || fs.statSync(cfr).mtimeMs < fs.statSync(src).mtimeMs) normaliseMaster(src, cfr);
  const total = probeDuration(cfr);
  if (!total) die(`could not read the duration of ${cfr}`);

  const { ranges, order } = readMarkers(rec);
  const wanted = only ? order.filter((id) => only.includes(id)) : order;
  const clips = [];
  for (const [i, clipId] of wanted.entries()) {
    const r = ranges.get(clipId);
    if (r.start === undefined) {
      warn(`${clipId}: no start marker, skipped`);
      continue;
    }
    let end = r.end;
    if (end === undefined) {
      const nextId = order[order.indexOf(clipId) + 1];
      end = nextId && ranges.get(nextId)?.start !== undefined ? ranges.get(nextId).start : total;
      warn(`${clipId}: no end marker, cutting to ${end.toFixed(1)}s`);
    }
    const start = Math.max(0, r.start - pad);
    end = Math.min(total, end + pad);
    if (end - start < 1) {
      warn(`${clipId}: range ${start.toFixed(1)}–${end.toFixed(1)}s is under a second, skipped`);
      continue;
    }
    const out = path.join(rec, `${clipId}.mp4`);
    cut(cfr, start, end, out);
    const duration = probeDuration(out) ?? 0;
    const poster = path.join(rec, `${clipId}.jpg`);
    frameAt(out, Math.min(1.0, Math.max(0, duration - 0.2)), poster, { height: 1200 });
    const fdir = path.join(cfg.frames, clipId);
    ensureDir(fdir);
    frameAt(out, 0.05, path.join(fdir, "boundary-first.jpg"));
    lastFrame(out, path.join(fdir, "boundary-last.jpg"));
    clips.push({ clipId, start, end, duration, file: out, index: i });
  }

  if (!only && clips.length) {
    const first = Math.max(0, Math.min(...clips.map((c) => c.start)));
    const last = Math.min(total, Math.max(...clips.map((c) => c.end)));
    cut(cfr, first, last, path.join(rec, "master-full.mp4"));
    return { clips, cfr, total, full: { file: path.join(rec, "master-full.mp4"), offset: first, duration: last - first } };
  }
  return { clips, cfr, total, full: null };
}
