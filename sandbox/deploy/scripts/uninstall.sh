#!/bin/bash
# SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
# SPDX-License-Identifier: Apache-2.0

# uninstall.sh — Uninstall agent-sandbox (Helm-first)
#
# Usage:
#   ./uninstall.sh                           # helm uninstall + delete Sandbox CRs
#   DELETE_CRDS=true ./uninstall.sh          # also delete CRDs and namespace

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(dirname "${SCRIPT_DIR}")"
REPO_ROOT="$(dirname "${DEPLOY_DIR}")"
NAMESPACE="${NAMESPACE:-agent-sandbox-system}"
RELEASE="${RELEASE:-agent-sandbox}"

log()  { echo -e "\033[0;36m[INFO]\033[0m $*"; }
head() { echo -e "\n\033[1;33m=== $* ===\033[0m"; }

head "Uninstall agent-sandbox"

head "Delete Sandbox custom resources"
kubectl delete sandboxes       --all -A --ignore-not-found 2>/dev/null || true
kubectl delete sandboxclaims   --all -A --ignore-not-found 2>/dev/null || true
kubectl delete sandboxwarmpools --all -A --ignore-not-found 2>/dev/null || true
kubectl delete sandboxtemplates --all -A --ignore-not-found 2>/dev/null || true
kubectl delete codeinterpreters --all -A --ignore-not-found 2>/dev/null || true
kubectl delete clustersandboxpolicies --all --ignore-not-found 2>/dev/null || true

head "Helm uninstall"
helm uninstall "${RELEASE}" --namespace "${NAMESPACE}" 2>/dev/null \
    || log "helm release '${RELEASE}' not found (OK if it was installed some other way)"

head "Delete ancillary resources (ingress / runtimeclass / redis secret)"
kubectl delete -f "${DEPLOY_DIR}/k8s/deployments/ingress.yaml"   --ignore-not-found 2>/dev/null || true
kubectl delete -f "${DEPLOY_DIR}/k8s-kata/deployments/ingress.yaml" --ignore-not-found 2>/dev/null || true
kubectl delete -f "${DEPLOY_DIR}/k8s/kata/runtimeclass.yaml"     --ignore-not-found 2>/dev/null || true
kubectl delete secret agent-sandbox-redis -n "${NAMESPACE}" --ignore-not-found 2>/dev/null || true

if [[ "${DELETE_CRDS:-false}" == "true" ]]; then
    head "Delete CRDs (destructive)"
    kubectl delete -f "${DEPLOY_DIR}/crds/runtime/"       --ignore-not-found 2>/dev/null || true
    kubectl delete -f "${REPO_ROOT}/k8s/extensions.yaml"  --ignore-not-found 2>/dev/null || true
    kubectl delete -f "${REPO_ROOT}/k8s/crds/"            --ignore-not-found 2>/dev/null || true

    head "Delete namespace"
    kubectl delete namespace "${NAMESPACE}" --ignore-not-found
fi

head "✅ Uninstall complete"
if [[ "${DELETE_CRDS:-false}" != "true" ]]; then
    echo "  Note: CRDs and namespace preserved."
    echo "  Full wipe:  DELETE_CRDS=true ./deploy/scripts/uninstall.sh"
fi
