# Android testing and demos with Gemini

Two workflows on the Android emulator, both built on the demo-creator engine
and both using **two separate Gemini agents**:

| Role | Command | Agent |
|---|---|---|
| Drives the device while scrcpy records | `qa test`, `drive` | Gemini Computer Use (`scripts/gemini-computer.py --mobile`) |
| Watches the recording and writes the verdict | `qa review`, `verify-video`, `review-presentation` | Gemini agentic video understanding (`scripts/gemini-video.py`) |
| Orchestrates, fixes code, decides when done | you, or Claude Code via the skills | |

The driver never sees a verdict; the judge never sees the driver's transcript.

## One-time setup (per machine)

```bash
git clone git@github.com:SensaraIO/demo-creator.git ~/code/demo-creator   # or git pull
cd ~/code/demo-creator
./scripts/install-skills.sh          # android-qa-loop + android-demo-gemini into ~/.claude/skills
mkdir -p ~/.local/bin && cp scripts/gemini-computer.py ~/.local/bin/ && chmod +x ~/.local/bin/gemini-computer.py
```

Prerequisites: Node 20+, `uv` (https://docs.astral.sh/uv/), Android platform-tools
(`adb` on PATH), `brew install scrcpy ffmpeg`, and a Gemini API key in
`~/.config/gemini/api_key` (or `export GEMINI_API_KEY=…`). Boot an emulator, then:

```bash
node bin/demo-creator.mjs doctor --android
```

Every check must be green before anything below will work.

## Workflow 1: QA loop (test → review → fix → repeat)

### Tell Claude Code

```
Use the android-qa-loop skill on ~/code/clients/acme-app. The package is com.acme.app and the
APK builds with `cd android && ./gradlew assembleDebug` (output app/build/outputs/apk/debug/app-debug.apk).
Focus on onboarding, sign-in and checkout. Run qa test, then qa review, fix every finding in the
app source, rebuild, and repeat until qa gate passes. Don't stop until it does.
```

Claude reads the skill, runs the commands below itself, edits your app between rounds, and
reports the rounds run, findings fixed by id, and anything left open.

### Or run it by hand

```bash
cd ~/code/demo-creator

# 1. Register the app under test (once). Anything the tester needs goes in --notes.
node bin/demo-creator.mjs qa init acme --package com.acme.app \
  --apk ~/code/clients/acme-app/android/app/build/outputs/apk/debug/app-debug.apk \
  --app-name "Acme" \
  --focus "Onboarding, sign-in, checkout." \
  --notes "Test account: qa@example.com / Passw0rd!. OTP codes print in the dev backend log."

# 2. Test round: installs the APK, wipes app data, launches, records with scrcpy,
#    hands the emulator to Gemini Computer Use (default 60 turns, high thinking).
node bin/demo-creator.mjs qa test acme

# 3. Review the recording with Gemini video. Writes qa/acme/runs/001/findings.json
#    with ids (R1-F1…), severity, timestamp, a frame under runs/001/frames/, repro steps.
node bin/demo-creator.mjs qa review acme

# 4. Fix the app, rebuild, run round 2. The next tester brief automatically lists
#    round 1's open findings so they get exercised again; the reviewer marks each
#    fixed / still-present / not-exercised.
node bin/demo-creator.mjs qa test acme --apk <fresh apk>
node bin/demo-creator.mjs qa review acme

# 5. Exit criterion: no open blocker/major/minor (add --strict to include polish).
node bin/demo-creator.mjs qa gate acme && echo CLEAN

# Anytime
node bin/demo-creator.mjs qa status acme           # all runs and verdicts
node bin/demo-creator.mjs qa findings acme --run 2 # print one run's findings
```

Useful flags on `qa test`: `--max-turns 30` (shorter round), `--thinking medium`,
`--focus "…"` (override for this round), `--no-reset` (keep app data), `--demo-bar`
(pin the status bar to 9:41), `--serial emulator-5556`.

What a round leaves behind, in `qa/<name>/runs/NNN/`:

```
master-cfr.mp4     the recording the reviewer watched (30fps h264)
tester.log         every driver action stamped with seconds into the video
tester-task.md     the brief the tester got
run.json           timing, turns, exit code, driver report
findings.json      the reviewer's verdict
frames/            one JPEG per finding, named by id and timestamp
```

`qa/` is gitignored.

## Workflow 2: Android client demo from a BRS

Same deliverable as the iOS `client-demo` skill: a branded deck where every BRS
requirement sits next to a verified video of it working.

### Tell Claude Code

```
Use the android-demo-gemini skill for client Acme. BRS at ~/Downloads/Acme-BRS.docx, APK at
~/code/clients/acme-app/android/app/build/outputs/apk/release/app-release.apk, icon at
~/code/clients/acme-app/assets/icon.png. Deliver the built deck with every clip verified by
verify-video and a clean presentation review.
```

### Or run it by hand

```bash
cd ~/code/demo-creator

# Plan exactly as for iOS
node bin/demo-creator.mjs init acme-client --brs ~/Downloads/Acme-BRS.docx --app app-release.apk \
  --client "Acme" --icon icon.png
node bin/demo-creator.mjs brief acme-client         # hand to a planning agent → plan.json
node bin/demo-creator.mjs plan validate acme-client
#   add  "androidPackage": "com.acme.app"  to projects/acme-client/project.json

# Fresh app, pinned status bar, then one continuous capture
node bin/demo-creator.mjs android prep --package com.acme.app --apk app-release.apk --demo-bar
node bin/demo-creator.mjs android record start acme-client

# One Gemini Computer Use call per section; markers are written around each call
node bin/demo-creator.mjs drive acme-client 01-signup
node bin/demo-creator.mjs drive acme-client 02-onboarding
node bin/demo-creator.mjs drive acme-client 03-checkout
#   redo a section: run drive again for the same clipId (last start/end pair wins)
#   ad-hoc state change between sections: drive acme-client seam --task "Sign out and return to the welcome screen"

node bin/demo-creator.mjs android record stop acme-client
node bin/demo-creator.mjs split acme-client            # master → 30fps → per-clip mp4 + posters + boundary frames
#   look at frames/<clipId>/boundary-first.jpg / boundary-last.jpg; nudge with `android mark` and `split --only` if needed

# Judge
node bin/demo-creator.mjs verify-video acme-client            # every clip vs its evidence → verification.json
node bin/demo-creator.mjs review-presentation acme-client     # all sections shown in their windows, clean take → presentation-review.json

# Retake one failed clip
node bin/demo-creator.mjs android record start acme-client
node bin/demo-creator.mjs drive acme-client 03-checkout
node bin/demo-creator.mjs android record stop acme-client
node bin/demo-creator.mjs split acme-client --only 03-checkout
node bin/demo-creator.mjs verify-video acme-client --only 03-checkout

# Ship
node bin/demo-creator.mjs build acme-client && node bin/demo-creator.mjs check acme-client
```

`split`, `verify-video` and `review-presentation` also work on an iOS master
(`recordings/master.mp4` + `markers.jsonl` + `rec-start.txt`), so the Gemini judge
can replace the frame-by-frame verifier on any existing project.

## Using the judge on any video

```bash
uv run --script scripts/gemini-video.py --video clip.mp4 --prompt-file question.md            # free text
uv run --script scripts/gemini-video.py --video clip.mp4 --prompt-file question.md --json     # JSON object parsed from the reply
```

Options: `--model gemini-3.8-flash` (default; 3.6-flash and 3.5-flash-lite also support agentic
video), `--thinking-level high`, `--processing static` (fixed 1fps instead of agentic).

## Spend

Every Gemini call records its token usage (input, output, thinking, tool-use, cached)
next to its result: `verification.json`, `presentation-review.json`,
`.state/drives.jsonl` for `drive`, and `run.json` / `findings.json` for QA runs.

```bash
node bin/demo-creator.mjs cost acme-client     # one project: each verify, review and drive call
node bin/demo-creator.mjs cost --qa acme       # one QA target: each tester and reviewer call
node bin/demo-creator.mjs cost --all           # everything recorded on this machine
```

Prices come from `src/pricing.json` (paid tier, per 1M tokens, dated in the file;
Flash prices double on 2027-01-01). Thinking and tool-use tokens are billed as output.
Rows marked "total only" are older records with no breakdown, priced conservatively at
the output rate. This is an estimate from the API's own counts; the authoritative number
is Google AI Studio → Billing, or the Cloud Billing report for the key's project.

Reference points from today's runs on Flash: one clip verification ~3k tokens
(~$0.01), a 12-minute take review ~208k tokens (~$0.60 at the worst case), a
12-turn Computer Use round ~60k tokens (~$0.05).

## Eval

`scripts/eval-video-judge.sh` stages a throwaway project from a real delivery, seeds a fake
evidence item, and checks the judge sees the real items with frames and rejects the fake one.
Run it after any model or prompt change; it must print `EVAL PASS`.

## Gotchas already paid for

- Agentic video with a JSON `response_format` fails with "too many tool calls"; the JSON
  contract lives in the prompt and is parsed from text. Static processing rejects the `name` field.
- A windowless scrcpy ignores SIGINT/SIGTERM sent to it alone and SIGKILL leaves an unreadable
  mp4. `android record stop` signals its whole process group so it finalises the file.
- scrcpy emits no frame on a static screen, so capture start flicks the notification shade once
  to force a first frame and uses that instant as the marker time base. It lands before the first
  start marker and is cut away.
- Gemini's own log lines are block-buffered when not on a tty; do not wait for "Recording started".
