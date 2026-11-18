#!/usr/bin/env bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

# image-relay-check.sh [workflow.yml]
#
# .github/workflows/image-relay.yml copies a release's image, by digest, to the ROCm staging repository with a registry
# credential. This checks the file's shape and runs its resolve step:
#   [shape]     no concurrency group that a newer run could use to cancel a relay waiting for its reviewer; the resolve
#               job never runs for a pull request; the relay job needs it, runs in image-publish and is the only job
#               that names a secret; the copy keeps the digest and reads the destination back; no run script
#               interpolates ${{ }}; every action is pinned to a commit
#   [resolve]   the resolve step's script, run with a stand-in gh (release notes) and skopeo (tag -> digest), against
#               fixed releases: the one claw build a claw-v release names, the Image: line of a personal-agent-v
#               release, a dispatch's agent-sandbox digests, and the cases that must resolve to nothing or fail

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
workflow="${1:-$repo_root/.github/workflows/image-relay.yml}"

command -v python3 >/dev/null 2>&1 || { echo "error: python3 is required for this check" >&2; exit 1; }
python3 -c 'import yaml' 2>/dev/null || { echo "error: python3 PyYAML is required for this check" >&2; exit 1; }

exec python3 - "$workflow" <<'PY'
import json, os, re, stat, subprocess, sys, tempfile
import yaml

path = sys.argv[1]
with open(path, encoding="utf-8") as f:
    doc = yaml.safe_load(f)
jobs = doc["jobs"]
failures = []


def fail(rule, message):
    failures.append(f"[{rule}] {message}")


# --- shape -----------------------------------------------------------------------------------------------------------
if "concurrency" in doc:
    fail("shape", "a workflow-wide concurrency group lets a newer queued run cancel a relay that waits for its reviewer")
for name, job in jobs.items():
    if "concurrency" in job:
        fail("shape", f"job {name} has a concurrency group")

resolve, relay = jobs.get("resolve"), jobs.get("relay")
if not resolve or not relay:
    fail("shape", "the resolve and relay jobs must both exist")
else:
    if "github.event_name != 'pull_request'" not in str(resolve.get("if", "")):
        fail("shape", "the resolve job must not run for a pull request")
    needs = relay.get("needs")
    if needs != "resolve" and needs != ["resolve"]:
        fail("shape", "the relay job must need the resolve job")
    if relay.get("environment") != "image-publish":
        fail("shape", "the relay job must run in the image-publish environment")
    copy = [s for s in relay["steps"] if "skopeo copy" in s.get("run", "")]
    if len(copy) != 1 or "--preserve-digests" not in copy[0]["run"] or "skopeo inspect" not in copy[0]["run"]:
        fail("shape", "exactly one step copies, with --preserve-digests, and reads the destination's digest back")
for name, job in jobs.items():
    if name != "relay" and "secrets." in yaml.safe_dump(job):
        fail("shape", f"job {name} names a secret; only the relay job may")
for name, job in jobs.items():
    for step in job.get("steps", []):
        if "${{" in step.get("run", ""):
            fail("shape", f"a run script of job {name} ({step.get('name')}) interpolates ${{{{ }}}}")
        uses = step.get("uses")
        if uses and not re.fullmatch(r"[^@\s]+@[0-9a-f]{40}", uses):
            fail("shape", f"{uses} is not pinned to a commit")

# --- resolve ---------------------------------------------------------------------------------------------------------
script = next((s["run"] for s in (resolve or {}).get("steps", []) if s.get("id") == "resolve"), None)
if script is None:
    fail("resolve", "the resolve job has no step with id resolve")
    script = "exit 1"

D = {k: "sha256:" + k * 64 for k in "1234abc"}
NOTES = {
    "claw-v1.2.3": "## Claw 1.2.3\n\n**Image:** `docker.io/primussafe/claw:202611131535`, the build id the Build workflow "
                   "pushed. Pin a deployment with `--set image.tag=202611131535`.\n",
    "claw-v1.2.4": "Builds `docker.io/primussafe/claw:202611131535` and `docker.io/primussafe/claw:202611131600`.\n",
    "claw-v1.2.5": "No image here.\n",
    "personal-agent-v1.2.3": f"## 1.2.3\n\nImage: `docker.io/primussafe/personal-agent-teams:1.2.3@{D['a']}`\n",
    "personal-agent-v1.2.4": "## 1.2.4\n\nNotes only; the image was not published.\n",
    "personal-agent-v1.2.5": f"Image: `registry.example.com/team/personal-agent-teams:1.2.5@{D['b']}`\n",
    "personal-agent-v1.2.6": f"Image: `docker.io/primussafe/personal-agent-teams:1.2.5@{D['c']}`\n",
}
TAGS = {"docker.io/primussafe/claw:202611131535": D["1"]}
KNOWN = {f"docker.io/primussafe/agent-sandbox-controlplane@{D['2']}", f"docker.io/primussafe/agent-sandbox-envd-injector@{D['3']}"}

work = tempfile.mkdtemp(prefix="image-relay-check-")
stub = os.path.join(work, "bin")
os.makedirs(stub)
with open(os.path.join(work, "notes.json"), "w") as f:
    json.dump(NOTES, f)
with open(os.path.join(work, "registry.json"), "w") as f:
    json.dump({"tags": TAGS, "known": sorted(KNOWN)}, f)
GH = f"""#!/usr/bin/env python3
import json, sys
a = sys.argv[1:]
if a[:2] != ["release", "view"]:
    sys.exit("stand-in gh: unexpected " + " ".join(a))
notes = json.load(open({json.dumps(os.path.join(work, "notes.json"))}))
if a[2] not in notes:
    sys.exit("release not found")
print(notes[a[2]])
"""
SKOPEO = f"""#!/usr/bin/env python3
import json, sys
a = sys.argv[1:]
if not a or a[0] != "inspect" or not a[-1].startswith("docker://"):
    sys.exit("stand-in skopeo: unexpected " + " ".join(a))
ref = a[-1][len("docker://"):]
reg = json.load(open({json.dumps(os.path.join(work, "registry.json"))}))
if ref in reg["tags"]:
    print(reg["tags"][ref])
elif ref in reg["known"]:
    print(ref.split("@", 1)[1])
else:
    sys.exit("manifest unknown: " + ref)
"""
for name, body in (("gh", GH), ("skopeo", SKOPEO)):
    p = os.path.join(stub, name)
    with open(p, "w") as f:
        f.write(body)
    os.chmod(p, os.stat(p).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
with open(os.path.join(work, "resolve.sh"), "w") as f:
    f.write(script)

S = "docker.io/rocm/primusclaw-private"
CASES = [
    # event, tag, controlplane, envd-injector, expected copies (None: the step fails)
    ("release", "claw-v1.2.3", "", "", [(f"docker.io/primussafe/claw@{D['1']}", f"{S}:claw-1.2.3")]),
    ("release", "claw-v1.2.4", "", "", None),
    ("release", "claw-v1.2.5", "", "", None),
    ("release", "connector-v0.2.2", "", "", []),
    ("release", "claw-v1.2.3; touch pwned", "", "", []),
    ("workflow_run", "personal-agent-v1.2.3", "", "",
     [(f"docker.io/primussafe/personal-agent-teams@{D['a']}", f"{S}:personal-agent-teams-1.2.3")]),
    ("workflow_run", "personal-agent-v1.2.4", "", "", []),
    ("workflow_run", "personal-agent-v1.2.5", "", "", None),
    ("workflow_run", "personal-agent-v1.2.6", "", "", None),
    ("workflow_run", "claw-v1.2.3", "", "", []),
    ("workflow_run", "feature/some-branch", "", "", []),
    ("workflow_dispatch", "claw-v1.2.3", D["2"], D["3"], [
        (f"docker.io/primussafe/claw@{D['1']}", f"{S}:claw-1.2.3"),
        (f"docker.io/primussafe/agent-sandbox-controlplane@{D['2']}", f"{S}:agent-sandbox-controlplane-1.2.3"),
        (f"docker.io/primussafe/agent-sandbox-envd-injector@{D['3']}", f"{S}:agent-sandbox-envd-injector-1.2.3"),
    ]),
    ("workflow_dispatch", "personal-agent-v1.2.3", D["2"], "", None),
    ("workflow_dispatch", "claw-v1.2.3", "sha256:BAD", "", None),
    ("workflow_dispatch", "claw-v1.2.3", D["4"], "", None),
]
for event, tag, cp, envd, want in CASES:
    out = os.path.join(work, "output")
    open(out, "w").close()
    env = dict(os.environ, PATH=stub + os.pathsep + os.environ["PATH"], GITHUB_OUTPUT=out,
               GITHUB_REPOSITORY="AMD-AGI/PrimusClaw", GH_TOKEN="stand-in", EVENT=event,
               RELEASE_TAG=tag if event == "release" else "", RUN_BRANCH=tag if event == "workflow_run" else "",
               INPUT_TAG=tag if event == "workflow_dispatch" else "", CONTROLPLANE_DIGEST=cp, ENVD_INJECTOR_DIGEST=envd)
    r = subprocess.run(["bash", "-e", os.path.join(work, "resolve.sh")], env=env, cwd=work, capture_output=True, text=True)
    label = f"{event} {tag!r} controlplane={cp[:12] or '-'} envd={envd[:12] or '-'}"
    if want is None:
        if r.returncode == 0:
            fail("resolve", f"{label}: expected the step to fail, it exited 0 with {open(out).read().strip()!r}")
        continue
    if r.returncode != 0:
        fail("resolve", f"{label}: exited {r.returncode}: {(r.stdout + r.stderr).strip()[-300:]}")
        continue
    lines = [l for l in open(out).read().splitlines() if l.startswith("copies=")]
    if len(lines) != 1:
        fail("resolve", f"{label}: wrote {len(lines)} copies= outputs")
        continue
    got = [(c["source"], c["destination"]) for c in json.loads(lines[0][len("copies="):])]
    if got != want:
        fail("resolve", f"{label}: copies {got}, expected {want}")
    if os.path.exists(os.path.join(work, "pwned")):
        fail("resolve", f"{label}: the tag reached the shell")

if failures:
    print("image-relay check: FAILED")
    for line in failures:
        print("  " + line)
    sys.exit(1)
print(f"image-relay check: ok ({len(CASES)} resolve cases)")
PY
