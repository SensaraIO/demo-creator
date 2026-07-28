import fs from "node:fs/promises";
import path from "node:path";

export const PROJECTS_DIR =
  process.env.DEMO_PROJECTS_DIR ?? path.resolve(process.cwd(), "..", "projects");

/** How long demo-status.json may go without an update before an active run counts as stalled. */
const STALL_MS = 5 * 60 * 1000;

export type ClipStatus = "pending" | "recording" | "recorded" | "verified" | "failed";

export interface ClipSummary {
  id: string;
  title: string;
  status: ClipStatus;
  durationSec: number | null;
  agent: string | null;
  error: string | null;
}

export type RunState =
  | "planning"
  | "recording"
  | "verifying"
  | "building"
  | "done"
  | "failed"
  | "idle";

export type DerivedState = "generating" | "stalled" | "failed" | "finished" | "idle";

export interface ProjectSummary {
  slug: string;
  client: string;
  app: string;
  brandColor: string | null;
  iconUrl: string | null;
  state: RunState;
  derived: DerivedState;
  stageDetail: string | null;
  error: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  finishedAt: string | null;
  counts: { planned: number; recorded: number; verified: number; failed: number };
  clips: ClipSummary[];
  presentationUrl: string | null;
}

export interface Snapshot {
  generatedAt: string;
  projectsDir: string;
  projects: ProjectSummary[];
}

async function readJson(file: string): Promise<any | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function summarizeProject(slug: string): Promise<ProjectSummary | null> {
  const root = path.join(PROJECTS_DIR, slug);
  const project = await readJson(path.join(root, "project.json"));
  if (!project) return null;

  const [status, plan, verification, hasDist, hasIcon] = await Promise.all([
    readJson(path.join(root, "demo-status.json")),
    readJson(path.join(root, "plan.json")),
    readJson(path.join(root, "verification.json")),
    exists(path.join(root, "dist", "index.html")),
    exists(path.join(root, "dist", "assets", "icon.png")),
  ]);

  let recordedIds: Set<string> = new Set();
  try {
    const files = await fs.readdir(path.join(root, "recordings"));
    recordedIds = new Set(
      files.filter((f) => f.endsWith(".mp4")).map((f) => f.replace(/\.mp4$/, ""))
    );
  } catch {
    /* no recordings yet */
  }

  const verifiedIds = new Set<string>(
    (verification?.results ?? []).filter((r: any) => r.pass).map((r: any) => r.clipId)
  );
  const failedVerifyIds = new Set<string>(
    (verification?.results ?? []).filter((r: any) => !r.pass).map((r: any) => r.clipId)
  );

  // Clip list: the live status file wins; otherwise reconstruct from plan + disk.
  let clips: ClipSummary[];
  if (Array.isArray(status?.clips) && status.clips.length > 0) {
    clips = status.clips.map((c: any) => ({
      id: String(c.id),
      title: c.title ?? c.id,
      status: (c.status ?? "pending") as ClipStatus,
      durationSec: typeof c.durationSec === "number" ? c.durationSec : null,
      agent: c.agent ?? null,
      error: c.error ?? null,
    }));
  } else {
    clips = (plan?.clips ?? []).map((c: any) => {
      const id = String(c.id);
      let clipState: ClipStatus = "pending";
      if (verifiedIds.has(id)) clipState = "verified";
      else if (failedVerifyIds.has(id)) clipState = "failed";
      else if (recordedIds.has(id)) clipState = "recorded";
      return {
        id,
        title: c.title ?? id,
        status: clipState,
        durationSec: null,
        agent: null,
        error: null,
      };
    });
  }

  const counts = {
    planned: status?.counts?.planned ?? plan?.clips?.length ?? clips.length,
    recorded:
      status?.counts?.recorded ??
      clips.filter((c) => c.status === "recorded" || c.status === "verified").length,
    verified: status?.counts?.verified ?? clips.filter((c) => c.status === "verified").length,
    failed: status?.counts?.failed ?? clips.filter((c) => c.status === "failed").length,
  };

  const state: RunState =
    status?.state ?? (hasDist && verification ? "done" : plan ? "idle" : "idle");

  let derived: DerivedState;
  if (state === "done") derived = "finished";
  else if (state === "failed") derived = "failed";
  else if (status) {
    const updated = Date.parse(status.updatedAt ?? status.startedAt ?? "");
    derived =
      Number.isFinite(updated) && Date.now() - updated <= STALL_MS ? "generating" : "stalled";
  } else {
    derived = hasDist ? "finished" : "idle";
  }

  return {
    slug,
    client: project.clientName ?? slug,
    app: project.appName ?? "",
    brandColor: project.brandColor ?? null,
    iconUrl: hasIcon ? `/api/files/${slug}/dist/assets/icon.png` : null,
    state,
    derived,
    stageDetail: status?.stageDetail ?? null,
    error: status?.error ?? null,
    startedAt: status?.startedAt ?? project.createdAt ?? null,
    updatedAt: status?.updatedAt ?? null,
    finishedAt: status?.finishedAt ?? (derived === "finished" ? verification?.retakeVerifiedAt ?? verification?.verifiedAt ?? null : null),
    counts,
    clips,
    presentationUrl: hasDist ? `/api/files/${slug}/dist/index.html` : null,
  };
}

export async function getSnapshot(): Promise<Snapshot> {
  let entries: string[] = [];
  try {
    const dirents = await fs.readdir(PROJECTS_DIR, { withFileTypes: true });
    entries = dirents.filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name);
  } catch {
    /* projects dir missing — empty dashboard */
  }

  const projects = (await Promise.all(entries.map(summarizeProject))).filter(
    (p): p is ProjectSummary => p !== null
  );

  const order: Record<DerivedState, number> = {
    generating: 0,
    stalled: 1,
    failed: 2,
    finished: 3,
    idle: 4,
  };
  projects.sort(
    (a, b) =>
      order[a.derived] - order[b.derived] ||
      (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") ||
      a.client.localeCompare(b.client)
  );

  return { generatedAt: new Date().toISOString(), projectsDir: PROJECTS_DIR, projects };
}
