/**
 * BRS ingest: Markdown (or .docx, via docx.mjs) -> a structured section tree.
 *
 * Section identity comes from the numbering the BRS already uses ("4.2 Image
 * Upload"), because that number is exactly what the client will look for when
 * they check a video against their document. Unnumbered headings fall back to a
 * slug so nothing is silently dropped.
 */
import fs from "node:fs";
import path from "node:path";
import { docxToMarkdown } from "./docx.mjs";
import { die, slug } from "./util.mjs";

const NUMBERED = /^(\d+(?:\.\d+)*)[.)]?\s+(.*)$/;

/** Split markdown into heading-delimited blocks, ignoring headings inside fenced code. */
function splitHeadings(markdown) {
  const lines = markdown.split("\n");
  const blocks = [];
  let current = { level: 0, heading: null, lines: [] };
  let inFence = false;

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const m = !inFence && line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (m) {
      blocks.push(current);
      current = { level: m[1].length, heading: m[2].trim(), lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  blocks.push(current);
  return blocks.filter((b) => b.heading !== null || b.lines.some((l) => l.trim()));
}

function stripEmphasis(s) {
  return s
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/`(.*?)`/g, "$1")
    .replace(/\\\./g, ".")
    .trim();
}

/** Plain text of a markdown block, for search and for agent prompts. */
export function toPlainText(markdown) {
  return stripEmphasis(markdown)
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/^#{1,6}\s+/gm, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * Parse a BRS into a flat, ordered section list with parent/child links.
 * @param {string} markdown
 * @param {{source?: string}} meta
 */
export function parseBrs(markdown, meta = {}) {
  const blocks = splitHeadings(markdown);
  const sections = [];
  const stack = []; // [{level, id}]
  const usedIds = new Set();
  let docTitle = null;
  let preamble = "";

  for (const block of blocks) {
    if (block.heading === null) {
      preamble = block.lines.join("\n").trim();
      continue;
    }

    const headingText = stripEmphasis(block.heading);
    const numMatch = headingText.match(NUMBERED);
    const number = numMatch ? numMatch[1] : null;
    const title = numMatch ? numMatch[2].trim() : headingText;
    const body = block.lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();

    // The first h1/h2 is the document title, not a requirement section.
    if (!docTitle && block.level <= 2 && !number) {
      docTitle = title;
      if (body) preamble = preamble ? `${preamble}\n\n${body}` : body;
      continue;
    }

    let id = number;
    if (!id) {
      id = slug(title) || `section-${sections.length + 1}`;
    }
    let unique = id;
    let n = 2;
    while (usedIds.has(unique)) unique = `${id}-${n++}`;
    usedIds.add(unique);

    while (stack.length && stack[stack.length - 1].level >= block.level) stack.pop();
    const parentId = stack.length ? stack[stack.length - 1].id : null;
    stack.push({ level: block.level, id: unique });

    sections.push({
      id: unique,
      number,
      title,
      heading: headingText,
      level: block.level,
      parentId,
      childIds: [],
      body,
      text: toPlainText(body),
    });
  }

  const byId = new Map(sections.map((s) => [s.id, s]));
  for (const s of sections) {
    if (s.parentId && byId.has(s.parentId)) byId.get(s.parentId).childIds.push(s.id);
  }
  for (const s of sections) {
    const trail = [];
    let cur = s;
    while (cur) {
      trail.unshift(cur.number ? `${cur.number} ${cur.title}` : cur.title);
      cur = cur.parentId ? byId.get(cur.parentId) : null;
    }
    s.path = trail;
    s.label = s.number ? `${s.number} ${s.title}` : s.title;
  }

  return {
    title: docTitle ?? meta.title ?? "Business Requirements Specification",
    source: meta.source ?? null,
    preamble,
    markdown,
    sections,
  };
}

/** Load a BRS from .docx or .md/.markdown/.txt. */
export function loadBrs(file) {
  if (!fs.existsSync(file)) die(`BRS not found: ${file}`);
  const ext = path.extname(file).toLowerCase();
  let markdown;
  let title;
  if (ext === ".docx") {
    const conv = docxToMarkdown(file);
    markdown = conv.markdown;
    title = conv.title;
  } else if ([".md", ".markdown", ".txt"].includes(ext)) {
    markdown = fs.readFileSync(file, "utf8");
  } else {
    die(`unsupported BRS format "${ext}" — use .docx or .md`);
  }
  return parseBrs(markdown, { source: path.resolve(file), title });
}

/** Section plus all descendants, as one markdown string (used by the presentation). */
export function sectionWithChildren(brs, id) {
  const byId = new Map(brs.sections.map((s) => [s.id, s]));
  const out = [];
  const walk = (sid) => {
    const s = byId.get(sid);
    if (!s) return;
    out.push(`${"#".repeat(s.level)} ${s.heading}`);
    if (s.body) out.push(s.body);
    for (const c of s.childIds) walk(c);
  };
  walk(id);
  return out.join("\n\n");
}
