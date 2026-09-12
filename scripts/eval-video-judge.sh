#!/usr/bin/env bash
# Eval for the Gemini video judge. Re-run whenever the model or the verifier
# prompt changes. It stages a throwaway project from an existing delivery's
# continuous take, splits it by the real markers, then verifies one clip whose
# plan has a seeded evidence item that is NOT in the footage. Pass = the real
# items are seen with timestamps and the seeded one is rejected.
#
#   scripts/eval-video-judge.sh [source-project] [clipId]
#
# Derived from the first real run on 2026-09-02 (project slug redacted, clip 01-signup):
# the judge found all four real items and rejected a fake "Payment failed" banner.
set -euo pipefail
cd "$(dirname "$0")/.."

SRC="${1:?usage: eval-video-judge.sh <project>}"
CLIP="${2:-03-home}"
EVAL="_eval-video-judge"
P="projects/$EVAL"

[ -f "projects/$SRC/recordings/master-cfr.mp4" ] || { echo "no projects/$SRC/recordings/master-cfr.mp4"; exit 2; }
rm -rf "$P"; mkdir -p "$P/recordings"
cp "projects/$SRC"/{project.json,brs.json,brs.md} "$P/"
cp "projects/$SRC"/recordings/{markers.jsonl,rec-start.txt} "$P/recordings/"
ln -s "../../$SRC/recordings/master-cfr.mp4" "$P/recordings/master.mp4"

# Seed one impossible evidence item into the clip under test.
python3 - "$SRC" "$P" "$CLIP" <<'EOF'
import json, sys
src, p, clip = sys.argv[1:4]
plan = json.load(open(f"projects/{src}/plan.json"))
for c in plan["clips"]:
    if c["id"] == clip:
        c["evidence"].append("A red 'Payment failed' banner covers the top of the screen")
json.dump(plan, open(f"{p}/plan.json", "w"), indent=2)
EOF

node bin/demo-creator.mjs split "$EVAL" --only "$CLIP" >/dev/null
node bin/demo-creator.mjs verify-video "$EVAL" --only "$CLIP" || true

python3 - "$P" "$CLIP" <<'EOF'
import json, sys
p, clip = sys.argv[1:3]
v = json.load(open(f"{p}/verification.json"))
r = next(x for x in v["results"] if x["clipId"] == clip)
checks = r["evidenceChecks"]
real, seeded = checks[:-1], checks[-1]
ok = all(c["seen"] and c["frame"] for c in real) and not seeded["seen"] and r["pass"] is False
print()
print(f"real items seen with frames: {sum(1 for c in real if c['seen'] and c['frame'])}/{len(real)}")
print(f"seeded item rejected: {not seeded['seen']}")
print(f"clip failed overall (as it must with a missing item): {r['pass'] is False}")
print("EVAL PASS" if ok else "EVAL FAIL")
sys.exit(0 if ok else 1)
EOF

# The staged project is left in place for inspection; it is throwaway.
echo "staged eval project: $P (safe to delete)"
