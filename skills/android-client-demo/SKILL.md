---
name: android-client-demo
description: Produce a branded Android client demo from a BRS. Plan one continuous take, let the local UI-Voyager model drive the Android emulator through Codex's android-ui-voyager MCP one observable step at a time, record with scrcpy, split by Codex-owned markers, verify every requirement, and build the delivery. Use for Android client demos, emulator walkthroughs, BRS evidence videos, delivery recordings, or requests to run the client-demo workflow with UI-Voyager instead of a general-purpose GPT driver.
---

# Android client demo walkthrough

Turn a client's BRS into a branded presentation where every visual functional
requirement sits beside video evidence of that requirement working on Android.
Use the `demo-creator` engine at `/Users/cheshire/code/demo-creator`; read its
`README.md` before the first run of a session. Each delivery lives under
`projects/<client>/` and the dashboard watches its `demo-status.json` live at
`http://127.0.0.1:4400` when `dashboard/npm run dev` is running.

Keep the existing `client-demo` skill for iOS. This skill is its Android
equivalent and deliberately changes only the device driver and capture path.

## Control model

- Codex is the sole orchestrator. It owns planning, Android setup, recorder
  lifecycle, section markers, status, splitting, verification, and retakes.
- UI-Voyager is the sole Android interaction driver. Access it directly through
  the `android-ui-voyager` MCP; do not launch Hermes, Glimmer, or another GPT
  agent for the take.
- During recording, call `android_ui_voyager_start_task` once per coherent flow,
  then call `android_ui_voyager_step` one step at a time. Inspect each returned
  action and evidence before continuing. Do not use `android_ui_voyager_run`
  for the master take because it hides the points where Codex must observe,
  steer, mark boundaries, and stop on failure.
- Record one continuous master take with `scrcpy`, then split it into clips.
  Record only failed clips again.

UI-Voyager evidence is retained under
`~/.codex/android-ui-voyager/runs/<task_id>/`. Keep the emulator visible if the
user wants to watch; `scrcpy --no-playback` records without opening a second
mirror window.

## Pipeline

```text
init -> plan -> Android prep -> rehearse -> one master recording
     -> split by markers -> verify -> retake failures only -> build -> done
```

Run demo-creator commands from `/Users/cheshire/code/demo-creator` with
`node bin/demo-creator.mjs ...`. Its `doctor`, `sim prep`, and `record`
commands are iOS-specific; do not use those three commands for this workflow.

## 1. Preflight and initialize

Required local services and tools:

```bash
curl -fsS http://127.0.0.1:8102/health
adb devices -l
scrcpy --version
ffmpeg -version
ffprobe -version
```

Call `android_environment_status`. If no Android device is ready, call
`android_start_emulator` with the installed AVD and wait for it to finish
booting. When more than one device is connected, select one serial and use it
for every ADB, scrcpy, and MCP call.

Initialize with the APK and explicit metadata because demo-creator's automatic
bundle/icon extraction is iOS-only:

```bash
node bin/demo-creator.mjs init <client> \
  --brs <brs.docx|md> \
  --app <path/to/app.apk> \
  --app-name "<App Name>" \
  --bundle-id <android.package.name> \
  --client "<Client Name>" \
  --icon <badge.png>
```

Immediately create `projects/<client>/demo-status.json` using the contract
below with `state: "planning"`. Update it atomically at each transition and
after every clip. Refresh `updatedAt` during any stage longer than five minutes
so the dashboard does not report a false stall.

## 2. Plan the clips and take

```bash
node bin/demo-creator.mjs brief <client>
node bin/demo-creator.mjs plan validate <client>
```

Write `plan.json` yourself. Arrange the planned clips as one natural journey,
such as registration, onboarding, core features, settings, and admin. Every
clip must cite the exact BRS section and list visible evidence.

- End each clip on a settled screen; begin the next with visible navigation.
- Hold the first screen of each section for about one second before acting.
- Put account or role changes at seams that will be excluded from final clips.
- Never plan a visual clip for a backend-only or narrative requirement.

Set status to `recording`, seed every planned clip as `pending`, and set
`counts.planned`.

## 3. Prepare and rehearse Android

Install and reset the app with the selected serial:

```bash
adb -s <serial> install -r <path/to/app.apk>
adb -s <serial> shell pm clear <android.package.name>
adb -s <serial> shell monkey -p <android.package.name> -c android.intent.category.LAUNCHER 1
```

Before recording:

- Confirm the backend is live and seeded.
- Stage all demo credentials, roles, OTP access, and test data.
- Dismiss first-run Android and app permission dialogs.
- Disable or clear notifications that could expose private information.
- Keep the emulator at a stable orientation and resolution.
- Rehearse every flow off-camera with `android_ui_voyager_start_task` and
  single `android_ui_voyager_step` calls. Confirm each task finishes cleanly.
- Reset app state and return to the opening screen after rehearsal.

Treat a UI-Voyager action as a proposal that the MCP validates and executes.
If a step is wrong, stop that task, restore the app to a known screen, and
start a corrected task. Do not let a bad action compound through the take.

## 4. Record one observable master take

Create the recordings directory, clear stale marker files, and start scrcpy in
a retained background terminal/process session owned by Codex:

```bash
mkdir -p projects/<client>/recordings
scrcpy --serial <serial> --no-playback --no-audio --video-codec=h264 \
  --record=projects/<client>/recordings/master.mp4
```

Do not use `nohup` or detach it from the controller. Confirm the process remains
alive, then immediately record the start epoch in
`projects/<client>/recordings/rec-start.txt`.

Codex owns markers. Append one JSON line when a section's first screen is
settled and one when its evidence is complete:

```json
{"t": 1786370400.125, "clipId": "01-signup", "event": "start"}
{"t": 1786370434.750, "clipId": "01-signup", "event": "end"}
```

For each planned section:

1. Update `stageDetail` with the section number and clip ID.
2. Put the app on the section's first settled screen; write its `start` marker.
3. Create a focused UI-Voyager task for that one flow.
4. Call `android_ui_voyager_step` once, inspect its returned before/after
   evidence and action, then repeat only while it advances the intended flow.
5. When the required evidence is visibly settled, write the `end` marker and
   update the clip status.

Stop the retained scrcpy process with Ctrl-C/SIGINT through the same process
session. Wait for a clean exit and verify the finalized master:

```bash
ffprobe -v error -show_entries format=duration,size \
  -of default=noprint_wrappers=1 projects/<client>/recordings/master.mp4
```

Never kill every `scrcpy` process globally. Stop only the PID/session Codex
started for this delivery.

## 5. Split by markers

Compute each offset relative to `rec-start.txt`, pad the start by up to 0.5s
and the end by up to 0.5s, then clamp to the master duration:

```bash
ffmpeg -ss <start> -to <end> -i projects/<client>/recordings/master.mp4 \
  -vf fps=30 -c:v libx264 -crf 24 -preset medium -pix_fmt yuv420p \
  -movflags +faststart -an projects/<client>/recordings/<clipId>.mp4
```

Re-encode every clip to constant 30 fps. Extract and inspect boundary frames,
nudging a cut by one or two seconds if it begins or ends mid-action. Also ship
a trimmed, CFR `master-full.mp4` when useful.

Mark each completed file `recorded`, set `durationSec`, and update counts and
`stageDetail` as splitting progresses.

## 6. Verify and retake only failures

Set `state: "verifying"`. For every clip:

```bash
node bin/demo-creator.mjs frames <client> <clipId> --count 8
```

Inspect the sampled frames against every evidence item in `plan.json`. Write
`verification.json` with a per-clip `pass` and frame-cited `evidenceChecks`.

If a clip fails, record only that flow again with the same Codex-owned scrcpy
lifecycle and stepwise UI-Voyager control. Re-encode and re-verify it. After
two failed attempts, mark the clip failed and report the honest gap; never
substitute a merely similar screen.

## 7. Build and finish

```bash
node bin/demo-creator.mjs build <client>
open projects/<client>/dist/index.html
```

Set `state: "done"`, `finishedAt`, and `stageDetail: "Presentation built"`.
If the workflow stops with an unrecoverable error, set `state: "failed"` and
top-level `error` before returning.

## Dashboard status contract

```json
{
  "version": 1,
  "project": "acme-android",
  "client": "Acme",
  "app": "Acme App",
  "state": "recording",
  "stageDetail": "Take: section 3 of 11 (02-onboarding)",
  "startedAt": "2026-08-10T14:00:00Z",
  "updatedAt": "2026-08-10T14:22:31Z",
  "finishedAt": null,
  "error": null,
  "counts": {"planned": 11, "recorded": 2, "verified": 0, "failed": 0},
  "clips": [
    {
      "id": "01-signup",
      "title": "Create an account",
      "sectionIds": ["5.1.1"],
      "status": "verified",
      "attempts": 1,
      "durationSec": 34.2,
      "agent": "android-ui-voyager-single-take",
      "error": null
    }
  ]
}
```

Allowed run states are `planning`, `recording`, `verifying`, `building`,
`done`, and `failed`. Allowed clip states are `pending`, `recording`,
`recorded`, `verified`, and `failed`. Use agent
`android-ui-voyager-single-take` for master cuts and
`android-ui-voyager-retake` for targeted retakes. Use ISO-8601 UTC timestamps
and replace the whole JSON file atomically.

## Common failure points

- No ADB device: call `android_environment_status`, start the intended AVD,
  and wait for boot completion before retrying.
- Multiple devices: always pass the same explicit serial to ADB, scrcpy, and
  UI-Voyager.
- Recording is not finalized: send SIGINT to the retained scrcpy process and
  wait for it to exit before reading the file.
- UI-Voyager drifts: stop immediately, reset to a known screen, and use a more
  focused task. Do not continue an incorrect autonomous loop.
- Text entry is unreliable: pre-stage long credentials when possible and
  screenshot-check each field before submitting.
- Android permission/system dialogs are not product evidence. Resolve them
  before the take unless the requirement explicitly covers permissions.
- Keep secrets, personal notifications, real accounts, and production data off
  the recorded device.
- Rehearsal remains the biggest quality lever.
