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

Values go through a values file rather than --set, so JSON, commas and spaces in a
value need no escaping. A malformed entry exits non-zero instead of being dropped.
"""
import json
import os
import re
import sys

NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
CM_RE = re.compile(r"^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$")
TARGETS = {"API": "api", "BRAIN": "brain"}


def die(msg):
    sys.stderr.write("extra-values: %s\n" % msg)
    sys.exit(1)


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
    for i, entry in enumerate(os.environ.get("EXTRA_CONFIGMAP_MOUNTS_%s" % tag, "").split()):
        cm, sep, path = entry.partition(":")
        if not sep or not CM_RE.match(cm) or not path.startswith("/") or len(path) < 2:
            die("EXTRA_CONFIGMAP_MOUNTS_%s: %r must be <configmap>:<absolute-mount-path>" % (tag, entry))
        vol = "extra-cm-%d" % i
        vols.append({"name": vol, "configMap": {"name": cm}})
        mounts.append({"name": vol, "mountPath": path, "readOnly": True})
    if vols:
        out.setdefault(key, {}).update({"extraVolumes": vols, "extraVolumeMounts": mounts})

json.dump(out, sys.stdout, indent=2, sort_keys=True)
sys.stdout.write("\n")
