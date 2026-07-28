"use client";

import { useEffect, useState } from "react";
import type { ProjectSummary, Snapshot } from "@/lib/projects";

const POLL_MS = 3000;

const CHIP_LABEL: Record<ProjectSummary["derived"], string> = {
  generating: "Generating",
  stalled: "Stalled",
  failed: "Failed",
  finished: "Finished",
  idle: "No active run",
};

function relTime(iso: string | null, now: number): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function Card({ p, now }: { p: ProjectSummary; now: number }) {
  const planned = Math.max(p.counts.planned, 1);
  const verifiedPct = (p.counts.verified / planned) * 100;
  const recordedOnlyPct =
    (Math.max(0, p.counts.recorded - p.counts.verified) / planned) * 100;
  const active = p.derived === "generating" || p.derived === "stalled";

  return (
    <article className="card" style={{ ["--accent" as string]: p.brandColor ?? undefined }}>
      <div className="card-head">
        {p.iconUrl ? (
          <img className="app-icon" src={p.iconUrl} alt="" />
        ) : (
          <div className="app-icon placeholder">{p.client.slice(0, 1)}</div>
        )}
        <div className="titles">
          <div className="client">{p.client}</div>
          <div className="app">{p.app}</div>
        </div>
        <span className={`chip ${p.derived}`}>
          <span className="dot" />
          {CHIP_LABEL[p.derived]}
        </span>
      </div>

      {(p.error || p.stageDetail) && (
        <div className={`stage${p.error ? " error" : ""}`} title={p.error ?? p.stageDetail ?? ""}>
          {p.error ?? p.stageDetail}
        </div>
      )}

      <div className="progress">
        <div className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={p.counts.planned} aria-valuenow={p.counts.verified}>
          <div className="seg verified" style={{ width: `${verifiedPct}%` }} />
          <div className="seg recorded" style={{ width: `${recordedOnlyPct}%` }} />
        </div>
        <div className="nums">
          <span>
            {p.counts.verified} / {p.counts.planned} verified · {p.counts.recorded} recorded
            {p.counts.failed > 0 ? ` · ${p.counts.failed} failed` : ""}
          </span>
        </div>
      </div>

      {p.clips.length > 0 && (
        <details className="clips" open={active}>
          <summary>
            {p.clips.length} clip{p.clips.length === 1 ? "" : "s"}
          </summary>
          <ul>
            {p.clips.map((c) => (
              <li key={c.id} className={`clip ${c.status}`} title={c.error ?? c.title}>
                <span className="dot" />
                <span className="name">{c.title}</span>
                {c.durationSec != null && <span className="dur">{Math.round(c.durationSec)}s</span>}
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="card-foot">
        <span className="updated">
          {p.derived === "finished"
            ? `Finished ${relTime(p.finishedAt ?? p.updatedAt, now)}`
            : `Updated ${relTime(p.updatedAt ?? p.startedAt, now)}`}
        </span>
        {p.presentationUrl && (
          <a className="open-btn" href={p.presentationUrl} target="_blank" rel="noreferrer">
            Open presentation
          </a>
        )}
      </div>
    </article>
  );
}

function Section({
  title,
  projects,
  now,
  emptyText,
}: {
  title: string;
  projects: ProjectSummary[];
  now: number;
  emptyText?: string;
}) {
  if (projects.length === 0 && !emptyText) return null;
  return (
    <section className="section">
      <h2>{title}</h2>
      {projects.length === 0 ? (
        <div className="empty">{emptyText}</div>
      ) : (
        <div className="grid">
          {projects.map((p) => (
            <Card key={p.slug} p={p} now={now} />
          ))}
        </div>
      )}
    </section>
  );
}

export default function Dashboard({ initial }: { initial: Snapshot }) {
  const [snap, setSnap] = useState<Snapshot>(initial);
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch("/api/status", { cache: "no-store" });
        if (res.ok && alive) setSnap(await res.json());
      } catch {
        /* keep last snapshot; retry next tick */
      }
    };
    const poll = setInterval(tick, POLL_MS);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      alive = false;
      clearInterval(poll);
      clearInterval(clock);
    };
  }, []);

  const inProgress = snap.projects.filter(
    (p) => p.derived === "generating" || p.derived === "stalled" || p.derived === "failed"
  );
  const finished = snap.projects.filter((p) => p.derived === "finished");
  const idle = snap.projects.filter((p) => p.derived === "idle");

  return (
    <main className="wrap">
      <header className="masthead">
        <h1>Client demos</h1>
        <span className="meta">
          {snap.projects.length} project{snap.projects.length === 1 ? "" : "s"} · refreshed{" "}
          {relTime(snap.generatedAt, now)}
        </span>
      </header>

      <Section
        title="Generating now"
        projects={inProgress}
        now={now}
        emptyText="Nothing is being generated right now. Start one with the client-demo skill."
      />
      <Section title="Finished demos" projects={finished} now={now} />
      <Section title="Not started" projects={idle} now={now} />
    </main>
  );
}
