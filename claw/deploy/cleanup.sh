#!/usr/bin/env bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

# Tear-down companion to deploy.sh — removes everything provisioned for
# the Claw stack from a single Kubernetes cluster.
#
# Default is DRY-RUN. Pass --yes to actually delete.
#
# Usage:
#   bash deploy/cleanup.sh                          # dry-run preview
#   bash deploy/cleanup.sh --yes                    # destructive
#   NAMESPACE=primus-claw bash deploy/cleanup.sh --yes
#   bash deploy/cleanup.sh --yes --keep-ns          # keep namespace
#   bash deploy/cleanup.sh --yes --keep-pgo         # keep PGO operator
set -euo pipefail

NAMESPACE="${NAMESPACE:-primus-claw}"
PG_CLUSTER="${PG_CLUSTER:-primus-claw}"
PGO_RELEASE="${PGO_RELEASE:-primus-pgo}"
NATS_RELEASE="${NATS_RELEASE:-primus-claw-nats}"
WAIT_TIMEOUT="${WAIT_TIMEOUT:-180}"
PG_FINALIZER_TIMEOUT="${PG_FINALIZER_TIMEOUT:-30}"

YES=false
KEEP_NS=false
KEEP_PGO=false

for arg in "$@"; do
  case "$arg" in
    --yes)      YES=true ;;
    --keep-ns)  KEEP_NS=true ;;
    --keep-pgo) KEEP_PGO=true ;;
    --help|-h)
      echo "Usage: [NAMESPACE=<ns>] $0 [--yes] [--keep-ns] [--keep-pgo]"
      exit 0 ;;
    *) echo "Unknown flag: $arg"; exit 1 ;;
  esac
done

log()  { echo "[cleanup] $(date +%H:%M:%S) $*"; }
warn() { echo "[cleanup] WARN: $*" >&2; }

# Wrap a real command so dry-run only prints it.
run() {
  if $YES; then
    "$@"
  else
    echo "  [dry-run] $*"
  fi
}

CTX=$(kubectl config current-context)
log "================================================================"
log " Cleanup target"
log "   context   : $CTX"
log "   namespace : $NAMESPACE"
log "   PG cluster: $PG_CLUSTER"
log "   PGO       : $([[ $KEEP_PGO == true ]] && echo KEEP || echo DELETE) ($PGO_RELEASE)"
log "   NATS      : $NATS_RELEASE"
log "   ns delete : $([[ $KEEP_NS == true ]] && echo NO || echo YES)"
log "   mode      : $($YES && echo DESTRUCTIVE || echo DRY-RUN)"
log "================================================================"

if ! kubectl get ns "$NAMESPACE" >/dev/null 2>&1; then
  log "Namespace $NAMESPACE not found — nothing to do."
  exit 0
fi

# ── Step 1: delete PostgresCluster (PGO will drop PG pods, services, secrets) ─
# If PGO has already been uninstalled, its finalizer
# (postgres-operator.crunchydata.com/finalizer) will never be cleared
# and the resource — and therefore the namespace — will hang in
# Terminating forever. Detect that case and force-clear finalizers.
log "Step 1/6: Deleting PostgresCluster '$PG_CLUSTER' (if present) ..."
if kubectl get postgrescluster "$PG_CLUSTER" -n "$NAMESPACE" >/dev/null 2>&1; then
  run kubectl delete postgrescluster "$PG_CLUSTER" -n "$NAMESPACE" --wait=false

  if $YES; then
    SECONDS_WAITED=0
    while [[ $SECONDS_WAITED -lt $PG_FINALIZER_TIMEOUT ]]; do
      kubectl get postgrescluster "$PG_CLUSTER" -n "$NAMESPACE" >/dev/null 2>&1 || break
      sleep 3
      SECONDS_WAITED=$((SECONDS_WAITED + 3))
    done
    if kubectl get postgrescluster "$PG_CLUSTER" -n "$NAMESPACE" >/dev/null 2>&1; then
      warn "PostgresCluster still present after ${PG_FINALIZER_TIMEOUT}s — clearing finalizers (PGO offline?)."
      run kubectl patch postgrescluster "$PG_CLUSTER" -n "$NAMESPACE" \
        --type=merge -p '{"metadata":{"finalizers":[]}}'
    fi
  fi
else
  log "  PostgresCluster '$PG_CLUSTER' not found."
fi

# ── Step 2: uninstall NATS ───────────────────────────────────────────────
log "Step 2/6: Uninstalling NATS helm release '$NATS_RELEASE' (if present) ..."
if helm status "$NATS_RELEASE" -n "$NAMESPACE" >/dev/null 2>&1; then
  run helm uninstall "$NATS_RELEASE" -n "$NAMESPACE" --wait
else
  log "  NATS release '$NATS_RELEASE' not found."
fi

# ── Step 3: delete K8s app manifests ─────────────────────────────────────
log "Step 3/6: Deleting K8s app manifests (api/brain/ingress/services/secret) ..."
  for kind_name in \
    ingress/primus-claw \
    deployment/primus-claw-api \
    deployment/primus-claw-brain \
    service/primus-claw-api \
    service/primus-claw-brain \
    service/primus-claw-brain-headless \
    secret/primus-claw-secrets \
    configmap/claw-config; do
  if kubectl get "$kind_name" -n "$NAMESPACE" >/dev/null 2>&1; then
    run kubectl delete "$kind_name" -n "$NAMESPACE" --ignore-not-found --wait=false
  fi
done

# ── Step 4: delete PVCs (NATS JetStream + any leftover Crunchy data/backup) ─
log "Step 4/6: Deleting PVCs in $NAMESPACE ..."
PVCS=$(kubectl get pvc -n "$NAMESPACE" -o name 2>/dev/null || true)
if [[ -n "$PVCS" ]]; then
  while IFS= read -r pvc; do
    [[ -z "$pvc" ]] && continue
    run kubectl delete "$pvc" -n "$NAMESPACE" --wait=false
  done <<< "$PVCS"
else
  log "  No PVCs in $NAMESPACE."
fi

# ── Step 5: uninstall PGO operator (optional) ────────────────────────────
if ! $KEEP_PGO; then
  log "Step 5/6: Uninstalling PGO helm release '$PGO_RELEASE' (if present) ..."
  if helm status "$PGO_RELEASE" -n "$NAMESPACE" >/dev/null 2>&1; then
    run helm uninstall "$PGO_RELEASE" -n "$NAMESPACE" --wait
  else
    log "  PGO release '$PGO_RELEASE' not found."
  fi
else
  log "Step 5/6: PGO uninstall skipped (--keep-pgo)."
fi

# ── Step 6: delete the namespace ─────────────────────────────────────────
if ! $KEEP_NS; then
  log "Step 6/6: Waiting briefly for resources to drain, then deleting namespace ..."
  if $YES; then
    SECONDS_WAITED=0
    REMAINING=0
    while [[ $SECONDS_WAITED -lt $WAIT_TIMEOUT ]]; do
      REMAINING=$(kubectl get pods,pvc -n "$NAMESPACE" --no-headers 2>/dev/null | wc -l)
      [[ "$REMAINING" -eq 0 ]] && break
      sleep 5
      SECONDS_WAITED=$((SECONDS_WAITED + 5))
    done
    [[ "$REMAINING" -ne 0 ]] && warn "Namespace still has $REMAINING resources after ${WAIT_TIMEOUT}s; deleting anyway."
  fi
  run kubectl delete namespace "$NAMESPACE" --ignore-not-found

  # Bottom-of-the-barrel fallback: if the namespace stays in
  # Terminating (a stray CR with a dangling finalizer for an operator
  # we already uninstalled), force-clear its kubernetes finalizer via
  # the /finalize subresource. Requires jq.
  if $YES; then
    SECONDS_WAITED=0
    while [[ $SECONDS_WAITED -lt $WAIT_TIMEOUT ]]; do
      kubectl get ns "$NAMESPACE" >/dev/null 2>&1 || break
      sleep 5
      SECONDS_WAITED=$((SECONDS_WAITED + 5))
    done
    if kubectl get ns "$NAMESPACE" >/dev/null 2>&1; then
      warn "Namespace still Terminating after ${WAIT_TIMEOUT}s — force-clearing namespace finalizers."
      if ! command -v jq >/dev/null 2>&1; then
        warn "  jq not found; cannot force-clear. Install jq or remove finalizers manually."
      else
        kubectl get ns "$NAMESPACE" -o json \
          | jq '.spec.finalizers = []' \
          | kubectl replace --raw "/api/v1/namespaces/$NAMESPACE/finalize" -f - >/dev/null
        log "  Finalizers cleared; namespace should disappear shortly."
      fi
    fi
  fi
else
  log "Step 6/6: Namespace delete skipped (--keep-ns)."
fi

log "================================================================"
if $YES; then
  log " Cleanup complete on context $CTX."
else
  log " Dry-run finished. Re-run with --yes to actually delete."
fi
log "================================================================"
