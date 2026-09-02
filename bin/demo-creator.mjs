#!/usr/bin/env node
/**
 * demo-creator — turn a client BRS into a branded, section-by-section demo
 * walkthrough recorded on the iOS Simulator.
 *
 * The CLI owns everything deterministic (parsing, capture, encoding, building).
 * Agents own everything that needs judgement (which requirements are worth
 * filming, how to drive the app, whether a clip really shows the requirement)
 * and talk to the CLI through these commands.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadBrs } from "../src/brs.mjs";
import { buildPresentation } from "../src/present.mjs";
import {
  abortRecording,
  cleanStatusBar,
  extractFrames,
  probeDuration,
  resetApp,
  resolveUdid,
  startRecording,
  stopRecording,
} from "../src/record.mjs";
import {
  extractBrandColor,
  findAppIcon,
  listProjects,
  loadConfig,
  projectPaths,
  readAppMeta,
  saveConfig,
} from "../src/project.mjs";
import { C, UserError, die, ensureDir, fail, info, log, ok, parseArgs, readJson, run, warn, which, writeJson } from "../src/util.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const USAGE = `${C.bold}demo-creator${C.reset} — BRS → recorded demo walkthrough

${C.bold}Setup${C.reset}
  doctor                             check simulator / ffmpeg prerequisites
  init <project> --brs <file> --app <path.app> [options]
                                     create a project and ingest its BRS
  reingest <project> [--brs <file>]  re-parse the BRS after it changes
  status <project>                   coverage: planned / recorded / verified

${C.bold}Planning${C.reset}
  outline <project> [--all]          numbered section outline (functional only by default)
  brief <project> [planner|recorder|verifier]
                                     print the brief to hand the matching agent
  plan validate <project>            check plan.json against the BRS

${C.bold}Recording${C.reset}
  sim prep [--udid <id>] [--bundle <id>] [--app <path>]
                                     clean status bar, reinstall + reset the app
  record start <project> <clipId> [--udid <id>]
  record stop  <project> <clipId> [--trim-start <s>] [--trim-end <s>]
  record abort <project> <clipId>
  frames <project> <clipId> [--count 6]
                                     sample frames for verification
  clips <project>                    list recorded clips

${C.bold}Delivery${C.reset}
  build <project>                    build the presentation into projects/<p>/dist
  check <project>                    ship gate: clips CFR + verified, status file valid, deck built
`;

function cmdDoctor() {
  let bad = 0;
  const check = (label, okCond, hint) => {
    if (okCond) ok(label);
    else {
      fail(`${label} — ${hint}`);
      bad++;
    }
  };
  check("xcrun", which("xcrun"), "install Xcode command line tools");
  const sims = run("xcrun", ["simctl", "list", "devices", "available"]);
  check("simctl", sims.code === 0, "xcrun simctl failed");
  check("ffmpeg", which("ffmpeg"), "brew install ffmpeg");
  check("ffprobe", which("ffprobe"), "brew install ffmpeg");
  check("unzip", fs.existsSync("/usr/bin/unzip"), "required to read .docx");
  const booted = run("xcrun", ["simctl", "list", "devices", "booted"]);
  const hasBooted = /Booted/.test(booted.stdout);
  if (hasBooted) ok("a simulator is booted");
  else warn("no simulator booted — boot one before recording");
  log();
  return bad === 0 ? 0 : 1;
}

function cmdInit(args) {
  const name = args._[1];
  if (!name) die("usage: demo-creator init <project> --brs <file> --app <path.app>");
  if (!args.brs) die("--brs <file.docx|file.md> is required");

  const p = projectPaths(name);
  ensureDir(p.dir);

  const brsSource = path.resolve(String(args.brs));
  const brs = loadBrs(brsSource);
  writeJson(p.brs, brs);
  fs.writeFileSync(p.brsMarkdown, brs.markdown);

  const appPath = args.app ? path.resolve(String(args.app)) : null;
  const meta = readAppMeta(appPath);

  const iconPath = args.icon
    ? path.resolve(String(args.icon))
    : findAppIcon([appPath, args["assets-dir"] ? path.resolve(String(args["assets-dir"])) : null].filter(Boolean));
  const splashPath = args.splash ? path.resolve(String(args.splash)) : null;
  const brandColor = args.color ? String(args.color) : extractBrandColor(iconPath);

  const config = {
    name,
    clientName: args.client ? String(args.client) : null,
    appName: args["app-name"] ? String(args["app-name"]) : meta.displayName ?? brs.title,
    appPath,
    bundleId: args["bundle-id"] ? String(args["bundle-id"]) : meta.bundleId ?? null,
    appVersion: meta.version ?? null,
    udid: args.udid ? String(args.udid) : null,
    iconPath: iconPath ?? null,
    splashPath,
    brandColor: brandColor ?? null,
    brsSourcePath: brsSource,
    createdAt: new Date().toISOString(),
  };
  saveConfig(name, config);
  ensureDir(p.recordings);
  ensureDir(p.state);

  ok(`project ${C.bold}${name}${C.reset} created at projects/${name}`);
  log(`  BRS       ${brs.sections.length} sections from ${path.basename(brsSource)}`);
  log(`  App       ${config.appName}${config.bundleId ? ` (${config.bundleId})` : ""}`);
  log(`  Icon      ${config.iconPath ? path.basename(config.iconPath) : "none found"}`);
  log(`  Accent    ${config.brandColor ?? "default"}`);
  log(`\nNext: demo-creator brief ${name}`);
  return 0;
}

function cmdReingest(args) {
  const name = args._[1];
  const cfg = loadConfig(name);
  const source = args.brs ? path.resolve(String(args.brs)) : cfg.brsSourcePath;
  const brs = loadBrs(source);
  writeJson(cfg.brs, brs);
  fs.writeFileSync(cfg.brsMarkdown, brs.markdown);
  saveConfig(name, { ...cfg, brsSourcePath: source });
  ok(`re-ingested ${brs.sections.length} sections from ${path.basename(source)}`);
  return 0;
}

/**
 * Heuristic split between requirement sections and front-matter. The planning
 * agent makes the real call; this just keeps the default outline readable.
 */
const NARRATIVE = /^(executive summary|business objectives?|scope|out of scope|in scope|assumptions|constraints|glossary|introduction|overview|success (criteria|metrics)|risks?|timeline|milestones?|appendix|revision history|document control|stakeholders?)/i;

function cmdOutline(args) {
  const cfg = loadConfig(args._[1]);
  const brs = readJson(cfg.brs);
  for (const s of brs.sections) {
    const narrative = NARRATIVE.test(s.title);
    if (narrative && !args.all) continue;
    const indent = "  ".repeat(Math.max(0, s.level - 3));
    const num = s.number ? `${C.dim}${s.number}${C.reset} ` : "";
    const tag = narrative ? ` ${C.dim}(narrative)${C.reset}` : "";
    log(`${indent}${num}${s.title}${tag}  ${C.dim}[${s.id}]${C.reset}`);
  }
  return 0;
}

const ROLES = { planner: "planner.md", recorder: "recorder.md", verifier: "verifier.md" };

function cmdBrief(args) {
  const name = args._[1];
  const role = args._[2] ?? args.role ?? "planner";
  if (!ROLES[role]) die(`unknown role "${role}" — one of: ${Object.keys(ROLES).join(", ")}`);

  const cfg = loadConfig(name);
  const brs = readJson(cfg.brs);
  const tmpl = fs.readFileSync(path.join(HERE, "..", "agents", ROLES[role]), "utf8");
  const filled = tmpl
    .replaceAll("{{PROJECT}}", name)
    .replaceAll("{{APP_NAME}}", cfg.appName ?? "")
    .replaceAll("{{BUNDLE_ID}}", cfg.bundleId ?? "")
    .replaceAll("{{APP_PATH}}", cfg.appPath ?? "")
    .replaceAll("{{UDID}}", cfg.udid ?? "booted")
    .replaceAll("{{BRS_JSON}}", cfg.brs)
    .replaceAll("{{BRS_MD}}", cfg.brsMarkdown)
    .replaceAll("{{PLAN_PATH}}", cfg.plan)
    .replaceAll("{{VERIFICATION_PATH}}", cfg.verification)
    .replaceAll("{{RECORDINGS}}", cfg.recordings)
    .replaceAll("{{SECTION_COUNT}}", String(brs.sections.length));
  log(filled);
  return 0;
}

function cmdPlanValidate(args) {
  const cfg = loadConfig(args._[2]);
  if (!fs.existsSync(cfg.plan)) die(`no plan yet — expected ${cfg.plan}`);
  return validatePlan(cfg) === 0 ? 0 : 1;
}

/** Check plan.json against the BRS. Returns the number of hard problems found. */
function validatePlan(cfg) {
  const brs = readJson(cfg.brs);
  const plan = readJson(cfg.plan);
  const ids = new Set(brs.sections.map((s) => s.id));

  let problems = 0;
  const clipIds = new Set();
  for (const clip of plan.clips ?? []) {
    if (!clip.id) {
      fail("a clip has no id");
      problems++;
      continue;
    }
    if (clipIds.has(clip.id)) {
      fail(`duplicate clip id: ${clip.id}`);
      problems++;
    }
    clipIds.add(clip.id);
    if (!/^[A-Za-z0-9._-]+$/.test(clip.id)) {
      fail(`clip id "${clip.id}" must be filename-safe`);
      problems++;
    }
    if (!clip.sectionIds?.length) {
      fail(`clip ${clip.id} maps to no BRS section`);
      problems++;
    }
    for (const sid of clip.sectionIds ?? []) {
      if (!ids.has(sid)) {
        fail(`clip ${clip.id} references unknown section "${sid}"`);
        problems++;
      }
    }
    if (!clip.steps?.length) {
      warn(`clip ${clip.id} has no steps`);
    }
    if (!clip.evidence?.length) {
      warn(`clip ${clip.id} lists no on-screen evidence`);
    }
  }
  for (const sid of Object.keys(plan.coverage ?? {})) {
    if (!ids.has(sid)) {
      fail(`coverage references unknown section "${sid}"`);
      problems++;
    }
  }

  const uncovered = brs.sections.filter(
    (s) => !plan.coverage?.[s.id] && !(plan.clips ?? []).some((c) => c.sectionIds?.includes(s.id)),
  );
  if (uncovered.length) {
    warn(`${uncovered.length} section(s) have no coverage decision:`);
    for (const s of uncovered.slice(0, 20)) log(`    ${s.label}  [${s.id}]`);
    if (uncovered.length > 20) log(`    …and ${uncovered.length - 20} more`);
  }

  if (problems === 0) ok(`plan is valid — ${(plan.clips ?? []).length} clips`);
  return problems;
}

// The dashboard's contract for demo-status.json (dashboard/lib/projects.ts).
const RUN_STATES = ["planning", "recording", "verifying", "building", "done", "failed"];
const CLIP_STATES = ["pending", "recording", "recorded", "verified", "failed"];

function probeStream(file) {
  const r = run("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=codec_name,pix_fmt,avg_frame_rate:format=duration",
    "-of", "json",
    file,
  ]);
  try {
    const j = JSON.parse(r.stdout);
    const s = j.streams?.[0] ?? {};
    return { codec: s.codec_name, pixFmt: s.pix_fmt, fps: s.avg_frame_rate, duration: Number.parseFloat(j.format?.duration) };
  } catch {
    return null;
  }
}

/**
 * The ship gate. Everything here is a defect that has reached, or nearly
 * reached, a client: sparse-VFR clips that freeze in players, clips that were
 * never verified against their evidence, a verifier-rejected clip left on disk
 * where `build` would still ship it labelled "Recorded", and status files the
 * dashboard cannot read. Exit 0 means the delivery is ready to send.
 */
function cmdCheck(args) {
  const cfg = loadConfig(args._[1]);
  let problems = 0;
  const bad = (msg) => {
    fail(msg);
    problems++;
  };

  if (!fs.existsSync(cfg.plan)) {
    bad(`no plan at ${cfg.plan}`);
    return 1;
  }
  problems += validatePlan(cfg);
  const clips = readJson(cfg.plan).clips ?? [];

  const statusFile = path.join(cfg.dir, "demo-status.json");
  let status = null;
  if (!fs.existsSync(statusFile)) bad("no demo-status.json: the dashboard cannot see this run");
  else {
    try {
      status = JSON.parse(fs.readFileSync(statusFile, "utf8"));
    } catch (e) {
      bad(`demo-status.json is not valid JSON: ${e.message}`);
    }
  }
  const statusClip = (id) => (status?.clips ?? []).find((c) => c.id === id);

  const verification = fs.existsSync(cfg.verification) ? readJson(cfg.verification) : null;
  if (!verification) bad("no verification.json: nothing has been checked against its evidence");
  const verdicts = new Map((verification?.results ?? []).map((v) => [v.clipId, v]));

  let passed = 0;
  let gaps = 0;
  for (const clip of clips) {
    const file = path.join(cfg.recordings, `${clip.id}.mp4`);
    const v = verdicts.get(clip.id);
    if (!fs.existsSync(file)) {
      if (statusClip(clip.id)?.status === "failed") {
        warn(`${clip.id}: no recording; marked failed in demo-status.json (honest gap)`);
        gaps++;
      } else bad(`${clip.id}: no recording at ${path.relative(process.cwd(), file)}`);
      continue;
    }
    const s = probeStream(file);
    if (!s) {
      bad(`${clip.id}: ffprobe could not read ${path.relative(process.cwd(), file)}`);
      continue;
    }
    if (s.fps !== "30/1") bad(`${clip.id}: frame rate ${s.fps}, not constant 30/1. Raw simctl output is sparse VFR; re-encode with -vf fps=30`);
    if (s.codec !== "h264" || !/^yuvj?420p$/.test(s.pixFmt ?? "")) bad(`${clip.id}: ${s.codec}/${s.pixFmt}, expected h264/yuv420p`);
    if (!(s.duration >= 2)) bad(`${clip.id}: duration ${s.duration}s`);
    if (!verification) continue;
    if (!v) bad(`${clip.id}: recorded but not in verification.json`);
    else if (v.pass !== true) bad(`${clip.id}: failed verification (${v.notes ?? "no notes"}) yet its file is still on disk. Retake it, or delete the file so the deck records an honest gap`);
    else {
      if (!(v.evidenceChecks ?? []).some((c) => c.frame || c.frames?.length)) warn(`${clip.id}: verification cites no frame; a pass should point at the frames that prove it`);
      passed++;
    }
  }

  if (status) {
    if (status.version !== 1) bad(`demo-status.json version is ${status.version}, expected 1`);
    if (!RUN_STATES.includes(status.state)) bad(`demo-status.json state "${status.state}" is not one of ${RUN_STATES.join(" | ")}`);
    for (const c of status.clips ?? []) {
      if (!CLIP_STATES.includes(c.status)) bad(`demo-status.json clip ${c.id}: status "${c.status}" is not one of ${CLIP_STATES.join(" | ")}`);
    }
    const missing = clips.filter((c) => !statusClip(c.id)).map((c) => c.id);
    if (missing.length) bad(`demo-status.json lists none of: ${missing.join(", ")}`);
    if (status.state === "done" && !status.finishedAt) bad("demo-status.json is done but finishedAt is empty");
    if (status.state !== "done" && status.state !== "failed") warn(`demo-status.json state is "${status.state}"; set done with finishedAt when the delivery is sent`);
  }

  const index = path.join(cfg.dist, "index.html");
  if (!fs.existsSync(index)) bad(`no presentation at ${path.relative(process.cwd(), index)}. Run build`);

  log();
  if (problems === 0) ok(`${cfg.name}: ${passed} of ${clips.length} clips verified at 30fps${gaps ? `, ${gaps} acknowledged gap(s)` : ""}, status file valid, presentation built`);
  else fail(`${problems} problem(s): not ready to send`);
  return problems === 0 ? 0 : 1;
}

function cmdSimPrep(args) {
  const udid = args.udid ? String(args.udid) : resolveUdid({}, null);
  if (cleanStatusBar(udid)) ok(`status bar pinned to 9:41 on ${udid}`);
  else warn("could not override the status bar");
  const bundle = args.bundle ? String(args.bundle) : null;
  const app = args.app ? path.resolve(String(args.app)) : null;
  if (bundle) resetApp(udid, bundle, { reinstallFrom: app });
  return 0;
}

function cmdRecord(args) {
  const sub = args._[1];
  const cfg = loadConfig(args._[2]);
  const clipId = args._[3];
  if (!clipId) die(`usage: demo-creator record ${sub} <project> <clipId>`);

  if (sub === "start") {
    const r = startRecording(cfg, clipId, { udid: args.udid ? String(args.udid) : undefined });
    ok(`recording ${C.bold}${clipId}${C.reset} (pid ${r.pid}) → ${path.relative(process.cwd(), r.rawFile)}`);
    log(`${C.dim}drive the app now, then: demo-creator record stop ${cfg.name} ${clipId}${C.reset}`);
    return 0;
  }
  if (sub === "stop") {
    const r = stopRecording(cfg, clipId, {
      trimStart: Number(args["trim-start"] ?? 0),
      trimEnd: Number(args["trim-end"] ?? 0),
    });
    ok(`${clipId} — ${r.duration.toFixed(1)}s, ${(r.bytes / 1e6).toFixed(1)} MB → ${path.relative(process.cwd(), r.file)}`);
    return 0;
  }
  if (sub === "abort") {
    ok(abortRecording(cfg, clipId) ? `aborted ${clipId}` : `nothing recording for ${clipId}`);
    return 0;
  }
  die(`unknown record subcommand "${sub}"`);
}

function cmdFrames(args) {
  const cfg = loadConfig(args._[1]);
  const clipId = args._[2];
  if (!clipId) die("usage: demo-creator frames <project> <clipId> [--count 6]");
  const r = extractFrames(cfg, clipId, Number(args.count ?? 6));
  ok(`${r.files.length} frames from ${r.duration.toFixed(1)}s clip`);
  for (const f of r.files) log(`  ${f}`);
  return 0;
}

function cmdClips(args) {
  const cfg = loadConfig(args._[1]);
  if (!fs.existsSync(cfg.recordings)) {
    warn("no recordings yet");
    return 0;
  }
  const files = fs.readdirSync(cfg.recordings).filter((f) => f.endsWith(".mp4")).sort();
  if (!files.length) {
    warn("no recordings yet");
    return 0;
  }
  for (const f of files) {
    const full = path.join(cfg.recordings, f);
    const d = probeDuration(full);
    const size = fs.statSync(full).size;
    log(`  ${f.replace(/\.mp4$/, "").padEnd(28)} ${String(d?.toFixed(1) ?? "?").padStart(6)}s  ${(size / 1e6).toFixed(1)} MB`);
  }
  return 0;
}

function cmdStatus(args) {
  const cfg = loadConfig(args._[1]);
  const brs = readJson(cfg.brs);
  const plan = fs.existsSync(cfg.plan) ? readJson(cfg.plan) : { clips: [], coverage: {} };
  const verification = fs.existsSync(cfg.verification) ? readJson(cfg.verification) : { results: [] };
  const verdicts = new Map((verification.results ?? []).map((v) => [v.clipId, v]));

  log(`${C.bold}${cfg.appName}${C.reset}${cfg.clientName ? ` — ${cfg.clientName}` : ""}`);
  log(`${C.dim}${brs.sections.length} BRS sections · ${(plan.clips ?? []).length} planned clips${C.reset}\n`);

  let recorded = 0;
  let passed = 0;
  for (const clip of plan.clips ?? []) {
    const file = path.join(cfg.recordings, `${clip.id}.mp4`);
    const exists = fs.existsSync(file);
    if (exists) recorded++;
    const v = verdicts.get(clip.id);
    if (v?.pass) passed++;
    const mark = !exists ? `${C.dim}○${C.reset}` : v?.pass ? `${C.green}●${C.reset}` : v ? `${C.red}●${C.reset}` : `${C.yellow}●${C.reset}`;
    const secs = (clip.sectionIds ?? []).join(", ");
    log(`  ${mark} ${clip.id.padEnd(26)} ${C.dim}${secs}${C.reset}  ${clip.title ?? ""}`);
    if (v && !v.pass) log(`      ${C.red}${v.notes ?? "verification failed"}${C.reset}`);
  }
  const backend = Object.values(plan.coverage ?? {}).filter((c) => c.status === "backend" || c.status === "non-visual").length;
  log(`\n  ${C.green}${passed} verified${C.reset} · ${recorded} recorded · ${(plan.clips ?? []).length} planned · ${backend} backend-only`);
  return 0;
}

function cmdBuild(args) {
  const cfg = loadConfig(args._[1]);
  const r = buildPresentation(cfg);
  ok(`built ${path.relative(process.cwd(), r.indexPath)}`);
  log(`  ${r.stats.clips} clips · ${r.stats.covered} verified · ${r.stats.backend} backend-only · ${r.stats.total} sections`);
  log(`\n  open ${r.indexPath}`);
  return 0;
}

const COMMANDS = {
  doctor: cmdDoctor,
  init: cmdInit,
  reingest: cmdReingest,
  outline: cmdOutline,
  brief: cmdBrief,
  plan: (args) => {
    if (args._[1] === "validate") return cmdPlanValidate(args);
    die(`unknown plan subcommand "${args._[1] ?? ""}"`);
  },
  sim: (args) => {
    if (args._[1] === "prep") return cmdSimPrep(args);
    die(`unknown sim subcommand "${args._[1] ?? ""}"`);
  },
  record: cmdRecord,
  frames: cmdFrames,
  clips: cmdClips,
  status: cmdStatus,
  build: cmdBuild,
  check: cmdCheck,
  projects: () => {
    const list = listProjects();
    if (!list.length) warn("no projects yet");
    for (const p of list) log(`  ${p}`);
    return 0;
  },
};

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (!cmd || cmd === "help" || args.help) {
    log(USAGE);
    return 0;
  }
  const fn = COMMANDS[cmd];
  if (!fn) {
    fail(`unknown command "${cmd}"`);
    log(USAGE);
    return 1;
  }
  return fn(args) ?? 0;
}

try {
  process.exit(main());
} catch (e) {
  if (e instanceof UserError) {
    fail(e.message);
    process.exit(1);
  }
  throw e;
}
