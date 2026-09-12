---
name: client-demo
description: Produce a branded demo-video walkthrough for any client project — ingest the BRS, plan a single choreographed take, record it once on the iOS Simulator with live section markers, split it into per-BRS-section clips in post, verify, and build the deliverable, while keeping the demo dashboard's status file live. Trigger on "create a demo", "client demo", "demo walkthrough", "record the demo videos", "make the delivery walkthrough", or any request to demo a client app against its BRS.
---

# Client demo walkthrough

Turn a client project's BRS into a branded presentation where every functional requirement sits next to a video of that requirement working on the iOS Simulator. The engine is demo-creator at `$DEMO_CREATOR`; set it once per session and run every command from there as `node bin/demo-creator.mjs …` (`help` lists them). When this skill is loaded from the demo-creator plugin, the engine is the plugin itself (`${CLAUDE_PLUGIN_ROOT}`); otherwise it is a clone of the repo:

```bash
export DEMO_CREATOR="${DEMO_CREATOR:-${CLAUDE_PLUGIN_ROOT:-$HOME/code/demo-creator}}"
export DEMO_PROJECTS_DIR="${DEMO_PROJECTS_DIR:-$HOME/demo-creator-projects}"
```

`DEMO_PROJECTS_DIR` is where `projects/<client>/` (BRS, plan, recordings, deck) is written; the engine and the dashboard both read it. It must point outside the plugin directory, because a plugin update replaces that directory and would take the recordings with it. A plain clone can leave it unset and use `<repo>/projects`.

Never hardcode a home directory or a username in this skill or in any command you derive from it. These flows run on many Macs under different usernames; an absolute `/Users/<someone>/…` path is the single most common way this pipeline breaks on a machine that isn't the one it was written on.

How a demo is made: one continuous simulator capture while the driver appends a timestamped marker at every section boundary; afterwards the master is cut into per-clip videos, each clip is verified against the evidence in the plan, only failures are retaken, and `build` produces the deck. One take instead of one recording per clip is what made this fast; per-clip recording (`record start|stop`) remains only as the retake path.

Division of labour: you (Claude Code) orchestrate: CLI, planning, prep, splitting, verification, deck, status file. The take has one driver. Default: one Codex agent (GPT 5.6 Sol, `-s danger-full-access`, with the `xcodebuildmcp` simulator tools) prompted with `brief <client> recorder`, which carries the take script, the marker protocol and the driver-side simulator gotchas. If you have already driven these exact flows in this session (you just built or verified the app in the simulator yourself), drive the take yourself and follow `agents/recorder.md` directly; a rehearsed driver is the fastest clean path, and spawning an agent to re-learn what you just did is waste. If Codex or `xcodebuildmcp` is not installed on this machine, do not stop to install it: drive the take yourself with whatever simulator control you have (an iOS-simulator MCP, or `xcrun simctl` plus the app's own accessibility tree), following the same brief.

Say in a line what you are about to do before you start, give brief updates as stages complete, and close with a recap that stands on its own: what was produced, what was left out and why, and where the deck is.

You are operating autonomously. The user is not watching in real time and cannot answer questions mid-task, so asking 'Want me to…?' or 'Shall I…?' will block the work. For reversible actions that follow from the original request, proceed without asking. Stop only for destructive actions or genuine scope changes the user must decide. Offering follow-ups after the task is done is fine; asking permission before doing the work is not. The things to stop for here: a required flow you cannot make work, anything that would write to a production backend or real client data, and deleting recordings you did not make in this run.

Before ending your turn, check your last paragraph. If it is a plan, an analysis, a question, a list of next steps, or a promise about work you have not done ('I'll…', 'let me know when…'), do that work now with tool calls. That includes retrying after errors and gathering missing information yourself. Do not stop because the context or session is long. End your turn only when the task is complete or you are blocked on input only the user can provide.

## Setup gate

Confirm the engine before anything else in a session:

```bash
export DEMO_CREATOR="${DEMO_CREATOR:-${CLAUDE_PLUGIN_ROOT:-$HOME/code/demo-creator}}"
[ -f "$DEMO_CREATOR/bin/demo-creator.mjs" ] && (cd "$DEMO_CREATOR" && node bin/demo-creator.mjs doctor)
```

`doctor` needs macOS with Xcode (`xcrun simctl`), Node 20+, `ffmpeg` and `ffprobe`. If a tool is missing, install it (`brew install node ffmpeg`; Xcode from the App Store, then `sudo xcodebuild -runFirstLaunch`) and rerun `doctor`.

If `bin/demo-creator.mjs` is not there at all, the skill was installed without its engine. Either install the plugin (`/plugin marketplace add SensaraIO/demo-creator`, then `/plugin install demo-creator@demo-creator`), or clone the repo and run its bootstrap, which is idempotent:

```bash
gh api repos/SensaraIO/demo-creator/contents/scripts/bootstrap.sh \
  -H "Accept: application/vnd.github.raw" | bash
```

Use `gh` (after `gh auth login`) if the repo is private to you; a public clone works with plain `git clone https://github.com/SensaraIO/demo-creator.git ~/code/demo-creator && bash ~/code/demo-creator/scripts/bootstrap.sh`. The bootstrap clones or fast-forwards the repo to `~/code/demo-creator`, installs what `doctor` checks, re-syncs this skill, and fixes `PATH` for non-interactive SSH shells. Do not start a demo until `doctor` passes.

Over SSH the login keychain is unreachable (`errSecInteractionNotAllowed`), so `claude` cannot authenticate, and `xcrun simctl io recordVideo` cannot capture without a logged-in GUI session either. Wrap remote runs inside that session, and treat a machine sitting at the login window as unable to produce a demo:

```bash
sudo -n launchctl asuser "$(id -u)" sudo -u "$(whoami)" ~/.local/bin/claude --print "…"
```

The simulator is single-occupancy per machine: confirm nobody else is driving it before you boot it.

## Readiness gate

Before planning or recording, compare the current build against the idea document or BRS. If required functionality is missing, incomplete, broken, or not demonstrable, resolve it first, along with material UI and UX issues that would weaken the demo; rebuild, run, and verify the app; then start. A gap you cannot resolve is reported honestly and excluded from claimed evidence, never covered by a lookalike screen.

## Producing the demo

`init <client> --brs <brs.docx|md> --app <App.app> --client "<Client Name>" --icon <badge.png>` creates `projects/<client>/`. Create `demo-status.json` (contract below) straight away with `state: "planning"` and keep it truthful from then on.

`brief <client>` prints the planner brief; you are the planner. Write `plan.json` and run `plan validate <client>` until it is clean. The brief covers how to arrange the clips as one take with clean cut points. Then set `state: "recording"`, seed `clips[]` as `pending`, set `counts.planned`.

`sim prep --bundle <bundleId> --app <App.app>` boots and resets the simulator, pins the status bar, reinstalls the app. Each item below has already appeared on camera once, so finish all of them before the capture starts:

- Backend live and seeded; the take must never hit a dead backend.
- `xcrun simctl keychain <udid> reset`: a reinstall does not clear the keychain, and a stale auth token survives `simctl uninstall`. Make the app sign out cleanly when its session no longer maps to a live account.
- Disable iOS "Suggest Strong Passwords" (Settings → General → AutoFill & Passwords): the sheet hijacks password fields and swallows typed input. The toggle often ignores plain simctl taps; use a short press gesture (touch-down, ~120 ms, touch-up on the switch) and screenshot-verify it turned off.
- OTP retrieval: if signup emails carry codes, enable the backend's dev-only code logging (for example `DEV_LOG_OTP=1`) so the driver can read them from logs mid-take, and put the exact command in the plan's `notes`. The pause on the OTP screen reads as "user checking email".
- Accounts staged: demo credentials decided, admin/regular role flags set server-side before the account is created on camera, app signed out and sitting on the welcome screen.
- Brand accent is sampled from the app icon; flatten transparency on white first or it reads as black.

Hand the take to the driver (`brief <client> recorder`). Update `demo-status.json` as sections land (`stageDetail: "Take: section 3 of 11"`). The driver's report lists redone sections and evidence it could not get on screen; carry both into splitting and verification.

Split the master by markers. `recordings/markers.jsonl` holds lines `{"t": <epoch>, "clipId": "…", "event": "start"|"end"}`, `rec-start.txt` holds the capture's start epoch, and the last start/end pair for a clipId wins. Offsets are `marker.t − rec-start`, padded 0.5 s outward and clamped. Rules that have each cost a re-cut:

- simctl masters are sparse variable-frame-rate (a frame only on screen change; a 17-minute master can be 9 MB at ~0.15 fps) and can carry bogus DTS (−35 s, B-frames), which makes ffmpeg shift timestamps mid-stream so every cut lands on the wrong footage even though single-frame `-ss` probes look right. Normalise the whole master first, then cut clips from the normalised file:

  ```bash
  ffmpeg -fflags +igndts -i master.mp4 -vf fps=30,scale=780:-2 -c:v libx264 -crf 24 -preset medium \
    -pix_fmt yuv420p -movflags +faststart -an master-cfr.mp4
  ffmpeg -ss <start> -to <end> -i master-cfr.mp4 -c:v libx264 -crf 24 -preset medium \
    -pix_fmt yuv420p -movflags +faststart -an recordings/<clipId>.mp4
  ```

  Every shipped clip is constant 30 fps h264; raw or copy-spliced VFR stutters or freezes in common players.
- Look at the boundary frames of every clip (`ffmpeg -ss <t> -i … -frames:v 1`) and nudge ±1–2 s until each opens on its first settled screen. That is the difference between "clean" and "obviously machine-cut".
- Look at the last frame of each take after CFR conversion (`ffmpeg -sseof -2 -i clip.mp4 -frames:v 1 last.png`). `recordVideo` flushes lazily, and on one 2026-08-25 run two takes lost their payoff frames. Plain `-ss` probes near EOF misreport on VFR masters, so check after normalising, and only accept a take whose last frame is the intended final screen.
- Also ship a trimmed CFR `master-full.mp4` (dead tail cut). Clients like the continuous video, and `build` links it from the overview.

Mark each clip `recorded` with `durationSec` as its file lands.

Verify with a context that did not drive the take: set `state: "verifying"`, then hand `brief <client> verifier` to a fresh subagent (several in parallel is fine, one batch of clips each). It writes `verification.json` with a frame-cited verdict per clip. A failed clip gets one targeted retake of just that section (`record start|stop` around one flow, or one driver agent for that clip), re-encoded to the same CFR spec and re-verified. A clip that fails twice is marked `failed` and its file moved out of `recordings/` (for example into `recordings/rejected/`), so the deck records an honest gap instead of shipping a video the verifier rejected.

`build <client>` writes `projects/<client>/dist/index.html`.

## demo-status.json (dashboard contract)

The dashboard (`$DEMO_CREATOR/dashboard`, `npm install && npm run dev`, port 4400, honours the same `DEMO_PROJECTS_DIR`) watches this file. It is optional; the pipeline does not depend on it running. Rewrite it whole and atomically at every state transition and after every clip, always bumping `updatedAt`; a file untouched for 5 minutes shows as stalled, so touch it with a fresh `stageDetail` during long quiet stages. If the run dies at any stage, write `state: "failed"` and a top-level `error` before stopping; never leave the file claiming progress that isn't happening.

```json
{
  "version": 1,
  "project": "acme-client",
  "client": "Acme Client",
  "app": "Acme App",
  "state": "recording",
  "stageDetail": "Take: section 3 of 11 (02-onboarding)",
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
      "agent": "single-take",
      "error": null
    }
  ]
}
```

`state`: `planning | recording | verifying | building | done | failed` (splitting reports under `recording` via `stageDetail` — the dashboard schema is unchanged). Clip `status`: `pending | recording | recorded | verified | failed`. Clip `agent`: `"single-take"` for clips cut from the master, `"gpt-5.6-sol"` for targeted retakes. Timestamps ISO-8601 UTC.

## Done when

- `node bin/demo-creator.mjs check <client>` exits 0: every planned clip is a 30 fps h264 file with a passing, frame-cited verdict (or an acknowledged gap with no file left behind), `demo-status.json` matches the contract, and the deck exists.
- `projects/<client>/dist/index.html` opens and the clips play.
- `demo-status.json` says `done` with `finishedAt`, and your recap lists every gap.
