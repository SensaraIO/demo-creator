import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
};

export function log(msg = "") {
  process.stdout.write(msg + "\n");
}
export function info(msg) {
  log(`${C.cyan}›${C.reset} ${msg}`);
}
export function ok(msg) {
  log(`${C.green}✓${C.reset} ${msg}`);
}
export function warn(msg) {
  log(`${C.yellow}!${C.reset} ${msg}`);
}
export function fail(msg) {
  log(`${C.red}✗${C.reset} ${msg}`);
}

export class UserError extends Error {}

export function die(msg) {
  throw new UserError(msg);
}

/** Run a command to completion, returning {code, stdout, stderr}. Never throws on non-zero. */
export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 256,
    ...opts,
  });
  if (r.error) die(`failed to run ${cmd}: ${r.error.message}`);
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Run a command, dying with its stderr if it exits non-zero. */
export function runOrDie(cmd, args, opts = {}) {
  const r = run(cmd, args, opts);
  if (r.code !== 0) {
    die(`${cmd} ${args.join(" ")} exited ${r.code}\n${r.stderr.trim() || r.stdout.trim()}`);
  }
  return r;
}

export function which(bin) {
  const r = run("/usr/bin/which", [bin]);
  return r.code === 0 ? r.stdout.trim() : null;
}

export function spawnDetached(cmd, args, { logFile } = {}) {
  const out = logFile ? fs.openSync(logFile, "a") : "ignore";
  const child = spawn(cmd, args, {
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  return child.pid;
}

export function readJson(file, fallback = undefined) {
  if (!fs.existsSync(file)) {
    if (fallback !== undefined) return fallback;
    die(`missing file: ${file}`);
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    die(`invalid JSON in ${file}: ${e.message}`);
  }
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function slug(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function humanDuration(seconds) {
  if (!Number.isFinite(seconds)) return "—";
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

export function nowIso() {
  return new Date().toISOString();
}

/** Parse `--key value` / `--flag` / positional args into {_: [...], key: value}. */
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        out[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) {
          out[a.slice(2)] = true;
        } else {
          out[a.slice(2)] = next;
          i++;
        }
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}
