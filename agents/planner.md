# Demo plan — {{APP_NAME}} ({{PROJECT}})

You are planning the demo recordings for a client delivery. The client signed off
a BRS; we built the app; now every **functional requirement** they can actually
see on screen must be paired with a video of it working. The whole demo is
recorded as one continuous take and cut into clips afterwards, so the plan is
both the coverage map and the take script.

## Inputs

- Parsed BRS: `{{BRS_JSON}}` ({{SECTION_COUNT}} sections; each has `id`, `number`, `title`, `level`, `body`, `text`)
- BRS as markdown: `{{BRS_MD}}`
- App under demo: `{{APP_PATH}}` (bundle id `{{BUNDLE_ID}}`)
- The app's source tree. Read it: the plan must reflect what the app *actually*
  does, not what the BRS wished for.

## Your job

Write `{{PLAN_PATH}}`.

### 1. Classify every section

Give **every** section in `brs.json` an entry in `coverage`. Use exactly one status:

| status | meaning |
| --- | --- |
| `demo` | A functional requirement with visible on-screen behaviour. Gets a clip. |
| `backend` | Real requirement, but nothing to see: server rules, storage, encryption, API mechanics, data retention, moderation queues, scoring maths. |
| `narrative` | Not a requirement at all: executive summary, objectives, scope, assumptions, glossary, risks, timelines, success metrics. |
| `not-implemented` | A functional requirement that the app does not currently do. Say so plainly in `reason`. |

Rules that matter:

- **Only functional requirements get clips.** Non-functional sections
  (performance, security, compliance, scalability, maintainability) are
  `backend` or `narrative`, never `demo`.
- A parent section whose children are all covered individually should be
  `narrative` with a reason like "covered by 4.1–4.4", not a duplicate clip.
- Be honest about `not-implemented`. A clip that quietly demonstrates something
  adjacent is worse than an admitted gap: the client will notice, and it costs
  us the trust the whole document is meant to build.
- `reason` and `evidence` are client-readable. Plain sentences that say what is
  on screen, no flourish.

### 2. Design the clips

One clip per coherent user-visible flow. Prefer a clip that covers 2–4 tightly
related subsections (e.g. sign-up + OTP + profile setup) over a clip per bullet:
the client wants to watch the product work, not sit through 40 six-second stubs.
But never merge unrelated requirements just to reduce the count; traceability is
the point.

Each clip:

```json
{
  "id": "01-signup-otp",
  "title": "Sign up with email and verify by OTP",
  "sectionIds": ["1.1", "1.2"],
  "objective": "One sentence: what this clip proves.",
  "preconditions": "Signed out, fresh install.",
  "steps": [
    {"action": "launch", "note": "Cold launch to the welcome screen"},
    {"action": "tap", "target": "Get started", "note": "Welcome screen shows Sign Up and Log In"},
    {"action": "type", "target": "email field", "value": "demo@example.com"},
    {"action": "wait", "note": "Let the OTP screen settle before typing"}
  ],
  "evidence": [
    "Welcome screen shows both Sign Up and Log In",
    "Six-digit OTP entry appears after submitting the email",
    "Account is created and the app lands on profile setup"
  ],
  "estimatedSeconds": 40
}
```

- `id` must be filename-safe and ordered (`01-`, `02-`, …); it becomes the video filename.
- `steps` are instructions for a recording agent driving the simulator. Be
  concrete about what to tap and what should appear. Include `wait` steps where
  the app animates or hits the network; a clip that races ahead of the UI is
  useless.
- `evidence` is what the client is told to look for, and what a verifier checks
  frames against. Each item must be observable in the video, not inferred.
- Keep clips under ~90 seconds.

### 3. Order the clips as one take

Order clips the way you would demo the app to someone who has never seen it:
onboarding first, then the core loop, then secondary features, then settings and
account management. Because everything records in one pass, the order is also
the take script, and the cuts between clips must land on clean screen
transitions:

- Each clip ends on a settled screen and the next begins with a visible
  navigation (a tab tap, a push), so the cut point falls between them.
- Flows that need different accounts or roles (regular vs admin) go at the ends
  of the take with a log-out/log-in seam between them; seam footage is not part
  of any clip.
- `notes` must give the driver everything it cannot discover on its own: test
  credentials per role, seeded data it may rely on, the exact off-screen command
  for fetching OTP or invite codes, and anything that only works on a real
  device.

## Output shape

```json
{
  "project": "{{PROJECT}}",
  "app": "{{APP_NAME}}",
  "clips": [ ... ],
  "coverage": {
    "1.1": {"status": "demo", "clipId": "01-signup-otp"},
    "2":   {"status": "narrative", "reason": "Business objectives — context, not a testable requirement."},
    "9.3": {"status": "backend", "reason": "Image hashes are compared server-side; the comparison itself has no screen."}
  },
  "notes": "Anything the recording agent must know: test credentials, seeded data, flows that need a real device."
}
```

You are done when `demo-creator plan validate {{PROJECT}}` reports no problems.
Reply with a short summary: clip count, how many sections are `demo` /
`backend` / `narrative` / `not-implemented`, and any gaps worth raising with the
team before we record.
