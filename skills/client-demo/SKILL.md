---
name: client-demo
description: Produce a branded demo-video walkthrough for any client project — ingest the BRS, plan a single choreographed take, record it once on the iOS Simulator with live section markers, split it into per-BRS-section clips in post, verify, and build the deliverable, while keeping the demo dashboard's status file live. Trigger on "create a demo", "client demo", "demo walkthrough", "record the demo videos", "make the delivery walkthrough", or any request to demo a client app against its BRS.
---

# Client demo walkthrough

Turn a client project's BRS into a branded presentation where every functional requirement sits next to a video of that requirement working on the iOS Simulator. The engine is the demo-creator tool, which lives at `$DEMO_CREATOR` — set it once per session:

```bash
export DEMO_CREATOR="${DEMO_CREATOR:-$HOME/code/demo-creator}"
```

Read its `README.md` before the first run of a session. Each delivery lives in `$DEMO_CREATOR/projects/<client>/` and is watched live by the demo dashboard (`$DEMO_CREATOR/dashboard`, `npm run dev`, port 4400) — so keeping `demo-status.json` current is part of the job, not optional telemetry.

**Never hardcode a home directory in this skill or in any command you derive from it.** These flows run on several Macs under different usernames (`cheshire`, `sensara-studio`, `mac-mini1`, `mac-mini2`); an absolute `/Users/<someone>/…` path is the single most common way this pipeline breaks on a machine that isn't the one it was written on.

**Core recording model — one take, split in post:** the whole demo is recorded as ONE continuous simulator capture while the driver logs a timestamped marker at every section boundary; afterwards ffmpeg cuts the master into per-clip videos. This replaces the old one-recorder-agent-per-clip loop (which paid agent boot + re-orientation + capture setup for every clip and was the main source of slowness). Per-clip recording still exists, but only as the retake path for a clip that fails verification.

**Division of labour:**

- You (Claude Code) are the orchestrator: CLI, planning, prep, splitting, verification, deck build, status file.
- The take has ONE driver. Default: spawn a single GPT 5.6 Sol (Codex) agent to drive the entire take (see §4). Exception: if you have already driven these exact flows in this session (e.g. you just built or verified the app in the simulator yourself), drive the take directly — a driver who has rehearsed is the fastest clean path, and spawning an agent to re-learn what you just did is waste.

## 0. First run on a machine — setup gate

Before anything else in a session, confirm the engine is present and healthy:

```bash
export DEMO_CREATOR="${DEMO_CREATOR:-$HOME/code/demo-creator}"
[ -d "$DEMO_CREATOR" ] && (cd "$DEMO_CREATOR" && node bin/demo-creator.mjs doctor)
```

If the directory is missing, or `doctor` reports missing tools, run the bootstrap — it is idempotent, so running it on an already-configured machine is a safe no-op:

```bash
gh api repos/SensaraIO/demo-creator/contents/scripts/bootstrap.sh \
  -H "Accept: application/vnd.github.raw" | bash
```

(The repo is private, so this goes through `gh` rather than a plain `curl` of a raw URL. If `gh auth status` fails, run `gh auth login` first.)

That clones (or fast-forwards) the repo to `~/code/demo-creator`, installs `ffmpeg`/`ffprobe` via Homebrew if absent, verifies Node 20+ and `xcrun simctl`, re-syncs this skill into `~/.claude/skills/`, and ensures `~/.zshenv` puts Homebrew and `~/.local/bin` on `PATH` for non-interactive SSH sessions. Re-run `doctor` afterwards and do not start a demo until it passes.

**Driving this remotely over SSH:** on macOS the login keychain is unreachable from an SSH session (`errSecInteractionNotAllowed`), so `claude` fails to authenticate. Wrap remote invocations so they run inside the logged-in GUI session:

```bash
sudo -n launchctl asuser "$(id -u)" sudo -u "$(whoami)" ~/.local/bin/claude --print "…"
```

Recording also needs that GUI session — `xcrun simctl io recordVideo` cannot capture without one. A machine sitting at the login window cannot produce a demo. The simulator is single-occupancy per machine — confirm no one else is driving it before you boot it.

## Pre-demo readiness gate

Before planning or recording a client demo, compare the current implementation against the project's idea document or BRS.

If required functionality is missing, incomplete, broken, or not demonstrable, resolve it first. Also fix material UI and UX issues that would weaken the client demo.

Rebuild, run, and verify the app after those changes. Do not begin demo recording until the required flows work and the UI is presentation-ready. If a gap cannot be resolved, report it honestly and exclude it from claimed demo evidence.

## Pipeline

```
init → plan → sim prep → rehearse → single-take record (live markers)
     → split by markers → verify clips → retake failures only → build → done
```

All CLI calls below run from `$DEMO_CREATOR` via `node bin/demo-creator.mjs …`. Run `doctor` once per session first (§0).

## 1. Init + status file

```bash
node bin/demo-creator.mjs init <client> --brs <brs.docx|md> --app <path/to/App.app> \
  --client "<Client Name>" --icon <badge.png>
```

Immediately create `projects/<client>/demo-status.json` (schema below) with `state: "planning"`. From here on, update the status file at every stage transition and after every clip, always bumping `updatedAt`. The dashboard treats a status file older than 5 minutes as stalled — if a stage will be quiet for longer, touch `updatedAt` with a fresh `stageDetail`.

## 2. Plan — clips AND the take script

`node bin/demo-creator.mjs brief <client>` prints the planner brief. Fill in `plan.json` yourself (you are the planner), then `node bin/demo-creator.mjs plan validate <client>`.

Because everything records in one pass, the plan must also define the take script: the clip order arranged as one natural user journey (registration → onboarding → core features → settings → admin …) so section boundaries fall on clean screen transitions. Rules that make splitting easy:

- Order clips so each ends on a settled screen and the next begins with a visible navigation (a tab tap, a push) — cut points land between them.
- Start each section by holding its first screen ~1–2s before interacting.
- Flows needing different accounts/roles (regular vs admin) go at the ends of the take with a log-out/log-in seam between them — the seam footage is simply not part of any clip.

Set `state: "recording"`, seed `clips[]` (all `"pending"`), set `counts.planned`.

## 3. Simulator prep (all of it BEFORE recording)

```bash
node bin/demo-creator.mjs sim prep --bundle <bundleId> --app <App.app>
```

Boot/reset the sim, pin the status bar, install the app, dismiss first-run dialogs. Then the pre-take checklist — every item here is a defect that has already appeared on camera once:

- Backend live + seeded; never let the take hit a dead backend.
- Disable iOS "Suggest Strong Passwords" (Settings → General → AutoFill & Passwords): the sheet hijacks password fields and swallows typed input. The toggle often ignores plain simctl taps — use a short press gesture (touch-down, ~120ms, touch-up on the switch) and screenshot-verify it turned off.
- OTP retrieval path: if signup emails carry OTPs, enable the backend's dev-only code logging (e.g. `DEV_LOG_OTP=1`) so the driver can read the code from logs mid-take. The pause on the OTP screen reads as "user checking email" — natural, don't fear it.
- Accounts staged: demo credentials decided, admin/regular role flags set server-side BEFORE the account is created on camera; app signed out and sitting on the welcome screen.
- State resets: foregrounding via URL/openurl does NOT reset app state — to hard-reset, terminate the app process and relaunch. There is no backspace via simulated typing (escape sequences type literally), so a wrong field value means reset-and-redo, not edit.
- Rehearse off-camera: walk every flow once, note tap coordinates for fiddly controls. Single biggest quality lever.

## 4. The single take — record with live markers

Start the master capture (background process):

```bash
xcrun simctl io booted recordVideo --codec h264 --force \
  projects/<client>/recordings/master.mp4
```

The instant "Recording started" appears, log the epoch: `date +%s.%N > projects/<client>/recordings/rec-start.txt`.

**Marker protocol.** The driver appends one JSON line to `projects/<client>/recordings/markers.jsonl` at the moment each section's first screen is settled, and one when its last screen is done:

```bash
echo "{\"t\": $(date +%s.%N), \"clipId\": \"01-signup\", \"event\": \"start\"}" >> markers.jsonl
```

Markers cost nothing on camera (the recording keeps rolling; a half-second pause between sections is invisible in the final clips). Waits are cheap — generation spinners, log fetches, thinking pauses all trim away in post, so drive deliberately and never rush a flow.

If a Sol agent drives, build its prompt from `agents/recorder.md` as before but give it the WHOLE ordered take script plus the marker protocol, and have it run `-s danger-full-access` with the `xcodebuildmcp` MCP tools. One agent, one take. Update `demo-status.json` per section as markers land (`stageDetail: "Take: section 3 of 11"`).

**Stopping the capture — the one that bites:** `pgrep -f recordVideo` matches BOTH the shell wrapper and the real recorder. SIGINT the actual `simctl` binary (path contains `CoreSimulator.framework/…/bin/simctl`) or the video never finalizes; the file legitimately reads 0 bytes until the moov atom is written on stop, so wait for a non-zero size before judging it. If the wrong PID was killed, the recording is still running and intact — find the real PID and stop it; nothing is lost.

**Before stopping — protect the tail:** `recordVideo` flushes frames lazily. SIGINT shortly after the last screen change and the final seconds are silently missing from the file even though the screen visibly updated (the robyn-mccraw demo lost the payoff frames of two takes this way). Rule: force one extra screen change (a tiny scroll is enough), wait 4–5 seconds, then SIGINT. Then extract and LOOK at the last frame before accepting the take — but only after CFR conversion, since sparse-VFR masters misreport with plain `-ss` probes near EOF:

```bash
ffmpeg -sseof -2 -i clip.mp4 -frames:v 1 last-frame.png
```

## 5. Split by markers

Compute each clip's offsets: `start = marker.t − rec-start`, `end` likewise (pad start −0.5s / end +0.5s, then clamp). For each clip:

```bash
ffmpeg -ss <start> -to <end> -i master.mp4 \
  -vf fps=30 -c:v libx264 -crf 24 -preset medium -pix_fmt yuv420p \
  -movflags +faststart -an recordings/<clipId>.mp4
```

Non-negotiables learned the hard way:

- simctl output is sparse variable-frame-rate (frames only on screen change — a 17-min master can be 9 MB and ~0.15 fps average). Every shipped clip must be re-encoded to constant 30fps exactly as above; raw or copy-spliced VFR stutters or freezes in common players.
- Verify cut points visually: extract one frame at each boundary (`ffmpeg -ss <t> -frames:v 1 …`), look at it, and nudge ±1–2s until the clip opens on the section's first settled screen. Cheap, and it's the difference between "clean" and "obviously machine-cut".
- Also produce a trimmed, CFR full-walkthrough `master-full.mp4` (cut the dead tail) — clients love the single continuous video as a bonus deliverable.

Mark each clip `status: "recorded"` (+`durationSec`) as its file lands, `stageDetail: "Splitting master into clips (i of N)"`.

## 6. Verify

Set `state: "verifying"`. For each clip: `node bin/demo-creator.mjs frames <client> <clipId> --count 8`, read the frames, check every `evidence` item from the plan, write `verification.json` (per-clip `pass` + `evidenceChecks` citing frames).

A clip that fails verification does not trigger a new master take — record just that section as a targeted retake (the old per-clip path: `record start|stop` around one flow, or one Sol agent for that single clip), re-encode to the same CFR spec, and re-verify. If it fails twice, mark it failed and move on — an honest gap beats a faked clip. Never substitute a lookalike screen for the requirement.

## 7. Build + finish

```bash
node bin/demo-creator.mjs build <client>
```

Then `state: "done"`, `finishedAt`, `stageDetail: "Presentation built"`. Confirm `projects/<client>/dist/index.html` opens. If the run dies at any stage, set `state: "failed"` + top-level `error` before stopping — never leave the status file claiming progress that isn't happening.

## demo-status.json (dashboard contract)

```json
{
  "version": 1,
  "project": "ray-white",
  "client": "Ray White",
  "app": "Profile P.I.",
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

`state`: `planning | recording | verifying | building | done | failed` (splitting reports under `recording` via `stageDetail` — the dashboard schema is unchanged). Clip `status`: `pending | recording | recorded | verified | failed`. Clip `agent`: `"single-take"` for clips cut from the master, `"gpt-5.6-sol"` for targeted retakes. Timestamps ISO-8601 UTC. Always rewrite the whole file atomically so the dashboard never reads a half file.

## Gotchas that have already cost time

- SIGINT the real `simctl` PID to stop recording, not the shell wrapper — and the master reads 0 bytes until finalized (see §4).
- `recordVideo` flushes lazily: SIGINT soon after the last screen change and the tail seconds silently vanish (two takes lost their payoff frames on robyn-mccraw, 2026-08-25). Force a tiny scroll, wait 4–5s, then stop — and always eyeball the last frame (`ffmpeg -sseof -2 -i clip.mp4 -frames:v 1 …`) after CFR conversion before accepting a take (VFR masters misreport near EOF with plain `-ss` probes).
- Never ship raw simctl output: sparse-VFR → constant 30fps re-encode, always.
- `openurl`/foregrounding does not reset app state; terminate + relaunch does. Simulated typing has no backspace — escape sequences land as literal text.
- iOS "Suggest Strong Passwords" swallows typed passwords; disable it in Settings pre-take (short-press the toggle, plain taps often don't register).
- Segmented OTP inputs: type the first digit, screenshot, then the rest — bulk text entry fills only the first box.
- Brand accent is sampled from the app icon; flatten transparency on white first or it reads as black.
- Rehearse each flow off-camera before recording — still the single biggest quality lever.
- simctl masters can carry bogus DTS (−35 s, B-frames): ffmpeg then shifts timestamps mid-stream and every clip cut lands on the wrong footage, even though single-frame `-ss` probes look right. Decode with `-fflags +igndts`, and normalise the whole master to one CFR 30fps file first (`ffmpeg -fflags +igndts -i master.mp4 -vf fps=30,scale=780:-2 …`) — then cut clips from that with plain `-ss/-to`. Check boundary frames after splitting, always.
- HID text entry (`idb ui text`, the simulator MCP `text` action) is lowercase-only on iOS 26 simulators and mangles shifted symbols (`+`→`=`, `@`→`2`). For mixed-case input tap the on-screen keyboard keys instead (shift/caps-lock + key, 123 / #+= layers; ABC-before-space because iOS auto-returns to letters after punctuation+space). The tap approach also gives you backspace (delete key) and reads as natural typing on camera.
- An app reinstall does NOT clear the keychain: a stale auth token survives `simctl uninstall`. Run `xcrun simctl keychain <udid> reset` during prep, and make the app sign out cleanly when its session no longer maps to a live account.
