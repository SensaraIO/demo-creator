/**
 * The QA loop: a Gemini Computer Use tester explores the app on the emulator
 * while scrcpy records; a separate Gemini video reviewer watches the recording
 * and writes findings; whoever orchestrates (Claude Code) fixes the app,
 * rebuilds, and runs the next round. Runs are numbered so each review can
 * re-check the previous round's open findings.
 *
 * qa/<name>/qa.json                   app under test
 * qa/<name>/runs/NNN/master.mp4       raw scrcpy capture
 *                    master-cfr.mp4   normalised (what the reviewer watches)
 *                    tester.log       driver actions, stamped +seconds
 *                    tester-task.md   the brief the tester was given
 *                    run.json         timing, exit code, driver report
 *                    findings.json    the reviewer's verdict
 *                    frames/          one frame per finding
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { demoStatusBar, prepApp, resolveSerial, startCapture, stopCapture } from "./android.mjs";
import { askVideo, DEFAULT_VIDEO_MODEL, fillTemplate, runComputerUse } from "./gemini.mjs";
import { ROOT } from "./project.mjs";
import { probeDuration } from "./record.mjs";
import { frameAt, normaliseMaster } from "./split.mjs";
import { C, die, ensureDir, fail, info, log, ok, readJson, warn, writeJson } from "./util.mjs";

export const QA_DIR = path.join(ROOT, "qa");
const AGENTS = path.join(ROOT, "agents");
const SEVERITIES = ["blocker", "major", "minor", "polish"];

export function listQaTargets() {
  if (!fs.existsSync(QA_DIR)) return [];
  return fs.readdirSync(QA_DIR).filter((d) => fs.existsSync(path.join(QA_DIR, d, "qa.json"))).sort();
}

export function qaPaths(name) {
  const dir = path.join(QA_DIR, name);
  return { name, dir, config: path.join(dir, "qa.json"), runs: path.join(dir, "runs") };
}

export function loadQa(name) {
  const p = qaPaths(name);
  if (!fs.existsSync(p.config)) die(`QA target "${name}" not found. Run: demo-creator qa init ${name} --package <pkg>`);
  return { ...readJson(p.config), ...p };
}

export function listRuns(q) {
  if (!fs.existsSync(q.runs)) return [];
  return fs
    .readdirSync(q.runs)
    .filter((d) => /^\d{3}$/.test(d))
    .sort()
    .map((d) => {
      const dir = path.join(q.runs, d);
      const run = fs.existsSync(path.join(dir, "run.json")) ? readJson(path.join(dir, "run.json")) : null;
      const findings = fs.existsSync(path.join(dir, "findings.json")) ? readJson(path.join(dir, "findings.json")) : null;
      return { n: Number(d), dir, run, findings };
    });
}

export function qaInit(name, { pkg, apk, appName, serial, focus, notes }) {
  if (!pkg) die("--package <android.package> is required");
  const p = qaPaths(name);
  ensureDir(p.runs);
  const cfg = {
    name,
    appName: appName ?? name,
    package: pkg,
    apk: apk ? path.resolve(apk) : null,
    serial: serial ?? null,
    focus: focus ?? "",
    notes: notes ?? "",
    createdAt: new Date().toISOString(),
  };
  writeJson(p.config, cfg);
  return cfg;
}

function openFindings(q) {
  const reviewed = listRuns(q).filter((r) => r.findings);
  if (!reviewed.length) return [];
  return (reviewed[reviewed.length - 1].findings.findings ?? []).filter((f) => f.status !== "fixed");
}

function findingsBlock(findings) {
  if (!findings.length) return "(none — this is the first round)";
  return findings
    .map((f) => `- ${f.id} [${f.severity}] ${f.title} — ${f.description}${f.repro?.length ? ` Repro: ${f.repro.join(" → ")}` : ""}`)
    .join("\n");
}

/**
 * One test round: prep the app, start recording, hand the emulator to the
 * Gemini Computer Use tester, stop recording, normalise the capture.
 */
export async function qaTest(q, { maxTurns = 60, thinking = "high", focus, reset = true, serial: serialOverride, demoBar = false, model, apk } = {}) {
  const serial = resolveSerial(serialOverride ?? q.serial);
  const prev = listRuns(q);
  const n = (prev.length ? prev[prev.length - 1].n : 0) + 1;
  const priorOpen = openFindings(q);

  const apkPath = apk ? path.resolve(apk) : q.apk;
  info(`run ${n}: preparing ${q.package} on ${serial}${apkPath ? ` from ${path.basename(apkPath)}` : ""}`);
  prepApp(serial, { pkg: q.package, apk: apkPath, reset });
  if (demoBar) demoStatusBar(serial, true);
  const dir = ensureDir(path.join(q.runs, String(n).padStart(3, "0")));

  const task = fillTemplate(path.join(AGENTS, "qa-tester.md"), {
    APP_NAME: q.appName,
    PACKAGE: q.package,
    FOCUS: focus ?? q.focus ?? "",
    NOTES: q.notes ?? "",
    ROUND: n,
    OPEN_FINDINGS: findingsBlock(priorOpen),
  });
  fs.writeFileSync(path.join(dir, "tester-task.md"), task);

  const stateFile = path.join(dir, ".capture.json");
  const cap = startCapture({ serial, outFile: path.join(dir, "master.mp4"), stateFile });
  ok(`recording (scrcpy pid ${cap.pid})`);
  const startedAt = new Date().toISOString();
  let driver;
  try {
    info(`tester: gemini computer use, thinking ${thinking}, up to ${maxTurns} turns`);
    driver = await runComputerUse(task, { serial, thinking, maxTurns, model, logFile: path.join(dir, "tester.log"), t0: cap.recStart });
  } finally {
    const stopped = stopCapture(stateFile);
    ok(`capture ${(stopped.bytes / 1e6).toFixed(1)} MB, ${stopped.duration?.toFixed(0) ?? "?"}s raw`);
    if (demoBar) demoStatusBar(serial, false);
  }
  const cfr = normaliseMaster(path.join(dir, "master.mp4"), path.join(dir, "master-cfr.mp4"));
  const run = {
    n,
    startedAt,
    finishedAt: new Date().toISOString(),
    serial,
    package: q.package,
    apk: apkPath,
    apkSha: apkPath && fs.existsSync(apkPath) ? shortHash(apkPath) : null,
    thinking,
    maxTurns,
    driverExit: driver.code,
    driverTurns: driver.turns,
    driverReport: driver.report,
    driverUsage: driver.usage,
    model: model ?? null,
    durationSec: cfr.duration,
    priorOpenFindings: priorOpen.map((f) => f.id),
  };
  writeJson(path.join(dir, "run.json"), run);
  if (driver.code === 2) warn(`tester hit the ${maxTurns}-turn limit; the recording is still reviewable`);
  else if (driver.code !== 0) warn(`tester exited ${driver.code}: ${driver.stderr.trim().split("\n").pop() ?? ""}`);
  ok(`run ${n} recorded: ${path.relative(ROOT, cfr.file)} (${cfr.duration?.toFixed(0)}s)`);
  return run;
}

function shortHash(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex").slice(0, 12);
}

/** Review one run's recording with Gemini video understanding; writes findings.json. */
export function qaReview(q, { run: runN, model = DEFAULT_VIDEO_MODEL, thinking = "high" } = {}) {
  const runs = listRuns(q);
  if (!runs.length) die("no runs yet; run qa test first");
  const target = runN ? runs.find((r) => r.n === Number(runN)) : runs[runs.length - 1];
  if (!target) die(`no run ${runN}`);
  const video = path.join(target.dir, "master-cfr.mp4");
  if (!fs.existsSync(video)) die(`no normalised capture at ${video}`);
  const duration = probeDuration(video) ?? 0;
  const testerLog = fs.existsSync(path.join(target.dir, "tester.log")) ? fs.readFileSync(path.join(target.dir, "tester.log"), "utf8") : "";
  const actionLog = testerLog
    .split("\n")
    .filter((l) => /\] \[[a-z_]+\]|Agent finished|Agent stopped/.test(l))
    .join("\n");

  const previousRuns = runs.filter((r) => r.n < target.n && r.findings);
  const priorOpen = previousRuns.length ? (previousRuns[previousRuns.length - 1].findings.findings ?? []).filter((f) => f.status !== "fixed") : [];

  const prompt = fillTemplate(path.join(AGENTS, "qa-reviewer.md"), {
    APP_NAME: q.appName,
    PACKAGE: q.package,
    FOCUS: q.focus ?? "",
    NOTES: q.notes ?? "",
    ROUND: target.n,
    DURATION: duration.toFixed(1),
    ACTION_LOG: actionLog || "(no action log)",
    DRIVER_REPORT: target.run?.driverReport || "(none)",
    OPEN_FINDINGS: findingsBlock(priorOpen),
  });
  fs.writeFileSync(path.join(target.dir, "reviewer-prompt.md"), prompt);
  info(`reviewing run ${target.n} (${duration.toFixed(0)}s) with ${model}`);
  const r = askVideo(video, path.join(target.dir, "reviewer-prompt.md"), { model, thinking, json: true, outFile: path.join(target.dir, "reviewer-raw.json") });
  if (r.code !== 0 || !r.json) die(`reviewer failed (exit ${r.code}): ${r.stderr.trim().split("\n").slice(-3).join("\n")}`);
  const j = r.json;

  const fdir = ensureDir(path.join(target.dir, "frames"));
  const findings = (j.findings ?? []).map((f, i) => {
    const id = `R${target.n}-F${i + 1}`;
    const t = Number.isFinite(f.atSeconds) ? f.atSeconds : null;
    const frame = t !== null ? frameAt(video, Math.min(t, Math.max(0, duration - 0.1)), path.join(fdir, `${id}-${t.toFixed(1)}s.jpg`)) : null;
    return {
      id,
      severity: SEVERITIES.includes(f.severity) ? f.severity : "minor",
      title: f.title ?? "",
      atSeconds: t,
      screen: f.screen ?? "",
      description: f.description ?? "",
      expected: f.expected ?? "",
      repro: Array.isArray(f.repro) ? f.repro : [],
      frame: frame ? path.relative(target.dir, frame) : null,
      status: "open",
    };
  });
  const regressions = priorOpen.map((p) => {
    const m = (j.regressions ?? []).find((x) => x.id === p.id) ?? {};
    const status = ["fixed", "still-present", "not-exercised"].includes(m.status) ? m.status : "not-exercised";
    return { ...p, status, note: m.note ?? "", atSeconds: Number.isFinite(m.atSeconds) ? m.atSeconds : null };
  });
  // Findings still present carry forward under their original id so the loop
  // can track how long they have been open.
  for (const reg of regressions) {
    if (reg.status === "fixed") continue;
    const dup = findings.find((f) => f.title.toLowerCase() === reg.title.toLowerCase());
    if (dup) {
      dup.id = reg.id;
      dup.carriedFrom = reg.id;
    } else findings.push({ ...reg, status: reg.status === "still-present" ? "open" : "unverified", note: reg.note });
  }

  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, findings.filter((f) => f.severity === s && f.status !== "fixed").length]));
  const out = {
    reviewedAt: new Date().toISOString(),
    run: target.n,
    model: j._meta?.model ?? model,
    processing: j._meta?.processing ?? null,
    verdict: counts.blocker + counts.major + counts.minor === 0 ? "pass" : "fail",
    counts,
    findings,
    regressions,
    coverage: { screensSeen: j.screensSeen ?? [], notExercised: j.notExercised ?? [] },
    summary: j.summary ?? "",
    usage: j._meta?.usage ?? null,
  };
  writeJson(path.join(target.dir, "findings.json"), out);
  printFindings(out);
  return out;
}

export function printFindings(f) {
  log(`${C.bold}run ${f.run}${C.reset} — ${f.verdict === "pass" ? C.green + "PASS" : C.red + "FAIL"}${C.reset}  ${SEVERITIES.map((s) => `${f.counts[s]} ${s}`).join(" · ")}`);
  for (const x of f.findings) {
    if (x.status === "fixed") continue;
    const col = x.severity === "blocker" || x.severity === "major" ? C.red : x.severity === "minor" ? C.yellow : C.dim;
    log(`  ${col}${x.severity.padEnd(7)}${C.reset} ${x.id.padEnd(8)} ${x.atSeconds !== null ? `${String(x.atSeconds).padStart(5)}s` : "     "}  ${x.title}`);
    if (x.description) log(`          ${C.dim}${x.description}${C.reset}`);
    if (x.repro?.length) log(`          ${C.dim}repro: ${x.repro.join(" → ")}${C.reset}`);
  }
  for (const r of f.regressions ?? []) log(`  ${r.status === "fixed" ? C.green + "fixed  " : r.status === "still-present" ? C.red + "present" : C.yellow + "unseen "}${C.reset} ${r.id.padEnd(8)} ${r.title}${r.note ? ` ${C.dim}${r.note}${C.reset}` : ""}`);
  if (f.summary) log(`\n  ${f.summary}`);
}

/** Exit criterion for the loop: the latest reviewed run has no open findings at or above the threshold. */
export function qaGate(q, { strict = false } = {}) {
  const reviewed = listRuns(q).filter((r) => r.findings);
  if (!reviewed.length) {
    fail("no reviewed run yet");
    return 2;
  }
  const latest = reviewed[reviewed.length - 1];
  const all = listRuns(q);
  if (all[all.length - 1].n !== latest.n) {
    fail(`run ${all[all.length - 1].n} is recorded but not reviewed; run qa review`);
    return 2;
  }
  const f = latest.findings;
  const open = f.findings.filter((x) => x.status !== "fixed" && (strict || x.severity !== "polish"));
  if (open.length) {
    fail(`run ${latest.n}: ${open.length} open finding(s) — ${open.map((x) => `${x.id} ${x.severity}`).join(", ")}`);
    return 1;
  }
  ok(`run ${latest.n}: no open ${strict ? "" : "blocker/major/minor "}findings`);
  return 0;
}

export function qaStatus(q) {
  log(`${C.bold}${q.appName}${C.reset} ${C.dim}${q.package}${C.reset}${q.apk ? `  ${C.dim}${path.basename(q.apk)}${C.reset}` : ""}`);
  const runs = listRuns(q);
  if (!runs.length) {
    warn("no runs yet");
    return;
  }
  for (const r of runs) {
    const f = r.findings;
    const status = !r.run ? "recording?" : !f ? "unreviewed" : f.verdict === "pass" ? `${C.green}pass${C.reset}` : `${C.red}${SEVERITIES.map((s) => (f.counts[s] ? `${f.counts[s]} ${s}` : null)).filter(Boolean).join(", ")}${C.reset}`;
    log(`  run ${String(r.n).padStart(3)}  ${r.run?.durationSec ? `${r.run.durationSec.toFixed(0).padStart(4)}s` : "    "}  ${r.run?.driverTurns != null ? `${String(r.run.driverTurns).padStart(3)} turns` : "         "}  ${status}`);
  }
}
