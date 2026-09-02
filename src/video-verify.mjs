/**
 * Judge recordings with Gemini agentic video understanding. Two jobs:
 *
 *  - verifyClips: per clip, does the video prove every evidence item in the
 *    plan and the BRS clause it stands for? Writes verification.json in the
 *    same shape the human/Claude verifier used, frames cited as real files.
 *  - reviewPresentation: over the continuous master, is every section shown
 *    in its marked window and is the take clean enough for a client?
 *
 * The verifier never sees the driver's transcript. It gets the plan, the BRS
 * text and the video, nothing else.
 */
import fs from "node:fs";
import path from "node:path";
import { askVideoAsync, DEFAULT_VIDEO_MODEL, fillTemplate } from "./gemini.mjs";
import { ROOT } from "./project.mjs";
import { probeDuration } from "./record.mjs";
import { frameAt, readMarkers } from "./split.mjs";
import { die, ensureDir, fail, info, ok, readJson, warn, writeJson } from "./util.mjs";

const AGENTS = path.join(ROOT, "agents");

function sectionText(brs, ids) {
  const byId = new Map(brs.sections.map((s) => [s.id, s]));
  return ids
    .map((id) => {
      const s = byId.get(id);
      if (!s) return `- ${id}: (not in BRS)`;
      return `### ${s.label ?? s.heading ?? id}\n${(s.text ?? s.body ?? "").trim() || "(no text)"}`;
    })
    .join("\n\n");
}

function tmpDir(cfg) {
  return ensureDir(path.join(cfg.state, "gemini"));
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Verify each planned clip's recording against its evidence with one Gemini
 * call per clip. Returns the results and merges them into verification.json.
 */
export async function verifyClips(cfg, { only = null, model = DEFAULT_VIDEO_MODEL, thinking = "medium", concurrency = 3 } = {}) {
  const plan = readJson(cfg.plan);
  const brs = readJson(cfg.brs);
  const clips = (plan.clips ?? []).filter((c) => !only || only.includes(c.id));
  if (!clips.length) die("no clips to verify");
  const tdir = tmpDir(cfg);

  const results = await mapLimit(clips, concurrency, async (clip) => {
    const video = path.join(cfg.recordings, `${clip.id}.mp4`);
    if (!fs.existsSync(video)) return { clipId: clip.id, pass: false, missing: true, notes: `no recording at ${video}` };
    const duration = probeDuration(video) ?? 0;
    const prompt = fillTemplate(path.join(AGENTS, "video-verifier.md"), {
      APP_NAME: cfg.appName ?? "",
      CLIP_ID: clip.id,
      TITLE: clip.title ?? "",
      OBJECTIVE: clip.objective ?? "",
      DURATION: duration.toFixed(1),
      EVIDENCE: (clip.evidence ?? []).map((e, i) => `${i + 1}. ${e}`).join("\n"),
      REQUIREMENTS: sectionText(brs, clip.sectionIds ?? []),
    });
    const promptFile = path.join(tdir, `verify-${clip.id}.md`);
    fs.writeFileSync(promptFile, prompt);
    info(`verifying ${clip.id} (${duration.toFixed(0)}s) with ${model}`);
    const r = await askVideoAsync(video, promptFile, { model, thinking, json: true, outFile: path.join(tdir, `verify-${clip.id}.json`) });
    if (r.code !== 0 || !r.json) {
      fail(`${clip.id}: verifier failed (exit ${r.code}): ${r.stderr.trim().split("\n").pop()}`);
      return { clipId: clip.id, pass: false, error: r.stderr.trim().split("\n").pop(), notes: "verifier call failed; re-run verify-video for this clip" };
    }
    const j = r.json;
    const fdir = ensureDir(path.join(cfg.frames, clip.id));
    const evidenceChecks = (clip.evidence ?? []).map((e, i) => {
      const c = (j.evidenceChecks ?? [])[i] ?? {};
      const seen = c.seen === true;
      let frame = null;
      if (seen && Number.isFinite(c.atSeconds)) {
        const t = Math.min(Math.max(0, c.atSeconds), Math.max(0, duration - 0.1));
        const f = frameAt(video, t, path.join(fdir, `gv-${t.toFixed(1)}s.jpg`));
        frame = f ? path.basename(f) : null;
      }
      return { evidence: e, seen, frame, atSeconds: Number.isFinite(c.atSeconds) ? c.atSeconds : null, note: c.note ?? "" };
    });
    const problems = (j.problems ?? []).map((p) => ({ atSeconds: p.atSeconds ?? null, severity: p.severity === "fail" ? "fail" : "polish", description: p.description ?? "" }));
    const failing = problems.filter((p) => p.severity === "fail");
    const allSeen = evidenceChecks.every((c) => c.seen);
    const clauseMet = j.requirementMet !== false;
    const pass = allSeen && clauseMet && failing.length === 0;
    const notes = [
      j.summary ?? "",
      ...(allSeen ? [] : [`missing evidence: ${evidenceChecks.filter((c) => !c.seen).map((c) => c.evidence).join("; ")}`]),
      ...(clauseMet ? [] : [`requirement not met: ${j.requirementNote ?? ""}`]),
      ...failing.map((p) => `problem at ${p.atSeconds ?? "?"}s: ${p.description}`),
    ]
      .filter(Boolean)
      .join(" ");
    const entry = {
      clipId: clip.id,
      pass,
      verifier: "gemini-video",
      model: j._meta?.model ?? model,
      processing: j._meta?.processing ?? null,
      evidenceChecks,
      requirementMet: clauseMet,
      notes,
      polish: problems.filter((p) => p.severity === "polish").map((p) => `${p.atSeconds ?? "?"}s: ${p.description}`),
      usage: j._meta?.usage ?? null,
    };
    (pass ? ok : fail)(`${clip.id}: ${pass ? "pass" : "FAIL"} — ${notes.slice(0, 160)}`);
    return entry;
  });

  const existing = fs.existsSync(cfg.verification) ? readJson(cfg.verification) : { results: [] };
  const byId = new Map((existing.results ?? []).map((v) => [v.clipId, v]));
  for (const r of results) byId.set(r.clipId, r);
  const merged = { ...existing, verifiedAt: new Date().toISOString(), verifier: "gemini-video", results: [...byId.values()] };
  writeJson(cfg.verification, merged);
  return results;
}

/**
 * Review the continuous take (master-full.mp4 by default) for presentation
 * quality and for every marked section actually appearing in its window.
 */
export async function reviewPresentation(cfg, { file = null, model = DEFAULT_VIDEO_MODEL, thinking = "medium" } = {}) {
  const plan = readJson(cfg.plan);
  const video = file ?? path.join(cfg.recordings, "master-full.mp4");
  if (!fs.existsSync(video)) die(`no continuous take at ${video}; run split first`);
  const duration = probeDuration(video) ?? 0;
  const { ranges, order } = readMarkers(cfg.recordings);
  const clipsById = new Map((plan.clips ?? []).map((c) => [c.id, c]));

  // master-full.mp4 starts `pad` before the first start marker; recover the
  // offset from the split so the section windows are in the file's time base.
  const starts = order.map((id) => ranges.get(id)?.start).filter((s) => Number.isFinite(s));
  const offset = Math.max(0, Math.min(...starts) - 0.5);
  const sections = order
    .filter((id) => clipsById.has(id) && Number.isFinite(ranges.get(id)?.start))
    .map((id) => {
      const r = ranges.get(id);
      const c = clipsById.get(id);
      const s = Math.max(0, r.start - offset);
      const e = Math.min(duration, (r.end ?? r.start + (c.estimatedSeconds ?? 20)) - offset);
      return { clipId: id, title: c.title ?? id, start: s, end: e, objective: c.objective ?? "", evidence: c.evidence ?? [] };
    });

  const prompt = fillTemplate(path.join(AGENTS, "presentation-reviewer.md"), {
    APP_NAME: cfg.appName ?? "",
    CLIENT: cfg.clientName ?? "",
    DURATION: duration.toFixed(1),
    SECTIONS: sections
      .map((s) => `- ${s.clipId} "${s.title}" — ${s.start.toFixed(1)}s to ${s.end.toFixed(1)}s. Objective: ${s.objective} Must show: ${s.evidence.join("; ")}`)
      .join("\n"),
  });
  const tdir = tmpDir(cfg);
  const promptFile = path.join(tdir, "presentation.md");
  fs.writeFileSync(promptFile, prompt);
  info(`reviewing ${path.basename(video)} (${duration.toFixed(0)}s, ${sections.length} sections) with ${model}`);
  const r = await askVideoAsync(video, promptFile, { model, thinking: thinking === "medium" ? "high" : thinking, json: true, outFile: path.join(tdir, "presentation.json") });
  if (r.code !== 0 || !r.json) die(`presentation review failed (exit ${r.code}): ${r.stderr.trim().split("\n").slice(-3).join("\n")}`);
  const j = r.json;
  const fdir = ensureDir(path.join(cfg.frames, "_presentation"));
  const issues = (j.issues ?? []).map((i, n) => {
    const t = Number.isFinite(i.atSeconds) ? i.atSeconds : null;
    const frame = t !== null ? frameAt(video, Math.min(t, duration - 0.1), path.join(fdir, `issue-${n + 1}-${t.toFixed(1)}s.jpg`)) : null;
    return { atSeconds: t, severity: i.severity ?? "polish", description: i.description ?? "", frame: frame ? path.relative(cfg.dir, frame) : null };
  });
  const sectionResults = sections.map((s, i) => {
    const m = (j.sections ?? []).find((x) => x.clipId === s.clipId) ?? (j.sections ?? [])[i] ?? {};
    return { clipId: s.clipId, window: [Number(s.start.toFixed(1)), Number(s.end.toFixed(1))], shown: m.shown === true, atSeconds: Number.isFinite(m.atSeconds) ? m.atSeconds : null, note: m.note ?? "" };
  });
  const notShown = sectionResults.filter((s) => !s.shown);
  const blocking = issues.filter((i) => i.severity === "fail");
  const out = {
    reviewedAt: new Date().toISOString(),
    file: path.relative(cfg.dir, video),
    model: j._meta?.model ?? model,
    processing: j._meta?.processing ?? null,
    cleanPresentation: j.cleanPresentation === true && blocking.length === 0,
    allSectionsShown: notShown.length === 0,
    sections: sectionResults,
    issues,
    summary: j.summary ?? "",
    usage: j._meta?.usage ?? null,
  };
  writeJson(path.join(cfg.dir, "presentation-review.json"), out);
  for (const s of sectionResults) (s.shown ? ok : fail)(`${s.clipId}: ${s.shown ? "shown" : "NOT shown"}${s.atSeconds !== null ? ` at ${s.atSeconds}s` : ""} ${s.note}`);
  for (const i of issues) (i.severity === "fail" ? fail : warn)(`${i.atSeconds ?? "?"}s [${i.severity}] ${i.description}`);
  (out.cleanPresentation && out.allSectionsShown ? ok : fail)(out.summary || "review written");
  return out;
}
