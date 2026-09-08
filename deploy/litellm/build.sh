#!/usr/bin/env bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT
#
# Build and push the LiteLLM gateway image.
#
# This existed only as a Dockerfile, on the assumption of a local docker
# daemon. On a cluster where that assumption does not hold -- ours -- there was
# no way to build it at all, which is how the deployed gateway drifted years
# away from the Dockerfile beside it. `claw/deploy/build.sh` had solved the
# same problem with an in-cluster kaniko job; this borrows that shape.
#
#   PUSH_SECRET      Secret holding .dockerconfigjson; selects the kaniko backend
#   HARBOR_PASSWORD  legacy selector for kaniko; credentials still use PUSH_SECRET
#   REGISTRY         e.g. harbor.example.com/primussafe
#   NAMESPACE        where the build job runs (default: primus-claw)
#   TAG              default: v<litellm version from the Dockerfile>-<date>
#
# The tag carries the LiteLLM version ON PURPOSE. The chart's default image was
# named `20260331111348` and the Dockerfile beside it pinned a base four minor
# versions newer; nothing in either name said so, and a whole upgrade was
# planned against the wrong premise before a probe pod said otherwise.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

NAMESPACE="${NAMESPACE:-primus-claw}"
REGISTRY="${REGISTRY:?REGISTRY is required, e.g. harbor.example.com/primussafe}"

# Read the pinned version out of the Dockerfile so the tag cannot disagree.
BASE_VERSION="$(grep -oE '^FROM .*litellm:v[0-9.]+' "$SCRIPT_DIR/Dockerfile" | grep -oE 'v[0-9.]+' | head -1)"
[ -n "$BASE_VERSION" ] || { echo "ERROR: cannot read the pinned litellm version from Dockerfile" >&2; exit 1; }
TAG="${TAG:-$BASE_VERSION-$(date +%Y%m%d%H%M)}"
IMG="$REGISTRY/litellm:$TAG"

echo "[litellm-build] building $IMG (base $BASE_VERSION)"

if [ -z "${PUSH_SECRET:-}" ] && [ -z "${HARBOR_PASSWORD:-}" ]; then
  command -v docker >/dev/null || { echo "ERROR: set PUSH_SECRET for kaniko, or install docker" >&2; exit 1; }
  docker build -t "$IMG" "$SCRIPT_DIR"
  docker push "$IMG"
  echo "[litellm-build] pushed $IMG"
  exit 0
fi

JOB="litellm-build-$(date +%s)"
CTX="litellm-build-ctx-$(date +%s)"
CONTEXT_ARCHIVE="$(mktemp)"
cleanup() {
  rm -f "$CONTEXT_ARCHIVE"
  kubectl -n "$NAMESPACE" delete cm "$CTX" --ignore-not-found >/dev/null 2>&1 || true
}
trap cleanup EXIT

tar -C "$SCRIPT_DIR" --exclude='__pycache__' --exclude='*.pyc' \
  -czf "$CONTEXT_ARCHIVE" Dockerfile apim_key_hook.py patches
kubectl -n "$NAMESPACE" create cm "$CTX" \
  --from-file=build-context.tar.gz="$CONTEXT_ARCHIVE" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null

# Registry auth is read from an existing pull/push secret rather than inlined
# into the job spec, so the password never lands in an object anyone can read
# back with `kubectl get job -o yaml`.
# Whichever Secret in $NAMESPACE holds a .dockerconfigjson with push rights to
# $REGISTRY. No default: the name is a property of the cluster, not of this repo.
PUSH_SECRET="${PUSH_SECRET:?PUSH_SECRET is required: a Secret with .dockerconfigjson for \$REGISTRY}"
kubectl -n "$NAMESPACE" get secret "$PUSH_SECRET" >/dev/null

kubectl -n "$NAMESPACE" apply -f - <<EOF >/dev/null
apiVersion: batch/v1
kind: Job
metadata: {name: $JOB, namespace: $NAMESPACE}
spec:
  backoffLimit: 0
  ttlSecondsAfterFinished: 600
  template:
    spec:
      restartPolicy: Never
      initContainers:
      - name: ctx
        image: busybox:1.36
        command: ["sh","-c","tar -xzf /cm/build-context.tar.gz -C /workspace"]
        volumeMounts:
        - {name: ws, mountPath: /workspace}
        - {name: cm, mountPath: /cm}
      containers:
      - name: kaniko
        image: gcr.io/kaniko-project/executor:v1.23.2
        args:
        - --context=dir:///workspace
        - --dockerfile=/workspace/Dockerfile
        - --destination=$IMG
        - --skip-tls-verify-registry=${REGISTRY%%/*}
        volumeMounts:
        - {name: ws, mountPath: /workspace}
        - {name: dockercfg, mountPath: /kaniko/.docker}
      volumes:
      - {name: ws, emptyDir: {}}
      - {name: cm, configMap: {name: $CTX}}
      - {name: dockercfg, secret: {secretName: $PUSH_SECRET, items: [{key: .dockerconfigjson, path: config.json}]}}
EOF

echo "[litellm-build] waiting for job/$JOB ..."
if ! kubectl -n "$NAMESPACE" wait --for=condition=complete --timeout=1800s "job/$JOB" 2>/dev/null; then
  kubectl -n "$NAMESPACE" logs "job/$JOB" --tail=40 >&2 || true
  echo "ERROR: build failed" >&2
  exit 1
fi
kubectl -n "$NAMESPACE" delete job "$JOB" --ignore-not-found >/dev/null 2>&1 || true
echo "[litellm-build] pushed $IMG"
echo "$IMG"
