#!/usr/bin/env python3
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT
"""Turn EXTRA_* settings from values.<ns>.env into Helm values for api and brain.

Prints one JSON document (valid as a Helm values file) on stdout. Prints {} when
nothing is set, so a deployment that sets none renders exactly what it did before.

  EXTRA_ENV_API_<NAME>=value    plain env var <NAME> on the api container
  EXTRA_ENV_BRAIN_<NAME>=value  plain env var <NAME> on the brain container
  EXTRA_SECRET_ENV_API_<NAME>   env var <NAME> whose value is one key of a Secret,
  EXTRA_SECRET_ENV_BRAIN_<NAME> written "<secret>:<key>"; rendered as valueFrom.secretKeyRef
  EXTRA_CONFIGMAP_MOUNTS_API    space-separated "<configmap>:<mount-path>" entries,
  EXTRA_CONFIGMAP_MOUNTS_BRAIN  each mounted read-only, whole ConfigMap, into that container
  EXTRA_SECRET_MOUNTS_API       space-separated "<secret>:<mount-path>" entries, each
  EXTRA_SECRET_MOUNTS_BRAIN     mounted read-only, whole Secret, into that container

Values go through a values file rather than --set, so JSON, commas and spaces in a
value need no escaping. A malformed entry exits non-zero instead of being dropped.
A Secret env entry is never echoed back when refused: a secret typed into the
wrong variable must not reach a terminal or a CI log. The Secret and key must
already exist; a missing one fails the pod at start instead of being ignored.

An env var can be set once per container. A name given both as EXTRA_ENV_* and as
EXTRA_SECRET_ENV_* in one container is refused here. A Secret env name that the
chart itself renders into the container cannot be known from the settings alone
(a NATS credential read back from the cluster, a CA ConfigMap and the identity
client each add env vars to a render), so that one is decided on the rendered
Deployment: render_chart runs

  extra-values.py --check-rendered API|BRAIN <rendered Deployment file>

on what helm produced, and upgrade.sh does so for both Deployments before it
applies either. Only names set through EXTRA_SECRET_ENV_* are held to it; a plain
EXTRA_ENV_* that replaces a chart value has always been allowed.

A container cannot have two mounts at one path: the API server refuses the
Deployment ("mountPath must be unique"), and upgrade.sh would only find out at
kubectl apply, after api has already rolled. So a mount path (normalised, so
/etc/x/, /etc//x and /etc/y/../x are /etc/x) is refused here when another
ConfigMap or Secret entry for the same container uses it, or when the chart itself
mounts a volume there. The chart's own paths are read from
charts/claw/mount-paths.json, which the Deployment templates render from too.
"""
import json
import os
import posixpath
import re
import sys

NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
CM_RE = re.compile(r"^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$")
# A key of a Secret is what Kubernetes calls a config-map key: letters, digits, '-', '_'
# and '.', at most 253 characters, not "." and not starting with "..".
OBJECT_KEY_RE = re.compile(r"^[-._a-zA-Z0-9]+$")
MAX_NAME = 253
TARGETS = {"API": "api", "BRAIN": "brain"}
# Where the chart writes down the directories it mounts into each container; the
# templates render their mountPath from it, so it is the chart's own answer.
CHART_MOUNT_PATHS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "charts", "claw", "mount-paths.json")
# (variable infix, volume-name prefix, volume source for an object name). The two
# kinds are numbered separately, so a volume name never depends on the other kind.
MOUNT_KINDS = (
    ("CONFIGMAP", "extra-cm", lambda n: {"configMap": {"name": n}}),
    ("SECRET", "extra-secret", lambda n: {"secret": {"secretName": n}}),
)


def die(msg):
    sys.stderr.write("extra-values: %s\n" % msg)
    sys.exit(1)


def normalise(path):
    # normpath keeps a leading "//" (POSIX allows it to mean something else), but
    # a container's mount table does not tell /etc/x from //etc/x.
    return "/" + posixpath.normpath(path).lstrip("/")


def chart_mounts(key):
    """{normalised path: chart volume name} for what the chart mounts into <key>'s container.

    Unreadable means the check cannot be made, which is a refusal, not a pass.
    """
    try:
        with open(CHART_MOUNT_PATHS, encoding="utf-8") as f:
            mounts = json.load(f)[key]
        return {normalise(path): vol for vol, path in mounts.items()}
    except (OSError, ValueError, KeyError, AttributeError, TypeError) as e:
        die("cannot read what the chart mounts into %s from %s: %s" % (key, CHART_MOUNT_PATHS, e))


def referenced_env(tag):
    """[(variable, env name, Secret name, key)] for EXTRA_SECRET_ENV_<tag>_*, in name order.

    A malformed entry is a refusal that names the variable and not its value.
    """
    prefix = "EXTRA_SECRET_ENV_%s_" % tag
    refs = []
    for var, value in sorted(os.environ.items()):
        if not var.startswith(prefix):
            continue
        name = var[len(prefix):]
        if not NAME_RE.match(name):
            die("%s: %r is not a valid environment variable name" % (var, name))
        holder, sep, item = value.partition(":")
        if (not sep or len(holder) > MAX_NAME or not CM_RE.match(holder)
                or len(item) > MAX_NAME or not OBJECT_KEY_RE.match(item) or item == "." or item.startswith("..")):
            die("%s must be <secret>:<key>, the name of a Secret (lowercase letters, digits, '-' and '.') "
                "and one of its keys (letters, digits, '-', '_' and '.'); what it holds is not repeated here" % var)
        refs.append((var, name, holder, item))
    return refs


ENV_KEY_RE = re.compile(r"^(\s*)env:\s*$")
ITEM_RE = re.compile(r"^(\s*)-\s+(?:\{\s*)?name:\s*(.*)$")


def item_name(rest):
    """The env var name in what follows `name:` of a list item, quoted or not."""
    if rest[:1] in ("'", '"'):
        end = rest.find(rest[0], 1)
        return rest[1:end] if end > 0 else None
    return re.split(r"[\s,}#]", rest, maxsplit=1)[0] or None


def env_blocks(text):
    """Every `env:` list of a rendered manifest, as the list of its env var names.

    One list per container, so an init container's env is not the main
    container's. Comments and blank lines inside a list are skipped; a list ends at
    the first line that is neither an item nor nested under one.
    """
    lines = text.splitlines()
    blocks, i = [], 0
    while i < len(lines):
        m = ENV_KEY_RE.match(lines[i])
        i += 1
        if not m:
            continue
        key_indent, item_indent, names = len(m.group(1)), None, []
        while i < len(lines):
            body = lines[i].strip()
            if not body or body.startswith("#"):
                i += 1
                continue
            indent = len(lines[i]) - len(lines[i].lstrip())
            if item_indent is None:
                if not body.startswith("- ") or indent < key_indent:
                    break
                item_indent = indent
            if indent < item_indent or (indent == item_indent and not body.startswith("- ")):
                break
            if indent == item_indent:
                im = ITEM_RE.match(lines[i])
                name = item_name(im.group(2)) if im else None
                if name:
                    names.append(name)
            i += 1
        blocks.append(names)
    return blocks


def read_rendered(tag, path):
    """The text of a rendered Deployment; one that cannot be read is a refusal, not a pass."""
    text = ""
    try:
        with open(path, encoding="utf-8") as f:
            text = f.read()
    except (OSError, ValueError) as e:
        die("cannot read the rendered %s Deployment to check its env from %s: %s" % (TARGETS[tag], path, e))
    return text


def check_rendered(tag, path):
    """Refuse a Secret env name that the chart renders into the container as well."""
    refs = referenced_env(tag)
    if not refs:
        return
    blocks = env_blocks(read_rendered(tag, path))
    for var, name, _, _ in refs:
        if any(names.count(name) > 1 for names in blocks):
            die("%s: the chart already renders env var %s in the %s container, and an env var can be set once per container; "
                "use another name, or stop setting it through the chart" % (var, name, TARGETS[tag]))


if len(sys.argv) > 1:
    if len(sys.argv) == 4 and sys.argv[1] == "--check-rendered" and sys.argv[2] in TARGETS:
        check_rendered(sys.argv[2], sys.argv[3])
        sys.exit(0)
    die("usage: extra-values.py [--check-rendered API|BRAIN <rendered Deployment file>]")

out = {}
for tag, key in TARGETS.items():
    prefix = "EXTRA_ENV_%s_" % tag
    env = [
        {"name": k[len(prefix):], "value": v}
        for k, v in sorted(os.environ.items())
        if k.startswith(prefix)
    ]
    for e in env:
        if not NAME_RE.match(e["name"]):
            die("EXTRA_ENV_%s_%s: %r is not a valid environment variable name" % (tag, e["name"], e["name"]))

    # After the plain entries, so a file with no Secret env renders what it always did.
    plain = {e["name"]: "EXTRA_ENV_%s_%s" % (tag, e["name"]) for e in env}
    for var, name, holder, item in referenced_env(tag):
        if name in plain:
            die("%s: %s is already set by %s; an env var can be set once per container, so keep one of them"
                % (var, name, plain[name]))
        env.append({"name": name, "valueFrom": {"secretKeyRef": {"name": holder, "key": item}}})
    if env:
        out.setdefault(key, {})["extraEnv"] = env

    vols, mounts = [], []
    reserved = None  # read from the chart on the first mount entry, not for env-only files
    taken = {}  # normalised mount path -> the variable and entry that mounts it
    for kind, vol_prefix, source in MOUNT_KINDS:
        var = "EXTRA_%s_MOUNTS_%s" % (kind, tag)
        for i, entry in enumerate(os.environ.get(var, "").split()):
            name, sep, path = entry.partition(":")
            if not sep or not CM_RE.match(name) or not path.startswith("/") or normalise(path) == "/":
                die("%s: %r must be <%s>:<absolute-mount-path>" % (var, entry, kind.lower()))
            if reserved is None:
                reserved = chart_mounts(key)
            where = normalise(path)
            if where in reserved:
                die("%s: %r mounts at %s, where the chart itself mounts its %s volume into the %s container; use another path"
                    % (var, entry, where, reserved[where], key))
            if where in taken:
                die("%s: %r mounts at %s, which %s already mounts into the %s container; a mount path can be used once"
                    % (var, entry, where, taken[where], key))
            taken[where] = "%s (%r)" % (var, entry)
            vol = "%s-%d" % (vol_prefix, i)
            vols.append(dict(source(name), name=vol))
            mounts.append({"name": vol, "mountPath": path, "readOnly": True})
    if vols:
        out.setdefault(key, {}).update({"extraVolumes": vols, "extraVolumeMounts": mounts})

json.dump(out, sys.stdout, indent=2, sort_keys=True)
sys.stdout.write("\n")
