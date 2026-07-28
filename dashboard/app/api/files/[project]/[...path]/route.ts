import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { NextRequest } from "next/server";
import { PROJECTS_DIR } from "@/lib/projects";

export const dynamic = "force-dynamic";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".mp4": "video/mp4",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

// Only these areas of a project folder are servable.
const ALLOWED_ROOTS = new Set(["dist", "recordings", "frames"]);

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ project: string; path: string[] }> }
) {
  const { project, path: parts } = await ctx.params;

  if (!/^[\w-]+$/.test(project) || parts.length === 0) {
    return new Response("Not found", { status: 404 });
  }
  const first = parts[0];
  if (!ALLOWED_ROOTS.has(first) && !(parts.length === 1 && first === "demo-status.json")) {
    return new Response("Forbidden", { status: 403 });
  }

  const projectRoot = path.join(PROJECTS_DIR, project);
  const filePath = path.resolve(projectRoot, ...parts);
  if (!filePath.startsWith(projectRoot + path.sep)) {
    return new Response("Forbidden", { status: 403 });
  }

  let stat: fs.Stats;
  try {
    stat = await fsp.stat(filePath);
    if (!stat.isFile()) throw new Error("not a file");
  } catch {
    return new Response("Not found", { status: 404 });
  }

  const type = TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
  const range = req.headers.get("range");

  // Single-range support so <video> seeking works on the mp4s.
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match) {
      const start = match[1] ? parseInt(match[1], 10) : 0;
      const end = match[2] ? Math.min(parseInt(match[2], 10), stat.size - 1) : stat.size - 1;
      if (start <= end && start < stat.size) {
        const stream = fs.createReadStream(filePath, { start, end });
        return new Response(stream as unknown as ReadableStream, {
          status: 206,
          headers: {
            "content-type": type,
            "content-length": String(end - start + 1),
            "content-range": `bytes ${start}-${end}/${stat.size}`,
            "accept-ranges": "bytes",
            "cache-control": "no-store",
          },
        });
      }
      return new Response(null, {
        status: 416,
        headers: { "content-range": `bytes */${stat.size}` },
      });
    }
  }

  const stream = fs.createReadStream(filePath);
  return new Response(stream as unknown as ReadableStream, {
    headers: {
      "content-type": type,
      "content-length": String(stat.size),
      "accept-ranges": "bytes",
      "cache-control": "no-store",
    },
  });
}
