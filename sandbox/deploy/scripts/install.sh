#!/bin/bash
# SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
# SPDX-License-Identifier: Apache-2.0

# install.sh — One-shot installer for the agent-sandbox stack (CRDs + namespace + envd identity + Helm release with Redis)
#
# This is the validated path used on the the cluster: Helm chart provisions
# controlplane + Redis StatefulSet + Redis Secret atomically; CRDs and the envd
# router identity Secret are bootstrapped outside the chart.
#
# Usage:
#   REDIS_PASSWORD='YourStrongPass1234567890abcd' \
#   IMAGE_TAG=202605041641 \
#   REDIS_STORAGE_CLASS=local-path \
#   ./install.sh                               # default recommended example
#
# Env overrides (defaults shown):
#   NAMESPACE=agent-sandbox-system
#   RELEASE=agent-sandbox
#   IMAGE_REGISTRY=primussafe/
#   IMAGE_TAG=latest
#   IMAGE_PULL_SECRET=                        # name of pre-created docker-registry secret
#   REDIS_IMAGE_REPOSITORY=redis              # Docker Hub by default; override for private registry mirror
#   REDIS_IMAGE_TAG=7-alpine
#   REDIS_PASSWORD=                           # empty = auto-generate (or reuse existing)
#   REDIS_STORAGE_CLASS=                      # empty = auto-detect cluster default; fail-fast if none
#   REDIS_STORAGE_SIZE=20Gi
#   ENVD_KEY_SOURCE=regen                     # regen | copy | skip
#   ENVD_KEY_SRC_KUBECONFIG=                  # required when ENVD_KEY_SOURCE=copy
#   ENVD_KEY_SRC_NAMESPACE=agent-sandbox-system
#   INSTALL_RUNTIMECLASS=false                # apply Kata RuntimeClass (kata-qemu)
#   INSTALL_INGRESS=false                     # apply Higress Ingress
#   INGRESS_VARIANT=k8s                       # k8s (example) | k8s-kata (example)
#   INGRESS_HOST=                             # if set, sed-replaces the default host in ingress.yaml
#   INSTALL_DEFAULT_TEMPLATES=false           # apply CodeInterpreter examples
#   TEMPLATES_VARIANT=default                 # default | kata (both use default-templates.yaml)
#   SAFE_API_URL=                             # set to enable SaFE authentication (recommended)
#   ALLOW_INSECURE_NO_AUTH=false              # true = install WITHOUT auth (dev clusters only)
#   EGRESS_ENABLED=true                       # enable EnvD egress enforcement
#   EGRESS_EXTRA_BLOCKED_CIDRS=               # comma-separated additional CIDRs
#                                             # one of the two above MUST be provided
#   AUTO_INSTALL_HELM=true                    # auto-download helm to HELM_INSTALL_DIR if missing
#   HELM_VERSION=v3.14.0
#   HELM_INSTALL_DIR=$HOME/.local/bin
#   DRY_RUN=false

set -euo pipefail
# Ignore SIGPIPE so a closed/truncated stdout (e.g. output captured by a wrapper)
# turns writes into EPIPE errors instead of killing the installer mid-step.
trap '' PIPE

# ── Config ────────────────────────────────────────────────────────────────────
NAMESPACE="${NAMESPACE:-agent-sandbox-system}"
RELEASE="${RELEASE:-agent-sandbox}"
IMAGE_REGISTRY="${IMAGE_REGISTRY:-primussafe/}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
IMAGE_PULL_SECRET="${IMAGE_PULL_SECRET:-}"
REDIS_IMAGE_REPOSITORY="${REDIS_IMAGE_REPOSITORY:-redis}"
REDIS_IMAGE_TAG="${REDIS_IMAGE_TAG:-7-alpine@sha256:e7723ff73d963f5cc6d9c4643ea3d989527a402a319239054e9472a7fb9219a2}"
REDIS_PASSWORD="${REDIS_PASSWORD:-}"
REDIS_STORAGE_CLASS="${REDIS_STORAGE_CLASS:-}"
REDIS_STORAGE_SIZE="${REDIS_STORAGE_SIZE:-20Gi}"
ENVD_KEY_SOURCE="${ENVD_KEY_SOURCE:-regen}"
ENVD_KEY_SRC_KUBECONFIG="${ENVD_KEY_SRC_KUBECONFIG:-}"
ENVD_KEY_SRC_NAMESPACE="${ENVD_KEY_SRC_NAMESPACE:-agent-sandbox-system}"
INSTALL_RUNTIMECLASS="${INSTALL_RUNTIMECLASS:-false}"
INSTALL_INGRESS="${INSTALL_INGRESS:-false}"
INGRESS_VARIANT="${INGRESS_VARIANT:-k8s}"
INGRESS_HOST="${INGRESS_HOST:-}"
INSTALL_DEFAULT_TEMPLATES="${INSTALL_DEFAULT_TEMPLATES:-false}"
TEMPLATES_VARIANT="${TEMPLATES_VARIANT:-default}"
AUTO_INSTALL_HELM="${AUTO_INSTALL_HELM:-true}"
HELM_VERSION="${HELM_VERSION:-v3.14.0}"
HELM_SHA256="${HELM_SHA256:-}"
HELM_INSTALL_DIR="${HELM_INSTALL_DIR:-${HOME}/.local/bin}"
DRY_RUN="${DRY_RUN:-false}"
EGRESS_ENABLED="${EGRESS_ENABLED:-true}"
EGRESS_EXTRA_BLOCKED_CIDRS="${EGRESS_EXTRA_BLOCKED_CIDRS:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(dirname "${SCRIPT_DIR}")"
REPO_ROOT="$(dirname "${DEPLOY_DIR}")"
CHART_DIR="${DEPLOY_DIR}/helm"
CORE_CRD_DIR="${REPO_ROOT}/k8s/crds"
RUNTIME_CRD_DIR="${DEPLOY_DIR}/crds/runtime"
NAMESPACE_YAML="${DEPLOY_DIR}/k8s/namespace.yaml"

GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log()  { echo -e "${CYAN}[INFO]${NC} $*"; }
ok()   { echo -e "${GREEN}[OK]${NC}   $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
err()  { echo -e "${RED}[ERR]${NC}  $*"; exit 1; }
section() { echo -e "\n${YELLOW}════════ $* ════════${NC}"; }

# Run cmd or print under DRY_RUN
run() {
    if [[ "${DRY_RUN}" == "true" ]]; then
        echo "  [dry-run] $*"
    else
        eval "$@"
    fi
}

# Download helm v3 to a user-writable dir when not on PATH
ensure_helm() {
    if command -v helm >/dev/null 2>&1; then return 0; fi
    [[ "${DRY_RUN}" != "true" ]] || err "helm is required for dry-run preview; refusing to download tools"
    [[ "${AUTO_INSTALL_HELM}" == "true" ]] || err "helm not found (install helm v3 or set AUTO_INSTALL_HELM=true)"
    local arch tarball url tmpdir checksum
    case "$(uname -m)" in
        x86_64|amd64) arch="amd64" ;;
        aarch64|arm64) arch="arm64" ;;
        *) err "unsupported arch $(uname -m) for helm auto-install" ;;
    esac
    tarball="helm-${HELM_VERSION}-linux-${arch}.tar.gz"
    checksum="${HELM_SHA256}"
    if [[ -z "${checksum}" && "${HELM_VERSION}" == "v3.14.0" ]]; then
        case "${arch}" in
            amd64) checksum="f43e1c3387de24547506ab05d24e5309c0ce0b228c23bd8aa64e9ec4b8206651" ;;
            arm64) checksum="b29e61674731b15f6ad3d1a3118a99d3cc2ab25a911aad1b8ac8c72d5a9d2952" ;;
        esac
    fi
    [[ -n "${checksum}" ]] || err "no Helm checksum for ${HELM_VERSION}/${arch}; set HELM_SHA256"
    url="https://get.helm.sh/${tarball}"
    tmpdir="$(mktemp -d)"
    log "downloading helm ${HELM_VERSION} (${arch}) to ${HELM_INSTALL_DIR}/helm ..."
    curl -fsSL "${url}" -o "${tmpdir}/${tarball}" \
        || err "failed to download helm from ${url}"
    printf '%s  %s\n' "${checksum}" "${tmpdir}/${tarball}" | sha256sum -c - >/dev/null \
        || err "Helm archive checksum verification failed"
    tar -xzf "${tmpdir}/${tarball}" -C "${tmpdir}"
    mkdir -p "${HELM_INSTALL_DIR}"
    install -m 0755 "${tmpdir}/linux-${arch}/helm" "${HELM_INSTALL_DIR}/helm"
    rm -rf "${tmpdir}"
    export PATH="${HELM_INSTALL_DIR}:${PATH}"
    command -v helm >/dev/null || err "helm still not on PATH after install (PATH=${PATH})"
    ok "helm installed: $(helm version --short 2>&1 | command head -1)"
}

# ── Idempotency guard: skip when Sandbox is already installed ─────────────────
# Re-running against an existing Helm release can fail on immutable StatefulSet
# fields (e.g. redis volumeClaimTemplates.storageClassName when the StorageClass
# changed). Treat Sandbox as installed only when its controlplane Deployment is
# Ready, so a half-broken install is still repaired. FORCE_SANDBOX=1 overrides.
FORCE_SANDBOX="${FORCE_SANDBOX:-false}"
if command -v kubectl >/dev/null 2>&1 \
   && [[ "${FORCE_SANDBOX}" != "1" && "${FORCE_SANDBOX}" != "true" && "${DRY_RUN}" != "true" ]]; then
    DEPLOY_STATE="$(kubectl -n "${NAMESPACE}" get deploy agent-sandbox-controlplane \
        -o jsonpath='{.metadata.labels.app\.kubernetes\.io/managed-by}|{.metadata.labels.app\.kubernetes\.io/instance}|{.spec.replicas}|{.status.readyReplicas}' \
        2>/dev/null || true)"
    REDIS_STATE="$(kubectl -n "${NAMESPACE}" get statefulset redis \
        -o jsonpath='{.spec.replicas}|{.status.readyReplicas}' 2>/dev/null || true)"
    IFS='|' read -r MANAGED_BY INSTANCE DESIRED READY_REPLICAS <<<"${DEPLOY_STATE}"
    IFS='|' read -r REDIS_DESIRED REDIS_READY <<<"${REDIS_STATE}"
    if [[ "${MANAGED_BY}" == "Helm" \
       && "${INSTANCE}" == "${RELEASE}" \
       && "${DESIRED}" =~ ^[1-9][0-9]*$ \
       && "${READY_REPLICAS}" == "${DESIRED}" \
       && "${REDIS_DESIRED}" =~ ^[1-9][0-9]*$ \
       && "${REDIS_READY}" == "${REDIS_DESIRED}" ]] \
       && kubectl -n "${NAMESPACE}" get secret agent-sandbox-redis >/dev/null 2>&1; then
        ok "Sandbox Helm release ${RELEASE} is fully ready in ${NAMESPACE} — skipping (set FORCE_SANDBOX=1 to reinstall)"
        exit 0
    fi
fi

# ── Step 0: Preflight ─────────────────────────────────────────────────────────
section "Step 0: Preflight"
command -v kubectl >/dev/null || err "kubectl not found"
if [[ "${DRY_RUN}" != "true" ]]; then
    command -v openssl >/dev/null || err "openssl not found"
    command -v curl    >/dev/null || err "curl not found (needed to auto-install helm)"
fi
ensure_helm
kubectl cluster-info >/dev/null 2>&1 || err "kubectl cannot reach cluster, check kubeconfig/context"

CTX="$(kubectl config current-context 2>/dev/null || echo '<unknown>')"

# If a redis StatefulSet already exists, its volumeClaimTemplates.storageClassName
# is immutable — reuse the deployed value and ignore the requested one so re-runs
# never attempt a forbidden StatefulSet patch. Only brand-new installs use the
# requested (unified) REDIS_STORAGE_CLASS.
REDIS_SC_FROM_LIVE=false
if [[ "${DRY_RUN}" != "true" ]] && kubectl -n "${NAMESPACE}" get statefulset redis >/dev/null 2>&1; then
    EXISTING_REDIS_SC="$(kubectl -n "${NAMESPACE}" get statefulset redis \
        -o jsonpath='{.spec.volumeClaimTemplates[0].spec.storageClassName}' 2>/dev/null || true)"
    if [[ -n "${REDIS_STORAGE_CLASS}" && "${REDIS_STORAGE_CLASS}" != "${EXISTING_REDIS_SC}" ]]; then
        warn "redis already deployed with storageClassName='${EXISTING_REDIS_SC:-<unset>}'; keeping it, ignoring requested '${REDIS_STORAGE_CLASS}' (StatefulSet volumeClaimTemplates are immutable)"
    else
        log "redis already deployed; keeping its storageClassName='${EXISTING_REDIS_SC:-<unset>}'"
    fi
    REDIS_STORAGE_CLASS="${EXISTING_REDIS_SC}"
    REDIS_SC_FROM_LIVE=true
fi

# Auto-detect default StorageClass when user did not pin one — new clusters often have none,
# in which case Redis PVC will hang in Pending forever.
if [[ -z "${REDIS_STORAGE_CLASS}" ]] && [[ "${DRY_RUN}" != "true" ]] && [[ "${REDIS_SC_FROM_LIVE}" != "true" ]]; then
    DEFAULT_SC="$(kubectl get sc -o jsonpath='{range .items[?(@.metadata.annotations.storageclass\.kubernetes\.io/is-default-class=="true")]}{.metadata.name}{"\n"}{end}' 2>/dev/null | command head -1)"
    if [[ -n "${DEFAULT_SC}" ]]; then
        REDIS_STORAGE_CLASS="${DEFAULT_SC}"
        log "Auto-detected default StorageClass: ${REDIS_STORAGE_CLASS}"
    else
        ALL_SC="$(kubectl get sc -o name 2>/dev/null | sed 's|storageclass.storage.k8s.io/||' | paste -sd ',' -)"
        warn "no default StorageClass found in cluster (available: ${ALL_SC:-<none>})"
        warn "Redis PVC will Pending — please rerun with REDIS_STORAGE_CLASS=<name>"
        err  "missing StorageClass blocks Redis StatefulSet; aborting before Helm install"
    fi
fi

# Fail-fast if the namespace already has a controlplane Deployment that is NOT helm-managed.
# This catches the case where a user previously ran "kubectl apply -f deploy/k8s/controlplane.yaml"
# (flat manifest path) — that path does not install Redis and pins a nodeSelector that breaks
# scheduling on clusters without the profile's configured node label.
if [[ "${DRY_RUN}" != "true" ]] && kubectl -n "${NAMESPACE}" get deploy agent-sandbox-controlplane >/dev/null 2>&1; then
    MANAGER="$(kubectl -n "${NAMESPACE}" get deploy agent-sandbox-controlplane \
                 -o jsonpath='{.metadata.labels.app\.kubernetes\.io/managed-by}' 2>/dev/null)"
    INSTANCE="$(kubectl -n "${NAMESPACE}" get deploy agent-sandbox-controlplane \
                  -o jsonpath='{.metadata.labels.app\.kubernetes\.io/instance}' 2>/dev/null)"
    if [[ "${MANAGER}" != "Helm" ]]; then
        warn "found agent-sandbox-controlplane Deployment NOT managed by Helm (managed-by='${MANAGER:-<none>}')"
        warn "this was likely created via 'kubectl apply -f deploy/k8s/controlplane.yaml' (flat manifest)"
        warn "the flat manifest does NOT install Redis and pins a nodeSelector that breaks new clusters"
        err  "clean up first: kubectl -n ${NAMESPACE} delete deploy,svc,sa,role,rolebinding -l 'app=agent-sandbox-controlplane' && kubectl delete clusterrole,clusterrolebinding agent-sandbox-controlplane"
    elif [[ -n "${INSTANCE}" && "${INSTANCE}" != "${RELEASE}" ]]; then
        err "controlplane Deployment owned by Helm release '${INSTANCE}', not '${RELEASE}'; either set RELEASE=${INSTANCE} or remove the conflicting release"
    fi
fi

log "Cluster context: ${CTX}"
log "Namespace:       ${NAMESPACE}"
log "Release:         ${RELEASE}"
log "Image:           ${IMAGE_REGISTRY}agent-sandbox-controlplane:${IMAGE_TAG}"
log "Envd injector:   ${IMAGE_REGISTRY}agent-sandbox-envd-injector:${IMAGE_TAG}"
log "Redis image:     ${REDIS_IMAGE_REPOSITORY}:${REDIS_IMAGE_TAG}"
log "Redis storage:   ${REDIS_STORAGE_SIZE} (class=${REDIS_STORAGE_CLASS:-<cluster-default>})"
log "Envd keys:       ${ENVD_KEY_SOURCE}"
log "Dry-run:         ${DRY_RUN}"

# ── Step 1: CRDs ──────────────────────────────────────────────────────────────
section "Step 1: Apply CRDs"
[[ -d "${CORE_CRD_DIR}"    ]] || err "missing ${CORE_CRD_DIR}"
[[ -d "${RUNTIME_CRD_DIR}" ]] || err "missing ${RUNTIME_CRD_DIR}"
run "kubectl apply -f \"${CORE_CRD_DIR}/\""
run "kubectl apply -f \"${RUNTIME_CRD_DIR}/\""

for c in sandboxes.agents.x-k8s.io \
         sandboxclaims.extensions.agents.x-k8s.io \
         sandboxtemplates.extensions.agents.x-k8s.io \
    sandboxwarmpools.extensions.agents.x-k8s.io \
         codeinterpreters.runtime.agent-sandbox.io \
         clustersandboxpolicies.runtime.agent-sandbox.io; do
    if [[ "${DRY_RUN}" != "true" ]]; then
        kubectl get crd "$c" >/dev/null 2>&1 || err "CRD $c not Established"
    fi
done
ok "6 CRDs Established"

# ── Step 2: Namespace ─────────────────────────────────────────────────────────
section "Step 2: Namespace"
if [[ "${DRY_RUN}" != "true" ]] && kubectl get ns "${NAMESPACE}" >/dev/null 2>&1; then
    ok "Namespace ${NAMESPACE} already exists"
else
    run "kubectl apply -f \"${NAMESPACE_YAML}\""
fi

# ── Step 3: envd-router-identity Secret ───────────────────────────────────────
section "Step 3: envd-router-identity Secret"
SECRET_EXISTS=false
if [[ "${DRY_RUN}" != "true" ]] && kubectl -n "${NAMESPACE}" get secret envd-router-identity >/dev/null 2>&1; then
    SECRET_EXISTS=true
fi

case "${ENVD_KEY_SOURCE}" in
    skip)
        if [[ "${SECRET_EXISTS}" == "true" ]]; then
            ok "envd-router-identity exists, skip"
        else
            warn "envd-router-identity missing and ENVD_KEY_SOURCE=skip — controlplane may degrade"
        fi
        ;;
    copy)
        [[ -n "${ENVD_KEY_SRC_KUBECONFIG}" ]] || err "ENVD_KEY_SOURCE=copy requires ENVD_KEY_SRC_KUBECONFIG"
        [[ -r "${ENVD_KEY_SRC_KUBECONFIG}" ]] || err "ENVD_KEY_SRC_KUBECONFIG=${ENVD_KEY_SRC_KUBECONFIG} not readable"
        TMP_SECRET="$(mktemp /tmp/envd-router-identity.XXXXXX.yaml)"
        # Strip cluster-bound fields so the manifest is portable
        kubectl --kubeconfig="${ENVD_KEY_SRC_KUBECONFIG}" \
            -n "${ENVD_KEY_SRC_NAMESPACE}" \
            get secret envd-router-identity -o yaml \
            | python3 -c "
import sys, yaml
d = yaml.safe_load(sys.stdin)
m = d.get('metadata', {})
for k in ('resourceVersion','uid','creationTimestamp','managedFields','ownerReferences'):
    m.pop(k, None)
m['namespace'] = '${NAMESPACE}'
print(yaml.safe_dump(d))
" > "${TMP_SECRET}" || err "failed to read source secret"
        run "kubectl apply -f \"${TMP_SECRET}\""
        rm -f "${TMP_SECRET}"
        ok "envd-router-identity copied from ${ENVD_KEY_SRC_KUBECONFIG}"
        ;;
    regen)
        if [[ "${SECRET_EXISTS}" == "true" ]]; then
            ok "envd-router-identity exists, regen skipped (delete it first to rotate)"
        elif [[ "${DRY_RUN}" == "true" ]]; then
            echo "  [dry-run] create secret envd-router-identity (RSA material not generated)"
        else
            TMP_PRIV="$(mktemp /tmp/envd-priv.XXXXXX.pem)"
            TMP_PUB="$(mktemp  /tmp/envd-pub.XXXXXX.pem)"
            # Either PEM encoding is fine: router/jwt.go reads PKCS#1 (BEGIN RSA
            # PRIVATE KEY, OpenSSL 1.x) and PKCS#8 (BEGIN PRIVATE KEY, the
            # OpenSSL 3.x default), so no conversion is needed here.
            openssl genrsa -out "${TMP_PRIV}" 2048 >/dev/null 2>&1
            openssl rsa -in "${TMP_PRIV}" -pubout -out "${TMP_PUB}" >/dev/null 2>&1
            kubectl -n "${NAMESPACE}" create secret generic envd-router-identity \
                --from-file=private.pem="${TMP_PRIV}" \
                --from-file=public.pem="${TMP_PUB}" \
                --dry-run=client -o yaml \
                | kubectl label --local -f - app=agent-sandbox component=router --dry-run=client -o yaml \
                | kubectl apply -f -
            rm -f "${TMP_PRIV}" "${TMP_PUB}"
            ok "envd-router-identity created (regen)"
        fi
        ;;
    *)
        err "unknown ENVD_KEY_SOURCE=${ENVD_KEY_SOURCE} (use regen|copy|skip)"
        ;;
esac

# ── Step 4: Helm install ──────────────────────────────────────────────────────
section "Step 4: Helm install/upgrade"
# Resolve / reuse Redis password
if [[ -z "${REDIS_PASSWORD}" ]] && [[ "${DRY_RUN}" != "true" ]]; then
    EXISTING="$(kubectl -n "${NAMESPACE}" get secret agent-sandbox-redis \
                  -o jsonpath='{.data.password}' 2>/dev/null | base64 -d 2>/dev/null || true)"
    if [[ -n "${EXISTING}" ]]; then
        REDIS_PASSWORD="${EXISTING}"
        log "Reusing existing Redis password from Secret"
    else
        REDIS_PASSWORD="$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | command head -c 32)"
        log "Generated new 32-char Redis password"
    fi
fi
[[ -n "${REDIS_PASSWORD}" ]] || REDIS_PASSWORD="dry-run-placeholder"
REDIS_VALUES_FILE="$(mktemp /tmp/agent-sandbox-redis-values.XXXXXX.json)"
chmod 600 "${REDIS_VALUES_FILE}"
REDIS_PASSWORD_FOR_VALUES="${REDIS_PASSWORD}" \
EGRESS_ENABLED_FOR_VALUES="${EGRESS_ENABLED}" \
EGRESS_CIDRS_FOR_VALUES="${EGRESS_EXTRA_BLOCKED_CIDRS}" \
python3 - "${REDIS_VALUES_FILE}" <<'PY'
import json
import os
import sys

enabled = os.environ["EGRESS_ENABLED_FOR_VALUES"].lower() == "true"
cidrs = ",".join(item.strip() for item in os.environ["EGRESS_CIDRS_FOR_VALUES"].split(",") if item.strip())
with open(sys.argv[1], "w", encoding="utf-8") as f:
    json.dump({
        "redis": {"password": os.environ["REDIS_PASSWORD_FOR_VALUES"]},
        "egress": {"enabled": enabled, "extraBlockedCIDRs": cidrs},
    }, f)
PY
trap 'rm -f "${REDIS_VALUES_FILE:-}"' EXIT

# Build helm --set args
HELM_ARGS=(
    upgrade --install "${RELEASE}" "${CHART_DIR}"
    --namespace "${NAMESPACE}"
    --values "${REDIS_VALUES_FILE}"
    --set "controlplane.image.repository=${IMAGE_REGISTRY}agent-sandbox-controlplane"
    --set "controlplane.image.tag=${IMAGE_TAG}"
    --set "controlplane.config.envdInjectorImage=${IMAGE_REGISTRY}agent-sandbox-envd-injector:${IMAGE_TAG}"
    --set "redis.deploy=true"
    --set "redis.secret.create=true"
    --set "redis.image.repository=${REDIS_IMAGE_REPOSITORY}"
    --set "redis.image.tag=${REDIS_IMAGE_TAG}"
    --set "redis.storage.size=${REDIS_STORAGE_SIZE}"
)
[[ -n "${REDIS_STORAGE_CLASS}" ]] && HELM_ARGS+=( --set "redis.storage.storageClassName=${REDIS_STORAGE_CLASS}" )
[[ -n "${IMAGE_PULL_SECRET}"   ]] && HELM_ARGS+=( --set "imagePullSecrets[0].name=${IMAGE_PULL_SECRET}" )
[[ -n "${SANDBOX_NODE_SELECTOR:-}" ]] && HELM_ARGS+=(
    --set-string "controlplane.config.sandboxNodeSelector=${SANDBOX_NODE_SELECTOR}"
)
if [[ -n "${SANDBOX_CONTROLPLANE_NODE_SELECTOR:-}" ]]; then
    if [[ "${SANDBOX_CONTROLPLANE_NODE_SELECTOR}" != *=* ]]; then
        err "SANDBOX_CONTROLPLANE_NODE_SELECTOR must use key=value syntax"
        exit 2
    fi
    CONTROLPLANE_SELECTOR_KEY="${SANDBOX_CONTROLPLANE_NODE_SELECTOR%%=*}"
    CONTROLPLANE_SELECTOR_VALUE="${SANDBOX_CONTROLPLANE_NODE_SELECTOR#*=}"
    CONTROLPLANE_SELECTOR_KEY="${CONTROLPLANE_SELECTOR_KEY//./\\.}"
    HELM_ARGS+=(
        --set-string "controlplane.nodeSelector.${CONTROLPLANE_SELECTOR_KEY}=${CONTROLPLANE_SELECTOR_VALUE}"
    )
fi

# ── Authentication posture (must be an explicit choice) ───────────────────────
#
# With auth disabled the Router and Workload Manager register no auth middleware
# at all, so anyone who can reach them can create sandboxes and execute code
# inside them. The control plane refuses to start in that state unless the risk is
# acknowledged, and this installer will not pick a side on the operator's behalf.
if [[ -n "${SAFE_API_URL:-}" ]]; then
    HELM_ARGS+=(
        --set "router.config.enableAuth=true"
        --set "router.config.safeApiUrl=${SAFE_API_URL}"
        --set "workloadmanager.config.enableAuth=true"
        --set "workloadmanager.config.safeApiUrl=${SAFE_API_URL}"
    )
    ok "authentication ENABLED against ${SAFE_API_URL}"
elif [[ "${ALLOW_INSECURE_NO_AUTH:-false}" == "true" ]]; then
    HELM_ARGS+=( --set "security.allowInsecureNoAuth=true" )
    warn "authentication DISABLED (ALLOW_INSECURE_NO_AUTH=true)."
    warn "Any client that can reach the Router can create sandboxes and run code in them."
    warn "Use this only on an isolated development cluster."
else
    err "refusing to install without an explicit authentication choice.
    Either enable authentication:
        SAFE_API_URL=https://<your-safe-api> $0
    or acknowledge an unauthenticated development install:
        ALLOW_INSECURE_NO_AUTH=true $0
    See the 'Production hardening' section of sandbox/README.md."
fi

# Run helm with retries. Output is teed to a log so the real helm exit code is
# read from PIPESTATUS (independent of pipefail / a broken downstream pipe),
# and the log can be dumped for diagnosis on final failure.
helm_install() {
    local attempt=1 max="${HELM_MAX_ATTEMPTS:-3}" rc=0 logf
    logf="$(mktemp /tmp/helm-install.XXXXXX.log)"
    while (( attempt <= max )); do
        set +e +o pipefail
        helm "${HELM_ARGS[@]}" 2>&1 | tee "${logf}"
        rc=${PIPESTATUS[0]}
        set -e -o pipefail
        if [[ ${rc} -eq 0 ]]; then
            rm -f "${logf}"
            return 0
        fi
        warn "helm attempt ${attempt}/${max} failed (rc=${rc})"
        (( attempt < max )) && { warn "retrying in 5s ..."; sleep 5; }
        attempt=$(( attempt + 1 ))
    done
    warn "helm install failed after ${max} attempt(s) — last output:"
    tail -40 "${logf}" 2>/dev/null | sed 's/^/    /' || true
    rm -f "${logf}"
    return 1
}

if [[ "${DRY_RUN}" == "true" ]]; then
    echo "  [dry-run] helm ${HELM_ARGS[*]}"
else
    helm_install || err "helm upgrade/install failed; see error above"
fi
ok "Helm release ${RELEASE} applied"

# Verify Redis resources actually rendered (catches silent chart-template issues)
if [[ "${DRY_RUN}" != "true" ]]; then
    if ! kubectl -n "${NAMESPACE}" get sts redis >/dev/null 2>&1; then
        warn "redis StatefulSet NOT found after helm install — chart may not have rendered redis.yaml"
        log  "current helm release values:"
        helm -n "${NAMESPACE}" get values "${RELEASE}" 2>&1 | sed 's/^/    /'
        err  "redis missing — verify redis.deploy=true was propagated"
    fi
    if ! kubectl -n "${NAMESPACE}" get svc redis >/dev/null 2>&1; then
        err "redis Service NOT found after helm install"
    fi
    if ! kubectl -n "${NAMESPACE}" get secret agent-sandbox-redis >/dev/null 2>&1; then
        err "Secret agent-sandbox-redis NOT found after helm install"
    fi
    ok "redis StatefulSet + Service + Secret confirmed"
fi

# Dump diagnostic info for a failed rollout: PVC state, recent events, pod status
diagnose_ns() {
    warn "── Diagnostic dump for ns=${NAMESPACE} ──"
    kubectl -n "${NAMESPACE}" get pvc           2>&1 | sed 's/^/  pvc:   /'
    kubectl -n "${NAMESPACE}" get pods -o wide  2>&1 | sed 's/^/  pods:  /'
    kubectl -n "${NAMESPACE}" get events --sort-by=.lastTimestamp 2>&1 \
        | tail -20 | sed 's/^/  evt:   /'
}

# ── Step 5: Wait for readiness ────────────────────────────────────────────────
section "Step 5: Wait for readiness"
if [[ "${DRY_RUN}" == "true" ]]; then
    echo "  [dry-run] skip rollout wait"
else
    log "controlplane rollout ..."
    if ! kubectl -n "${NAMESPACE}" rollout status deploy/agent-sandbox-controlplane --timeout=300s; then
        diagnose_ns
        err "controlplane not Ready in 5m — see diagnostic dump above"
    fi
    log "redis rollout ..."
    if ! kubectl -n "${NAMESPACE}" rollout status statefulset/redis --timeout=300s; then
        diagnose_ns
        err "redis not Ready in 5m — common causes: (a) PVC Pending (no working StorageClass), (b) image pull (set REDIS_IMAGE_REPOSITORY to a reachable mirror)"
    fi
    ok "all workloads Ready"
fi

# ── Step 6: Smoke test ────────────────────────────────────────────────────────
section "Step 6: Smoke test"
if [[ "${DRY_RUN}" == "true" ]]; then
    echo "  [dry-run] skip smoke test"
else
    set +e
    SMOKE="$(kubectl -n "${NAMESPACE}" run smoke-$$ --rm -i --restart=Never \
        --image=curlimages/curl:latest@sha256:7c12af72ceb38b7432ab85e1a265cff6ae58e06f95539d539b654f2cfa64bb13 --timeout=30s -- \
        curl -sf -m 5 http://workloadmanager:8080/healthz 2>&1)"
    RC=$?
    set -e
    if [[ ${RC} -eq 0 ]]; then
        ok "workloadmanager:8080/healthz reachable: ${SMOKE}"
    else
        warn "smoke test rc=${RC} — check: kubectl -n ${NAMESPACE} logs deploy/agent-sandbox-controlplane"
    fi
fi

# ── Step 7: RuntimeClass kata-qemu (optional) ─────────────────────────────────
section "Step 7: RuntimeClass kata-qemu (optional)"
RUNTIMECLASS_YAML="${DEPLOY_DIR}/k8s/kata/runtimeclass.yaml"
if [[ "${INSTALL_RUNTIMECLASS}" == "true" ]]; then
    [[ -f "${RUNTIMECLASS_YAML}" ]] || err "missing ${RUNTIMECLASS_YAML}"
    run "kubectl apply -f \"${RUNTIMECLASS_YAML}\""
    ok "RuntimeClass kata-qemu applied (worker nodes still need: bash ${SCRIPT_DIR}/install-kata.sh)"
else
    log "skipped (INSTALL_RUNTIMECLASS=false)"
fi

# ── Step 8: Higress Ingress (optional) ────────────────────────────────────────
section "Step 8: Higress Ingress (optional)"
case "${INGRESS_VARIANT}" in
    k8s)    INGRESS_YAML="${DEPLOY_DIR}/k8s/deployments/ingress.yaml" ;;
    k8s-kata) INGRESS_YAML="${DEPLOY_DIR}/k8s-kata/deployments/ingress.yaml" ;;
    *)      err "unknown INGRESS_VARIANT=${INGRESS_VARIANT} (use k8s|k8s-kata)" ;;
esac
if [[ "${INSTALL_INGRESS}" == "true" ]]; then
    [[ -f "${INGRESS_YAML}" ]] || err "missing ${INGRESS_YAML}"
    TMP_ING="$(mktemp /tmp/sandbox-ingress.XXXXXX.yaml)"
    cp "${INGRESS_YAML}" "${TMP_ING}"
    if [[ -n "${INGRESS_HOST}" ]]; then
        # Rewrite the only host field in the manifest to the user-provided one
        sed -i "s|host: .*|host: ${INGRESS_HOST}|g" "${TMP_ING}"
        log "rewrote ingress host -> ${INGRESS_HOST}"
    fi
    run "kubectl apply -f \"${TMP_ING}\""
    rm -f "${TMP_ING}"
    ok "Ingress applied (variant=${INGRESS_VARIANT})"
else
    log "skipped (INSTALL_INGRESS=false)"
fi

# ── Step 9: Default CodeInterpreter templates (optional) ──────────────────────
section "Step 9: Default CodeInterpreter templates (optional)"
case "${TEMPLATES_VARIANT}" in
    default) TEMPLATES_YAML="${DEPLOY_DIR}/examples/default-templates.yaml" ;;
    kata)    TEMPLATES_YAML="${DEPLOY_DIR}/examples/default-templates.yaml" ;;
    *)       err "unknown TEMPLATES_VARIANT=${TEMPLATES_VARIANT} (use default|kata)" ;;
esac
if [[ "${INSTALL_DEFAULT_TEMPLATES}" == "true" ]]; then
    [[ -f "${TEMPLATES_YAML}" ]] || err "missing ${TEMPLATES_YAML}"
    run "kubectl apply -f \"${TEMPLATES_YAML}\""
    ok "Default CodeInterpreter templates applied (variant=${TEMPLATES_VARIANT})"
else
    log "skipped (INSTALL_DEFAULT_TEMPLATES=false)"
fi

# ── Done ──────────────────────────────────────────────────────────────────────
section "Install complete"
cat <<EOF

  Resources installed:
    - 6 CRDs (sandboxes / sandboxclaims / sandboxtemplates / sandboxwarmpools / codeinterpreters / clustersandboxpolicies)
    - Namespace ${NAMESPACE}
    - Secret envd-router-identity (mode=${ENVD_KEY_SOURCE})
    - Helm release ${RELEASE}:
        Deployment   agent-sandbox-controlplane
        Service      workloadmanager:8080
        Service      agent-sandbox-router:8080
        StatefulSet  redis (${REDIS_STORAGE_SIZE})
        Service      redis:6379
        Secret       agent-sandbox-redis
    - RuntimeClass kata-qemu     (INSTALL_RUNTIMECLASS=${INSTALL_RUNTIMECLASS})
    - Higress Ingress            (INSTALL_INGRESS=${INSTALL_INGRESS}, variant=${INGRESS_VARIANT})
    - Default templates          (INSTALL_DEFAULT_TEMPLATES=${INSTALL_DEFAULT_TEMPLATES}, variant=${TEMPLATES_VARIANT})

  Notes:
    - Kata RuntimeClass alone is harmless; runtime binaries still require: sudo bash ${SCRIPT_DIR}/install-kata.sh (per worker node)
    - Ingress requires Higress controller in the cluster; override host via INGRESS_HOST=<fqdn>

  Uninstall:
    DELETE_CRDS=true bash ${SCRIPT_DIR}/uninstall.sh
EOF
