/**
 * Builds the client-facing deliverable: a static, offline-capable page that puts
 * each BRS requirement next to the video proving it.
 *
 * The whole point is one-to-one traceability — the client reads the clause they
 * signed off on, and watches that exact clause working, without having to take
 * anyone's word for the mapping.
 */
import fs from "node:fs";
import path from "node:path";
import { renderMarkdown } from "./md.mjs";
import { sectionWithChildren } from "./brs.mjs";
import { probeDuration, probeIsLandscape } from "./record.mjs";
import { escapeHtml, ensureDir, humanDuration, readJson } from "./util.mjs";

const STATUS = {
  demo: { label: "Demonstrated", cls: "ok" },
  unverified: { label: "Recorded", cls: "warn" },
  pending: { label: "Not yet recorded", cls: "todo" },
  backend: { label: "Backend / not visually demonstrable", cls: "muted" },
  narrative: { label: "Narrative — no requirement to demo", cls: "muted" },
  // Deliberately distinct from "pending": this is a requirement the build does
  // not meet, and it must never read as "we just haven't filmed it yet".
  "not-implemented": { label: "Not in the delivered build", cls: "gap" },
};

function copyInto(src, destDir, name) {
  if (!src || !fs.existsSync(src)) return null;
  ensureDir(destDir);
  const dest = path.join(destDir, name);
  fs.copyFileSync(src, dest);
  return name;
}

/** Resolve every section to a status + optional clip, from the plan and verification. */
function buildIndex(brs, plan, verification, cfg) {
  const byId = new Map(brs.sections.map((s) => [s.id, s]));
  const clipsBySection = new Map();
  const clips = plan?.clips ?? [];

  for (const clip of clips) {
    for (const sid of clip.sectionIds ?? []) {
      if (!clipsBySection.has(sid)) clipsBySection.set(sid, []);
      clipsBySection.get(sid).push(clip);
    }
  }

  const verdicts = new Map((verification?.results ?? []).map((v) => [v.clipId, v]));
  const coverage = new Map(Object.entries(plan?.coverage ?? {}));

  const entries = [];
  for (const section of brs.sections) {
    const cov = coverage.get(section.id) ?? {};
    const sectionClips = (clipsBySection.get(section.id) ?? []).map((clip) => {
      const file = path.join(cfg.recordings, `${clip.id}.mp4`);
      const poster = path.join(cfg.recordings, `${clip.id}.jpg`);
      const verdict = verdicts.get(clip.id) ?? null;
      const exists = fs.existsSync(file);
      const duration = exists ? probeDuration(file) : null;
      return {
        ...clip,
        exists,
        file,
        poster: fs.existsSync(poster) ? poster : null,
        durationLabel: duration ? humanDuration(duration) : null,
        verdict,
      };
    });

    let status;
    if (cov.status === "backend" || cov.status === "non-visual") status = "backend";
    else if (cov.status === "narrative" || cov.status === "informational") status = "narrative";
    else if (cov.status === "not-implemented") status = "not-implemented";
    else if (sectionClips.some((c) => c.exists && c.verdict?.pass)) status = "demo";
    else if (sectionClips.some((c) => c.exists)) status = "unverified";
    else status = "pending";

    entries.push({ section, status, clips: sectionClips, reason: cov.reason ?? null });
  }
  return { entries, byId };
}

function statusPill(status) {
  const s = STATUS[status] ?? STATUS.pending;
  return `<span class="pill ${s.cls}">${escapeHtml(s.label)}</span>`;
}

/**
 * One clip rendered as the phone video and its "what to look for" list side by
 * side — the video is the proof, the list is how to read it, so they belong
 * next to each other rather than stacked.
 */
function demoPair(clip, mediaName, posterName, landscape = false) {
  if (!clip.exists) return "";
  const poster = posterName ? ` poster="media/${posterName}"` : "";
  const items = clip.evidence ?? [];
  const watch = items.length
    ? `<div class="watch">
        <h5>What to look for</h5>
        <ul>${items.map((e) => `<li>${escapeHtml(e)}</li>`).join("")}</ul>
      </div>`
    : "";
  const frame = landscape
    ? `<div class="device browser">
          <div class="chrome"><i></i><i></i><i></i></div>
          <video src="media/${mediaName}"${poster} controls playsinline preload="none"></video>
        </div>`
    : `<div class="device">
          <video src="media/${mediaName}"${poster} controls playsinline preload="none"></video>
        </div>`;
  return `
    <div class="demo-pair${landscape ? " wide" : ""}">
      <figure class="demo">
        ${frame}
        <figcaption>
          <span class="clip-title">${escapeHtml(clip.title ?? clip.id)}</span>
          ${clip.durationLabel ? `<span class="clip-meta">${escapeHtml(clip.durationLabel)}</span>` : ""}
        </figcaption>
      </figure>
      ${watch}
    </div>`;
}

export function buildPresentation(cfg, { open = false } = {}) {
  const brs = readJson(cfg.brs);
  const plan = fs.existsSync(cfg.plan) ? readJson(cfg.plan) : { clips: [], coverage: {} };
  const verification = fs.existsSync(cfg.verification) ? readJson(cfg.verification) : { results: [] };

  const dist = ensureDir(cfg.dist);
  const mediaDir = path.join(dist, "media");
  const assetDir = path.join(dist, "assets");
  fs.rmSync(mediaDir, { recursive: true, force: true });

  const { entries } = buildIndex(brs, plan, verification, cfg);

  // Copy media for every clip that actually recorded.
  const mediaNames = new Map();
  for (const entry of entries) {
    for (const clip of entry.clips) {
      if (!clip.exists || mediaNames.has(clip.id)) continue;
      const v = copyInto(clip.file, mediaDir, `${clip.id}.mp4`);
      const p = copyInto(clip.poster, mediaDir, `${clip.id}.jpg`);
      mediaNames.set(clip.id, { video: v, poster: p, landscape: probeIsLandscape(clip.file) });
    }
  }

  // Optional bonus deliverable: the single continuous walkthrough (recordings/master-full.mp4).
  const fullWalkthrough = copyInto(path.join(cfg.recordings, "master-full.mp4"), mediaDir, "full-walkthrough.mp4");

  const iconName = copyInto(cfg.iconPath, assetDir, "icon.png");
  const splashName = copyInto(cfg.splashPath, assetDir, "splash.png");
  const brsCopy = copyInto(cfg.brsSourcePath, assetDir, path.basename(cfg.brsSourcePath ?? "brs.docx"));

  const demoable = entries.filter((e) => e.status === "demo" || e.status === "unverified" || e.status === "pending");
  const shown = demoable.filter((e) => e.clips.some((c) => c.exists));
  const covered = entries.filter((e) => e.status === "demo").length;
  const recorded = entries.filter((e) => e.status === "demo" || e.status === "unverified").length;
  const backend = entries.filter((e) => e.status === "backend").length;

  const accent = cfg.brandColor || "#4f46e5";

  const html = page({
    cfg,
    brs,
    entries,
    shown,
    stats: {
      covered,
      recorded,
      backend,
      demoable: demoable.length,
      total: entries.length,
      clipsTotal: mediaNames.size,
    },
    mediaNames,
    iconName,
    splashName,
    brsCopy,
    fullWalkthrough,
    accent,
    generatedAt: new Date(),
  });

  fs.writeFileSync(path.join(dist, "index.html"), html);
  return {
    dist,
    indexPath: path.join(dist, "index.html"),
    stats: { covered, recorded, backend, demoable: demoable.length, total: entries.length, clips: mediaNames.size },
  };
}

function navTree(entries) {
  const out = [];
  for (const entry of entries) {
    const { section, status } = entry;
    // Requirements live as deep as level 5 (e.g. "5.1.1"); those are exactly the
    // sections that carry videos, so they must appear in the nav. Only skip
    // anything deeper than that to keep the tree readable.
    if (section.level > 5) continue;
    const has = entry.clips.some((c) => c.exists);
    const cls = [
      "nav-item",
      `lvl-${section.level}`,
      status === "backend" || status === "narrative" ? "is-muted" : "",
      has ? "has-demo" : "",
    ]
      .filter(Boolean)
      .join(" ");
    out.push(
      `<a class="${cls}" href="#req-${escapeHtml(section.id)}" data-status="${status}">
         <span class="nav-dot"></span>
         <span class="nav-num">${escapeHtml(section.number ?? "")}</span>
         <span class="nav-label">${escapeHtml(section.title)}</span>
       </a>`,
    );
  }
  return out.join("\n");
}

function walkthrough(entries, mediaNames) {
  const out = [];
  for (const entry of entries) {
    const { section, status, clips } = entry;
    const playable = clips.filter((c) => c.exists);
    if (!playable.length) continue;

    // The panel header already shows this section's title, so render its body
    // plus descendants but drop the section's own heading.
    const full = sectionWithChildren({ sections: entriesToSections(entries) }, section.id);
    const doc = renderMarkdown(full.replace(/^#{1,6}\s+.*(?:\n|$)/, "").trim());

    const videos = playable
      .map((c) => {
        const m = mediaNames.get(c.id) ?? {};
        return demoPair(c, m.video, m.poster, m.landscape);
      })
      .join("\n");

    out.push(`
      <article class="req" id="req-${escapeHtml(section.id)}">
        <header class="req-head">
          <div class="req-id">${escapeHtml(section.number ?? "—")}</div>
          <div class="req-titles">
            <h2>${escapeHtml(section.title)}</h2>
            <div class="req-trail">${escapeHtml(section.path.slice(0, -1).join("  ›  "))}</div>
          </div>
          ${statusPill(status)}
        </header>
        <div class="req-split">
          <div class="req-doc">
            <div class="doc-label">Your BRS, verbatim</div>
            <div class="prose">${doc}</div>
          </div>
          <div class="req-demo-col">
            <div class="doc-label">The delivered app</div>
            ${videos}
          </div>
        </div>
      </article>`);
  }
  return out.join("\n");
}

// The walkthrough needs the raw section list for sectionWithChildren().
function entriesToSections(entries) {
  return entries.map((e) => e.section);
}

function fullBrs(entries, mediaNames) {
  const out = [];
  for (const entry of entries) {
    const { section, status, clips } = entry;
    const playable = clips.filter((c) => c.exists);
    const level = Math.min(6, section.level + 1);
    let jump = "";
    if (playable.length) {
      jump = `<a class="jump" href="#req-${escapeHtml(section.id)}" data-goto="walkthrough">▶ Watch this working</a>`;
    } else if (status === "backend") {
      jump = `<span class="jump muted-jump">Not visible on screen</span>`;
    } else if (status === "not-implemented") {
      jump = `<span class="jump gap-jump">Not in the delivered build</span>`;
    }

    // The planner's reason is written for the client to read — it is the only
    // place a gap or an omission gets explained, so it must not be swallowed.
    const note =
      entry.reason && (status === "backend" || status === "not-implemented")
        ? `<p class="sec-note ${status === "not-implemented" ? "gap-note" : ""}">${escapeHtml(entry.reason)}</p>`
        : "";

    out.push(`
      <section class="brs-sec" id="brs-${escapeHtml(section.id)}">
        <h${level}>
          ${section.number ? `<span class="brs-num">${escapeHtml(section.number)}</span>` : ""}
          ${escapeHtml(section.title)}
          ${jump}
        </h${level}>
        ${note}
        <div class="prose">${renderMarkdown(section.body)}</div>
      </section>`);
  }
  return out.join("\n");
}

function page({ cfg, brs, entries, shown, stats, mediaNames, iconName, splashName, brsCopy, fullWalkthrough, accent, generatedAt }) {
  const appName = cfg.appName ?? brs.title;
  const client = cfg.clientName ?? "";
  const dateLabel = generatedAt.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(appName)} — Delivery Walkthrough</title>
<style>
:root{
  --accent:${accent};
  --bg:#fbfbfd; --panel:#fff; --ink:#14151a; --ink-2:#5b6070; --ink-3:#8a90a2;
  --line:#e6e7ee; --line-2:#f0f1f6;
  --ok:#0f9d58; --ok-bg:#e8f6ee; --warn:#b8860b; --warn-bg:#fdf5e3;
  --todo:#b04a4a; --todo-bg:#fceded; --muted-bg:#f2f3f7;
  --radius:16px;
  --shadow:0 1px 2px rgba(16,18,32,.05), 0 8px 24px rgba(16,18,32,.06);
  --font:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Inter,system-ui,sans-serif;
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#0e0f13; --panel:#16181f; --ink:#f2f3f7; --ink-2:#a7adbe; --ink-3:#767d92;
    --line:#262932; --line-2:#1e2029;
    --ok:#4ade80; --ok-bg:#12271b; --warn:#fbbf24; --warn-bg:#2a2210;
    --todo:#f87171; --todo-bg:#2b1616; --muted-bg:#1c1f27;
    --shadow:0 1px 2px rgba(0,0,0,.4), 0 8px 28px rgba(0,0,0,.35);
  }
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--font);
  font-size:15px;line-height:1.6;-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none}
h1,h2,h3,h4,h5,h6{line-height:1.25;letter-spacing:-.015em;margin:0}

/* ---------- top bar ---------- */
.topbar{position:sticky;top:0;z-index:50;display:flex;align-items:center;gap:16px;
  padding:12px 24px;background:color-mix(in srgb,var(--panel) 88%,transparent);
  backdrop-filter:saturate(180%) blur(16px);border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:12px;min-width:0}
.brand img{width:34px;height:34px;border-radius:9px;box-shadow:var(--shadow)}
.brand-text{min-width:0}
.brand-name{font-weight:650;font-size:15px;letter-spacing:-.02em;white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis}
.brand-sub{font-size:11.5px;color:var(--ink-3);letter-spacing:.02em}
.tabs{display:flex;gap:2px;margin-left:auto;background:var(--muted-bg);padding:3px;border-radius:11px}
.tab{appearance:none;border:0;background:transparent;color:var(--ink-2);font:inherit;font-size:13px;
  font-weight:550;padding:7px 15px;border-radius:8px;cursor:pointer;white-space:nowrap}
.tab[aria-selected="true"]{background:var(--panel);color:var(--ink);box-shadow:var(--shadow)}

/* ---------- cover ---------- */
.cover{max-width:1180px;margin:0 auto;padding:72px 24px 40px;text-align:center}
.cover-icon{width:92px;height:92px;border-radius:22px;box-shadow:var(--shadow);margin-bottom:26px}
.cover h1{font-size:clamp(30px,4.6vw,46px);font-weight:700;letter-spacing:-.03em}
.cover .kicker{color:var(--accent);font-weight:650;font-size:12.5px;letter-spacing:.1em;
  text-transform:uppercase;margin-bottom:14px}
.cover .lede{color:var(--ink-2);font-size:17px;max-width:640px;margin:16px auto 0}
.stats{display:flex;flex-wrap:wrap;gap:12px;justify-content:center;margin:38px 0 30px}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:14px;
  padding:16px 22px;min-width:132px;box-shadow:var(--shadow)}
.stat b{display:block;font-size:27px;font-weight:700;letter-spacing:-.03em}
.stat span{font-size:11.5px;color:var(--ink-3);text-transform:uppercase;letter-spacing:.06em}
.cta{display:inline-flex;gap:10px;align-items:center;background:var(--accent);color:#fff;
  font-weight:600;font-size:14.5px;padding:13px 26px;border-radius:12px;border:0;cursor:pointer;
  font-family:inherit;box-shadow:var(--shadow)}
.cta.ghost{background:var(--panel);color:var(--ink);border:1px solid var(--line)}
.cta-row{display:flex;gap:12px;justify-content:center;flex-wrap:wrap}
.how{max-width:720px;margin:56px auto 0;text-align:left;background:var(--panel);
  border:1px solid var(--line);border-radius:var(--radius);padding:24px 28px;box-shadow:var(--shadow)}
.how h3{font-size:14px;margin-bottom:12px}
.how ol{margin:0;padding-left:20px;color:var(--ink-2);font-size:14px}
.how li{margin:7px 0}

/* ---------- layout ---------- */
.view{display:none}
.view.active{display:block}
.shell{display:grid;grid-template-columns:296px minmax(0,1fr);gap:0;max-width:1560px;margin:0 auto}
.sidebar{position:sticky;top:59px;align-self:start;height:calc(100vh - 59px);overflow-y:auto;
  padding:22px 12px 60px;border-right:1px solid var(--line)}
.sidebar h4{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--ink-3);
  padding:0 12px;margin:0 0 10px}
.nav-item{display:grid;grid-template-columns:14px 34px 1fr;align-items:baseline;gap:7px;
  padding:6px 12px;border-radius:9px;color:var(--ink-2);font-size:13.2px;line-height:1.4}
.nav-item:hover{background:var(--muted-bg);color:var(--ink)}
.nav-item.active{background:color-mix(in srgb,var(--accent) 12%,transparent);color:var(--ink);font-weight:600}
.nav-item.lvl-2{font-weight:640;color:var(--ink);margin-top:12px;font-size:13.6px}
.nav-item.lvl-4{padding-left:26px;font-size:12.6px}
.nav-item.lvl-5{padding-left:40px;font-size:12.4px}
.nav-item.is-muted{opacity:.5}
.nav-dot{width:7px;height:7px;border-radius:50%;background:var(--line);transform:translateY(-1px)}
.nav-item.has-demo .nav-dot{background:var(--accent)}
.nav-num{color:var(--ink-3);font-variant-numeric:tabular-nums;font-size:11.5px}
.nav-toggle{display:flex;align-items:center;gap:8px;padding:10px 12px;margin-top:16px;
  border-top:1px solid var(--line);font-size:12.5px;color:var(--ink-3)}

.main{padding:30px 34px 120px;min-width:0}

/* ---------- requirement panels ---------- */
.req{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);
  padding:26px 28px;margin-bottom:26px;box-shadow:var(--shadow);scroll-margin-top:78px}
.req-head{display:flex;align-items:flex-start;gap:14px;padding-bottom:18px;
  border-bottom:1px solid var(--line-2);margin-bottom:20px}
.req-id{font-variant-numeric:tabular-nums;font-weight:700;font-size:13px;color:#fff;
  background:var(--accent);border-radius:8px;padding:5px 10px;white-space:nowrap;margin-top:2px}
.req-titles{flex:1;min-width:0}
.req-titles h2{font-size:20px;font-weight:660}
.req-trail{font-size:12px;color:var(--ink-3);margin-top:3px}
.pill{font-size:11.5px;font-weight:600;padding:5px 11px;border-radius:999px;white-space:nowrap}
.pill.ok{background:var(--ok-bg);color:var(--ok)}
.pill.warn{background:var(--warn-bg);color:var(--warn)}
.pill.todo{background:var(--todo-bg);color:var(--todo)}
.pill.muted{background:var(--muted-bg);color:var(--ink-3)}
.pill.gap{background:var(--todo-bg);color:var(--todo)}

.req-split{display:grid;grid-template-columns:minmax(260px,0.82fr) minmax(0,1.18fr);gap:30px;align-items:start}
.doc-label{font-size:10.5px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;
  color:var(--ink-3);margin-bottom:12px}
.req-demo-col{min-width:0}
/* Each clip: phone video and its "what to look for" list, side by side. */
.demo-pair{display:flex;gap:20px;align-items:flex-start;margin-bottom:22px}
.demo-pair:last-child{margin-bottom:0}
.demo-pair .demo{flex:0 0 232px;max-width:232px}
.demo-pair .watch{flex:1 1 auto;margin-top:0;align-self:stretch}

/* Wide (landscape/browser) recordings: full-width video, notes underneath. */
.demo-pair.wide{flex-direction:column}
.demo-pair.wide .demo{flex:1 1 auto;max-width:100%;width:100%}
.demo-pair.wide .watch{width:100%}

/* ---------- device frame ---------- */
.device{background:#0b0b0f;border-radius:34px;padding:9px;box-shadow:0 10px 40px rgba(16,18,32,.22);
  border:1px solid rgba(255,255,255,.08)}
.device video{display:block;width:100%;border-radius:26px;background:#000}
.device.browser{border-radius:14px;padding:0;overflow:hidden}
.device.browser .chrome{display:flex;gap:6px;padding:10px 14px;background:#16161c;
  border-bottom:1px solid rgba(255,255,255,.06)}
.device.browser .chrome i{width:10px;height:10px;border-radius:50%;background:#33333d;display:block}
.device.browser video{border-radius:0}
.demo{margin:0}
.demo figcaption{display:flex;gap:8px;align-items:baseline;justify-content:space-between;
  margin-top:11px;font-size:12.5px;color:var(--ink-2)}
.clip-title{font-weight:560}
.clip-meta{color:var(--ink-3);font-variant-numeric:tabular-nums}
.watch{background:var(--muted-bg);border-radius:12px;padding:15px 17px;
  border-left:3px solid color-mix(in srgb,var(--accent) 55%,transparent)}
.watch h5{font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--accent);margin-bottom:9px;font-weight:700}
.watch ul{margin:0;padding-left:16px;font-size:13.2px;color:var(--ink-2);line-height:1.5}
.watch li{margin:6px 0}

/* ---------- prose ---------- */
.prose{color:var(--ink-2);font-size:14.2px}
.prose h3,.prose h4,.prose h5,.prose h6{color:var(--ink);margin:20px 0 8px;font-size:14px;font-weight:650}
.prose h3:first-child,.prose h4:first-child{margin-top:0}
.prose p{margin:9px 0}
.prose ul,.prose ol{margin:9px 0;padding-left:21px}
.prose li{margin:4px 0}
.prose strong{color:var(--ink);font-weight:620}
.prose code{background:var(--muted-bg);padding:1px 5px;border-radius:5px;font-size:12.6px}
.table-wrap{overflow-x:auto;margin:12px 0}
.prose table{border-collapse:collapse;width:100%;font-size:13px}
.prose th,.prose td{border:1px solid var(--line);padding:7px 10px;text-align:left}
.prose th{background:var(--muted-bg);font-weight:620;color:var(--ink)}

/* ---------- full BRS ---------- */
.doc{max-width:900px;margin:0 auto;padding:36px 24px 120px}
.doc-head{border-bottom:1px solid var(--line);padding-bottom:22px;margin-bottom:28px}
.doc-head h1{font-size:30px;font-weight:700;letter-spacing:-.028em}
.doc-head p{color:var(--ink-3);font-size:13.5px;margin:8px 0 0}
.brs-sec{scroll-margin-top:78px;margin-bottom:6px}
.brs-sec h2,.brs-sec h3,.brs-sec h4,.brs-sec h5,.brs-sec h6{
  display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin:26px 0 8px;color:var(--ink)}
.brs-sec h2{font-size:23px;font-weight:680;padding-top:16px;border-top:1px solid var(--line)}
.brs-sec h3{font-size:18px;font-weight:660}
.brs-sec h4,.brs-sec h5,.brs-sec h6{font-size:15px;font-weight:640}
.brs-num{font-variant-numeric:tabular-nums;color:var(--accent);font-weight:700}
.jump{font-size:11.5px;font-weight:620;background:color-mix(in srgb,var(--accent) 13%,transparent);
  color:var(--accent);padding:4px 10px;border-radius:999px;white-space:nowrap}
.jump:hover{background:color-mix(in srgb,var(--accent) 22%,transparent)}
.muted-jump{background:var(--muted-bg);color:var(--ink-3);font-weight:500}
.gap-jump{background:var(--todo-bg);color:var(--todo)}
.sec-note{margin:8px 0 4px;padding:10px 14px;border-left:3px solid var(--line);
  background:var(--muted-bg);border-radius:0 9px 9px 0;font-size:13.2px;color:var(--ink-2)}
.sec-note.gap-note{border-left-color:var(--todo);background:var(--todo-bg);color:var(--todo)}

.footer{border-top:1px solid var(--line);padding:26px 24px;text-align:center;
  color:var(--ink-3);font-size:12.5px}

@media (max-width:1180px){
  .req-split{grid-template-columns:1fr;gap:24px}
  .req-demo-col{max-width:none}
}
@media (max-width:900px){
  .shell{grid-template-columns:1fr}
  .sidebar{display:none}
  .main{padding:22px 16px 80px}
  .req{padding:20px 18px}
}
@media (max-width:560px){
  /* Stack the video above its "what to look for" list on small screens. */
  .demo-pair{flex-direction:column}
  .demo-pair .demo{flex-basis:auto;max-width:280px;align-self:center}
  .demo-pair .watch{align-self:stretch}
}
@media (max-width:680px){
  .topbar{padding:10px 14px;gap:10px}
  .brand img{width:30px;height:30px}
  .brand-sub{display:none}
  .brand-name{font-size:14px}
  .tab{padding:6px 11px;font-size:12px}
  .cover{padding:48px 18px 32px}
  .stat{min-width:104px;padding:13px 16px}
}
</style>
</head>
<body>

<div class="topbar">
  <div class="brand">
    ${iconName ? `<img src="assets/${iconName}" alt="">` : ""}
    <div class="brand-text">
      <div class="brand-name">${escapeHtml(appName)}</div>
      <div class="brand-sub">${escapeHtml(client ? `${client} · Delivery Walkthrough` : "Delivery Walkthrough")}</div>
    </div>
  </div>
  <div class="tabs" role="tablist">
    <button class="tab" role="tab" data-view="cover" aria-selected="true">Overview</button>
    <button class="tab" role="tab" data-view="walkthrough" aria-selected="false">Walkthrough</button>
    <button class="tab" role="tab" data-view="brs" aria-selected="false">Full BRS</button>
  </div>
</div>

<!-- ===== Overview ===== -->
<div class="view active" id="view-cover">
  <div class="cover">
    ${iconName ? `<img class="cover-icon" src="assets/${iconName}" alt="">` : ""}
    <div class="kicker">Delivery Walkthrough</div>
    <h1>${escapeHtml(appName)}</h1>
    <p class="lede">Every functional requirement in your Business Requirements Specification, shown side by side with a recording of that exact requirement working in the delivered app.</p>
    <div class="stats">
      <div class="stat"><b>${stats.recorded}</b><span>Requirements shown</span></div>
      <div class="stat"><b>${stats.clipsTotal ?? shown.length}</b><span>Demo recordings</span></div>
      <div class="stat"><b>${stats.backend}</b><span>Backend-only items</span></div>
    </div>
    <div class="cta-row">
      <button class="cta" data-goto="walkthrough">Start the walkthrough →</button>
      <button class="cta ghost" data-goto="brs">Read the full BRS</button>
      ${brsCopy ? `<a class="cta ghost" href="assets/${escapeHtml(brsCopy)}" download>Download original BRS</a>` : ""}
      ${fullWalkthrough ? `<a class="cta ghost" href="media/${escapeHtml(fullWalkthrough)}" target="_blank" rel="noopener">Watch the full walkthrough (one take)</a>` : ""}
    </div>
    <div class="how">
      <h3>How to read this</h3>
      <ol>
        <li><b>Walkthrough</b> pairs each requirement with its recording. The BRS text on the left is copied verbatim from your document — nothing paraphrased.</li>
        <li><b>Full BRS</b> is your complete specification. Sections with a recording carry a “Watch this working” link.</li>
        <li>Items marked <b>backend / not visually demonstrable</b> have no on-screen behaviour to film — server rules, storage, and third-party API mechanics.</li>
      </ol>
    </div>
  </div>
  <div class="footer">Prepared ${escapeHtml(dateLabel)}${client ? ` for ${escapeHtml(client)}` : ""}</div>
</div>

<!-- ===== Walkthrough ===== -->
<div class="view" id="view-walkthrough">
  <div class="shell">
    <nav class="sidebar" id="sidebar">
      <h4>Requirements</h4>
      ${navTree(entries)}
      <div class="nav-toggle">
        <input type="checkbox" id="show-muted"> <label for="show-muted">Show backend-only items</label>
      </div>
    </nav>
    <main class="main">
      ${walkthrough(entries, mediaNames) || `<div class="req"><p class="prose">No recordings have been produced yet. Run <code>demo-creator record</code> and rebuild.</p></div>`}
    </main>
  </div>
</div>

<!-- ===== Full BRS ===== -->
<div class="view" id="view-brs">
  <div class="doc">
    <div class="doc-head">
      <h1>${escapeHtml(brs.title)}</h1>
      <p>${escapeHtml(client ? `${client} · ` : "")}Complete specification as signed off${brsCopy ? " · " : ""}${brsCopy ? `<a href="assets/${escapeHtml(brsCopy)}" download>download original</a>` : ""}</p>
    </div>
    ${brs.preamble ? `<div class="prose">${renderMarkdown(brs.preamble)}</div>` : ""}
    ${fullBrs(entries, mediaNames)}
  </div>
  <div class="footer">Prepared ${escapeHtml(dateLabel)}${client ? ` for ${escapeHtml(client)}` : ""}</div>
</div>

<script>
(function(){
  var views = {
    cover: document.getElementById('view-cover'),
    walkthrough: document.getElementById('view-walkthrough'),
    brs: document.getElementById('view-brs')
  };
  var tabs = [].slice.call(document.querySelectorAll('.tab'));

  function show(name, anchor){
    Object.keys(views).forEach(function(k){ views[k].classList.toggle('active', k === name); });
    tabs.forEach(function(t){ t.setAttribute('aria-selected', String(t.dataset.view === name)); });
    // Pause anything playing when leaving the walkthrough.
    if (name !== 'walkthrough') {
      [].forEach.call(document.querySelectorAll('video'), function(v){ v.pause(); });
    }
    if (anchor) {
      var el = document.getElementById(anchor);
      if (el) { el.scrollIntoView(); return; }
    }
    window.scrollTo(0, 0);
  }

  document.addEventListener('click', function(e){
    var tab = e.target.closest('.tab');
    if (tab) { show(tab.dataset.view); return; }

    var goto = e.target.closest('[data-goto]');
    if (goto) {
      e.preventDefault();
      var href = goto.getAttribute('href') || '';
      show(goto.dataset.goto, href.charAt(0) === '#' ? href.slice(1) : null);
      return;
    }

    var nav = e.target.closest('.nav-item');
    if (nav) {
      e.preventDefault();
      var id = nav.getAttribute('href').slice(1);
      var target = document.getElementById(id);
      if (target) target.scrollIntoView();
      else show('brs', 'brs-' + id.replace(/^req-/, ''));
    }
  });

  // Highlight the requirement currently in view.
  var items = [].slice.call(document.querySelectorAll('.nav-item'));
  var byHash = {};
  items.forEach(function(i){ byHash[i.getAttribute('href')] = i; });
  var obs = new IntersectionObserver(function(entries){
    entries.forEach(function(en){
      if (!en.isIntersecting) return;
      items.forEach(function(i){ i.classList.remove('active'); });
      var item = byHash['#' + en.target.id];
      if (item) {
        item.classList.add('active');
        var side = document.getElementById('sidebar');
        var top = item.offsetTop - side.clientHeight / 2;
        if (Math.abs(side.scrollTop - top) > side.clientHeight / 2) side.scrollTop = top;
      }
    });
  }, { rootMargin: '-72px 0px -60% 0px' });
  [].forEach.call(document.querySelectorAll('.req'), function(r){ obs.observe(r); });

  // Backend-only items are hidden by default: they have nothing to watch.
  var toggle = document.getElementById('show-muted');
  function applyToggle(){
    var on = toggle && toggle.checked;
    [].forEach.call(document.querySelectorAll('.nav-item.is-muted'), function(n){
      n.style.display = on ? '' : 'none';
    });
  }
  if (toggle) { toggle.addEventListener('change', applyToggle); applyToggle(); }

  // Only one clip plays at a time.
  document.addEventListener('play', function(e){
    [].forEach.call(document.querySelectorAll('video'), function(v){ if (v !== e.target) v.pause(); });
  }, true);

  if (location.hash) {
    var h = location.hash.slice(1);
    if (h.indexOf('req-') === 0) show('walkthrough', h);
    else if (h.indexOf('brs-') === 0) show('brs', h);
  }
})();
</script>
</body>
</html>
`;
}
