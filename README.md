# demo-creator

Turn a client's BRS into a branded walkthrough where **every functional
requirement sits next to a video of that exact requirement working** in the
delivered app.

The client reads the clause they signed off on, and watches it run — one to one,
no interpretation required.

```
BRS (.docx/.md) ──▶ sections ──▶ plan ──▶ simulator recordings ──▶ verify ──▶ presentation
                    (CLI)      (agent)   (agent + CLI)          (agent)      (CLI)
```

The CLI owns everything deterministic — parsing, capture, encoding, building.
Agents own everything needing judgement — which requirements are worth filming,
how to drive the app, whether a clip really shows what it claims.

## Requirements

Node 20+ and `ffmpeg` + `ffprobe`. iOS capture also requires macOS with Xcode
(`xcrun simctl`). Android capture uses ADB, the local `android-ui-voyager` MCP,
and `scrcpy`.

```bash
node bin/demo-creator.mjs doctor
```

## Quick start

```bash
# 1. Create the project and ingest the BRS
node bin/demo-creator.mjs init acme-client \
  --brs ~/Downloads/BRS.docx \
  --app ~/Library/Developer/Xcode/DerivedData/App-xxx/Build/Products/Release-iphonesimulator/App.app \
  --client "Acme Client" \
  --icon ~/code/clients/acme-client/assets/badge.png

# 2. Hand the planning brief to an agent
node bin/demo-creator.mjs brief acme-client
#    …the agent writes plan.json, then:
node bin/demo-creator.mjs plan validate acme-client

# 3. Prep the simulator, then let the recording agent drive it
node bin/demo-creator.mjs sim prep --bundle com.acme.app
node bin/demo-creator.mjs record start acme-client 01-signup
#    …agent performs the flow via the simulator control tools…
node bin/demo-creator.mjs record stop acme-client 01-signup --trim-start 0.5

# 4. Verify, then build the deliverable
node bin/demo-creator.mjs frames acme-client 01-signup --count 8
node bin/demo-creator.mjs build acme-client
open projects/acme-client/dist/index.html
```

For Android, invoke `$android-client-demo` from Codex. It keeps this same BRS,
planning, verification, dashboard, and build pipeline, but Codex records the
emulator with `scrcpy` while the local UI-Voyager model drives it one observable
MCP step at a time. The complete procedure is in
`skills/android-client-demo/SKILL.md`.

## Android with Gemini (two agents, never the same one)

Full guide with copy-paste examples and the prompts to give Claude Code:
**[docs/GEMINI-ANDROID.md](docs/GEMINI-ANDROID.md)**.

Two more skills use the same engine on the Android emulator with Google's
Gemini in two separate roles: **Gemini Computer Use** drives the device
(`gemini-computer.py --mobile`), and **Gemini agentic video understanding**
judges the recording (`scripts/gemini-video.py`). The driver never sees a
verdict and the judge never sees the driver's transcript.

```bash
node bin/demo-creator.mjs doctor --android      # adb, scrcpy, uv, gemini-computer.py, API key, device
```

**Client demo** (`skills/android-demo-gemini`): plan as usual, then

```bash
node bin/demo-creator.mjs android prep --package com.acme.app --apk app-release.apk --demo-bar
node bin/demo-creator.mjs android record start acme-client         # scrcpy master capture
node bin/demo-creator.mjs drive acme-client 01-signup              # one section = one Computer Use call, markers around it
node bin/demo-creator.mjs drive acme-client 02-onboarding
node bin/demo-creator.mjs android record stop acme-client
node bin/demo-creator.mjs split acme-client                        # 30fps normalise + cut by markers + boundary frames
node bin/demo-creator.mjs verify-video acme-client                 # every clip vs its evidence → verification.json
node bin/demo-creator.mjs review-presentation acme-client          # every section shown in its window, clean take → presentation-review.json
node bin/demo-creator.mjs build acme-client && node bin/demo-creator.mjs check acme-client
```

`split`, `verify-video` and `review-presentation` work on iOS masters too, so
the Gemini judge can replace the frame-by-frame verifier for any project.

**QA loop** (`skills/android-qa-loop`): a tester explores and is recorded, a
reviewer watches and writes timestamped findings, Claude fixes and rebuilds,
repeat until the gate passes.

```bash
node bin/demo-creator.mjs qa init acme --package com.acme.app --apk app-debug.apk --focus "checkout"
node bin/demo-creator.mjs qa test acme            # Gemini Computer Use explores, scrcpy records → qa/acme/runs/001
node bin/demo-creator.mjs qa review acme          # Gemini video → findings.json (ids, timestamps, frames, repro steps)
#   …fix the app, rebuild the APK…
node bin/demo-creator.mjs qa test acme --apk app-debug.apk   # round 2 re-checks round 1's open findings
node bin/demo-creator.mjs qa review acme
node bin/demo-creator.mjs qa gate acme            # exit 0 when no blocker/major/minor findings remain
```

Each run keeps `master-cfr.mp4`, `tester.log` (actions stamped with seconds
into the video), `findings.json`, and one frame per finding under `frames/`.

## Project layout

Each delivery is one self-contained folder you can zip and send:

```
projects/<client>/
  project.json        client name, app path, bundle id, brand colour, icon
  brs.json            parsed section tree (ids come from the BRS's own numbering)
  brs.md              the BRS as markdown (converted from .docx if needed)
  plan.json           clips + a coverage decision for every section
  verification.json   per-clip pass/fail with cited frames
  recordings/         <clipId>.mp4 (web-ready h264) + .jpg poster
    raw/              untouched simulator captures
  frames/<clipId>/    sampled frames used for verification
  dist/               the presentation: index.html + media/ + assets/
```

## Commands

| | |
| --- | --- |
| `doctor` | check prerequisites |
| `init <p> --brs <f> --app <f>` | create a project, ingest the BRS, extract branding |
| `reingest <p> [--brs <f>]` | re-parse after the BRS changes |
| `outline <p> [--all]` | numbered section outline |
| `brief <p>` | print the planning brief for an agent |
| `plan validate <p>` | check plan.json against the BRS |
| `sim prep [--bundle <id>] [--app <f>]` | pin the status bar to 9:41, reset the app |
| `record start\|stop\|abort <p> <clip>` | recording lifecycle |
| `frames <p> <clip> [--count 6]` | sample frames for verification |
| `clips <p>` | list recordings with durations |
| `status <p>` | coverage: planned / recorded / verified |
| `android devices\|prep\|record start\|stop\|mark` | Android device, scrcpy master capture, markers |
| `drive <p> <clip>` | one demo section driven by Gemini Computer Use, markers around it |
| `split <p>` | normalise the master to 30fps and cut clips by markers |
| `verify-video <p>` | Gemini agentic video verifies each clip against its evidence |
| `review-presentation <p>` | Gemini reviews the full take: sections shown, clean presentation |
| `qa init\|test\|review\|findings\|status\|gate` | the Android QA loop |
| `build <p>` | build the presentation into `dist/` |
| `check <p>` | ship gate: every clip 30fps and verified, status file valid, deck built |

## How sections are identified

Section ids come from the numbering the BRS already uses — `5.2.1` stays
`5.2.1`. That number is exactly what a client looks for when checking a video
against their document, so it is what the plan, the videos, and the presentation
all key on. Unnumbered headings fall back to a slug.

The `.docx` reader is deliberately faithful: it will not invent structure the
document doesn't have. If a BRS skips from section 5 to section 7, the parsed
output skips too — that's a gap in the client's document, and worth raising with
them rather than papering over.

## Coverage statuses

Every section gets one, and the presentation renders each differently:

- **`demo`** — a functional requirement with visible behaviour. Gets a clip.
- **`backend`** — real requirement, nothing to see: server rules, storage,
  API mechanics. Shown in the Full BRS view, marked as not visually
  demonstrable, hidden from the walkthrough by default.
- **`narrative`** — not a requirement: summaries, objectives, scope, glossary.
- **`not-implemented`** — a functional requirement the app doesn't currently
  meet. Recorded honestly rather than quietly skipped.

## The presentation

Three views, one static page, no network access needed:

1. **Overview** — app icon, coverage counts, and how to read the deck.
2. **Walkthrough** — per requirement: the BRS text verbatim on the left, the
   video in a device frame on the right, plus a "what to look for" list drawn
   from the plan's `evidence`.
3. **Full BRS** — the complete specification, with a "Watch this working" link
   on every section that has a recording.

Brand accent is sampled from the app icon, so the deck reads as the client's
product rather than as our template.

## Dashboard

`dashboard/` is a Next.js app that watches `projects/` live: demos currently
being generated (state, current clip, progress) and finished deliverables
(with the presentation served inline).

```bash
cd dashboard && npm run dev   # http://localhost:4400
```

It reads each project's `project.json` / `plan.json` / `verification.json` /
`recordings/` directly, plus an optional `demo-status.json` heartbeat that an
orchestrating agent keeps updated during a run (schema in the `client-demo`
skill at `~/.claude/skills/client-demo/SKILL.md`). A run whose status file
hasn't been touched in 5 minutes shows as **stalled**; without a status file a
project is simply **finished** (dist built) or **not started**.

## Using from another machine

```bash
git clone git@github.com:SensaraIO/demo-creator.git ~/code/demo-creator
cd ~/code/demo-creator
./scripts/install-skills.sh        # installs the client-demo skill into ~/.claude/skills
cd dashboard && npm install        # dashboard deps
```

The canonical skill copies live in `skills/client-demo/` for iOS and
`skills/android-client-demo/` for Android. `install-skills.sh` copies them into
`~/.claude/skills` (re-run after pulling skill changes). Codex users can install
the Android skill with:

```bash
mkdir -p ~/.codex/skills/android-client-demo
rsync -a --delete skills/android-client-demo/ ~/.codex/skills/android-client-demo/
```

The skills and briefs assume the repo at
`~/code/demo-creator` (`/Users/<you>/code/demo-creator`) — adjust the paths in
the installed SKILL.md if you keep it elsewhere. The Android skills also need
`scripts/gemini-computer.py` copied to `~/.local/bin` (see docs/GEMINI-ANDROID.md). `projects/` (client
deliveries, large videos) is deliberately not in git.

## Agent briefs

`agents/planner.md`, `agents/recorder.md`, `agents/verifier.md` are the prompts
handed to each agent. `brief` fills the planner template with real paths.
`agents/android-driver.md`, `qa-tester.md` (Gemini Computer Use) and
`video-verifier.md`, `presentation-reviewer.md`, `qa-reviewer.md` (Gemini
video) are filled by `drive`, `qa test`, `verify-video`, `review-presentation`
and `qa review`.

The rule running through all three: **never show a clip that doesn't prove its
requirement.** An admitted gap costs one line in the deck; a wrong-but-plausible
clip costs the credibility of the whole document.
