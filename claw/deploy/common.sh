#!/usr/bin/env bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

# ═══════════════════════════════════════════════════════════════════════════
# Shared variables and helper functions for deploy.sh / upgrade.sh.
# Source this file — do NOT execute directly.
#
# Usage (in deploy.sh / upgrade.sh):
#   SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
#   source "$SCRIPT_DIR/common.sh"
# ═══════════════════════════════════════════════════════════════════════════

# ── Environment defaults ─────────────────────────────────────────────────
NAMESPACE="${NAMESPACE:-primus-claw}"
REGISTRY="${REGISTRY:-docker.io/primussafe}"
TAG="${TAG:-}"
STORAGE_CLASS="${STORAGE_CLASS:-}"
DOMAIN="${DOMAIN:-}"
INGRESS_PATH="${INGRESS_PATH:-/claw-api}"
CLAW_DEPLOY_ROOT="${CLAW_DEPLOY_ROOT:-}"
# Deploy mode: kubernetes (agent-sandbox BYOK, default) or safe (legacy SaFE).
# Gates AUTH_INTERNAL_TOKEN handling: auto-generated in kubernetes mode,
# operator-supplied (required) in safe mode.
CLAW_DEPLOY_MODE="${CLAW_DEPLOY_MODE:-kubernetes}"

# Shared volume asset paths (derived from CLAW_DEPLOY_ROOT)
NODE_TARBALL_NAME="${NODE_TARBALL_NAME:-node-v22.15.0-linux-x64.tar.xz}"
NODE_TARBALL_URL="${NODE_TARBALL_URL:-https://nodejs.org/dist/v22.15.0/${NODE_TARBALL_NAME}}"
HARNESS_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Helm chart is the single source of truth for every Claw manifest (API,
# Brain, Secret, Services, Ingress, PostgresCluster).
# deploy.sh installs the full release; upgrade.sh renders individual
# templates from it via render_chart (see below).
CLAW_CHART_DIR="${CLAW_CHART_DIR:-$SCRIPT_DIR/charts/claw}"

# ── Logging ──────────────────────────────────────────────────────────────
_SCRIPT_LABEL="${_SCRIPT_LABEL:-claw}"
log()  { echo "[$_SCRIPT_LABEL] $(date +%H:%M:%S) $*"; }
fail() { echo "[$_SCRIPT_LABEL] ERROR: $*" >&2; exit 1; }

# ── StorageClass selection ───────────────────────────────────────────────
# Chooses the StorageClass for the PostgresCluster + NATS PVCs. Honors an
# explicit STORAGE_CLASS env; otherwise lists `kubectl get sc` and prompts.
# Non-interactive (no TTY) falls back to the cluster default SC (or the first
# listed). An empty listing leaves STORAGE_CLASS unset (k8s default applies).
select_storage_class() {
  if [ -n "${STORAGE_CLASS:-}" ]; then
    log "storage class: $STORAGE_CLASS (from env)"
    return 0
  fi

  local names default_sc
  names="$(kubectl get sc --no-headers 2>/dev/null | awk '{print $1}' || true)"
  if [ -z "$names" ]; then
    log "WARN: no StorageClass found via 'kubectl get sc'; leaving STORAGE_CLASS unset (cluster default applies)."
    return 0
  fi
  default_sc="$(kubectl get sc --no-headers 2>/dev/null | awk '/\(default\)/{print $1; exit}' || true)"

  # Non-interactive (CI / piped stdin): use the cluster default, else the first.
  if [ ! -t 0 ]; then
    STORAGE_CLASS="${default_sc:-${names%%$'\n'*}}"
    log "storage class: $STORAGE_CLASS (non-interactive default)"
    return 0
  fi

  echo "Available StorageClasses${default_sc:+ (cluster default: $default_sc)}:" >&2
  local opt
  PS3="Select StorageClass by number: "
  select opt in $names; do
    if [ -n "$opt" ]; then STORAGE_CLASS="$opt"; break; fi
    echo "Invalid selection; enter a listed number." >&2
  done
  log "storage class: $STORAGE_CLASS (selected)"
}

# ── Per-env values loader ────────────────────────────────────────────────
# Source deploy/values.<NAMESPACE>.env (gitignored) so deploy.sh can feed
# env-specific values (S3_*, AUTH_INTERNAL_TOKEN, ...) into the Helm chart.
#
# Bootstrap policy:
#   * File exists  -> trust it verbatim (preserves USER_ENV_ENCRYPTION_KEY
#                     across redeploys; shell env vars are IGNORED).
#   * File missing -> create it from current shell env vars; auto-generate
#                     USER_ENV_ENCRYPTION_KEY when shell didn't provide one.
#                     Persisted to disk (chmod 600) so future deploys are
#                     reproducible and the encryption key is never silently
#                     regenerated. **WARNING**: if you previously deployed
#                     this namespace, restore the original file from your
#                     secret store BEFORE re-running — a fresh key makes
#                     existing per-user encrypted env vars unreadable.
_VALUES_FILE="${SCRIPT_DIR}/values.${NAMESPACE}.env"
if [ "${DRY_RUN:-false}" = "true" ] && [ ! -f "$_VALUES_FILE" ]; then
  _VALUES_FILE="$(mktemp "/tmp/claw-dry-run-values.${NAMESPACE}.XXXXXX.env")"
  _EPHEMERAL_VALUES_FILE="$_VALUES_FILE"
  cat >"$_VALUES_FILE" <<EOF
AUTH_INTERNAL_TOKEN="${AUTH_INTERNAL_TOKEN:-dry-run-auth-token}"
DOMAIN="${DOMAIN:-dry-run.example}"
S3_ENDPOINT="${S3_ENDPOINT:-https://s3.dry-run.example}"
S3_API_ENDPOINT="${S3_API_ENDPOINT:-https://s3.dry-run.example}"
S3_ACCESS_KEY="${S3_ACCESS_KEY:-dry-run-access}"
S3_SECRET_KEY="${S3_SECRET_KEY:-dry-run-secret}"
USER_ENV_ENCRYPTION_KEY="${USER_ENV_ENCRYPTION_KEY:-01234567890123456789012345678901}"
CLAW_DEPLOY_ROOT="${CLAW_DEPLOY_ROOT:-}"
BRAIN_REPLICAS="${BRAIN_REPLICAS:-3}"
EOF
  chmod 600 "$_VALUES_FILE"
  log "dry-run: using ephemeral placeholder values"
fi
if [ ! -f "$_VALUES_FILE" ]; then
  log "values file $_VALUES_FILE not found — bootstrapping from shell env (one-time)"
  _BOOT_USER_ENV_KEY="${USER_ENV_ENCRYPTION_KEY:-}"
  if [ -z "$_BOOT_USER_ENV_KEY" ]; then
    _BOOT_USER_ENV_KEY="$(openssl rand -base64 32)"
    log "  USER_ENV_ENCRYPTION_KEY: auto-generated (preserved in $_VALUES_FILE — back it up)"
    log "  WARN: if NAMESPACE=$NAMESPACE has prior installs, abort now and restore the original values file; this fresh key cannot decrypt existing per-user env vars."
  else
    log "  USER_ENV_ENCRYPTION_KEY: inherited from shell env (persisted to $_VALUES_FILE)"
  fi
  # AUTH_INTERNAL_TOKEN: in kubernetes mode it is a stable internal HMAC secret
  # (BYOK user-id derivation + Brain<->Hands/API auth) — auto-generate once and
  # persist (a changed value re-keys every BYOK user id). In safe mode it must
  # match the SaFE apiserver token, so leave it for the operator to supply
  # (the post-source guard fails if it stays empty).
  _BOOT_AUTH_TOKEN="${AUTH_INTERNAL_TOKEN:-}"
  if [ -n "$_BOOT_AUTH_TOKEN" ]; then
    log "  AUTH_INTERNAL_TOKEN: inherited from shell env (persisted to $_VALUES_FILE)"
  elif [ "$CLAW_DEPLOY_MODE" = "kubernetes" ]; then
    _BOOT_AUTH_TOKEN="$(openssl rand -hex 32)"
    log "  AUTH_INTERNAL_TOKEN: auto-generated (kubernetes mode; preserved in $_VALUES_FILE — back it up)"
  fi
  cat > "$_VALUES_FILE" <<EOF
# Auto-generated by deploy/common.sh on $(date -Iseconds) for NAMESPACE=${NAMESPACE}.
# CRITICAL: USER_ENV_ENCRYPTION_KEY (per-user env decryption) and
# AUTH_INTERNAL_TOKEN (BYOK user-id HMAC) below must NEVER change after the
# first install — a new value makes existing encrypted rows / BYOK user ids
# unusable (rotation playbook — claw/docs/user-env-vars-design.md §8.3). Back
# up this file to your team's secret store before running a second deploy.
#
# DOMAIN is required (cluster ingress host). Empty S3_ fields are
# auto-discovered at deploy time from the minio namespace; fill in to override.

AUTH_INTERNAL_TOKEN="${_BOOT_AUTH_TOKEN}"
DOMAIN="${DOMAIN:-}"
S3_ENDPOINT="${S3_ENDPOINT:-}"
S3_API_ENDPOINT="${S3_API_ENDPOINT:-}"
S3_ACCESS_KEY="${S3_ACCESS_KEY:-}"
S3_SECRET_KEY="${S3_SECRET_KEY:-}"

USER_ENV_ENCRYPTION_KEY="${_BOOT_USER_ENV_KEY}"

CLAW_DEPLOY_ROOT="${CLAW_DEPLOY_ROOT:-}"
BRAIN_REPLICAS="${BRAIN_REPLICAS:-3}"
EOF
  chmod 600 "$_VALUES_FILE"
  unset _BOOT_USER_ENV_KEY _BOOT_AUTH_TOKEN
fi
# Shell-env override policy for auto-discovered fields:
#   * file has a NON-EMPTY value -> file wins (operator-pinned)
#   * file leaves the field EMPTY -> shell env wins (CLI ergonomics) ->
#                                    resolve_*_from_cluster fills the rest
# USER_ENV_ENCRYPTION_KEY is intentionally NOT in this list: file is
# always authoritative to prevent accidental key rotation.
_SHELL_DOMAIN="${DOMAIN:-}"
_SHELL_AUTH_INTERNAL_TOKEN="${AUTH_INTERNAL_TOKEN:-}"
_SHELL_S3_ENDPOINT="${S3_ENDPOINT:-}"
_SHELL_S3_API_ENDPOINT="${S3_API_ENDPOINT:-}"
_SHELL_S3_ACCESS_KEY="${S3_ACCESS_KEY:-}"
_SHELL_S3_SECRET_KEY="${S3_SECRET_KEY:-}"

set -a
# shellcheck disable=SC1090
source "$_VALUES_FILE"
set +a

# Backfill BRAIN_CHECKPOINT_KEY.
#
# The block above only writes a values file that does not exist yet, so a
# namespace installed before this key existed sources a file without it. Append
# rather than regenerate: this key must be stable for as long as any sealed
# checkpoint is still within the bucket's 24h TTL, and rewriting the file would
# also disturb USER_ENV_ENCRYPTION_KEY and AUTH_INTERNAL_TOKEN, neither of which
# may ever change.
#
# Generated even while checkpointWriteVersion is 3, so that flipping to 4 later
# is a one-line change rather than a key-distribution exercise. An unused key
# costs nothing; discovering at cutover that there isn't one costs a rollout.
if [ -z "${BRAIN_CHECKPOINT_KEY:-}" ]; then
  BRAIN_CHECKPOINT_KEY="$(openssl rand -base64 32)"
  if [ -w "$_VALUES_FILE" ]; then
    echo "BRAIN_CHECKPOINT_KEY=\"$BRAIN_CHECKPOINT_KEY\"" >> "$_VALUES_FILE"
    log "  BRAIN_CHECKPOINT_KEY: auto-generated (preserved in $_VALUES_FILE — back it up)"
  fi
fi
export BRAIN_CHECKPOINT_KEY

# Reinstate shell-supplied values where the file left the field blank.
[ -z "${DOMAIN:-}" ]              && DOMAIN="$_SHELL_DOMAIN"
[ -z "${AUTH_INTERNAL_TOKEN:-}" ] && AUTH_INTERNAL_TOKEN="$_SHELL_AUTH_INTERNAL_TOKEN"
[ -z "${S3_ENDPOINT:-}" ]         && S3_ENDPOINT="$_SHELL_S3_ENDPOINT"
[ -z "${S3_API_ENDPOINT:-}" ]     && S3_API_ENDPOINT="$_SHELL_S3_API_ENDPOINT"
[ -z "${S3_ACCESS_KEY:-}" ]       && S3_ACCESS_KEY="$_SHELL_S3_ACCESS_KEY"
[ -z "${S3_SECRET_KEY:-}" ]       && S3_SECRET_KEY="$_SHELL_S3_SECRET_KEY"
unset _SHELL_DOMAIN _SHELL_AUTH_INTERNAL_TOKEN _SHELL_S3_ENDPOINT \
      _SHELL_S3_API_ENDPOINT _SHELL_S3_ACCESS_KEY _SHELL_S3_SECRET_KEY
# Defaults for any placeholder not provided by the values file. Fallback to
# the literal "<KEY>" so render output keeps the placeholder, and the
# deploy.sh guard fails loudly rather than silently shipping empty secrets.
#
# AUTH_INTERNAL_TOKEN by deploy mode:
#   * kubernetes -> stable internal HMAC secret; auto-generate once + persist
#     (a changed value re-keys every BYOK user id).
#   * safe       -> must match the SaFE apiserver token; operator-supplied,
#     fail fast when missing.
if [ -z "${AUTH_INTERNAL_TOKEN:-}" ]; then
  if [ "$CLAW_DEPLOY_MODE" = "kubernetes" ]; then
    AUTH_INTERNAL_TOKEN="$(openssl rand -hex 32)"
    printf '\n# Auto-generated internal HMAC secret; do NOT change (re-keys BYOK user ids).\nAUTH_INTERNAL_TOKEN="%s"\n' "$AUTH_INTERNAL_TOKEN" >> "$_VALUES_FILE"
    log "AUTH_INTERNAL_TOKEN: auto-generated + persisted to $_VALUES_FILE (kubernetes mode)"
  else
    fail "AUTH_INTERNAL_TOKEN is required in safe mode (must match the SaFE apiserver token). Set it in $_VALUES_FILE or pass AUTH_INTERNAL_TOKEN=..."
  fi
fi
# DOMAIN (cluster ingress host) must be provided explicitly; deploy.sh fails
# fast on the "<DOMAIN>" placeholder below.
DOMAIN="${DOMAIN:-<DOMAIN>}"
S3_ENDPOINT="${S3_ENDPOINT:-<S3_ENDPOINT>}"
S3_API_ENDPOINT="${S3_API_ENDPOINT:-<S3_API_ENDPOINT>}"
S3_ACCESS_KEY="${S3_ACCESS_KEY:-<S3_ACCESS_KEY>}"
S3_SECRET_KEY="${S3_SECRET_KEY:-<S3_SECRET_KEY>}"
BRAIN_REPLICAS="${BRAIN_REPLICAS:-3}"
USER_ENV_ENCRYPTION_KEY="${USER_ENV_ENCRYPTION_KEY:-<USER_ENV_ENCRYPTION_KEY>}"

# ── Work dir for rendered manifests ──────────────────────────────────────
WORK_DIR=$(mktemp -d)
cleanup_deploy_temp_files() {
  rm -rf "${WORK_DIR:-}"
  if [ -n "${_EPHEMERAL_VALUES_FILE:-}" ]; then
    rm -f "$_EPHEMERAL_VALUES_FILE"
  fi
}
trap cleanup_deploy_temp_files EXIT

# ── Render one chart template to a file via `helm template --show-only` ──
# The chart is the single source of truth; callers that apply a single object
# imperatively (upgrade.sh api/brain, deploy.sh PostgresCluster) render
# just that template here.
#
# secret / ingress / postgres are disabled so their `required` guards never
# fire while rendering an unrelated Deployment/CronJob/CRD. Image coordinates
# use --set-string so an all-digit TAG (e.g. 202607131200) is not coerced to a
# number. Extra --set args (e.g. postgres.enabled=true) are forwarded by the
# caller and, being later on the command line, override the defaults below.
#
# helm template does NOT stamp metadata.namespace onto rendered objects, so the
# imperative kubectl_apply below always passes -n "$NAMESPACE".
# ── Security values that must survive a re-render ────────────────────────
#
# render_chart renders one template with chart DEFAULTS for everything it is
# not told about. That is fine for a knob whose default is the desired value
# and catastrophic for one an operator turned on: a routine `upgrade.sh` would
# otherwise strip BRAIN_CHECKPOINT_KEY out of the Deployment, reset
# CHECKPOINT_WRITE_VERSION to 3, and drop the per-workload NATS credentials so
# every component silently reverted to the shared all-access user. On a fleet
# already writing v4 that is not a rollback, it is data loss: the sealed
# checkpoints stay in the bucket and nothing can open them.
#
# Read from the cluster rather than from a values file. The file that has these
# is not the one every entrypoint sources -- deploy.sh knows the NATS creds
# file, upgrade.sh does not -- and "the operator must remember to pass them" is
# precisely the failure being fixed. What is deployed is the authority on what
# should stay deployed.
_preserve_security_values() {
  local out=() v
  v=$(kubectl get secret primus-claw-brain-checkpoint -n "$NAMESPACE" \
      -o jsonpath='{.data.BRAIN_CHECKPOINT_KEY}' 2>/dev/null | base64 -d 2>/dev/null || true)
  [ -n "$v" ] && out+=(--set-string "secret.brainCheckpointKey=$v")

  v=$(kubectl get deployment primus-claw-brain -n "$NAMESPACE" -o \
      jsonpath='{range .spec.template.spec.containers[0].env[?(@.name=="CHECKPOINT_WRITE_VERSION")]}{.value}{end}' \
      2>/dev/null || true)
  [ -n "$v" ] && out+=(--set-string "brain.checkpointWriteVersion=$v")

  local c
  for c in api brain reaper ops; do
    v=$(kubectl get secret "primus-claw-nats-$c" -n "$NAMESPACE" \
        -o jsonpath='{.data.NATS_PASSWORD}' 2>/dev/null | base64 -d 2>/dev/null || true)
    [ -n "$v" ] && out+=(--set-string "secret.natsUsers.$c.password=$v")
  done
  printf '%s\n' "${out[@]+"${out[@]}"}"
}

render_chart() {
  local template="$1" dst="$2"; shift 2
  local preserved=()
  # Explicit values from the caller come after these, so a deliberate --set
  # still wins over what happens to be deployed.
  mapfile -t preserved < <(_preserve_security_values)
  helm template primus-claw "$CLAW_CHART_DIR" \
    -n "$NAMESPACE" \
    --set secret.create=false \
    --set ingress.enabled=false \
    --set postgres.enabled=false \
    --set-string image.registry="$REGISTRY" \
    --set-string image.repository=claw \
    --set-string image.tag="$TAG" \
    ${preserved[@]+"${preserved[@]}"} \
    "$@" \
    --show-only "templates/$template" > "$dst"
}

# ── kubectl apply wrapper ────────────────────────────────────────────────
DRY_RUN="${DRY_RUN:-false}"

# All Claw objects are namespace-scoped. helm-rendered manifests carry no
# metadata.namespace, so pin the target ns here (previously the flat manifests
# baked in namespace: <NAMESPACE>).
kubectl_apply() {
  if $DRY_RUN; then
    log "[dry-run] kubectl apply -n $NAMESPACE -f $1"
    kubectl apply -n "$NAMESPACE" -f "$1" --dry-run=client
  else
    kubectl apply -n "$NAMESPACE" -f "$1"
  fi
}

# ── Deploy Hands binary to shared storage ─────────────────────────────────
# Extract the Bun-compiled Hands binary from the image to a per-namespace
# subdirectory under CLAW_DEPLOY_ROOT. dev/prod can share the same root mount
# without clobbering each other's binary.
#
# Layout:  $CLAW_DEPLOY_ROOT/$NAMESPACE/hands-binary
# Brain reads the same path via config.ts (LOCAL_MODE_HANDS_BINARY).
#
# Skipped entirely when CLAW_DEPLOY_ROOT is empty (Brain serves binary via HTTP).
deploy_shared_assets() {
  if [ -z "$CLAW_DEPLOY_ROOT" ]; then
    log "CLAW_DEPLOY_ROOT empty — Brain serves hands-binary via HTTP, skip shared asset deploy."
    return 0
  fi

  local bin_dir="$CLAW_DEPLOY_ROOT/$NAMESPACE"
  local bin_dst="$bin_dir/hands-binary"

  log "Deploying hands-binary to $bin_dst ..."

  # IMG is exported by build.sh; fall back to REGISTRY:TAG when build was skipped.
  local img="${IMG:-${REGISTRY}/claw:${TAG}}"
  if $DRY_RUN; then
    log "[dry-run] extract hands-binary from $img → $bin_dst"
    return 0
  fi

  mkdir -p "$bin_dir"

  # Wait for an API pod with the new image to be ready, then kubectl cp from it.
  local api_pod
  api_pod=$(kubectl -n "$NAMESPACE" get pod -l component=primus-claw-api -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)

  if [ -n "$api_pod" ]; then
    log "  Copying hands-binary from $api_pod → $bin_dst ..."
    kubectl -n "$NAMESPACE" exec "$api_pod" -- cat /app/hands-binary > "$bin_dst" \
      && chmod +x "$bin_dst" \
      && log "  hands-binary deployed → $bin_dst ($(wc -c < "$bin_dst") bytes)" \
      || log "  WARN: kubectl exec cat failed. Brain will serve binary via HTTP fallback."
  else
    log "  WARN: no running API pod found. Brain will serve binary via HTTP fallback."
  fi
}

# ── Deploy Hands binary straight from the built image ─────────────────────
# Extracts /app/hands-binary from the local docker image and writes it to
# shared storage, without touching any cluster pod. Used by
# `upgrade.sh --only-hands` so the Hands binary can be refreshed in isolation
# (no API/Brain rollout). Pairs with build.sh, which produces/pushes the image
# and exports IMG/TAG.
#
# Layout:  $CLAW_DEPLOY_ROOT/$NAMESPACE/hands-binary  (same path as Brain reads)
deploy_hands_from_image() {
  if [ -z "$CLAW_DEPLOY_ROOT" ]; then
    log "CLAW_DEPLOY_ROOT empty — nothing to do (Brain serves hands-binary via HTTP)."
    return 0
  fi

  local bin_dir="$CLAW_DEPLOY_ROOT/$NAMESPACE"
  local bin_dst="$bin_dir/hands-binary"
  local img="${IMG:-${REGISTRY}/claw:${TAG}}"

  log "Deploying hands-binary from image $img → $bin_dst ..."
  if $DRY_RUN; then
    log "[dry-run] docker create $img + stream /app/hands-binary → $bin_dst"
    return 0
  fi

  mkdir -p "$bin_dir"

  local cid
  cid=$(docker create "$img") || fail "docker create failed for image $img"

  # Stream the file out as a tar archive on stdout (`docker cp SRC -`) and
  # untar to stdout locally. We deliberately AVOID `docker cp SRC <hostpath>`:
  # docker resolves <hostpath> on the docker DAEMON host, not where this script
  # runs. When the daemon is remote (or the shared-storage mount only exists on
  # the operator host) that path is missing daemon-side and docker cp fails with
  # "invalid output path: directory ... does not exist". A stdout stream always
  # lands on the LOCAL filesystem regardless of where the daemon lives, mirroring
  # the `kubectl exec ... cat > file` approach used by deploy_shared_assets.
  if docker cp "$cid:/app/hands-binary" - | tar -xO > "$bin_dst"; then
    docker rm -f "$cid" >/dev/null 2>&1 || true
    local sz
    sz=$(wc -c < "$bin_dst" 2>/dev/null || echo 0)
    if [ "$sz" -le 0 ]; then
      rm -f "$bin_dst" 2>/dev/null || true
      fail "extracted hands-binary is empty (image $img)"
    fi
    chmod +x "$bin_dst"
    log "  hands-binary deployed → $bin_dst ($sz bytes)"
  else
    docker rm -f "$cid" >/dev/null 2>&1 || true
    rm -f "$bin_dst" 2>/dev/null || true
    fail "extracting /app/hands-binary failed from image $img"
  fi
}

# ── Auto-discover S3_* values from the minio namespace ──────────────────
# WARN-only by design: minio is treated as an optional dependency (operator
# may run an external S3, or migrate clusters). A missing/inaccessible minio
# release should NOT abort the deploy — we keep the literal "<KEY>"
# placeholder so the existing placeholder guard in deploy.sh surfaces a
# clear error pointing operators to deploy/values.<ns>.env.
#
# Override knobs (env vars; defaults match the standard helm release):
#   MINIO_NAMESPACE     (default: minio)
#   MINIO_SECRET_NAME   (default: minio)        # Bitnami chart's root secret
#   MINIO_SVC_NAME      (default: minio)        # in-cluster ClusterIP svc DNS
#   MINIO_SVC_PORT      (default: 9000)         # S3 API port
#
# Endpoint policy (per ops decision): use the in-cluster svc DNS form,
#   http://${MINIO_SVC_NAME}.${MINIO_NAMESPACE}.svc.cluster.local:${MINIO_SVC_PORT}
# This keeps S3 traffic on the cluster network (no NodePort dependency).
resolve_minio_secrets_from_cluster() {
  local mns="${MINIO_NAMESPACE:-minio}"
  local msec="${MINIO_SECRET_NAME:-minio}"
  local msvc="${MINIO_SVC_NAME:-minio}"
  local mport="${MINIO_SVC_PORT:-9000}"

  if [ -z "${S3_ACCESS_KEY:-}" ] || [ "$S3_ACCESS_KEY" = "<S3_ACCESS_KEY>" ]; then
    log "Resolving S3_ACCESS_KEY from secret ${mns}/${msec} (.data.rootUser) ..."
    local ak
    ak="$(kubectl get secret -n "$mns" "$msec" \
      -o jsonpath='{.data.rootUser}' 2>/dev/null | base64 -d 2>/dev/null || true)"
    if [ -n "$ak" ]; then
      S3_ACCESS_KEY="$ak"
      log "  S3_ACCESS_KEY=<redacted, ${#ak} chars>"
    else
      log "  WARN: could not read S3_ACCESS_KEY from ${mns}/${msec}. Placeholder kept; supply via deploy/values.${NAMESPACE}.env if minio is external/unreachable."
    fi
  else
    log "S3_ACCESS_KEY provided by values.${NAMESPACE}.env (skip cluster lookup)."
  fi

  if [ -z "${S3_SECRET_KEY:-}" ] || [ "$S3_SECRET_KEY" = "<S3_SECRET_KEY>" ]; then
    log "Resolving S3_SECRET_KEY from secret ${mns}/${msec} (.data.rootPassword) ..."
    local sk
    sk="$(kubectl get secret -n "$mns" "$msec" \
      -o jsonpath='{.data.rootPassword}' 2>/dev/null | base64 -d 2>/dev/null || true)"
    if [ -n "$sk" ]; then
      S3_SECRET_KEY="$sk"
      log "  S3_SECRET_KEY=<redacted, ${#sk} chars>"
    else
      log "  WARN: could not read S3_SECRET_KEY from ${mns}/${msec}. Placeholder kept; supply via deploy/values.${NAMESPACE}.env if minio is external/unreachable."
    fi
  else
    log "S3_SECRET_KEY provided by values.${NAMESPACE}.env (skip cluster lookup)."
  fi

  # S3_ENDPOINT defaults to in-cluster svc DNS; no kubectl needed.
  if [ -z "${S3_ENDPOINT:-}" ] || [ "$S3_ENDPOINT" = "<S3_ENDPOINT>" ]; then
    S3_ENDPOINT="http://${msvc}.${mns}.svc.cluster.local:${mport}"
    log "S3_ENDPOINT defaults to in-cluster svc DNS: $S3_ENDPOINT"
  else
    log "S3_ENDPOINT provided by values.${NAMESPACE}.env (skip): $S3_ENDPOINT"
  fi

  # S3_API_ENDPOINT mirrors S3_ENDPOINT unless explicitly overridden.
  if [ -z "${S3_API_ENDPOINT:-}" ] || [ "$S3_API_ENDPOINT" = "<S3_API_ENDPOINT>" ]; then
    S3_API_ENDPOINT="$S3_ENDPOINT"
    log "S3_API_ENDPOINT defaults to S3_ENDPOINT: $S3_API_ENDPOINT"
  else
    log "S3_API_ENDPOINT provided by values.${NAMESPACE}.env (skip): $S3_API_ENDPOINT"
  fi
}

# ── Wait for pods with target image tag to be Ready ──────────────────────
wait_pods_ready() {
  local component="$1" kind="$2" timeout="${3:-180}"
  local elapsed=0
  log "  Waiting for $component pods (tag=$TAG) to be Ready (timeout ${timeout}s) ..."
  while [ "$elapsed" -lt "$timeout" ]; do
    local ready
    ready=$(kubectl get pods -n "$NAMESPACE" \
      -l "component=$component" \
      -o jsonpath="{range .items[*]}{range .spec.containers[*]}{.image}{end}{' '}{range .status.containerStatuses[*]}{.ready}{end}{'\n'}{end}" \
      2>/dev/null | grep "$TAG" | grep -c "true" || true)
    local desired
    desired=$(kubectl get "$kind/$component" -n "$NAMESPACE" \
      -o jsonpath='{.spec.replicas}' 2>/dev/null || echo "1")
    if [ "$ready" -ge "$desired" ]; then
      log "  $component: $ready/$desired pods Ready."
      return 0
    fi
    sleep 5
    elapsed=$((elapsed + 5))
  done
  return 1
}
