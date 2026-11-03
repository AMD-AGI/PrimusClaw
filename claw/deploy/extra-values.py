#!/usr/bin/env python3
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT
"""Turn EXTRA_* settings from values.<ns>.env into Helm values for api and brain.

Prints one JSON document (valid as a Helm values file) on stdout. Prints {} when
nothing is set, so a deployment that sets none renders exactly what it did before.

  EXTRA_ENV_API_<NAME>=value    plain env var <NAME> on the api container
  EXTRA_ENV_BRAIN_<NAME>=value  plain env var <NAME> on the brain container
  EXTRA_CONFIGMAP_MOUNTS_API    space-separated "<configmap>:<mount-path>" entries,
  EXTRA_CONFIGMAP_MOUNTS_BRAIN  each mounted read-only, whole ConfigMap, into that container
  EXTRA_SECRET_MOUNTS_API       space-separated "<secret>:<mount-path>" entries, each
  EXTRA_SECRET_MOUNTS_BRAIN     mounted read-only, whole Secret, into that container

Values go through a values file rather than --set, so JSON, commas and spaces in a
value need no escaping. A malformed entry exits non-zero instead of being dropped.

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
