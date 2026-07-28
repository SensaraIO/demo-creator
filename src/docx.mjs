/**
 * Minimal, dependency-free .docx -> Markdown converter.
 *
 * Scoped deliberately at what BRS documents actually contain: headings, bullet /
 * numbered lists, bold+italic runs, tables, and paragraphs. Anything exotic
 * degrades to plain text rather than throwing, because a BRS that half-converts
 * is far more useful than one that errors out.
 */
import { runOrDie } from "./util.mjs";

function unescapeXml(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");
}

function readEntry(file, entry) {
  const r = runOrDie("/usr/bin/unzip", ["-p", file, entry], { encoding: "utf8" });
  return r.stdout;
}

/** Map numbering.xml numId -> per-level format, so we can tell bullets from ordered lists. */
function parseNumbering(xml) {
  if (!xml) return {};
  const abstractFmt = {};
  for (const m of xml.matchAll(/<w:abstractNum\b[^>]*w:abstractNumId="(\d+)"[\s\S]*?<\/w:abstractNum>/g)) {
    const id = m[1];
    const levels = {};
    for (const lvl of m[0].matchAll(/<w:lvl\b[^>]*w:ilvl="(\d+)"[\s\S]*?<\/w:lvl>/g)) {
      const fmt = lvl[0].match(/<w:numFmt w:val="([^"]+)"/);
      levels[lvl[1]] = fmt ? fmt[1] : "bullet";
    }
    abstractFmt[id] = levels;
  }
  const numToAbstract = {};
  for (const m of xml.matchAll(/<w:num\b[^>]*w:numId="(\d+)"[\s\S]*?<w:abstractNumId w:val="(\d+)"[\s\S]*?<\/w:num>/g)) {
    numToAbstract[m[1]] = m[2];
  }
  const out = {};
  for (const [numId, absId] of Object.entries(numToAbstract)) {
    out[numId] = abstractFmt[absId] ?? {};
  }
  return out;
}

/** Extract a paragraph's text, wrapping bold/italic runs in Markdown emphasis. */
function paragraphText(pXml) {
  let out = "";
  for (const runM of pXml.matchAll(/<w:r(?:\s[^>]*)?>([\s\S]*?)<\/w:r>/g)) {
    const runXml = runM[1];
    const rPr = runXml.match(/<w:rPr>[\s\S]*?<\/w:rPr>/);
    const props = rPr ? rPr[0] : "";
    // <w:b/> sets bold; <w:b w:val="0"/> explicitly clears it.
    const bold = /<w:b\b(?![^>]*w:val="(?:0|false)")[^>]*\/?>/.test(props);
    const italic = /<w:i\b(?![^>]*w:val="(?:0|false)")[^>]*\/?>/.test(props);

    let text = "";
    for (const piece of runXml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>/g)) {
      if (piece[1] !== undefined) text += unescapeXml(piece[1]);
      else if (piece[0] === "<w:tab/>") text += " ";
      else text += " ";
    }
    if (!text) continue;

    // Emphasis markers must hug the text or Markdown won't render them.
    const lead = text.match(/^\s*/)[0];
    const trail = text.match(/\s*$/)[0];
    const core = text.slice(lead.length, text.length - trail.length);
    if (core) {
      let wrapped = core;
      if (bold) wrapped = `**${wrapped}**`;
      if (italic) wrapped = `*${wrapped}*`;
      text = lead + wrapped + trail;
    }
    out += text;
  }
  return out.replace(/\s+/g, " ").trim();
}

function headingLevel(pXml) {
  const m = pXml.match(/<w:pStyle w:val="(?:Heading|heading)\s*(\d)"/);
  if (m) return Number(m[1]);
  const outline = pXml.match(/<w:outlineLvl w:val="(\d+)"/);
  if (outline) return Number(outline[1]) + 1;
  return null;
}

function tableToMarkdown(tblXml) {
  const rows = [];
  for (const trM of tblXml.matchAll(/<w:tr(?:\s[^>]*)?>([\s\S]*?)<\/w:tr>/g)) {
    const cells = [];
    for (const tcM of trM[1].matchAll(/<w:tc(?:\s[^>]*)?>([\s\S]*?)<\/w:tc>/g)) {
      const paras = [...tcM[1].matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)]
        .map((p) => paragraphText(p[1]))
        .filter(Boolean);
      cells.push(paras.join(" ").replace(/\|/g, "\\|"));
    }
    if (cells.length) rows.push(cells);
  }
  if (!rows.length) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r) => [...r, ...Array(width - r.length).fill("")];
  const lines = [
    `| ${pad(rows[0]).join(" | ")} |`,
    `| ${Array(width).fill("---").join(" | ")} |`,
    ...rows.slice(1).map((r) => `| ${pad(r).join(" | ")} |`),
  ];
  return lines.join("\n");
}

/**
 * Convert a .docx file to Markdown.
 * @returns {{markdown: string, title: string|null}}
 */
export function docxToMarkdown(file) {
  const doc = readEntry(file, "word/document.xml");
  let numbering = {};
  try {
    numbering = parseNumbering(readEntry(file, "word/numbering.xml"));
  } catch {
    // numbering.xml is optional; without it every list renders as bullets.
  }

  const body = doc.match(/<w:body>([\s\S]*)<\/w:body>/)?.[1] ?? doc;

  // Walk top-level paragraphs and tables in document order.
  const blocks = [...body.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>|<w:tbl>[\s\S]*?<\/w:tbl>/g)];

  const out = [];
  let title = null;
  // Per-list running counters so ordered lists number correctly.
  const counters = new Map();
  let lastWasList = false;

  for (const b of blocks) {
    const xml = b[0];

    if (xml.startsWith("<w:tbl>")) {
      const md = tableToMarkdown(xml);
      if (md) out.push(md, "");
      lastWasList = false;
      counters.clear();
      continue;
    }

    const inner = xml.replace(/^<w:p(?:\s[^>]*)?>/, "").replace(/<\/w:p>$/, "");
    const text = paragraphText(inner);
    const numPr = inner.match(/<w:numPr>[\s\S]*?<\/w:numPr>/)?.[0];
    const level = headingLevel(inner);

    if (!text) {
      // Blank paragraph: acts as a separator, and breaks list continuity.
      if (lastWasList) {
        out.push("");
        lastWasList = false;
        counters.clear();
      }
      continue;
    }

    if (level !== null && !numPr) {
      if (lastWasList) counters.clear();
      lastWasList = false;
      const hashes = "#".repeat(Math.min(6, Math.max(1, level)));
      // Strip emphasis from headings — Word bolds them, Markdown already does.
      const clean = text.replace(/\*\*/g, "").replace(/(^|\s)\*(\S)/g, "$1$2").replace(/(\S)\*(\s|$)/g, "$1$2");
      if (!title && level <= 2) title = clean;
      out.push("", `${hashes} ${clean}`, "");
      continue;
    }

    if (numPr) {
      const ilvl = Number(numPr.match(/<w:ilvl w:val="(\d+)"/)?.[1] ?? 0);
      const numId = numPr.match(/<w:numId w:val="(\d+)"/)?.[1] ?? "0";
      const fmt = numbering[numId]?.[String(ilvl)] ?? "bullet";
      const ordered = fmt !== "bullet" && fmt !== "none";
      const key = `${numId}:${ilvl}`;
      let marker = "-";
      if (ordered) {
        const n = (counters.get(key) ?? 0) + 1;
        counters.set(key, n);
        marker = `${n}.`;
        // A deeper level restarting means shallower siblings continue; deeper
        // counters reset when we come back up.
        for (const k of counters.keys()) {
          const [, lv] = k.split(":");
          if (Number(lv) > ilvl) counters.delete(k);
        }
      }
      out.push(`${"  ".repeat(ilvl)}${marker} ${text}`);
      lastWasList = true;
      continue;
    }

    if (lastWasList) {
      out.push("");
      counters.clear();
    }
    lastWasList = false;
    out.push(text, "");
  }

  const markdown = out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { markdown: markdown + "\n", title };
}
