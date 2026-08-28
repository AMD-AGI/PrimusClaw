#!/usr/bin/env bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

# Build and push the Claw image.
# When TAG is not set, generates one from the current timestamp.
# Exports TAG and IMG so callers (upgrade.sh) can read the built tag.
#
# Build backends:
#   docker (default) - local `docker build` + `docker push` from this host's
#                       checkout (incl. uncommitted changes). Requires a docker
#                       daemon + prior `docker login`.
#   kaniko            - in-cluster build via a one-shot Job in $NAMESPACE, no
#                       local docker needed. Packages THIS checkout's build
#                       context (incl. uncommitted changes; node_modules/.git/
#                       dist excluded) into a ConfigMap, extracts it in the pod,
#                       and builds it with kaniko (--context=dir:///workspace).
#                       Enable with USE_KANIKO=true ./build.sh
#
# kaniko backend is auto-selected by passing HARBOR_PASSWORD (no separate
# USE_KANIKO flag needed; set USE_KANIKO=false to force the docker backend
# even when HARBOR_PASSWORD is set). Registry auth is stored in a short-lived
# K8s Secret (deleted on exit) and read by the Job's initContainer via
# secretKeyRef, never inlined in the Job spec:
#   HARBOR_USERNAME  - push user for $REGISTRY (default: admin)
#   HARBOR_PASSWORD  - push password for $REGISTRY (presence triggers kaniko)
#
# EXTRA_CA_CERT_URLS is forwarded to the Dockerfile build arg of the same name
# on both backends: a space-separated list of PEM URLs to add to the image's
# trust store, for a gateway/SaFE/S3 endpoint signed by a private CA. Prefer
# content-addressed URLs; whoever controls the ref controls what the image
# trusts.
#
# Docker Hub ($REGISTRY=docker.io/...) auth is keyed by "https://index.docker.io/v1/",
# not the bare "docker.io" host. Private registries additionally get
# --skip-tls-verify-registry (self-signed/private-CA certs). The context stays
# small enough for a ConfigMap (~1MB base64); trim it or use S3 if it grows.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_SCRIPT_LABEL="build"
source "$SCRIPT_DIR/common.sh"

TAG="${TAG:-$(date +%Y%m%d%H%M)}"
export TAG

IMG="$REGISTRY/claw:$TAG"
export IMG

# Auto-select the kaniko backend when a push password is supplied; an
# explicit USE_KANIKO always wins (e.g. USE_KANIKO=false forces docker even
# with HARBOR_PASSWORD set).
if [ -z "${USE_KANIKO:-}" ]; then
  [ -n "${HARBOR_PASSWORD:-}" ] && USE_KANIKO=true || USE_KANIKO=false
fi

log "Building $IMG ..."

if [ "$USE_KANIKO" = "true" ]; then
  # ── In-cluster kaniko build from the LOCAL working tree (no docker) ───────
  # Package the current build context (incl. uncommitted changes) as a tar.gz,
  # ship it via a ConfigMap, extract it into an emptyDir, and build with kaniko.
  KANIKO_IMAGE="${KANIKO_IMAGE:-gcr.io/kaniko-project/executor:v1.23.2}"
  KANIKO_JOB_TIMEOUT="${KANIKO_JOB_TIMEOUT:-1800}"
  # Sanity ceiling, not a ConfigMap budget: the context is split across as many
  # ConfigMaps as it needs (see CTX_CHUNK_BYTES below), so the only thing this
  # catches is a context that should never have been packaged at all -- a
  # stray node_modules, a checked-in binary.
  KANIKO_CONTEXT_MAX_BYTES="${KANIKO_CONTEXT_MAX_BYTES:-67108864}"
  # Raw bytes per ConfigMap. Base64 inflates by 4/3, so 600KB lands at ~800KB
  # against the 1MiB per-object limit, leaving room for the object's own
  # metadata and for kubectl's request overhead.
  CTX_CHUNK_BYTES="${CTX_CHUNK_BYTES:-600000}"
  HARBOR_USERNAME="${HARBOR_USERNAME:-admin}"
  : "${HARBOR_PASSWORD:?HARBOR_PASSWORD must be set to use the kaniko backend}"

  # EXTRA_CA_CERT_URLS is the Dockerfile's documented way to reach an endpoint
  # behind a private CA (see its ARG of the same name). Without this
  # passthrough the only route left is tls.insecureSkipVerify, which turns off
  # certificate verification for every outbound connection the image makes --
  # so the supported remedy was unreachable and the unsupported one was not.
  KANIKO_BUILD_ARGS=""
  if [ -n "${EXTRA_CA_CERT_URLS:-}" ]; then
    KANIKO_BUILD_ARGS="        - \"--build-arg=EXTRA_CA_CERT_URLS=${EXTRA_CA_CERT_URLS}\""
  fi

  REGISTRY_HOST="${REGISTRY%%/*}"
  JOB_NAME="claw-kaniko-build-${TAG}"
  CM_NAME="claw-build-context-${TAG}"
  REG_SECRET_NAME="claw-build-registry-auth-${TAG}"

  # Docker Hub auth is keyed by index.docker.io (not the bare "docker.io"); a
  # private registry uses its host and commonly needs skip-tls (self-signed CA).
  case "$REGISTRY_HOST" in
    docker.io|registry-1.docker.io|index.docker.io)
      AUTH_REGISTRY="https://index.docker.io/v1/"; KANIKO_SKIP_TLS="" ;;
    *)
      AUTH_REGISTRY="$REGISTRY_HOST"
      KANIKO_SKIP_TLS='        - "--skip-tls-verify-registry='"$REGISTRY_HOST"'"' ;;
  esac

  # AUTH_REGISTRY is just a hostname (not a credential); escape it so it embeds
  # safely in a double-quoted YAML scalar baked into the Job's pod spec.
  # HARBOR_USERNAME/PASSWORD are credentials and must NOT be inlined into the
  # Job YAML (anyone with `get job/pod` in the namespace could read them) — they
  # go into a short-lived Secret instead, referenced via secretKeyRef below.
  yaml_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
  AUTH_REGISTRY_ESC="$(yaml_escape "$AUTH_REGISTRY")"

  log "  build backend: kaniko (local context, job=$JOB_NAME)"
  log "  packaging build context from $HARNESS_ROOT ..."
  CTX_TAR="$WORK_DIR/claw-context.tar.gz"
  # Exclude per-env secret files (deploy/values.*.env, .env*): the Dockerfile
  # only COPYs deploy/entrypoint.sh from deploy/, never the values files, so
  # they must never end up in the ConfigMap-backed build context below.
  tar --exclude='./node_modules' --exclude='*/node_modules' \
      --exclude='./.git' --exclude='./dist' --exclude='*/dist' \
      --exclude='__pycache__' --exclude='*.pyc' \
      --exclude='./.env' --exclude='./.env.*' --exclude='deploy/values.*.env' \
      --exclude='./docs' --exclude='./tests' --exclude='./examples' --exclude='./scripts' \
      --exclude='./packages/*/test' --exclude='./deploy/charts' \
      --exclude='./deploy/*.md' --exclude='./deploy/build.sh' \
      --exclude='./deploy/cleanup.sh' --exclude='./deploy/common.sh' \
      --exclude='./deploy/deploy.sh' --exclude='./deploy/upgrade.sh' \
      --exclude='./deploy/make-dev-account.sh' --exclude='./deploy/minio-lifecycle.py' \
      --exclude='./deploy/nats-values.yaml' --exclude='./deploy/values.example.env' \
      -C "$HARNESS_ROOT" -czf "$CTX_TAR" .
  ctx_bytes=$(wc -c < "$CTX_TAR")
  if [ "$ctx_bytes" -gt "$KANIKO_CONTEXT_MAX_BYTES" ]; then
    fail "build context $((ctx_bytes / 1024))KB exceeds the sanity ceiling ($((KANIKO_CONTEXT_MAX_BYTES / 1024))KB). Something is in the context that should not be -- check for node_modules or large binaries, or raise KANIKO_CONTEXT_MAX_BYTES."
  fi

  # Split across ConfigMaps rather than fitting into one.
  #
  # A ConfigMap's 1MiB limit is per object, so more keys in one map buys
  # nothing; more maps does. The context had grown to within a few KB of the
  # limit, which made every commit that touched packages/*/src a coin flip on
  # whether the build still packaged -- and the failure arrived as a build
  # error with no obvious connection to the change that caused it.
  #
  # Chunks are numbered and mounted under /context/NN, so the initContainer's
  # glob concatenates them in order for as many as there are.
  # -a 3 rather than 2: two digits caps at 100 chunks, which at 600KB is
  # 57.2MiB -- below the 64MiB sanity ceiling above, so a context in between
  # would clear the check and then die on "output file suffixes exhausted".
  # Three digits covers 600MB, well past anything the ceiling admits.
  split -b "$CTX_CHUNK_BYTES" -d -a 3 "$CTX_TAR" "$WORK_DIR/ctxchunk"
  CTX_CHUNKS=""
  for f in "$WORK_DIR"/ctxchunk*; do CTX_CHUNKS="$CTX_CHUNKS ${f##*ctxchunk}"; done
  ctx_n=$(set -- $CTX_CHUNKS; echo $#)
  log "  context: $((ctx_bytes / 1024))KB → $ctx_n ConfigMap(s) ${CM_NAME}-NN ; destination=$IMG"

  # Use `create` (not `apply`): apply stores the whole object in the
  # last-applied-configuration annotation (256KB cap) which a binary context
  # blows past. create has no such annotation.
  CTX_VOLUMES=""
  CTX_MOUNTS=""
  for n in $CTX_CHUNKS; do
    kubectl -n "$NAMESPACE" delete configmap "${CM_NAME}-${n}" --ignore-not-found >/dev/null
    kubectl -n "$NAMESPACE" create configmap "${CM_NAME}-${n}" \
      --from-file=chunk="$WORK_DIR/ctxchunk${n}" >/dev/null
    CTX_VOLUMES="${CTX_VOLUMES}
      - name: context-${n}
        configMap:
          name: ${CM_NAME}-${n}"
    CTX_MOUNTS="${CTX_MOUNTS}
        - { name: context-${n}, mountPath: /context/${n} }"
  done

  # Registry push credentials live only in this Secret, never inline in the Job
  # YAML; the initContainer reads them via secretKeyRef.
  kubectl -n "$NAMESPACE" delete secret "$REG_SECRET_NAME" --ignore-not-found >/dev/null
  kubectl -n "$NAMESPACE" create secret generic "$REG_SECRET_NAME" \
    --from-literal=username="$HARBOR_USERNAME" \
    --from-literal=password="$HARBOR_PASSWORD" >/dev/null

  # Clean up the context ConfigMap + registry Secret on exit (keep common.sh's WORK_DIR cleanup).
  trap 'for n in $CTX_CHUNKS; do kubectl -n "$NAMESPACE" delete configmap "${CM_NAME}-${n}" --ignore-not-found >/dev/null 2>&1 || true; done; kubectl -n "$NAMESPACE" delete secret "$REG_SECRET_NAME" --ignore-not-found >/dev/null 2>&1 || true; rm -rf "$WORK_DIR"' EXIT

  JOB_YAML="$WORK_DIR/kaniko-job.yaml"
  cat > "$JOB_YAML" <<EOF
apiVersion: batch/v1
kind: Job
metadata:
  name: $JOB_NAME
  namespace: $NAMESPACE
spec:
  backoffLimit: 0
  ttlSecondsAfterFinished: 3600
  template:
    spec:
      restartPolicy: Never
      initContainers:
      # 1) Render the registry docker config.json from user/pass.
      - name: gen-docker-config
        image: busybox:1.36
        env:
        - name: REG_USERNAME
          valueFrom:
            secretKeyRef: { name: $REG_SECRET_NAME, key: username }
        - name: REG_PASSWORD
          valueFrom:
            secretKeyRef: { name: $REG_SECRET_NAME, key: password }
        command:
        - sh
        - -c
        - |
          set -e
          AUTH=\$(printf '%s:%s' "\$REG_USERNAME" "\$REG_PASSWORD" | base64 | tr -d '\n')
          printf '{"auths":{"%s":{"auth":"%s"}}}' "$AUTH_REGISTRY_ESC" "\$AUTH" > /kaniko/.docker/config.json
        volumeMounts:
        - { name: docker-config, mountPath: /kaniko/.docker }
      # 2) Extract the tarball build context into an emptyDir kaniko reads.
      - name: stage-context
        image: busybox:1.36
        # The glob is ordered because the chunk directories are zero-padded, so
        # cat reassembles the tarball in the order split wrote it.
        command: ["sh", "-c", "set -e; mkdir -p /workspace; cat /context/*/chunk | tar -xz -C /workspace"]
        volumeMounts:$CTX_MOUNTS
        - { name: build-context, mountPath: /workspace }
      containers:
      - name: kaniko
        image: $KANIKO_IMAGE
        args:
        - "--context=dir:///workspace"
        - "--dockerfile=/workspace/Dockerfile"
        - "--destination=$IMG"
        - "--snapshot-mode=redo"
        - "--use-new-run"
$KANIKO_BUILD_ARGS
$KANIKO_SKIP_TLS
        volumeMounts:
        - { name: build-context, mountPath: /workspace }
        - { name: docker-config, mountPath: /kaniko/.docker }
        resources:
          requests: { cpu: "2", memory: "4Gi" }
          limits:   { cpu: "8", memory: "12Gi" }
      volumes:$CTX_VOLUMES
      - name: build-context
        emptyDir: {}
      - name: docker-config
        emptyDir: {}
EOF

  kubectl -n "$NAMESPACE" delete job "$JOB_NAME" --ignore-not-found >/dev/null
  kubectl -n "$NAMESPACE" apply -f "$JOB_YAML"

  log "  waiting for job/$JOB_NAME to finish (timeout ${KANIKO_JOB_TIMEOUT}s) ..."
  elapsed=0
  succeeded=0
  while [ "$elapsed" -lt "$KANIKO_JOB_TIMEOUT" ]; do
    succeeded=$(kubectl -n "$NAMESPACE" get job "$JOB_NAME" -o jsonpath='{.status.succeeded}' 2>/dev/null)
    job_failed=$(kubectl -n "$NAMESPACE" get job "$JOB_NAME" -o jsonpath='{.status.failed}' 2>/dev/null)
    [ "${succeeded:-0}" -ge 1 ] && break
    if [ "${job_failed:-0}" -ge 1 ]; then
      kubectl -n "$NAMESPACE" logs "job/$JOB_NAME" --all-containers 2>/dev/null || true
      fail "kaniko job/$JOB_NAME failed — see logs above (or: kubectl -n $NAMESPACE logs job/$JOB_NAME)"
    fi
    sleep 5
    elapsed=$((elapsed + 5))
  done
  [ "${succeeded:-0}" -ge 1 ] || fail "kaniko job/$JOB_NAME did not complete within ${KANIKO_JOB_TIMEOUT}s"

  log "Built and pushed via kaniko: $IMG"
else
  # ── Local docker build (default) ────────────────────────────────────────
  log "  Dockerfile: $HARNESS_ROOT/Dockerfile"
  log "  docker context: $(docker context show 2>/dev/null || echo n/a)"

  # --no-cache forces a full rebuild so layers like the Hands binary are always
  # recompiled from current source (avoids shipping a stale cached hands-binary).
  # Exclude per-env secret files for the same reason as the kaniko backend above.
  tar --exclude='./node_modules' \
      --exclude='./.git' \
      --exclude='./dist' \
      --exclude='./.env' --exclude='./.env.*' --exclude='deploy/values.*.env' \
      -C "$HARNESS_ROOT" -cf - . \
    | docker build --no-cache --progress=plain --network host \
        ${EXTRA_CA_CERT_URLS:+--build-arg "EXTRA_CA_CERT_URLS=$EXTRA_CA_CERT_URLS"} \
        -t "$IMG" -f Dockerfile -

  docker push "$IMG"
  log "Built and pushed: $IMG"
fi
