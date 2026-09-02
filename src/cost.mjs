/**
 * Add up every Gemini call the pipeline recorded and price it. Sources:
 * verification.json (verify-video), presentation-review.json, .state/drives.jsonl
 * (drive), and for QA targets run.json (tester) + findings.json (reviewer).
 * Usage objects are {input, output, thought, tool_use, cached, total}; thought
 * and tool-use tokens are billed as output.
 */
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./project.mjs";
import { listRuns, loadQa } from "./qa.mjs";
import { C, log, readJson } from "./util.mjs";

const PRICING = readJson(new URL("./pricing.json", import.meta.url).pathname);

export function priceUsage(model, u) {
  const p = PRICING[model] ?? PRICING["gemini-3.8-flash"];
  u = norm(u);
  if (!u) return 0;
  if (u.input === undefined && u.output === undefined) return ((u.total ?? 0) * p.output) / 1e6;
  const cached = u.cached ?? 0;
  const input = Math.max(0, (u.input ?? 0) - cached);
  const output = (u.output ?? 0) + (u.thought ?? 0) + (u.tool_use ?? 0);
  return (input * p.input + cached * p.cached + output * p.output) / 1e6;
}

/** Older records stored only {total_tokens}; normalise to the current shape. */
function norm(u) {
  if (!u) return null;
  if (u.total === undefined && u.total_tokens !== undefined) return { total: u.total_tokens };
  return u;
}

function line(label, model, u) {
  u = norm(u);
  return { label, model, tokens: u?.total ?? 0, usd: priceUsage(model, u), complete: !!(u && (u.input !== undefined || u.output !== undefined)) };
}

export function costReport({ project, qa }) {
  const rows = [];
  let name;
  if (project) {
    const cfg = loadConfig(project);
    name = `project ${project}`;
    const v = fs.existsSync(cfg.verification) ? readJson(cfg.verification) : null;
    for (const r of v?.results ?? []) if (r.usage) rows.push(line(`verify ${r.clipId}`, r.model, r.usage));
    const pr = path.join(cfg.dir, "presentation-review.json");
    if (fs.existsSync(pr)) {
      const j = readJson(pr);
      if (j.usage) rows.push(line("presentation review", j.model, j.usage));
    }
    const drives = path.join(cfg.state, "drives.jsonl");
    if (fs.existsSync(drives)) {
      for (const l of fs.readFileSync(drives, "utf8").split("\n").filter(Boolean)) {
        const d = JSON.parse(l);
        rows.push(line(`drive ${d.clipId} (${d.turns} turns)`, d.model ?? "gemini-3.8-flash", d.usage));
      }
    }
  } else if (qa) {
    const q = loadQa(qa);
    name = `qa ${qa}`;
    for (const r of listRuns(q)) {
      if (r.run) rows.push(line(`run ${r.n} tester (${r.run.driverTurns ?? "?"} turns)`, r.run.model ?? "gemini-3.8-flash", r.run.driverUsage));
      if (r.findings?.usage) rows.push(line(`run ${r.n} reviewer`, r.findings.model, r.findings.usage));
    }
  }
  return { name, rows, usd: rows.reduce((a, r) => a + r.usd, 0), tokens: rows.reduce((a, r) => a + r.tokens, 0) };
}

export function printCost(rep) {
  log(`${C.bold}${rep.name}${C.reset}`);
  if (!rep.rows.length) log(`  ${C.dim}no recorded Gemini calls${C.reset}`);
  for (const r of rep.rows) {
    const flag = r.complete ? "" : ` ${C.yellow}(total only; priced as output)${C.reset}`;
    log(`  ${r.label.padEnd(40)} ${String(r.tokens).padStart(9)} tok  $${r.usd.toFixed(4).padStart(8)}  ${C.dim}${r.model}${C.reset}${flag}`);
  }
  log(`  ${"".padEnd(40)} ${String(rep.tokens).padStart(9)} tok  ${C.bold}$${rep.usd.toFixed(4).padStart(8)}${C.reset}`);
  return rep.usd;
}
