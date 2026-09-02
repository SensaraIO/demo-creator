---
name: android-demo-gemini
description: Produce a branded Android client demo from a BRS with two separate Gemini agents — Gemini Computer Use drives each section on the emulator while scrcpy records one continuous take, and Gemini agentic video understanding verifies every clip against its evidence and reviews the whole take for clean presentation. Trigger on "android demo", "record the android demo", "client demo on android", "demo the apk", or any request to run the client-demo workflow on Android with Gemini.
---

# Android client demo with Gemini

Same deliverable as `client-demo` (BRS → plan → one continuous take → per-section clips → verified → branded deck), with the iOS Simulator driver and the Claude frame-by-frame verifier replaced by two Gemini agents that never share a context: the driver (`demo-creator drive`, Gemini Computer Use) and the judge (`demo-creator verify-video`, Gemini agentic video). You orchestrate; you do not drive the device and you do not judge the clips yourself.

```bash
export DEMO_CREATOR="${DEMO_CREATOR:-$HOME/code/demo-creator}"
cd "$DEMO_CREATOR" && node bin/demo-creator.mjs doctor --android
```

`doctor --android` must pass (adb, scrcpy, uv, gemini-computer.py, a Gemini key, a booted emulator) before you start. Never hardcode a home directory; these flows run on several Macs.

## Outcome

`projects/<client>/dist/index.html` built, `check <client>` exit 0, every clip verified by `verify-video` with a cited frame, `presentation-review.json` reporting every section shown and the take clean, and `demo-status.json` at `done`. Keep the status file live at every transition exactly as the `client-demo` skill describes; the dashboard contract is unchanged.

## The run

1. `init <client> --brs <file> --app <apk> --client "<name>" --icon <png>` then plan with `brief <client>` as usual, and add `androidPackage` to `project.json` (`init` reads the package from an APK when `aapt` is available; otherwise set it by hand). `plan validate <client>` must pass.
2. `android prep --package <pkg> --apk <apk> --demo-bar` puts the app fresh on its first screen with a pinned status bar. Stage accounts and OTP retrieval as the plan's `notes` say; the driver can only use what the plan gives it.
3. `android record start <client>` starts the master capture. Then, for every clip in plan order, `drive <client> <clipId>`: it writes the start marker, hands that one section to Gemini Computer Use with the clip's steps and evidence, and writes the end marker when the driver returns. Read each driver report; do state switching between sections yourself (adb, or a short `drive` with an ad-hoc `--task`), because footage between an end and the next start is cut away. A section that went wrong is redone with another `drive` for the same clipId; the splitter uses the last start/end pair.
4. `android record stop <client>`, then `split <client>`. Look at `frames/<clipId>/boundary-first.jpg` and `boundary-last.jpg` for every clip and nudge a marker (`android mark`) and re-split any clip that opens or closes mid-transition.
5. `verify-video <client>` (all clips, in parallel) and `review-presentation <client>`. A failed clip gets one targeted retake: `android record start`, `drive` for that clip, `android record stop`, `split --only <clipId>`, `verify-video --only <clipId>`. A clip that fails twice is marked `failed` in the status file and its file moved to `recordings/rejected/`, so the deck records an honest gap.
6. `build <client>`, `check <client>`, status `done`.

## Guardrails

- Two agents, two calls. The driver never sees a verdict; the judge never sees the driver's transcript. Do not verify a clip by looking at frames yourself and marking it passed; if `verify-video` cannot run, the clip is unverified.
- Nothing to production: no real client accounts, no live payments, no writes to a production backend.
- Stop only for a required flow you cannot make work, or a decision about deleting recordings you did not make in this run.
- Report: what was produced, which sections were retaken or left as gaps and why, and the deck path.
