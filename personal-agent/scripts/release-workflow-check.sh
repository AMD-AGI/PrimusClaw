#!/usr/bin/env bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

# release-workflow-check.sh [workflow.yml]
#
# .github/workflows/personal-agent-release.yml publishes five npm packages with an OIDC identity and, once switched on,
# pushes an image with a registry credential. A tag push runs the file as it exists at the tag, so what keeps a publish
# behind the environments, and the credential on the right registry, is the file's shape. This asserts it:
#   [trigger]      only a personal-agent-v* tag push, a workflow_dispatch with a dry-run input on by default, and a pull
#                  request changing the release start it; never a branch push
#   [events]       each job's `if` is evaluated for every kind of run: publish-npm runs only on a personal-agent-v* tag
#                  of AMD-AGI/PrimusClaw, pushed or dispatched with dry-run off; publish-image only then and with
#                  PERSONAL_AGENT_IMAGE_PUBLISH "true"; a pull request, a branch, a dry run, a fork never publish. The
#                  package job's plan step is run too: a publishing dispatch on anything but a tag is refused
#   [switch]       publish-image stops unless the switch is exactly "true" (the `if` compares without case)
#   [target]       the step that resolves the image target is run against a set of prefixes: the registry it names is
#                  always the push target's first component, its default is docker.io/primussafe, and malformed
#                  prefixes are refused
#   [login]        exactly one step logs in to a registry, to the target step's registry, and only with that
#                  registry's credentials (Docker Hub's only for docker.io); run with a stand-in skopeo
#   [push]         exactly one step pushes to a registry, to the target step's repository, and the attestation names it
#   [permissions]  only the publish jobs hold a write scope (the OIDC one included)
#   [environment]  publish-npm runs in npm-publish, publish-image in image-publish, each after the package job
#   [no-code]      the publish jobs check out nothing, install no dependency and run no repository script
#   [publish-last] `npm publish` is only in publish-npm's last step: core, runtime, worker, teams, teams-ingress, in order
#   [injection]    no run script interpolates ${{ }}
#   [pinned]       every action is pinned to a commit
# Then it mutates a copy of the file once per rule and requires that rule, and not just any rule, to report it: a check
# that has never been seen refusing is not a check.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
workflow="${1:-$repo_root/.github/workflows/personal-agent-release.yml}"

command -v python3 >/dev/null 2>&1 || { echo "error: python3 is required for this check" >&2; exit 1; }
python3 -c 'import yaml' 2>/dev/null || { echo "error: python3 PyYAML is required for this check" >&2; exit 1; }

exec python3 - "$workflow" "$repo_root" <<'PY'
import copy, os, re, subprocess, sys, tempfile
import yaml

path, repo_root = sys.argv[1], sys.argv[2]
with open(path, encoding="utf-8") as f:
    baseline = yaml.safe_load(f)

REPO = "AMD-AGI/PrimusClaw"
TAG = "refs/tags/personal-agent-v1.2.3"


# ---------------------------------------------------------------------------------------------------------------------
# A GitHub Actions expression evaluator, enough for this file's `if`s and defaults: literals, context paths, ! && || ==
# != ( ), startsWith, endsWith, contains, format. Comparison follows GitHub's rules: strings compare without case, and
# values of different types are compared as numbers.
TOKEN = re.compile(r"\s*(?:(?P<str>'(?:[^']|'')*')|(?P<op>&&|\|\||==|!=|!|\(|\)|,)|(?P<num>-?\d+(?:\.\d+)?)|(?P<id>[A-Za-z_][A-Za-z0-9_.\-]*))")


def tokenize(text):
    pos, out = 0, []
    text = text.strip()
    while pos < len(text):
        m = TOKEN.match(text, pos)
        if not m or m.end() == pos:
            raise ValueError(f"cannot read the expression at {text[pos:]!r}")
        pos = m.end()
        kind = m.lastgroup
        out.append((kind, m.group(kind)))
        while pos < len(text) and text[pos].isspace():
            pos += 1
    return out


def to_number(v):
    if v is None:
        return 0.0
    if isinstance(v, bool):
        return 1.0 if v else 0.0
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        if v.strip() == "":
            return 0.0
        try:
            return float(v)
        except ValueError:
            return float("nan")
    return float("nan")


def to_string(v):
    if v is None:
        return ""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


def truthy(v):
    if v is None or v is False or v == "":
        return False
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return v != 0 and v == v
    return True


def equal(a, b):
    if isinstance(a, str) and isinstance(b, str):
        return a.lower() == b.lower()
    if type(a) is type(b) and not isinstance(a, str):
        return a == b
    return to_number(a) == to_number(b)


def lookup(ctx, name):
    if name in ("true", "false", "null"):
        return {"true": True, "false": False, "null": None}[name]
    value = ctx
    for part in name.split("."):
        if not isinstance(value, dict) or part not in value:
            return None
        value = value[part]
    return value


def evaluate(text, ctx):
    tokens = tokenize(text)
    i = 0

    def peek():
        return tokens[i] if i < len(tokens) else (None, None)

    def take(expected=None):
        nonlocal i
        tok = peek()
        if expected is not None and tok[1] != expected:
            raise ValueError(f"expected {expected!r}, found {tok[1]!r} in {text!r}")
        i += 1
        return tok

    def primary():
        kind, value = take()
        if kind == "str":
            return value[1:-1].replace("''", "'")
        if kind == "num":
            return float(value)
        if value == "(":
            v = disjunction()
            take(")")
            return v
        if value == "!":
            return not truthy(primary())
        if kind == "id":
            if peek()[1] == "(":
                take("(")
                args = []
                if peek()[1] != ")":
                    args.append(disjunction())
                    while peek()[1] == ",":
                        take(",")
                        args.append(disjunction())
                take(")")
                return call(value, args)
            return lookup(ctx, value)
        raise ValueError(f"unexpected {value!r} in {text!r}")

    def comparison():
        v = primary()
        while peek()[1] in ("==", "!="):
            op = take()[1]
            w = primary()
            v = equal(v, w) if op == "==" else not equal(v, w)
        return v

    def conjunction():
        v = comparison()
        while peek()[1] == "&&":
            take()
            w = comparison()
            v = w if truthy(v) else v
        return v

    def disjunction():
        v = conjunction()
        while peek()[1] == "||":
            take()
            w = conjunction()
            v = v if truthy(v) else w
        return v

    result = disjunction()
    if i != len(tokens):
        raise ValueError(f"trailing tokens in {text!r}")
    return result


def call(name, args):
    lname = name.lower()
    if lname == "startswith":
        return to_string(args[0]).lower().startswith(to_string(args[1]).lower())
    if lname == "endswith":
        return to_string(args[0]).lower().endswith(to_string(args[1]).lower())
    if lname == "contains":
        return to_string(args[1]).lower() in to_string(args[0]).lower()
    if lname == "format":
        out = to_string(args[0])
        for n, a in enumerate(args[1:]):
            out = out.replace("{" + str(n) + "}", to_string(a))
        return out
    raise ValueError(f"the evaluator does not know {name}()")


def interpolate(text, ctx):
    """A ${{ }} value as the runner renders it into an env var."""
    return re.sub(r"\$\{\{(.*?)\}\}", lambda m: to_string(evaluate(m.group(1), ctx)), str(text), flags=re.S)


def job_runs(job, ctx):
    cond = job.get("if")
    if cond is None:
        return True
    cond = str(cond).strip()
    m = re.fullmatch(r"\$\{\{(.*)\}\}", cond, re.S)
    return truthy(evaluate(m.group(1) if m else cond, ctx))


def context(event, ref, dry_run=None, switch=None, repository=REPO, prefix=None):
    ref_name = ref.split("/", 2)[2] if ref.count("/") >= 2 else ref
    vars_ = {}
    if switch is not None:
        vars_["PERSONAL_AGENT_IMAGE_PUBLISH"] = switch
    if prefix is not None:
        vars_["PERSONAL_AGENT_IMAGE_PREFIX"] = prefix
    inputs = {} if dry_run is None else {"dry-run": dry_run}
    return {
        "github": {"event_name": event, "ref": ref, "ref_name": ref_name, "repository": repository,
                   "event": {"pull_request": {"number": 1}} if event == "pull_request" else {}},
        "inputs": inputs, "vars": vars_, "secrets": {}, "steps": {}, "runner": {"temp": "/tmp"},
    }


# Every kind of run, and which publish jobs it may start: (description, context, npm, image).
SCENARIOS = [
    ("pull request", context("pull_request", "refs/pull/1/merge", switch="true"), False, False),
    ("pull request from a branch named like a tag", context("pull_request", "refs/heads/personal-agent-v1.2.3", switch="true"), False, False),
    ("push to main", context("push", "refs/heads/main", switch="true"), False, False),
    ("push to a branch named like a tag", context("push", "refs/heads/personal-agent-v1.2.3", switch="true"), False, False),
    ("tag push, switch unset", context("push", TAG), True, False),
    ("tag push, switch \"false\"", context("push", TAG, switch="false"), True, False),
    ("tag push, switch \"1\"", context("push", TAG, switch="1"), True, False),
    ("tag push, switch \"true\"", context("push", TAG, switch="true"), True, True),
    ("tag push of another component", context("push", "refs/tags/connector-v1.2.3", switch="true"), False, False),
    ("tag push in a fork", context("push", TAG, switch="true", repository="someone/PrimusClaw"), False, False),
    ("dispatch, dry run, on main", context("workflow_dispatch", "refs/heads/main", dry_run=True, switch="true"), False, False),
    ("dispatch, dry run, on a tag", context("workflow_dispatch", TAG, dry_run=True, switch="true"), False, False),
    ("dispatch, dry-run input missing, on a tag", context("workflow_dispatch", TAG, switch="true"), False, False),
    ("dispatch, dry run off, on main", context("workflow_dispatch", "refs/heads/main", dry_run=False, switch="true"), False, False),
    ("dispatch, dry run off, on a tag, switch off", context("workflow_dispatch", TAG, dry_run=False), True, False),
    ("dispatch, dry run off, on a tag, switch \"true\"", context("workflow_dispatch", TAG, dry_run=False, switch="true"), True, True),
    ("dispatch, dry run off as text, on a tag", context("workflow_dispatch", TAG, dry_run="false"), True, False),
]


def run_step(step, env, extra_path=None, cwd=None):
    """Run a step's script as the runner would (bash -e), with `env`; (exit status, outputs, stdout+stderr)."""
    with tempfile.TemporaryDirectory() as tmp:
        out_file = os.path.join(tmp, "output")
        open(out_file, "w").close()
        full = {"PATH": (extra_path + os.pathsep if extra_path else "") + os.environ.get("PATH", ""),
                "GITHUB_OUTPUT": out_file, "HOME": tmp}
        full.update(env)
        p = subprocess.run(["bash", "--noprofile", "--norc", "-e", "-o", "pipefail", "-c", step["run"]],
                           env=full, cwd=cwd or repo_root, capture_output=True, text=True, timeout=60)
        outputs = {}
        for line in open(out_file, encoding="utf-8").read().splitlines():
            if "=" in line:
                k, v = line.split("=", 1)
                outputs[k] = v
        return p.returncode, outputs, p.stdout + p.stderr


def step_env(step, ctx):
    return {k: interpolate(v, ctx) for k, v in (step.get("env") or {}).items()}


def find_step(job, name_part):
    for s in job.get("steps") or []:
        if name_part in str(s.get("name", "")):
            return s
    return None


def all_steps(doc):
    for jname, job in (doc.get("jobs") or {}).items():
        for i, s in enumerate(job.get("steps") or []):
            yield jname, i, s


ALLOWED_PUBLISH_ACTIONS = {"actions/download-artifact", "actions/setup-node", "actions/attest-build-provenance"}
REPO_CODE = re.compile(
    r"\b(?:npm\s+(?:ci|install|i|run|test|exec|start|pack)|npx|pnpm|yarn|make|tar|unzip|python3?|chmod|git)\b"
    r"|(?:^|[;&|(]|&&)\s*node\s+(?!-e\b)\S|(?:^|[;&|(]|&&)\s*(?:ba)?sh\s+\S|(?:^|\s)\./",
    re.M,
)
LOGIN = re.compile(r"\b(?:skopeo|buildah|podman|docker)\s+login\b")
PUSH = re.compile(r"\b(?:skopeo\s+copy|buildah\s+push|podman\s+push|docker\s+push)\b")


def check_trigger(doc):
    on = doc.get("on", doc.get(True))
    p = []
    if not isinstance(on, dict) or set(on) != {"push", "workflow_dispatch", "pull_request"}:
        return [f"the triggers are {sorted(on) if isinstance(on, dict) else on!r}, expected push, workflow_dispatch, pull_request"]
    if on["push"] != {"tags": ["personal-agent-v*"]}:
        p.append(f"push must be tags personal-agent-v* only, is {on['push']!r}")
    dry = (((on.get("workflow_dispatch") or {}).get("inputs") or {}).get("dry-run") or {})
    if dry.get("type") != "boolean" or dry.get("default") is not True:
        p.append("workflow_dispatch needs a boolean dry-run input defaulting to true")
    pr = on.get("pull_request") or {}
    if set(pr) - {"paths"}:
        p.append(f"pull_request may only filter paths, has {sorted(pr)}")
    return p


def check_events(doc):
    p = []
    jobs = doc.get("jobs") or {}
    if set(jobs) != {"package", "publish-npm", "publish-image"}:
        return [f"the jobs are {sorted(jobs)}, expected package, publish-npm, publish-image"]
    for desc, ctx, npm, image in SCENARIOS:
        try:
            got_npm, got_image = job_runs(jobs["publish-npm"], ctx), job_runs(jobs["publish-image"], ctx)
        except ValueError as e:
            return [str(e)]
        if got_npm != npm:
            p.append(f"{desc}: publish-npm {'runs' if got_npm else 'does not run'}, expected {'it to' if npm else 'not'}")
        if got_image != image:
            p.append(f"{desc}: publish-image {'runs' if got_image else 'does not run'}, expected {'it to' if image else 'not'}")
        if image and not npm:
            p.append(f"{desc}: the scenario table is inconsistent")
    # publish-image also waits for publish-npm, so an image is never pushed for a version npm refused.
    needs = jobs["publish-image"].get("needs")
    if sorted(needs if isinstance(needs, list) else [needs]) != ["package", "publish-npm"]:
        p.append("publish-image must need package and publish-npm")
    # The package job's plan: publishing anywhere but on a tag is refused there, before anything is built.
    plan = find_step(jobs["package"], "What this run releases")
    if plan is None:
        return p + ["the package job has no \"What this run releases\" step"]
    for desc, ctx, want_status, want_publish in [
        ("dispatch, dry run off, on main", context("workflow_dispatch", "refs/heads/main", dry_run=False), 1, None),
        ("dispatch, dry run, on main", context("workflow_dispatch", "refs/heads/main", dry_run=True), 0, "false"),
        ("pull request", context("pull_request", "refs/pull/1/merge"), 0, "false"),
        ("tag push", context("push", TAG), 0, "true"),
        ("tag push, malformed tag", context("push", "refs/tags/personal-agent-v1.2.3-rc.1"), 1, None),
        ("dispatch, dry run, on a tag", context("workflow_dispatch", TAG, dry_run=True), 0, "false"),
    ]:
        status, out, log = run_step(plan, step_env(plan, ctx))
        if (status == 0) != (want_status == 0):
            p.append(f"plan step, {desc}: exit {status}, expected {'success' if want_status == 0 else 'a refusal'}: {log.strip()}")
        elif want_publish is not None and out.get("publish") != want_publish:
            p.append(f"plan step, {desc}: publish={out.get('publish')}, expected {want_publish}")
    return p


def check_switch(doc):
    step = find_step(doc["jobs"]["publish-image"], "The image switch is on")
    first = (doc["jobs"]["publish-image"].get("steps") or [None])[0]
    if step is None or step is not first:
        return ["publish-image's first step must check that the switch is exactly \"true\""]
    p = []
    for value, ok in [("true", True), ("TRUE", False), ("True", False), ("", False), ("yes", False)]:
        status, _, _ = run_step(step, step_env(step, context("push", TAG, switch=value)))
        if (status == 0) != ok:
            p.append(f"the switch step {'accepts' if status == 0 else 'refuses'} {value!r}")
    return p


TARGET_CASES = [
    # (prefix variable, expected registry, expected repository) or None for a refusal
    (None, "docker.io", "docker.io/primussafe/personal-agent-teams"),
    ("docker.io/primussafe", "docker.io", "docker.io/primussafe/personal-agent-teams"),
    ("docker.io/primusclaw/", "docker.io", "docker.io/primusclaw/personal-agent-teams"),
    ("ghcr.io/some-org", "ghcr.io", "ghcr.io/some-org/personal-agent-teams"),
    ("registry.example.com:5000/team/images", "registry.example.com:5000", "registry.example.com:5000/team/images/personal-agent-teams"),
    ("localhost:5000/x", "localhost:5000", "localhost:5000/x/personal-agent-teams"),
    ("primussafe", None, None),
    ("primussafe/personal", None, None),
    ("docker.io", None, None),
    ("https://docker.io/primussafe", None, None),
    ("Docker.io/primussafe", None, None),
    ("docker.io/primussafe:latest", None, None),
    ("docker.io/../primussafe", None, None),
    ("docker.io/prim ussafe", None, None),
    ("evil.example.com/x docker.io/primussafe", None, None),
]


def check_target(doc):
    job = doc["jobs"]["publish-image"]
    step = find_step(job, "Resolve the image target")
    if step is None or step.get("id") != "target":
        return ["publish-image has no \"Resolve the image target\" step with id target"]
    p = []
    for prefix, registry, repository in TARGET_CASES:
        status, out, log = run_step(step, step_env(step, context("push", TAG, switch="true", prefix=prefix)))
        if registry is None:
            if status == 0 or out:
                p.append(f"the target step accepts the prefix {prefix!r}: {out}")
            continue
        if status != 0:
            p.append(f"the target step refuses the prefix {prefix!r}: {log.strip()}")
            continue
        if out.get("registry") != registry or out.get("repository") != repository or out.get("version") != "1.2.3":
            p.append(f"prefix {prefix!r}: registry {out.get('registry')!r}, repository {out.get('repository')!r}, expected {registry!r}, {repository!r}")
        if out.get("repository", "").split("/", 1)[0] != out.get("registry"):
            p.append(f"prefix {prefix!r}: the login registry {out.get('registry')!r} is not the push target's {out.get('repository')!r}")
    return p


FAKE_SKOPEO = """#!/bin/sh
printf '%s\\n' "$@" > "$FAKE_LOG.args"
cat > "$FAKE_LOG.stdin"
"""


def check_login(doc):
    logins = [(j, i, s) for j, i, s in all_steps(doc) if LOGIN.search(str(s.get("run", "")))]
    if len(logins) != 1 or logins[0][0] != "publish-image":
        return [f"exactly one step may log in to a registry, in publish-image; found {[(j, s.get('name')) for j, _, s in logins]}"]
    job, idx, step = logins[0]
    p = []
    steps = doc["jobs"][job]["steps"]
    target_idx = next((k for k, s in enumerate(steps) if s.get("id") == "target"), None)
    if target_idx is None or target_idx > idx:
        p.append("the login step must come after the target step")
    env = step.get("env") or {}
    if str(env.get("REGISTRY", "")).replace(" ", "") != "${{steps.target.outputs.registry}}":
        p.append(f"the login step's REGISTRY is {env.get('REGISTRY')!r}, not the target step's registry")
    if not re.search(r'login\b[^\n]*"\$REGISTRY"\s*$', step["run"], re.M):
        p.append("the login command must end with \"$REGISTRY\"")
    secrets_used = sorted(set(re.findall(r"secrets\.([A-Za-z0-9_]+)", yaml.safe_dump(doc))))
    if set(secrets_used) - {"DOCKER_USERNAME", "DOCKER_PASSWORD", "PERSONAL_AGENT_REGISTRY_USERNAME", "PERSONAL_AGENT_REGISTRY_PASSWORD"}:
        p.append(f"unexpected secrets in the workflow: {secrets_used}")
    for j, _, s in all_steps(doc):
        if "secrets." in yaml.safe_dump(s) and s is not step:
            p.append(f"{j}: step {s.get('name')!r} reads a secret; only the login step may")
    # Run it with a stand-in skopeo: which registry it logs in to, with which password.
    hub = {"DOCKERHUB_USERNAME": "hub-user", "DOCKERHUB_PASSWORD": "hub-pass"}
    own = {"REGISTRY_USERNAME": "own-user", "REGISTRY_PASSWORD": "own-pass"}
    cases = [
        ("docker.io", hub, "hub-pass"),
        ("docker.io", {**hub, **own}, "own-pass"),
        ("docker.io", {}, None),
        ("ghcr.io", hub, None),
        ("ghcr.io", {**hub, **own}, "own-pass"),
        ("registry.example.com:5000", own, "own-pass"),
        ("ghcr.io", {"REGISTRY_USERNAME": "own-user"}, None),
    ]
    with tempfile.TemporaryDirectory() as tmp:
        fake = os.path.join(tmp, "bin")
        os.mkdir(fake)
        for tool in ("skopeo", "buildah", "podman", "docker"):
            with open(os.path.join(fake, tool), "w") as f:
                f.write(FAKE_SKOPEO)
            os.chmod(os.path.join(fake, tool), 0o755)
        for registry, creds, password in cases:
            log = os.path.join(tmp, "log")
            for suffix in (".args", ".stdin"):
                if os.path.exists(log + suffix):
                    os.remove(log + suffix)
            run_env = {k: interpolate(v, {"steps": {"target": {"outputs": {"registry": registry}}}, "runner": {"temp": tmp}, "secrets": {}})
                       for k, v in env.items() if "secrets." not in str(v)}
            run_env.update({k: "" for k in ("DOCKERHUB_USERNAME", "DOCKERHUB_PASSWORD", "REGISTRY_USERNAME", "REGISTRY_PASSWORD")})
            run_env.update(creds)
            run_env["FAKE_LOG"] = log
            status, _, out = run_step(step, run_env, extra_path=fake)
            logged = os.path.exists(log + ".args")
            if password is None:
                if status == 0 or logged:
                    p.append(f"login to {registry} with {sorted(creds)}: it logged in, expected a refusal")
                continue
            if status != 0 or not logged:
                p.append(f"login to {registry} with {sorted(creds)}: refused: {out.strip()}")
                continue
            args = open(log + ".args").read().split("\n")
            args = [a for a in args if a != ""]
            sent = open(log + ".stdin").read()
            if not args or args[-1] != registry:
                p.append(f"login to {registry}: the stand-in was asked to log in to {args[-1:]}, not {registry}")
            if sent != password:
                p.append(f"login to {registry} with {sorted(creds)}: sent the password of the wrong pair")
    return p


def check_push(doc):
    # A push whose every destination is a local OCI archive stays on the runner; anything else reaches a registry.
    remote = []
    for j, i, s in all_steps(doc):
        run = str(s.get("run", ""))
        pushes = [line for line in run.splitlines() if PUSH.search(line)]
        if "docker://" in run or any("oci-archive:" not in line for line in pushes):
            remote.append((j, i, s))
    p = []
    if len(remote) != 1 or remote[0][0] != "publish-image":
        return [f"exactly one step may push to a registry, in publish-image; found {[(j, s.get('name')) for j, _, s in remote]}"]
    job, idx, step = remote[0]
    steps = doc["jobs"][job]["steps"]
    login_idx = next((k for k, s in enumerate(steps) if LOGIN.search(str(s.get("run", "")))), None)
    if login_idx is None or login_idx > idx:
        p.append("the push step must come after the login step")
    env = step.get("env") or {}
    if str(env.get("REPOSITORY", "")).replace(" ", "") != "${{steps.target.outputs.repository}}":
        p.append(f"the push step's REPOSITORY is {env.get('REPOSITORY')!r}, not the target step's repository")
    dests = re.findall(r'"?docker://([^"\s]+)"?', step["run"])
    if dests != ["$REPOSITORY:$VERSION"]:
        p.append(f"the push step pushes to {dests}, expected docker://$REPOSITORY:$VERSION only")
    login = steps[login_idx] if login_idx is not None else {}
    if (login.get("env") or {}).get("AUTHFILE") != env.get("AUTHFILE") or "--authfile \"$AUTHFILE\"" not in step["run"]:
        p.append("the push step must use the login step's authfile")
    attest = next((s for s in steps if str(s.get("uses", "")).startswith("actions/attest-build-provenance")), None)
    if attest is None or str((attest.get("with") or {}).get("subject-name", "")).replace(" ", "") != "${{steps.target.outputs.repository}}":
        p.append("publish-image must attest the target step's repository")
    return p


def check_permissions(doc):
    p = []
    if doc.get("permissions") != {"contents": "read"}:
        p.append(f"workflow permissions are {doc.get('permissions')!r}, expected contents: read")
    for name, job in doc["jobs"].items():
        perms = job.get("permissions")
        writes = sorted(k for k, v in (perms or {}).items() if v == "write") if isinstance(perms, dict) else ["(not a map)"]
        if name == "package":
            if perms != {"contents": "read"}:
                p.append(f"package's permissions are {perms!r}, expected contents: read")
        elif writes != ["attestations", "contents", "id-token"]:
            p.append(f"{name} writes {writes}, expected attestations, contents, id-token")
    return p


def check_environment(doc):
    p = []
    for name, env in (("publish-npm", "npm-publish"), ("publish-image", "image-publish")):
        job = doc["jobs"][name]
        if job.get("environment") != env:
            p.append(f"{name} must run in the environment {env}, has {job.get('environment')!r}")
        needs = job.get("needs")
        if "package" not in (needs if isinstance(needs, list) else [needs]):
            p.append(f"{name} must need package")
    if doc["jobs"]["package"].get("environment") is not None:
        p.append("package must not run in an environment")
    return p


def check_no_code(doc):
    p = []
    for name in ("publish-npm", "publish-image"):
        for s in doc["jobs"][name].get("steps") or []:
            uses = str(s.get("uses", ""))
            if uses and uses.split("@")[0] not in ALLOWED_PUBLISH_ACTIONS:
                p.append(f"{name} uses {uses.split('@')[0]}")
            m = REPO_CODE.search(str(s.get("run", "")))
            if m:
                p.append(f"{name}: step {s.get('name')!r} runs {m.group(0).strip()!r}")
    return p


def check_publish_last(doc):
    p = []
    for j, i, s in all_steps(doc):
        if "npm publish" in str(s.get("run", "")):
            steps = doc["jobs"][j]["steps"]
            if j != "publish-npm" or i != len(steps) - 1:
                p.append(f"npm publish in {j} step {s.get('name')!r}; it belongs only in publish-npm's last step")
    last = (doc["jobs"]["publish-npm"].get("steps") or [{}])[-1]
    order = re.findall(r"^\s*publish (@primusclaw/[a-z-]+) ", str(last.get("run", "")), re.M)
    expected = ["@primusclaw/personal-agent", "@primusclaw/personal-agent-runtime", "@primusclaw/personal-agent-worker",
                "@primusclaw/personal-agent-teams", "@primusclaw/personal-agent-teams-ingress"]
    if order != expected:
        p.append(f"publish-npm publishes {order}, expected core, runtime, worker, teams, teams-ingress in that order")
    return p


def check_injection(doc):
    return [f"{j}: step {s.get('name')!r} interpolates ${{{{ }}}} in its script"
            for j, _, s in all_steps(doc) if "${{" in str(s.get("run", ""))]


def check_pinned(doc):
    return [f"{j}: {s['uses']} is not pinned to a commit" for j, _, s in all_steps(doc)
            if "uses" in s and not re.fullmatch(r"[^@]+@[0-9a-f]{40}", str(s["uses"]))]


RULES = {
    "trigger": check_trigger, "events": check_events, "switch": check_switch, "target": check_target,
    "login": check_login, "push": check_push, "permissions": check_permissions, "environment": check_environment,
    "no-code": check_no_code, "publish-last": check_publish_last, "injection": check_injection, "pinned": check_pinned,
}


def check(doc):
    found = {}
    for rule, fn in RULES.items():
        try:
            problems = fn(doc)
        except Exception as e:  # a shape the rule cannot read is a finding of that rule
            problems = [f"cannot check: {type(e).__name__}: {e}"]
        if problems:
            found[rule] = problems
    return found


problems = check(baseline)
if problems:
    for rule, items in problems.items():
        for item in items:
            print(f"[{rule}] {item}", file=sys.stderr)
    sys.exit(1)
print(f"release workflow: every rule holds ({len(SCENARIOS)} run kinds, {len(TARGET_CASES)} image prefixes)")


# Each mutation must be reported by its own rule.
def step_of(doc, job, name):
    return find_step(doc["jobs"][job], name)


def m_trigger(d):
    d.get("on", d.get(True))["push"]["branches"] = ["main"]


def m_events_image(d):
    d["jobs"]["publish-image"]["if"] = d["jobs"]["publish-npm"]["if"]


def m_events_dry(d):
    d["jobs"]["publish-npm"]["if"] = "github.repository == 'AMD-AGI/PrimusClaw' && startsWith(github.ref, 'refs/tags/personal-agent-v')"


def m_events_plan(d):
    s = step_of(d, "package", "What this run releases")
    s["run"] = s["run"].replace('elif [ "$publish" = true ]; then', "elif false; then", 1)


def m_switch(d):
    s = step_of(d, "publish-image", "The image switch is on")
    s["run"] = s["run"].replace('[ "$SWITCH" = true ]', '[ "${SWITCH,,}" = true ]')


def m_target(d):
    s = step_of(d, "publish-image", "Resolve the image target")
    s["run"] = s["run"].replace('registry="${prefix%%/*}"', 'registry=docker.io').replace(
        '[ "${repository%%/*}" = "$registry" ] ||', 'true ||')


def m_login_registry(d):
    step_of(d, "publish-image", "Log in")["env"]["REGISTRY"] = "docker.io"


def m_login_creds(d):
    s = step_of(d, "publish-image", "Log in")
    s["run"] = s["run"].replace('if [ "$REGISTRY" = docker.io ] && [ -z "$user$pass" ]', 'if [ -z "$user$pass" ]')


def m_push(d):
    s = step_of(d, "publish-image", "Push the image")
    s["run"] = s["run"].replace('"docker://$REPOSITORY:$VERSION"', '"docker://docker.io/primussafe/personal-agent-teams:$VERSION"')


def m_push_package(d):
    s = step_of(d, "package", "Export the image")
    s["run"] += '\nskopeo copy "oci-archive:$OUT/personal-agent-teams.oci.tar" "docker://docker.io/primussafe/personal-agent-teams:$VERSION"\n'


def m_permissions(d):
    d["jobs"]["package"]["permissions"]["id-token"] = "write"


def m_environment(d):
    del d["jobs"]["publish-image"]["environment"]


def m_no_code(d):
    d["jobs"]["publish-npm"]["steps"].insert(0, {"uses": "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1"})


def m_publish_last(d):
    d["jobs"]["publish-npm"]["steps"].append({"name": "after", "run": "echo done"})


def m_injection(d):
    s = step_of(d, "publish-image", "Name the image on the release")
    s["run"] = s["run"].replace('"$TAG"', '"${{ github.ref_name }}"', 1)


def m_pinned(d):
    s = step_of(d, "publish-npm", "Fetch the tarballs")
    s["uses"] = "actions/download-artifact@v8"


MUTATIONS = [
    ("trigger", "a push to main starts it", m_trigger),
    ("events", "publish-image without the switch", m_events_image),
    ("events", "publish-npm without the dry-run condition", m_events_dry),
    ("events", "the plan step lets a publishing dispatch run on a branch", m_events_plan),
    ("switch", "the switch step ignores case", m_switch),
    ("target", "the target step logs in to docker.io whatever the prefix", m_target),
    ("login", "the login step names docker.io", m_login_registry),
    ("login", "Docker Hub's credentials go to any registry", m_login_creds),
    ("push", "the push step names its own target", m_push),
    ("push", "the package job pushes", m_push_package),
    ("permissions", "package holds id-token: write", m_permissions),
    ("environment", "publish-image runs outside image-publish", m_environment),
    ("no-code", "publish-npm checks out the repository", m_no_code),
    ("publish-last", "a step follows npm publish", m_publish_last),
    ("injection", "a script interpolates the ref", m_injection),
    ("pinned", "an action by tag", m_pinned),
]

failed = []
for rule, desc, mutate in MUTATIONS:
    doc = copy.deepcopy(baseline)
    mutate(doc)
    if doc == baseline:
        failed.append(f"mutation \"{desc}\" changed nothing: it no longer matches the file")
        continue
    found = check(doc)
    if rule not in found:
        failed.append(f"mutation \"{desc}\": [{rule}] did not report it (reported: {sorted(found) or 'nothing'})")
if failed:
    for f in failed:
        print(f, file=sys.stderr)
    sys.exit(1)
print(f"release workflow: each of {len(MUTATIONS)} mutations is reported by its rule")
PY
