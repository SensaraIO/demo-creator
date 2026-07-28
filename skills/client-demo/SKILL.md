---
name: client-demo
description: Produce a branded demo-video walkthrough for any client project — ingest the BRS, plan clips, record one iOS-Simulator video per requirement using GPT 5.6 Sol (Codex) recorder agents, verify, and build the deliverable, while keeping the demo dashboard's status file live. Trigger on "create a demo", "client demo", "demo walkthrough", "record the demo videos", "make the delivery walkthrough", or any request to demo a client app against its BRS.
---

# Client demo walkthrough

Turn a client project's BRS into a branded presentation where every functional
requirement sits next to a video of that requirement working on the iOS
Simulator. The engine is the **demo-creator** tool at
`/Users/cheshire/code/demo-creator` (read its `README.md` before the first run
of a session). Each delivery lives in
`/Users/cheshire/code/demo-creator/projects/<client>/` and is watched live by
the demo dashboard (`/Users/cheshire/code/demo-creator/dashboard`, `npm run dev`,
port 4400) — so **keeping `demo-status.json` current is part of the job, not
optional telemetry**.

Division of labour:

- **You (Claude Code) are the orchestrator.** You run the CLI, do the planning,
  do the verification, build the deck, and maintain the status file.
- **GPT 5.6 Sol agents do the recording.** Every clip is recorded by a Codex
  CLI agent running model `gpt-5.6-sol` (see §Recording). Do not drive the
  simulator and record clips yourself — spawn a Sol recorder agent per clip.

## Pipeline

```
init → plan → sim prep → record (one Sol agent per clip) → verify → build → done
```

All CLI calls below run from `/Users/cheshire/code/demo-creator` via
`node bin/demo-creator.mjs …`. Run `doctor` once per session first.

### 1. Init + status file

```bash
node bin/demo-creator.mjs init <client> --brs <brs.docx|md> --app <path/to/App.app> \
  --client "<Client Name>" --icon <badge.png>
```

Immediately create `projects/<client>/demo-status.json` (schema below) with
`state: "planning"`. From here on, update the status file **at every stage
transition and after every clip**, always bumping `updatedAt`. The dashboard
treats a status file older than 5 minutes as stalled — if a stage will be quiet
for longer (e.g. a long recording), touch `updatedAt` with a fresh
`stageDetail`.

### 2. Plan

`node bin/demo-creator.mjs brief <client>` prints the planner brief. Fill in
`plan.json` yourself (you are the planner), then
`node bin/demo-creator.mjs plan validate <client>`. Set `state: "recording"`,
seed `clips[]` in the status file from the plan (all `"pending"`), and set
`counts.planned`.

### 3. Simulator prep

```bash
node bin/demo-creator.mjs sim prep --bundle <bundleId> --app <App.app>
```

Boot/reset the sim, pin the status bar, install the app, dismiss first-run
dialogs **before** any recording. Make sure the backend the build points at is
live and seeded — a recorder agent must never hit a dead backend on camera.

### 4. Recording — GPT 5.6 Sol agents (required)

Record clips **sequentially** (one simulator, one capture at a time). For each
clip in `plan.json`, spawn one Codex agent on `gpt-5.6-sol`:

```bash
codex exec \
  -m gpt-5.6-sol \
  -s danger-full-access \
  --skip-git-repo-check \
  -C /Users/cheshire/code/demo-creator \
  -o "projects/<client>/recordings/<clipId>.report.md" \
  "<recorder prompt for this one clip>"
```

Notes on the invocation:

- `gpt-5.6-sol` is the model the user standardized on for recording work — do
  not substitute another model or record inline as Claude.
- `-s danger-full-access` is required: the agent needs `xcrun simctl`, the
  `xcodebuildmcp` MCP tools (its simulator tap/type/screenshot automation), and
  writes outside the workspace. This machine is the user's own; that is the
  accepted mode for this task.
- `-o` captures the agent's final report; read it after each run.

Build the recorder prompt from `agents/recorder.md` (the recorder brief),
substituting the real values (`PROJECT`, `APP_NAME`, `APP_PATH`, `BUNDLE_ID`,
`UDID` from `project.json`) and appending **only the one clip's JSON object**
from `plan.json` (id, title, sectionIds, objective, preconditions, steps,
evidence). One clip per agent keeps runs short, restartable, and honest.
Adjust the brief's Tools section for Codex: simulator control is via the
`xcodebuildmcp` MCP tools (screenshot/tap/type/gesture), and the recording
lifecycle commands are `node bin/demo-creator.mjs record start|stop|abort …`
run from the repo root.

Around every agent run, update `demo-status.json`:

- before spawn: clip `status: "recording"`, `stageDetail: "Recording <clipId> (n of N)"`
- after: read the `-o` report and the produced `recordings/<clipId>.mp4`;
  set clip `status: "recorded"` (+ `durationSec` from `clips <client>`) or
  `status: "failed"` + `error`, bump `counts`, bump `updatedAt`.

If a clip fails twice, mark it failed and move on — an honest gap beats a
faked clip. Never let an agent substitute a lookalike screen for the
requirement; that rule (from the recorder brief) is the whole point of the
tool.

### 5. Verify

Set `state: "verifying"`. For each recorded clip:
`node bin/demo-creator.mjs frames <client> <clipId> --count 8`, read the
frames, and check every `evidence` item from the plan. Write
`verification.json` (per-clip `pass` + `evidenceChecks` citing frames). A clip
that fails verification goes back to §4 for a retake by a fresh Sol agent.
Update clip `status: "verified"` / `"failed"` and `counts.verified` as you go.

### 6. Build + finish

```bash
node bin/demo-creator.mjs build <client>
```

Then set `state: "done"`, `finishedAt`, `stageDetail: "Presentation built"`.
Confirm `projects/<client>/dist/index.html` opens. If the run dies at any
stage, set `state: "failed"` + top-level `error` before stopping — never leave
the status file claiming progress that isn't happening.

## demo-status.json (dashboard contract)

```json
{
  "version": 1,
  "project": "ray-white",
  "client": "Ray White",
  "app": "Profile P.I.",
  "state": "recording",
  "stageDetail": "Recording 03-home-and-image-upload (3 of 11)",
  "startedAt": "2026-07-28T14:00:00Z",
  "updatedAt": "2026-07-28T14:22:31Z",
  "finishedAt": null,
  "error": null,
  "counts": { "planned": 11, "recorded": 2, "verified": 0, "failed": 0 },
  "clips": [
    {
      "id": "01-signup",
      "title": "Create an account",
      "sectionIds": ["5.1.1"],
      "status": "verified",
      "attempts": 1,
      "durationSec": 34.2,
      "agent": "gpt-5.6-sol",
      "error": null
    }
  ]
}
```

`state`: `planning | recording | verifying | building | done | failed`.
Clip `status`: `pending | recording | recorded | verified | failed`.
Timestamps are ISO-8601 UTC. Always rewrite the whole file atomically (write
temp + rename, or a single Write) so the dashboard never reads a half file.

## Gotchas that have already cost time

- `simctl` records variable-frame-rate video; the CLI's `record stop` re-encodes
  to CFR — never ship a raw capture.
- Segmented OTP inputs: type the first digit, screenshot, then the rest —
  bulk text entry fills only the first box.
- Brand accent is sampled from the app icon; flatten transparency on white
  first or it reads as black.
- Rehearse each flow off-camera before recording — this is the single biggest
  quality lever, and it's in the recorder brief for a reason.
