#!/usr/bin/env bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

# ═══════════════════════════════════════════════════════════════════════════
# Claw component upgrade script.
#
# Upgrades API / Brain / both to a new image tag without touching infra
# (PGO, NATS, PG). Supports selective component upgrade and dry-run mode.
#
# REQUIRED FLAG: -n <ns>  (no default; safety-first to prevent accidentally
#                          upgrading prod when you meant dev, or vice versa.)
#
# Usage:
#   bash deploy/upgrade.sh -n primus-claw-dev                              # build + upgrade all
#   TAG=202604240800 bash deploy/upgrade.sh -n primus-claw                 # upgrade all (existing image)
#   TAG=202604240800 bash deploy/upgrade.sh -n primus-claw-dev --only-api  # API only
#   TAG=202604240800 bash deploy/upgrade.sh -n primus-claw-dev --only-brain
#   bash deploy/upgrade.sh -n primus-claw-dev --dry-run                    # preview (no build)
#
# Environment variables:
#   TAG              - image tag to deploy (REQUIRED; image building was removed)
#   REGISTRY         - image registry (default: docker.io/primussafe)
#   DOMAIN           - cluster ingress host (required for a full deploy; set in
#                       values.<NAMESPACE>.env or via DOMAIN=...)
#
# Per-env values (S3, AUTH, CLAW_DEPLOY_ROOT, ...) live in
# deploy/values.<NAMESPACE>.env (gitignored). common.sh sources that
# file based on -n <ns>; do NOT pass these as env vars on the command line.
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_SCRIPT_LABEL="upgrade"

DRY_RUN=false
ONLY_API=false
ONLY_BRAIN=false
ONLY_HANDS=false
SKIP_HEALTH=false
SKIP_SHARED_ASSETS=false
ROLLBACK=false
NAMESPACE_EXPLICIT=""

while [ $# -gt 0 ]; do
  case "$1" in
    -n)
      [ $# -ge 2 ] || { echo "ERROR: -n requires a namespace value" >&2; exit 1; }
      NAMESPACE_EXPLICIT="$2"; shift 2 ;;
    --dry-run)             DRY_RUN=true; shift ;;
    --only-api)            ONLY_API=true; shift ;;
    --only-brain)          ONLY_BRAIN=true; shift ;;
    --only-hands)          ONLY_HANDS=true; shift ;;
    --skip-health)         SKIP_HEALTH=true; shift ;;
    --skip-shared-assets)  SKIP_SHARED_ASSETS=true; shift ;;
    --rollback)            ROLLBACK=true; shift ;;
    --help|-h)
      cat <<'HELP'
Usage: TAG=<tag> bash deploy/upgrade.sh -n <ns> [flags]

Required:
  -n <ns>                K8s namespace to upgrade (e.g. primus-claw, primus-claw-dev)
  TAG=<tag>              Pre-built image tag to deploy (image building was removed;
                         build & push docker.io/primussafe/claw:<tag> out-of-band first)

Flags:
  --only-api             Upgrade only the API deployment
  --only-brain           Upgrade only the Brain deployment
  --only-hands           Only refresh hands-binary on shared storage: pulls
                         $REGISTRY/claw:$TAG, streams /app/hands-binary out of it
                         and writes it to CLAW_DEPLOY_ROOT — no API/Brain rollout.
  --skip-health          Skip post-upgrade health probes
  --skip-shared-assets   Skip copying hands-binary to CLAW_DEPLOY_ROOT
                         (use when operator host has no weka/shared-storage mount;
                          sandbox falls back to Brain HTTP download automatically)
  --rollback             Roll the Brain deployment back to its previous version.
                         Use this instead of a bare `kubectl rollout undo`: undo
                         reverts the pods but leaves brain.min_version naming the
                         tag you are rolling away from, and a pod that is not the
                         version that key names stops taking work -- so the fleet
                         comes back up and serves nothing while reporting healthy.
                         This reverts the pods, waits for them, re-points
                         brain.min_version at whatever tag the cluster now runs,
                         and verifies the pods report they are taking work again.
                         TAG is not required (and is ignored): the tag to bless is
                         read from the cluster, never typed.
  --dry-run              Preview only, no apply
HELP
      exit 0 ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

# Refuse to run without an explicit -n. Override any inherited NAMESPACE
# env var so a stale shell export cannot silently target prod.
if [ -z "$NAMESPACE_EXPLICIT" ]; then
  echo "[upgrade] ERROR: -n <ns> is required (no default; safety-first)" >&2
  echo "  e.g.  bash $0 -n primus-claw-dev" >&2
  exit 1
fi
export NAMESPACE="$NAMESPACE_EXPLICIT"

# common.sh provides log/fail/render_chart/kubectl_apply/wait_pods_ready/etc.
# It honors the NAMESPACE we just exported and does not override it.
source "$SCRIPT_DIR/common.sh"

# TAG is required: image building was removed from the upgrade path. Build &
# push $REGISTRY/claw:<tag> out-of-band (e.g. deploy/build.sh) first. IMG is
# consumed by health checks and deploy_hands_from_image / deploy_shared_assets.
if [[ -z "$TAG" ]] && ! $ROLLBACK; then
  fail "TAG is required (image building was removed). Build & push $REGISTRY/claw:<tag> out-of-band (e.g. deploy/build.sh), then pass TAG=<tag>."
fi
# On --rollback the tag is whatever the cluster reverts to, so it is read back
# after the undo rather than taken from the environment. Anything TAG-derived is
# filled in there.
if ! $ROLLBACK; then
  IMG="${IMG:-$REGISTRY/claw:$TAG}"
fi
export TAG IMG

if $ONLY_API && $ONLY_BRAIN; then
  fail "--only-api and --only-brain are mutually exclusive"
fi
if $ONLY_HANDS && { $ONLY_API || $ONLY_BRAIN; }; then
  fail "--only-hands cannot be combined with --only-api / --only-brain"
fi

UPGRADE_API=true
UPGRADE_BRAIN=true
if $ONLY_API;   then UPGRADE_BRAIN=false; fi
if $ONLY_BRAIN; then UPGRADE_API=false;   fi
# --only-hands refreshes just the hands-binary: no Deployment rollout at all.
if $ONLY_HANDS; then UPGRADE_API=false; UPGRADE_BRAIN=false; fi
# --rollback reverts Brain and nothing else. Without this the API upgrade and
# the shared-asset copy above it would still run first -- and with no TAG, they
# would push an empty image reference at the cluster.
#
# Refuse the combinations rather than silently winning over them: someone who
# typed --rollback --only-api meant something this script is not going to do,
# and quietly doing something else on a rollback path is how you get a second
# incident on top of the one being rolled back.
if $ROLLBACK; then
  if $ONLY_API;   then fail "--rollback cannot be combined with --only-api (rollback is Brain-only; roll the API back with 'kubectl rollout undo deployment/primus-claw-api -n $NAMESPACE_EXPLICIT')."; fi
  if $ONLY_HANDS; then fail "--rollback cannot be combined with --only-hands (rollback changes no binaries; the reverted pods carry their own)."; fi
  UPGRADE_API=false
  ONLY_HANDS=false
  SKIP_SHARED_ASSETS=true
fi

if $ROLLBACK; then
  log "Rollback → namespace=$NAMESPACE  (Brain only; target tag is read from the cluster)"
  log "  dry-run=$DRY_RUN"
else
  IMAGE="$REGISTRY/claw:$TAG"
  log "Upgrade → namespace=$NAMESPACE  image=$IMAGE"
  log "  API=$UPGRADE_API  Brain=$UPGRADE_BRAIN  hands-only=$ONLY_HANDS  dry-run=$DRY_RUN"
fi

# WORK_DIR, render_chart, kubectl_apply, wait_pods_ready — provided by common.sh

# Preserve manually scaled deployment replicas during image-only upgrades.
# `kubectl apply` treats `spec.replicas` as desired state, so applying a rendered
# manifest with a template/default value would silently undo a live scale action.
current_deploy_replicas() {
  local deploy="$1" fallback="$2"
  local replicas
  replicas=$(kubectl get "deployment/$deploy" -n "$NAMESPACE" \
    -o jsonpath='{.spec.replicas}' 2>/dev/null || true)
  if [[ "$replicas" =~ ^[0-9]+$ ]]; then
    echo "$replicas"
  else
    echo "$fallback"
  fi
}

preserve_rendered_deploy_replicas() {
  local deploy="$1" manifest="$2" fallback="$3"
  local replicas

  if ! kubectl get "deployment/$deploy" -n "$NAMESPACE" >/dev/null 2>&1; then
    log "  $deploy not found; keep manifest default replicas."
    return 0
  fi

  replicas=$(current_deploy_replicas "$deploy" "$fallback")
  log "  Preserving $deploy replicas=$replicas in rendered manifest."
  python3 - "$manifest" "$replicas" <<'PY'
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
replicas = sys.argv[2]
text = path.read_text()
updated, count = re.subn(r"(?m)^(\s*)replicas:\s*\d+\s*$", rf"\1replicas: {replicas}", text, count=1)
if count != 1:
    raise SystemExit(f"failed to replace replicas in {path}")
path.write_text(updated)
PY
}

# ═══════════════════════════════════════════════════════════════════════════
# 1. Upgrade API (Deployment — standard rolling update)
# ═══════════════════════════════════════════════════════════════════════════
if $UPGRADE_API; then
  log "═══ Upgrading API ═══"
  render_chart api-deployment.yaml "$WORK_DIR/api-deployment.yaml"
  preserve_rendered_deploy_replicas "primus-claw-api" "$WORK_DIR/api-deployment.yaml" "2"
  kubectl_apply "$WORK_DIR/api-deployment.yaml"

  if ! $DRY_RUN; then
    if ! wait_pods_ready "primus-claw-api" "deployment" 180; then
      log "WARNING: API pods not fully Ready within 180s. Check: kubectl get pods -n $NAMESPACE -l component=primus-claw-api"
    fi
  fi
  log "API upgrade applied."
fi

# ═══════════════════════════════════════════════════════════════════════════
# 1.5. Deploy hands-binary to shared storage (after API is ready)
# ═══════════════════════════════════════════════════════════════════════════
if $ROLLBACK; then
  : # a rollback changes no binaries; the reverted pods carry their own
elif $ONLY_HANDS; then
  log "═══ Refreshing hands-binary only ═══"
  deploy_hands_from_image
elif $UPGRADE_BRAIN; then
  if $SKIP_SHARED_ASSETS; then
    log "--skip-shared-assets set; sandbox will pull hands-binary via Brain HTTP fallback."
  else
    deploy_shared_assets
  fi
fi

# ═══════════════════════════════════════════════════════════════════════════
# 2. Upgrade Brain (Deployment — safety-first rolling update)
#    Order: apply → new ready → write min_version → drain old → complete
# ═══════════════════════════════════════════════════════════════════════════

# Helper: write a value into the BRAIN_REGISTRY NATS KV bucket.
#
# Used by the Brain rollout to publish `brain.min_version` so old pods
# drain. Three independent transport strategies are tried in order so a
# single environmental hiccup doesn't abort the rollout:
#
#   1. exec into the long-running `primus-claw-nats-box` deployment
#      (in-cluster, reuses an established TLS session, no pod churn).
#   2. exec into any existing nats-box pod found by label selector.
#   3. spawn a one-shot pod via `kubectl run` (legacy path, kept as a
#      last resort — `--rm` is known to corrupt exit codes on some
#      kubelet versions, hence we read back the value to verify rather
#      than trust the exit code blindly).
#
# After every strategy we verify the write by reading the key back; if
# the read returns the expected value we treat the write as a success
# regardless of the writer command's exit code.
#
# Historical bug: an earlier version of this function double-prefixed
# the NATS URL with credentials when the secret already carried
# `nats://user:pass@host`, producing `nats://user:pass@user:pass@host`
# which the nats CLI silently rejects (and 2>/dev/null swallowed the
# error). The URL builder below detects an existing `@` to avoid the
# duplication.
nats_kv_put() {
  local key="$1" val="$2"
  local nats_user nats_pass nats_host nats_url
  # Prefer the `ops` identity when one has been provisioned. It can set this
  # one key and read it back and nothing else, which is the whole point: the
  # credential a human pastes into a shell during an upgrade should not also
  # be able to rewrite checkpoints or ack another component's deliveries.
  # Falls back to whatever primus-claw-secrets holds when the per-user secrets
  # have not been rolled out yet, so this keeps working mid-migration.
  nats_user=$(kubectl get secret primus-claw-nats-ops -n "$NAMESPACE" \
    -o jsonpath='{.data.NATS_USER}' 2>/dev/null | base64 -d 2>/dev/null || true)
  nats_pass=$(kubectl get secret primus-claw-nats-ops -n "$NAMESPACE" \
    -o jsonpath='{.data.NATS_PASSWORD}' 2>/dev/null | base64 -d 2>/dev/null || true)
  if [ -z "$nats_user" ] || [ -z "$nats_pass" ]; then
    nats_user=$(kubectl get secret primus-claw-secrets -n "$NAMESPACE" \
      -o jsonpath='{.data.NATS_USER}' 2>/dev/null | base64 -d 2>/dev/null || echo "prod")
    nats_pass=$(kubectl get secret primus-claw-secrets -n "$NAMESPACE" \
      -o jsonpath='{.data.NATS_PASSWORD}' 2>/dev/null | base64 -d 2>/dev/null || echo "")
  fi
  nats_host=$(kubectl get secret primus-claw-secrets -n "$NAMESPACE" \
    -o jsonpath='{.data.NATS_URL}' 2>/dev/null | base64 -d 2>/dev/null \
    || echo "nats://primus-claw-nats.${NAMESPACE}.svc.cluster.local:4222")

  # Build authenticated URL. If the secret-supplied URL already carries
  # credentials (nats://user:pass@host), keep it verbatim — the
  # double-prefix bug above is exactly what we avoid here.
  if [[ "$nats_host" == *"@"* ]]; then
    nats_url="$nats_host"
  else
    local scheme_rest="${nats_host#nats://}"
    nats_url="nats://${nats_user}:${nats_pass}@${scheme_rest}"
  fi

  local nats_box_image="${NATS_BOX_IMAGE:-docker.io/natsio/nats-box:0.14.5}"
  local put_cmd="nats kv put BRAIN_REGISTRY '$key' '$val' --server='$nats_url'"
  local get_cmd="nats kv get BRAIN_REGISTRY '$key' --server='$nats_url' --raw"

  # Strategy 1: exec into the long-running nats-box deployment.
  local box_pod
  box_pod=$(kubectl get pods -n "$NAMESPACE" \
    -l "app.kubernetes.io/name=nats-box,app.kubernetes.io/instance=primus-claw-nats" \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
  if [[ -z "$box_pod" ]]; then
    # Some Helm chart variants use a different selector — fall back to a name match.
    box_pod=$(kubectl get pods -n "$NAMESPACE" 2>/dev/null \
      | awk '$1 ~ /^primus-claw-nats-box/ && $3 == "Running" {print $1; exit}')
  fi
  if [[ -n "$box_pod" ]]; then
    log "  nats_kv_put: exec into $box_pod (strategy 1)"
    if kubectl exec -n "$NAMESPACE" "$box_pod" -- sh -c "$put_cmd"; then
      local readback
      readback=$(kubectl exec -n "$NAMESPACE" "$box_pod" -- sh -c "$get_cmd" 2>/dev/null | tr -d '[:space:]')
      if [[ "$readback" == "$val" ]]; then return 0; fi
      log "  nats_kv_put: strategy 1 put succeeded but readback returned '$readback' (want '$val')"
    else
      log "  nats_kv_put: strategy 1 put failed; falling back"
    fi
  fi

  # Strategy 2: throwaway pod via kubectl run. Don't swallow stderr —
  # we want operators to see the real error if both paths fail.
  log "  nats_kv_put: spawn throwaway nats-box pod (strategy 2)"
  if kubectl run "nats-kv-put-$$" --rm -i --restart=Never \
       -n "$NAMESPACE" \
       --image="$nats_box_image" \
       --command -- sh -c "$put_cmd"; then
    return 0
  fi

  # Either strategy may have actually written the value while the
  # caller saw a non-zero exit code (kubectl --rm tear-down quirks).
  # Verify by reading back via whichever pod we have available before
  # declaring failure.
  if [[ -n "$box_pod" ]]; then
    local readback
    readback=$(kubectl exec -n "$NAMESPACE" "$box_pod" -- sh -c "$get_cmd" 2>/dev/null | tr -d '[:space:]')
    if [[ "$readback" == "$val" ]]; then
      log "  nats_kv_put: writer exit code non-zero but readback confirms write — treating as success"
      return 0
    fi
  fi
  return 1
}

# Helper: block until N pods with the given image tag are Ready.
wait_for_new_pods_ready() {
  local tag="$1" desired="$2" timeout="${3:-300}"
  local elapsed=0
  log "  Waiting for $desired Brain pod(s) with brain-version=$tag to be Ready (timeout ${timeout}s) ..."
  while [ "$elapsed" -lt "$timeout" ]; do
    local ready
    ready=$(kubectl get pods -n "$NAMESPACE" \
      -l "component=primus-claw-brain,brain-version=$tag" \
      -o jsonpath="{range .items[*]}{range .status.containerStatuses[?(@.name=='brain')]}{.ready}{'\n'}{end}{end}" \
      2>/dev/null | grep -c "^true$" || true)
    if [ "$ready" -ge "$desired" ]; then
      log "  $ready new Brain pod(s) Ready."
      return 0
    fi
    sleep 5
    elapsed=$((elapsed + 5))
  done
  return 1
}

# Confirm the fleet is actually taking work.
#
# A drained pod and a serving one used to answer /health identically, which is
# how a fleet that had drained itself into serving nothing still reported full
# health. /health now carries `draining` and `drainReason`, so a rollback can be
# checked rather than assumed.
verify_brain_taking_work() {
  local img="$1" out
  kubectl delete pod claw-rollback-hc -n "$NAMESPACE" --ignore-not-found --wait=false 2>/dev/null || true
  sleep 2
  out=$(kubectl run claw-rollback-hc --rm -i --restart=Never \
    -n "$NAMESPACE" --image="$img" \
    --command -- curl -sf "http://primus-claw-brain.$NAMESPACE.svc.cluster.local:8100/health" 2>&1) || true

  # Tolerate JSON spacing, and distinguish the three outcomes properly. An
  # earlier version grepped only for the false case and treated everything else
  # as "old build", so an unreachable pod, a curl failure or a differently
  # spaced payload all read as success -- a verifier that passes when it learned
  # nothing is worse than no verifier.
  if [ -z "$out" ]; then
    log "  Brain drain state: FAIL — /health returned nothing (probe could not reach the pods)."
    return 1
  fi
  if echo "$out" | grep -Eq '"draining"[[:space:]]*:[[:space:]]*false'; then
    log "  Brain drain state: PASS (taking work)"
  elif echo "$out" | grep -Eq '"draining"[[:space:]]*:[[:space:]]*true'; then
    log "  Brain drain state: FAIL — pods are still drained."
    log "    $out"
    log "    drainReason=version means brain.min_version does not name the deployed tag."
    return 1
  elif echo "$out" | grep -q '"service":"brain"'; then
    # A real answer from a Brain that predates the drain fields. Nothing this
    # check can assert -- say so, and say it is not a pass.
    log "  Brain drain state: NOT CHECKED (this build predates the /health drain fields)"
  else
    log "  Brain drain state: FAIL — /health did not answer as a Brain:"
    log "    $out"
    return 1
  fi
  return 0
}

# Brain rollback helper.
#
# `kubectl rollout undo` alone is not a rollback of a *completed* Brain upgrade.
# It reverts the pod template, so pods come back on the previous tag -- but
# brain.min_version still names the tag being rolled away from, and a pod that
# is not the version that key names stops taking work. The fleet returns and
# serves nothing.
#
# The KV therefore has to move with the pods, and *after* them, for the same
# reason the upgrade writes it after the new pods are Ready: writing it first
# drains the pods that are still serving before their replacements exist.
#
# (Rolling back a *failed* upgrade needs none of this: upgrade_brain aborts at
# the readiness gate, before it ever writes the key, so a bare undo is correct
# there and that is still what the failure message says.)
rollback_brain() {
  local replicas
  replicas=$(kubectl get deployment/primus-claw-brain -n "$NAMESPACE" \
    -o jsonpath='{.spec.replicas}' 2>/dev/null || echo "3")

  if $DRY_RUN; then
    log "[dry-run] kubectl rollout undo deployment/primus-claw-brain -n $NAMESPACE"
    log "[dry-run] wait for $replicas pod(s) Ready → rewrite brain.min_version to the"
    log "[dry-run] reverted tag → verify /health reports the pods are taking work"
    return 0
  fi

  # `rollout undo` with no --to-revision toggles between the last two
  # revisions, so running this twice puts you back where you started. Capture
  # what we are leaving so the from->to is on the record and a no-op undo is
  # caught rather than blessed.
  local before_tag
  before_tag=$(kubectl get deployment/primus-claw-brain -n "$NAMESPACE" \
    -o jsonpath='{.spec.template.metadata.labels.brain-version}' 2>/dev/null || true)

  log "Brain rollback: reverting the Deployment (currently ${before_tag:-<unknown>}) ..."
  kubectl rollout undo deployment/primus-claw-brain -n "$NAMESPACE"
  kubectl rollout status deployment/primus-claw-brain -n "$NAMESPACE" --timeout=360s

  # Read the tag from the cluster, never from the environment. This path runs
  # when something is already wrong, and a mistyped tag here would drain the
  # fleet a second time.
  local tag
  tag=$(kubectl get deployment/primus-claw-brain -n "$NAMESPACE" \
    -o jsonpath='{.spec.template.metadata.labels.brain-version}' 2>/dev/null || true)

  if [ -n "$before_tag" ] && [ "$tag" = "$before_tag" ]; then
    fail "Rollback: the Deployment still runs $tag after the undo, so there was \
nothing to roll back to. brain.min_version was NOT touched. Check \
'kubectl rollout history deployment/primus-claw-brain -n $NAMESPACE' and roll \
forward to a known-good tag instead."
  fi
  [ -n "$tag" ] || fail "Rollback: could not read brain-version from the Deployment's \
pod template, so there is no safe value to write. The pods are reverted but \
brain.min_version still names the old tag and they will not take work. Set it by \
hand: POST /v1/internal/brain/min-version {\"minVersion\":\"<deployed tag>\"}"

  log "Brain rollback: reverted to tag=$tag; waiting for $replicas pod(s) ..."
  wait_for_new_pods_ready "$tag" "$replicas" 300 \
    || fail "Rollback: pods with brain-version=$tag did not become Ready within 300s. \
brain.min_version was NOT rewritten, so it still names the tag you rolled away from."

  log "Brain rollback: re-pointing brain.min_version at $tag ..."
  nats_kv_put "brain.min_version" "$tag" \
    || fail "Rollback: the pods are reverted but brain.min_version could not be \
rewritten. The fleet is drained and will not take work. Set it by hand: \
POST /v1/internal/brain/min-version {\"minVersion\":\"$tag\"}"

  ROLLBACK_TAG="$tag"
  ROLLBACK_IMG=$(kubectl get deployment/primus-claw-brain -n "$NAMESPACE" \
    -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || true)
  log "Brain rollback complete: ${before_tag:-<unknown>} → $tag"
  log "  Note: 'rollout undo' toggles between the last two revisions, so running"
  log "  --rollback again would put Brain back on ${before_tag:-the previous tag}."
}

# Brain upgrade helper (safety-first):
#   1. Apply new Deployment → new pods start alongside old (maxSurge=3)
#   2. Wait for new pods Ready → confirms new version is healthy
#   3. Write min_version → old pods drain (stop pulling new tasks)
#   4. Wait for rollout complete → old pods exit, K8s cleans up
#
# If new pods fail to start, step 2 aborts, step 3 is never reached,
# old pods continue serving normally. Zero task blackout on failure.
upgrade_brain() {
  local new_manifest="$1"
  local replicas
  replicas=$(kubectl get deployment/primus-claw-brain -n "$NAMESPACE" \
    -o jsonpath='{.spec.replicas}' 2>/dev/null || echo "3")

  log "Brain upgrade: applying new image (tag=$TAG, replicas=$replicas) ..."

  # Step 1: apply new manifest (-n required: chart-rendered manifest carries no
  # metadata.namespace).
  kubectl apply -n "$NAMESPACE" -f "$new_manifest"

  # Step 2: wait for new pods to become Ready
  if ! wait_for_new_pods_ready "$TAG" "$replicas" 300; then
    fail "New Brain pods did not become Ready within 300s. \
Old pods are still running normally. \
Rollback with: kubectl rollout undo deployment/primus-claw-brain -n $NAMESPACE"
  fi

  # Step 3: new pods confirmed healthy — signal old pods to drain
  log "Brain upgrade: new pods Ready. Signaling old pods to drain (min_version=$TAG) ..."
  nats_kv_put "brain.min_version" "$TAG" \
    || fail "Failed to write brain.min_version. Abort rollout to avoid mixed scheduling behavior."

  # Step 4: wait for rollout complete.
  # Timeout must exceed brain-deployment.yaml::terminationGracePeriodSeconds
  # (300s for Plan Y v2 SIGTERM checkpoint) plus a small buffer; old pods
  # drain in parallel (maxSurge=3 / maxUnavailable=0), so we do not need to
  # scale this with replica count.
  log "Brain upgrade: waiting for old pods to exit ..."
  kubectl rollout status deployment/primus-claw-brain \
    -n "$NAMESPACE" --timeout=360s
  log "Brain upgrade complete."
}

# ── Rollback (Brain only; exits when done) ─────────────────────────────────
# Scoped to Brain because Brain is the only component whose "which version is
# current" lives outside the Deployment, in brain.min_version. Rolling the API
# back really is just `kubectl rollout undo`.
if $ROLLBACK; then
  log "═══ Rolling Brain back ═══"
  ROLLBACK_TAG=""
  ROLLBACK_IMG=""
  rollback_brain
  if ! $DRY_RUN && ! $SKIP_HEALTH && [ -n "$ROLLBACK_IMG" ]; then
    log "═══ Health check ═══"
    verify_brain_taking_work "$ROLLBACK_IMG" || fail "Rollback finished but the Brain \
pods are not taking work. See the drain state above."
  fi
  log "════════════════════════════════════════════════════════"
  log "Rollback complete!${ROLLBACK_TAG:+ Brain is on tag=$ROLLBACK_TAG}"
  log "  kubectl get pods -n $NAMESPACE -l component=primus-claw-brain"
  log "════════════════════════════════════════════════════════"
  exit 0
fi

if $UPGRADE_BRAIN; then
  log "═══ Upgrading Brain ═══"
  render_chart brain-deployment.yaml "$WORK_DIR/brain-deployment.yaml"
  preserve_rendered_deploy_replicas "primus-claw-brain" "$WORK_DIR/brain-deployment.yaml" "$BRAIN_REPLICAS"

  if ! $DRY_RUN; then
    if kubectl get deployment/primus-claw-brain -n "$NAMESPACE" >/dev/null 2>&1; then
      upgrade_brain "$WORK_DIR/brain-deployment.yaml"
    else
      kubectl_apply "$WORK_DIR/brain-deployment.yaml"   # first install
      if ! wait_pods_ready "primus-claw-brain" "deployment" 300; then
        log "WARNING: Brain pods not fully Ready within 300s."
      fi
    fi
  else
    log "[dry-run] upgrade_brain (apply → wait Ready → signal → wait complete)"
    kubectl apply -n "$NAMESPACE" -f "$WORK_DIR/brain-deployment.yaml" --dry-run=client
  fi
  log "Brain upgrade applied."
fi

# ═══════════════════════════════════════════════════════════════════════════
# 3. Health check
# ═══════════════════════════════════════════════════════════════════════════
if ! $DRY_RUN && ! $SKIP_HEALTH; then
  log "═══ Health check ═══"

  if $UPGRADE_API; then
    API_SVC="primus-claw-api.$NAMESPACE.svc.cluster.local:80"
    kubectl delete pod claw-upgrade-hc -n "$NAMESPACE" --ignore-not-found --wait=false 2>/dev/null || true
    sleep 2
    HEALTH=$(kubectl run claw-upgrade-hc --rm -i --restart=Never \
      -n "$NAMESPACE" \
      --image="$IMG" \
      --command -- curl -sf "http://$API_SVC/health" 2>&1) || true
    if echo "$HEALTH" | grep -qi 'ok\|healthy\|status'; then
      log "  API health: PASS ($HEALTH)"
    else
      log "  API health: WARN ($HEALTH)"
    fi
  fi

  if $UPGRADE_BRAIN; then
    BRAIN_SVC="primus-claw-brain.$NAMESPACE.svc.cluster.local:8100"
    kubectl delete pod claw-upgrade-hc -n "$NAMESPACE" --ignore-not-found --wait=false 2>/dev/null || true
    sleep 2
    HEALTH=$(kubectl run claw-upgrade-hc --rm -i --restart=Never \
      -n "$NAMESPACE" \
      --image="$IMG" \
      --command -- curl -sf "http://$BRAIN_SVC/health" 2>&1) || true
    if echo "$HEALTH" | grep -qi 'ok\|brain'; then
      log "  Brain health: PASS ($HEALTH)"
    else
      log "  Brain health: WARN ($HEALTH)"
    fi
  fi
fi

# ═══════════════════════════════════════════════════════════════════════════
# 4. Summary
# ═══════════════════════════════════════════════════════════════════════════
log "════════════════════════════════════════════════════════"
log "Upgrade complete! image=$IMAGE"
if $ONLY_HANDS; then log "  hands-binary refreshed on shared storage (no API/Brain rollout)."; fi
if $UPGRADE_API;   then log "  API:   kubectl get pods -n $NAMESPACE -l component=primus-claw-api"; fi
if $UPGRADE_BRAIN; then log "  Brain: kubectl get pods -n $NAMESPACE -l component=primus-claw-brain"; fi
log ""
log "Rollback:"
if $UPGRADE_API;   then log "  kubectl rollout undo deployment/primus-claw-api   -n $NAMESPACE"; fi
if $UPGRADE_BRAIN; then
  # Deliberately not `kubectl rollout undo` for Brain. This upgrade has already
  # written brain.min_version, so undo on its own reverts the pods and leaves
  # them drained against a key naming the tag being rolled away from -- a fleet
  # that comes back and serves nothing while reporting healthy.
  log "  bash deploy/upgrade.sh -n $NAMESPACE --rollback"
  log "    (NOT a bare 'kubectl rollout undo': this upgrade wrote brain.min_version,"
  log "     and undo alone leaves the reverted pods drained against it.)"
fi
log "════════════════════════════════════════════════════════"
