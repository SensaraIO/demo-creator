---
name: android-qa-loop
description: Test an Android app on the emulator in a fix-until-clean loop with two separate Gemini agents — Gemini Computer Use explores the app while scrcpy records, Gemini agentic video understanding reviews the recording and writes timestamped findings, then Claude fixes the code, rebuilds the APK, and runs the next round until the gate passes. Trigger on "qa the app", "test the android app with gemini", "find bugs in the apk", "run the qa loop", or any request to test an Android app visually and fix what is found.
---

# Android QA loop

Three roles, never merged: the tester (`demo-creator qa test`, Gemini Computer Use, drives the emulator and is recorded), the reviewer (`demo-creator qa review`, Gemini agentic video, watches the recording, writes `findings.json`), and you (fix the app, rebuild, decide when the loop ends). The tester does not judge and the reviewer does not drive.

```bash
export DEMO_CREATOR="${DEMO_CREATOR:-$HOME/code/demo-creator}"
cd "$DEMO_CREATOR" && node bin/demo-creator.mjs doctor --android
```

## Outcome

`qa gate <name>` exits 0: the latest run was reviewed and has no open blocker, major or minor findings (`--strict` also requires zero polish). Every finding you fixed is confirmed `fixed` by a later review, not by you. Stop the loop earlier only when a finding needs a product decision or the same finding survives three fix rounds; report it as open and say why.

## The loop

1. Once: `qa init <name> --package <pkg> --apk <path> --app-name "<name>" --focus "<what matters most>"`. Put anything the tester needs (test account, how to get an OTP, screens to avoid) in `--notes`; the tester can use only what it is told.
2. Build the APK from the project's own build command, then `qa test <name> --apk <fresh apk>` (defaults: 60 turns, high thinking, app data reset). Read the tester's report on the console but do not act on it; it is context for the reviewer.
3. `qa review <name>`. Findings carry ids (`R2-F3`), a timestamp, a frame under `qa/<name>/runs/NNN/frames/`, and repro steps taken from the tester's own action log. Prior open findings are re-classified as fixed, still-present, or not-exercised.
4. Fix in the app's source, one commit per finding or tightly related group, rebuild, and go to step 2. The next tester brief automatically lists the open findings so they are exercised again. If a finding was not-exercised two rounds running, put its repro in `--focus` for the next run.
5. When `qa gate` passes, report: rounds run, findings fixed with their ids, findings left open and why, and the run directories.

## Guardrails

- Never mark a finding fixed yourself; only a review can. Never edit `findings.json` by hand.
- The tester works on throwaway data only. Nothing it does may reach a production backend; point the app at a dev environment before round one.
- If the tester exits 3 (Gemini refused an action) or 2 (turn limit), the recording is still reviewed; note it in the report.
- Do not widen scope: fix what the reviewer found in the app under test. A defect in the emulator, the build, or the harness is reported, not silently worked around.
