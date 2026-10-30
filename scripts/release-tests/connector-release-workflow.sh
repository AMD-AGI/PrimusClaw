#!/usr/bin/env bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

# connector-release-workflow.sh [workflow.yml]
#
# .github/workflows/connector-release.yml publishes @primusclaw/connector to a public registry
# with an OIDC identity. A release event runs the file as it exists at the release's tag, so the
# checks inside the file are not what stops an unreviewed publish; the `npm-publish` environment's
# reviewers are. That only holds while the file keeps its shape, which this asserts:
#   [trigger]      nothing starts it but a published release
#   [permissions]  only the job in the environment holds a write scope (the OIDC one included)
#   [environment]  that job names npm-publish and needs the package job
#   [no-code]      that job checks out nothing, installs nothing, runs no repository script and
#                  uses only the three actions it needs
#   [publish-last] `npm publish` is that job's last step and appears nowhere else
#   [guard]        the package job checks, before it builds, that the environment has at least one
#                  required reviewer and administrator bypass off. Self-review is allowed (the
#                  maintainer who cuts a release approves it), so the check must not demand it: the
#                  job's own jq program is run against environment responses, so a guard that would
#                  refuse the environment as it is set up, or accept one without reviewers, fails here
#   [injection]    no run script interpolates ${{ }}; every expression reaches the shell as env
#   [pinned]       every action is pinned to a commit
# Then it mutates a copy of the file once per rule and requires that rule, and not just any rule,
# to report it: a check that has never been seen refusing is not a check.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
workflow="${1:-$repo_root/.github/workflows/connector-release.yml}"

command -v python3 >/dev/null 2>&1 || { echo "error: python3 is required for this check" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "error: jq is required for this check" >&2; exit 1; }
python3 -c 'import yaml' 2>/dev/null || { echo "error: python3 PyYAML is required for this check" >&2; exit 1; }

exec python3 - "$workflow" <<'PY'
import copy, json, re, subprocess, sys
import yaml

path = sys.argv[1]
with open(path, encoding="utf-8") as f:
    baseline = yaml.safe_load(f)

ALLOWED_PUBLISH_ACTIONS = {
    "actions/download-artifact",
    "actions/setup-node",
    "actions/attest-build-provenance",
}
# Anything that could run code from the repository or from the tarball: installs, package scripts,
# a node script file (the toolchain guard's `node -e` is inline code written in the workflow itself),
# unpacking and running what was unpacked.
_cmd = r"(?:^|[;&|(]|&&)\s*"  # a command position: line start or after ; & | (
REPO_CODE = re.compile(
    r"\b(?:npm\s+(?:ci|install|i|run|test|exec|start)|npx|pnpm|yarn|make|tar|unzip|python3?|chmod)\b"
    + r"|" + _cmd + r"node\s+(?!-e\b)\S"
    + r"|" + _cmd + r"(?:ba)?sh\s+\S"
    + r"|(?:^|\s)\./",
    re.M,
)


# The package job decides whether the environment is acceptable with a `jq -e` program over the
# response of GET /repos/{repo}/environments/npm-publish. It is run here, against responses shaped
# like the API's, so that what it accepts and refuses is observed and not read off its text.
GUARD_PROGRAM = re.compile(r"jq -e '(.*?)'\s*<<<\"\$environment\"", re.S)


def environment(bypass=False, rules=None):
    doc = {"name": "npm-publish", "protection_rules": rules if rules is not None else []}
    if bypass is not None:
        doc["can_admins_bypass"] = bypass
    return doc


def reviewers(prevent_self_review, people=1):
    return {
        "id": 1, "type": "required_reviewers", "prevent_self_review": prevent_self_review,
        "reviewers": [{"type": "User", "reviewer": {"login": f"maintainer{i}"}} for i in range(people)],
    }


GUARD_ACCEPTS = [
    ("a reviewer, self-review allowed, administrator bypass off (how the environment is set up)",
     environment(rules=[reviewers(False)])),
    ("a reviewer, self-review prevented, administrator bypass off (stricter is fine)",
     environment(rules=[reviewers(True)])),
    ("two reviewers beside a wait timer", environment(rules=[{"type": "wait_timer", "wait_timer": 5}, reviewers(False, people=2)])),
]
GUARD_REFUSES = [
    ("no protection rules at all", environment(rules=[])),
    ("a wait timer and no reviewer rule", environment(rules=[{"type": "wait_timer", "wait_timer": 5}])),
    ("a reviewer rule with nobody in it", environment(rules=[reviewers(False, people=0)])),
    ("a reviewer rule that has no reviewers key", environment(rules=[{"type": "required_reviewers", "prevent_self_review": False}])),
    ("a reviewer, but administrators may bypass", environment(bypass=True, rules=[reviewers(False)])),
    ("a reviewer, but the response does not say whether administrators may bypass", environment(bypass=None, rules=[reviewers(False)])),
    ("a response without protection_rules", {"name": "npm-publish", "can_admins_bypass": False}),
]


def jq_decides(program, doc):
    """True: accepted; False: refused; None: jq itself failed on the program."""
    r = subprocess.run(["jq", "-e", program], input=json.dumps(doc), capture_output=True, text=True)
    return {0: True, 1: False}.get(r.returncode)


def triggers(wf):
    # YAML 1.1 reads the key `on` as the boolean True.
    return wf.get("on", wf.get(True))


def writes(perms):
    return isinstance(perms, dict) and any(v == "write" for v in perms.values()) or perms == "write-all"


def steps(job):
    return job.get("steps") or []


def uses_of(step):
    return str(step.get("uses", "")).split("@")[0]


def check(wf):
    out = []
    bad = lambda rule, msg: out.append(f"[{rule}] {msg}")
    jobs = wf.get("jobs") or {}

    if triggers(wf) != {"release": {"types": ["published"]}}:
        bad("trigger", f"on: must be exactly release: types: [published], found {triggers(wf)!r}")

    if wf.get("permissions") != {"contents": "read"}:
        bad("permissions", f"workflow-level permissions must be exactly contents: read, found {wf.get('permissions')!r}")
    for name, job in jobs.items():
        if writes(job.get("permissions")) and job.get("environment") != "npm-publish":
            bad("permissions", f"job {name} holds a write scope without environment npm-publish")
        if name != "publish" and (writes(job.get("permissions")) or job.get("environment") is not None):
            bad("permissions", f"job {name} must hold no write scope and no environment; only publish does")

    pub, pkg = jobs.get("publish"), jobs.get("package")
    if pub is None or pkg is None:
        bad("environment", "the workflow needs a package job and a publish job")
        return out

    if pub.get("environment") != "npm-publish":
        bad("environment", f"publish must declare environment: npm-publish, found {pub.get('environment')!r}")
    if pub.get("needs") != "package":
        bad("environment", f"publish must need package, found {pub.get('needs')!r}")
    perms = pub.get("permissions") or {}
    if perms.get("id-token") != "write":
        bad("permissions", "publish must hold id-token: write (npm Trusted Publishing)")

    for s in steps(pub):
        action = uses_of(s)
        if action == "actions/checkout":
            bad("no-code", "publish must not check out the repository")
        elif action and action not in ALLOWED_PUBLISH_ACTIONS:
            bad("no-code", f"publish uses {action}, which is not one of {sorted(ALLOWED_PUBLISH_ACTIONS)}")
        if REPO_CODE.search(str(s.get("run", ""))):
            bad("no-code", f"publish step {s.get('name')!r} installs or runs repository code")

    publishing = [(n, i, len(steps(j))) for n, j in jobs.items() for i, s in enumerate(steps(j)) if re.search(r"\bnpm\s+publish\b", str(s.get("run", "")))]
    if len(publishing) != 1 or publishing[0][0] != "publish" or publishing[0][1] != publishing[0][2] - 1:
        bad("publish-last", f"npm publish must appear once, as the last step of publish; found {publishing!r}")

    guards = [s for s in steps(pkg) if "environments/npm-publish" in str(s.get("run", ""))]
    if not guards:
        bad("guard", "package must check the npm-publish environment through the API")
    for s in guards:
        found = GUARD_PROGRAM.search(str(s.get("run", "")))
        if not found:
            bad("guard", f"step {s.get('name')!r} must decide with a jq -e program over the environment response")
            continue
        for what, doc in GUARD_ACCEPTS:
            if jq_decides(found.group(1), doc) is not True:
                bad("guard", f"the environment check must accept {what}")
        for what, doc in GUARD_REFUSES:
            if jq_decides(found.group(1), doc) is not False:
                bad("guard", f"the environment check must refuse {what}")

    for name, job in jobs.items():
        for s in steps(job):
            if "${{" in str(s.get("run", "")):
                bad("injection", f"{name}: step {s.get('name')!r} interpolates ${{{{ }}}} into a script; pass it through env")
            ref = str(s.get("uses", ""))
            if ref and not re.search(r"@[0-9a-f]{40}$", ref):
                bad("pinned", f"{name}: {ref} is not pinned to a commit")
    return out


problems = check(baseline)
if problems:
    print(f"FAIL: {path}", file=sys.stderr)
    for p in problems:
        print(f"  {p}", file=sys.stderr)
    sys.exit(1)
print(f"  ok: {path} keeps the shape that keeps the publish behind the environment")


# --- the check must refuse what it is written to refuse ---------------------------------------
def mutate(fn):
    wf = copy.deepcopy(baseline)
    fn(wf)
    return wf


def add_trigger(wf):
    wf["on" if "on" in wf else True]["push"] = {"tags": ["connector-v*"]}


def add_publish_step(step):
    return lambda wf: wf["jobs"]["publish"]["steps"].insert(0, step)


def add_package_step(step):
    return lambda wf: wf["jobs"]["package"]["steps"].append(step)


def rewrite_runs(old, new):
    def go(wf):
        for job in wf["jobs"].values():
            for s in job["steps"]:
                if "run" in s:
                    s["run"] = s["run"].replace(old, new)
    return go


def set_publish_permission(key, value):
    return lambda wf: wf["jobs"]["publish"].setdefault("permissions", {}).__setitem__(key, value)


def unpin(wf):
    for s in wf["jobs"]["package"]["steps"]:
        if s.get("uses", "").startswith("actions/setup-node@"):
            s["uses"] = "actions/setup-node@v7"


def move_publish_up(wf):
    st = wf["jobs"]["publish"]["steps"]
    st.insert(0, st.pop())


def drop_guard(wf):
    wf["jobs"]["package"]["steps"] = [s for s in wf["jobs"]["package"]["steps"] if "environments/npm-publish" not in str(s.get("run", ""))]


mutations = [
    ("trigger", "a tag push also starts it", add_trigger),
    ("trigger", "release types widened", lambda wf: wf["on" if "on" in wf else True]["release"].update(types=["published", "created"])),
    ("environment", "publish loses its environment", lambda wf: wf["jobs"]["publish"].pop("environment")),
    ("environment", "publish names another environment", lambda wf: wf["jobs"]["publish"].update(environment="release")),
    ("environment", "publish no longer waits for package", lambda wf: wf["jobs"]["publish"].pop("needs")),
    ("permissions", "package gets the OIDC scope", lambda wf: wf["jobs"]["package"].update(permissions={"contents": "read", "id-token": "write"})),
    ("permissions", "package gets an environment", lambda wf: wf["jobs"]["package"].update(environment="npm-publish")),
    ("permissions", "workflow-level write scope", lambda wf: wf.update(permissions={"contents": "write"})),
    ("permissions", "publish loses id-token", lambda wf: wf["jobs"]["publish"]["permissions"].pop("id-token")),
    ("no-code", "publish checks out the repository", add_publish_step({"uses": "actions/checkout@" + "0" * 40})),
    ("no-code", "publish installs dependencies", add_publish_step({"name": "install", "run": "npm ci"})),
    ("no-code", "publish runs a repository script", add_publish_step({"name": "script", "run": "node scripts/anything.mjs"})),
    ("no-code", "publish uses another action", add_publish_step({"uses": "some/action@" + "0" * 40})),
    ("no-code", "publish unpacks the tarball and runs the bundle", add_publish_step({"name": "run", "run": "tar -xzf x.tgz && node package/dist/cli.js --version"})),
    ("publish-last", "npm publish also runs in package", add_package_step({"name": "early", "run": "npm publish"})),
    ("publish-last", "npm publish is not last", move_publish_up),
    ("guard", "package stops checking the environment", drop_guard),
    ("guard", "the check demands self-review prevented again",
     rewrite_runs("select(((.reviewers", "select(.prevent_self_review == true and ((.reviewers")),
    ("guard", "the check stops requiring administrator bypass off", rewrite_runs(".can_admins_bypass == false", ".can_admins_bypass != null")),
    ("guard", "the check stops requiring a reviewer", rewrite_runs("select(((.reviewers // []) | length) > 0)", "select(true)")),
    ("guard", "the check no longer reads the environment's response", rewrite_runs("<<<\"$environment\"", "<<<'{}'")),
    ("injection", "the tag is interpolated into a script", add_package_step({"name": "echo", "run": "echo ${{ github.event.release.tag_name }}"})),
    ("pinned", "an action is not pinned to a commit", unpin),
]

failed = False
for rule, what, fn in mutations:
    found = check(mutate(fn))
    if any(p.startswith(f"[{rule}]") for p in found):
        print(f"  ok: refused ({rule}): {what}")
    else:
        failed = True
        print(f"  FAIL: not refused by [{rule}]: {what} (found: {found!r})", file=sys.stderr)
sys.exit(1 if failed else 0)
PY
