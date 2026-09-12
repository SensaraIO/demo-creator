/**
 * A "project" is one client delivery: their BRS, the app under demo, the plan,
 * the recordings, and the built presentation. Everything lives under
 * projects/<name>/ so a delivery is a single self-contained folder you can zip.
 */
import fs from "node:fs";
import path from "node:path";
import { die, ensureDir, readJson, run, writeJson } from "./util.mjs";

export const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
// Deliveries default to <repo>/projects. When the engine is installed as a
// Claude Code plugin its root lives in the plugin cache and is replaced on
// update, so set DEMO_PROJECTS_DIR to keep recordings somewhere durable.
// The dashboard reads the same variable (dashboard/lib/projects.ts).
export const PROJECTS_DIR = process.env.DEMO_PROJECTS_DIR
  ? path.resolve(process.env.DEMO_PROJECTS_DIR)
  : path.join(ROOT, "projects");

export function projectPaths(name) {
  const dir = path.join(PROJECTS_DIR, name);
  return {
    name,
    dir,
    config: path.join(dir, "project.json"),
    brs: path.join(dir, "brs.json"),
    brsMarkdown: path.join(dir, "brs.md"),
    plan: path.join(dir, "plan.json"),
    verification: path.join(dir, "verification.json"),
    recordings: path.join(dir, "recordings"),
    raw: path.join(dir, "recordings", "raw"),
    frames: path.join(dir, "frames"),
    assets: path.join(dir, "assets"),
    state: path.join(dir, ".state"),
    dist: path.join(dir, "dist"),
  };
}

export function listProjects() {
  if (!fs.existsSync(PROJECTS_DIR)) return [];
  return fs
    .readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(PROJECTS_DIR, d.name, "project.json")))
    .map((d) => d.name)
    .sort();
}

export function loadConfig(name) {
  const p = projectPaths(name);
  if (!fs.existsSync(p.config)) {
    die(`project "${name}" not found. Run: demo-creator init ${name} --brs <file> --app <path>`);
  }
  return { ...readJson(p.config), ...p };
}

export function saveConfig(name, config) {
  const p = projectPaths(name);
  ensureDir(p.dir);
  // Keep derived paths out of the persisted file.
  const { dir, config: _c, brs, brsMarkdown, plan, verification, recordings, raw, frames, assets, state, dist, name: _n, ...rest } = config;
  writeJson(p.config, rest);
}

/**
 * Pull a brand accent colour out of the app icon by averaging its most
 * saturated region. Cheap, and better than a hardcoded default: the deck ends
 * up feeling like the client's app rather than like our template.
 */
export function extractBrandColor(imagePath) {
  if (!imagePath || !fs.existsSync(imagePath)) return null;
  const SIZE = 48;
  // Flatten onto white first: icons are often transparent outside the squircle,
  // and un-composited alpha reads as black, which poisons the average.
  const r = run("ffmpeg", [
    "-v", "error",
    "-f", "lavfi", "-i", `color=white:s=${SIZE}x${SIZE}`,
    "-i", imagePath,
    "-filter_complex", `[1:v]scale=${SIZE}:${SIZE}[ic];[0:v][ic]overlay=0:0,format=rgb24`,
    "-frames:v", "1",
    "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
  ], { encoding: "buffer" });
  if (r.code !== 0 || !r.stdout?.length) return null;

  const buf = r.stdout;
  // Bucket similar colours together and weight by how "brand-like" each pixel
  // is, so a large flat logo colour beats a handful of vivid stray pixels.
  const buckets = new Map();
  for (let i = 0; i + 2 < buf.length; i += 3) {
    const red = buf[i];
    const green = buf[i + 1];
    const blue = buf[i + 2];
    const max = Math.max(red, green, blue);
    const min = Math.min(red, green, blue);
    if (max === 0) continue;
    const sat = (max - min) / max;
    const lum = (0.299 * red + 0.587 * green + 0.114 * blue) / 255;
    // Near-greys and near-white/near-black make poor accents.
    if (sat < 0.25 || lum > 0.93 || lum < 0.07) continue;
    const weight = sat * (1 - Math.abs(lum - 0.5) * 0.9);
    const key = `${red >> 4}-${green >> 4}-${blue >> 4}`;
    const b = buckets.get(key) ?? { w: 0, r: 0, g: 0, b: 0, n: 0 };
    b.w += weight;
    b.r += red;
    b.g += green;
    b.b += blue;
    b.n++;
    buckets.set(key, b);
  }
  if (!buckets.size) return null;

  let best = null;
  for (const b of buckets.values()) {
    if (!best || b.w > best.w) best = b;
  }
  // Require the winner to cover a meaningful slice of the icon.
  if (!best || best.n < (SIZE * SIZE) * 0.02) return null;
  return rgbToHex(Math.round(best.r / best.n), Math.round(best.g / best.n), Math.round(best.b / best.n));
}

function rgbToHex(r, g, b) {
  return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
}

/** Locate an app icon inside a built .app bundle or a project's assets dir. */
export function findAppIcon(searchPaths) {
  const candidates = [];
  for (const base of searchPaths.filter(Boolean)) {
    if (!fs.existsSync(base)) continue;
    const stat = fs.statSync(base);
    if (stat.isFile()) {
      candidates.push(base);
      continue;
    }
    const entries = fs.readdirSync(base);
    for (const name of entries) {
      if (!/\.(png|jpg|jpeg)$/i.test(name)) continue;
      const full = path.join(base, name);
      let score = 0;
      if (/^AppIcon/i.test(name)) score += 100;
      if (/icon/i.test(name)) score += 60;
      if (/badge/i.test(name)) score += 50;
      if (/logo/i.test(name)) score += 40;
      if (/@3x/i.test(name)) score += 12;
      else if (/@2x/i.test(name)) score += 8;
      if (/ipad/i.test(name)) score -= 30;
      if (/splash|launch/i.test(name)) score -= 80;
      if (score > 0) candidates.push({ full, score, size: fs.statSync(full).size });
    }
  }
  const scored = candidates.filter((c) => typeof c === "object");
  if (scored.length) {
    scored.sort((a, b) => b.score - a.score || b.size - a.size);
    return scored[0].full;
  }
  return candidates.find((c) => typeof c === "string") ?? null;
}

/** Read display name + bundle id straight out of a built .app. */
export function readAppMeta(appPath) {
  if (!appPath || !fs.existsSync(path.join(appPath, "Info.plist"))) return {};
  const plist = path.join(appPath, "Info.plist");
  const get = (key) => {
    const r = run("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plist]);
    return r.code === 0 ? r.stdout.trim() : null;
  };
  return {
    displayName: get("CFBundleDisplayName") || get("CFBundleName"),
    bundleId: get("CFBundleIdentifier"),
    version: get("CFBundleShortVersionString"),
  };
}
