/**
 * A small Markdown -> HTML renderer, scoped to what BRS documents use:
 * headings, nested lists, tables, emphasis, code, links, rules.
 *
 * Rendering happens at build time so the presentation ships as plain HTML with
 * no client-side library and no network access.
 */
import { escapeHtml } from "./util.mjs";

function inline(text) {
  let s = escapeHtml(text);
  s = s.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  s = s.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
  s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" rel="noreferrer">$1</a>');
  return s;
}

function listItemDepth(line) {
  const m = line.match(/^(\s*)([-*+]|\d+[.)])\s+/);
  if (!m) return null;
  return {
    indent: m[1].replace(/\t/g, "  ").length,
    ordered: /\d/.test(m[2]),
    content: line.slice(m[0].length),
  };
}

export function renderMarkdown(markdown) {
  if (!markdown || !markdown.trim()) return "";
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  // Stack of currently-open lists, so nesting closes in the right order.
  const listStack = [];

  const closeListsTo = (indent) => {
    while (listStack.length && listStack[listStack.length - 1].indent >= indent) {
      out.push(`</${listStack.pop().tag}>`);
    }
  };
  const closeAllLists = () => {
    while (listStack.length) out.push(`</${listStack.pop().tag}>`);
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i++;
      continue;
    }

    // Fenced code
    if (/^\s*(```|~~~)/.test(line)) {
      closeAllLists();
      const fence = line.trim().slice(0, 3);
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${escapeHtml(buf.join("\n"))}</code></pre>`);
      continue;
    }

    // Table: a header row followed by a separator row.
    if (line.includes("|") && /^\s*\|?[\s:-]*-[\s:|-]*\|/.test(lines[i + 1] ?? "")) {
      closeAllLists();
      const cells = (l) =>
        l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const body = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) body.push(cells(lines[i++]));
      out.push(
        `<div class="table-wrap"><table><thead><tr>${head
          .map((c) => `<th>${inline(c)}</th>`)
          .join("")}</tr></thead><tbody>${body
          .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`)
          .join("")}</tbody></table></div>`,
      );
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      closeAllLists();
      const lvl = Math.min(6, heading[1].length + 1); // demote: the page owns h1
      out.push(`<h${lvl}>${inline(heading[2].trim())}</h${lvl}>`);
      i++;
      continue;
    }

    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
      closeAllLists();
      out.push("<hr>");
      i++;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      closeAllLists();
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push(`<blockquote>${renderMarkdown(buf.join("\n"))}</blockquote>`);
      continue;
    }

    const item = listItemDepth(line);
    if (item) {
      const tag = item.ordered ? "ol" : "ul";
      const top = listStack[listStack.length - 1];
      if (!top || item.indent > top.indent) {
        listStack.push({ indent: item.indent, tag });
        out.push(`<${tag}>`);
      } else {
        closeListsTo(item.indent + 1);
        const now = listStack[listStack.length - 1];
        if (!now || now.tag !== tag) {
          if (now) out.push(`</${listStack.pop().tag}>`);
          listStack.push({ indent: item.indent, tag });
          out.push(`<${tag}>`);
        }
      }
      // Continuation lines that are indented but not new items belong to this item.
      const buf = [item.content];
      i++;
      while (i < lines.length && lines[i].trim() && !listItemDepth(lines[i]) && /^\s{2,}/.test(lines[i])) {
        buf.push(lines[i++].trim());
      }
      out.push(`<li>${inline(buf.join(" "))}</li>`);
      continue;
    }

    closeAllLists();
    const buf = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !listItemDepth(lines[i]) && !/^\s*(#{1,6}\s|>|```|~~~)/.test(lines[i])) {
      buf.push(lines[i++]);
    }
    out.push(`<p>${inline(buf.join(" "))}</p>`);
  }

  closeAllLists();
  return out.join("\n");
}
