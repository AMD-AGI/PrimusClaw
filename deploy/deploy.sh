#!/usr/bin/env bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

# One-click installer for a standalone PrimusClaw stack:
#   1. agent-sandbox (sandbox/)         required
#   2. LiteLLM gateway (deploy/litellm/) optional
#   3. Claw API/Brain (claw/deploy/)     required
#
# By default this prints the plan and refuses to mutate the cluster. Pass
# --yes to execute, or --dry-run to ask each child installer for a preview.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# This orchestrator lives in deploy/; child installers are addressed relative
# to the repo root above it (sandbox/, deploy/litellm/, claw/deploy/).
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

YES=false
DRY_RUN=false
DEPLOY_SANDBOX=true
DEPLOY_LITELLM=true
DEPLOY_CLAW=true
SKIP_SANDBOX_CHECK=false
SKIP_LITELLM_HEALTH=false
INSECURE_SANDBOX=false
CONFIG_FILE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --yes) YES=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    --skip-litellm) DEPLOY_LITELLM=false; shift ;;
    --skip-sandbox-check) SKIP_SANDBOX_CHECK=true; shift ;;
    --skip-litellm-health) SKIP_LITELLM_HEALTH=true; shift ;;
    --insecure-sandbox) INSECURE_SANDBOX=true; shift ;;
    --config)
      [ $# -ge 2 ] && [ -n "$2" ] || { echo "--config requires a path" >&2; exit 2; }
      CONFIG_FILE="$2"
      shift 2 ;;
    --config=*) CONFIG_FILE="${1#*=}"; shift ;;
    --help|-h)
      cat <<'HELP'
Usage:
  bash deploy/deploy.sh --yes

Flags:
  --dry-run              Preview child deploys where supported
  --yes                  Required for real cluster mutations
  --skip-litellm         Skip optional LiteLLM; Sandbox and Claw always deploy
  --skip-sandbox-check   Skip Sandbox check.sh
  --skip-litellm-health  Skip LiteLLM in-cluster health probe
  --insecure-sandbox     Explicitly deploy Sandbox without authentication (dev only)
  --config <path>        Load a non-secret deployment profile

Profile:
  DEPLOY_PROFILE_FILE=/path/to/deploy.env
  --config takes precedence over DEPLOY_PROFILE_FILE. Existing exported
  environment variables take precedence over values in the profile.

Common env:
  KUBECONFIG
  NAMESPACE=primus-claw  # unified namespace for Claw + LiteLLM (Sandbox uses SANDBOX_NAMESPACE)
  STORAGE_CLASS          # if unset, prompted interactively from `kubectl get sc`
  DOMAIN

Sandbox env:
  SANDBOX_NAMESPACE=agent-sandbox-system
  SANDBOX_IMAGE_REGISTRY=docker.io/primussafe/
  SANDBOX_IMAGE_TAG=latest
  SAFE_API_URL=https://<safe-api>       # required unless --insecure-sandbox
  SANDBOX_EGRESS_ENABLED=true
  SANDBOX_EGRESS_EXTRA_BLOCKED_CIDRS=10.0.0.0/8,192.168.0.0/16

LiteLLM env (deployed AFTER Claw so it can reuse Claw's PGO database):
  LITELLM_NAMESPACE=<NAMESPACE>        # defaults to $NAMESPACE (shares Claw's namespace)
  LITELLM_DATABASE_URL=...             # optional; if unset, auto-discovers the PGO PostgresCluster in LITELLM_NAMESPACE, else prompts (TTY)
  LITELLM_VALUES_FILE=/path/private-values.yaml
  LITELLM_INGRESS_HOST=<host>          # optional; enables ingress when set
  # Interactive (TTY only): prompts to add an anthropic/openai provider and auto-discovers its models
  # glm-5.3: copy deploy/litellm/values.glm53.example.yaml, set api_base to the
  # cluster OpenAI-compatible /v1 URL, then pass that copy as LITELLM_VALUES_FILE.
  # Skip the interactive /models prompt so it does not overwrite that modelList.

Claw env:
  CLAW_NAMESPACE=<NAMESPACE>          # defaults to $NAMESPACE
  CLAW_REGISTRY=docker.io/primussafe
  CLAW_TAG=<tag>                      # optional; default "latest" (pulled from CLAW_REGISTRY)
  LLM_API_STYLE=anthropic|openai      # explicit Brain wire protocol
  PG_SSL_NO_VERIFY=true               # keep api's PG connection encrypted but skip
                                      # server-cert validation; required against a
                                      # PGO database, whose CA no trust store carries
  ANTHROPIC_BASE_URL / OPENAI_BASE_URL # only with --skip-litellm; else Claw targets https://$DOMAIN/llm-gateway.
                                       # If unset with --skip-litellm on a TTY, you'll be prompted (BYOK: no server key stored).

Multi-node GPU clusters are provisioned through the SaFE Workload API, so
CLAW_DEPLOY_MODE must be `safe`; any other mode rejects multi-node requests.
They also need the SaFE Workspace to declare shared storage, mounted at the same
absolute path in the sandbox and every GPU pod: a run writes its profiles and
traces there and reads them back on the next round. SaFE mounts those volumes and
supplies the paths, so this deployment configures nothing for it -- there is no
multi-node setting here beyond the workload timeout.
HELP
      exit 0 ;;
    *) echo "Unknown flag: $1" >&2; exit 2 ;;
  esac
done

# Profiles configure environments, not command behavior. Preserve every CLI
# decision across the source operation even though these variables are not
# exported process environment.
CLI_YES="$YES"
CLI_DRY_RUN="$DRY_RUN"
CLI_DEPLOY_SANDBOX="$DEPLOY_SANDBOX"
CLI_DEPLOY_LITELLM="$DEPLOY_LITELLM"
CLI_DEPLOY_CLAW="$DEPLOY_CLAW"
CLI_SKIP_SANDBOX_CHECK="$SKIP_SANDBOX_CHECK"
CLI_SKIP_LITELLM_HEALTH="$SKIP_LITELLM_HEALTH"
CLI_INSECURE_SANDBOX="$INSECURE_SANDBOX"
CLI_SCRIPT_DIR="$SCRIPT_DIR"
CLI_REPO_ROOT="$REPO_ROOT"
source "$SCRIPT_DIR/profile-loader.sh"
load_deploy_profile "$CONFIG_FILE" || {
  profile_rc=$?
  exit "$profile_rc"
}
profile_control_error=false
for key in \
  YES DRY_RUN DEPLOY_SANDBOX DEPLOY_LITELLM DEPLOY_CLAW \
  SKIP_SANDBOX_CHECK SKIP_LITELLM_HEALTH INSECURE_SANDBOX \
  SCRIPT_DIR REPO_ROOT; do
  cli_key="CLI_$key"
  if [ "${!key}" != "${!cli_key}" ]; then
    echo "ERROR: deployment profile must not set command/internal variable $key" >&2
    profile_control_error=true
  fi
done
[ "$profile_control_error" = "false" ] || exit 2
YES="$CLI_YES"
DRY_RUN="$CLI_DRY_RUN"
DEPLOY_SANDBOX="$CLI_DEPLOY_SANDBOX"
DEPLOY_LITELLM="$CLI_DEPLOY_LITELLM"
DEPLOY_CLAW="$CLI_DEPLOY_CLAW"
SKIP_SANDBOX_CHECK="$CLI_SKIP_SANDBOX_CHECK"
SKIP_LITELLM_HEALTH="$CLI_SKIP_LITELLM_HEALTH"
INSECURE_SANDBOX="$CLI_INSECURE_SANDBOX"
readonly SCRIPT_DIR REPO_ROOT

if [ "$INSECURE_SANDBOX" = "true" ] && [ -n "${SAFE_API_URL:-}" ]; then
  echo "ERROR: --insecure-sandbox cannot be combined with SAFE_API_URL" >&2
  exit 2
fi
if [ "$DEPLOY_SANDBOX" = "true" ] \
   && [ "$INSECURE_SANDBOX" != "true" ] \
   && [ -z "${SAFE_API_URL:-}" ]; then
  echo "ERROR: Sandbox authentication must be explicit." >&2
  echo "Set SAFE_API_URL=https://<safe-api>, or use --insecure-sandbox for an isolated development cluster." >&2
  exit 2
fi

DEPLOY_SANDBOX=true
DEPLOY_CLAW=true

log() { echo "[one-click] $(date +%H:%M:%S) $*"; }
fail() { echo "[one-click] ERROR: $*" >&2; exit 1; }

# ── StorageClass selection ───────────────────────────────────────
# Picks the StorageClass used by Redis (sandbox) + Postgres/PVCs (Claw).
# Honors an explicit STORAGE_CLASS env; otherwise lists `kubectl get sc` and
# prompts. Non-interactive (no TTY) falls back to the cluster default SC (or
# the first listed); an empty listing leaves the choice to child defaults.
select_storage_class() {
  if [ -n "${STORAGE_CLASS:-}" ]; then
    log "storage class: $STORAGE_CLASS (from env)"
    return 0
  fi

  local names default_sc
  names="$(kubectl get sc --no-headers 2>/dev/null | awk '{print $1}' || true)"
  if [ -z "$names" ]; then
    log "WARN: no StorageClass found via 'kubectl get sc'; child scripts use their own defaults."
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
  log "storage class: $STORAGE_CLASS"
}

# ── Claw LLM endpoint (only when LiteLLM is NOT deployed) ────────────────
# With LiteLLM deployed, Claw targets the in-cluster gateway (https://DOMAIN/
# llm-gateway). With --skip-litellm there is no gateway, so Claw's
# ANTHROPIC_BASE_URL/OPENAI_BASE_URL must point at a real provider endpoint.
# Prompt for provider + base URL (TTY only) unless already set via env. Claw is
# BYOK: no provider key is stored — end users pass their own key per request.

# Derive the provider's models endpoint from its configured base URL.
derive_byok_models_url() {
  local base="${1%/}"
  case "$base" in
    */models) printf '%s\n' "$base" ;;
    */v1)     printf '%s/models\n' "$base" ;;
    *)        printf '%s/v1/models\n' "$base" ;;
  esac
}

configure_claw_llm_interactive() {
  [ "$DEPLOY_CLAW" = "true" ]      || return 0
  [ "$DEPLOY_LITELLM" != "true" ]  || return 0   # gateway will be deployed
  if [ -n "${ANTHROPIC_BASE_URL:-}" ] || [ -n "${OPENAI_BASE_URL:-}" ]; then
    local ptype="${LLM_API_STYLE:-}" purl
    if [ -z "$ptype" ]; then
      if [ -n "${ANTHROPIC_BASE_URL:-}" ] && [ -z "${OPENAI_BASE_URL:-}" ]; then
        ptype="anthropic"
      elif [ -n "${OPENAI_BASE_URL:-}" ] && [ -z "${ANTHROPIC_BASE_URL:-}" ]; then
        ptype="openai"
      else
        fail "LLM_API_STYLE is required when both ANTHROPIC_BASE_URL and OPENAI_BASE_URL are set"
      fi
    fi
    case "$ptype" in
      anthropic) purl="${ANTHROPIC_BASE_URL:-}" ;;
      openai)    purl="${OPENAI_BASE_URL:-}" ;;
      *) fail "LLM_API_STYLE must be 'anthropic' or 'openai'" ;;
    esac
    [ -n "$purl" ] || fail "${ptype^^} provider selected but its base URL is not set"

    export LLM_API_STYLE="$ptype"
    if [ -z "${BYOK_VERIFY_API_STYLE:-}" ]; then
      export BYOK_VERIFY_API_STYLE="$ptype"
    fi
    [ -n "${BYOK_VERIFY_MODELS_URL:-}" ] ||
      export BYOK_VERIFY_MODELS_URL="$(derive_byok_models_url "$purl")"
    log "Claw LLM endpoint: $purl (provider=$ptype, preconfigured, BYOK)"
    return 0                                      # operator already provided endpoint(s)
  fi
  if [ ! -t 0 ]; then
    fail "--skip-litellm requires ANTHROPIC_BASE_URL or OPENAI_BASE_URL in non-interactive mode"
  fi

  local ptype purl
  while :; do
    read -r -p "[one-click] LiteLLM skipped — Claw LLM provider (anthropic/openai): " ptype
    case "${ptype:-}" in anthropic|openai) break ;; *) echo "  enter 'anthropic' or 'openai'" ;; esac
  done
  read -r -p "[one-click] $ptype base URL (e.g. https://api.anthropic.com or https://api.openai.com/v1): " purl
  purl="${purl%/}"
  [ -n "$purl" ] || fail "provider base URL is required"

  # Claw's chart marks both base URLs required; point both at the chosen
  # endpoint (mirrors the single-gateway default) and derive the BYOK verify URL.
  export ANTHROPIC_BASE_URL="$purl"
  export OPENAI_BASE_URL="$purl"
  export LLM_API_STYLE="$ptype"
  export BYOK_VERIFY_MODELS_URL="$(derive_byok_models_url "$purl")"
  export BYOK_VERIFY_API_STYLE="$ptype"
  log "Claw LLM endpoint: $purl (provider=$ptype, BYOK — no server key stored)"
}

# Unified namespace for Claw + LiteLLM: they share one namespace (and its PGO
# database). LiteLLM follows Claw, Claw follows NAMESPACE; Sandbox is separate.
# Per-component overrides (CLAW_NAMESPACE / LITELLM_NAMESPACE) still take effect.
NAMESPACE="${NAMESPACE:-primus-claw}"
CLAW_NAMESPACE="${CLAW_NAMESPACE:-$NAMESPACE}"
LITELLM_NAMESPACE="${LITELLM_NAMESPACE:-$CLAW_NAMESPACE}"
SANDBOX_NAMESPACE="${SANDBOX_NAMESPACE:-agent-sandbox-system}"
SANDBOX_IMAGE_REGISTRY="${SANDBOX_IMAGE_REGISTRY:-docker.io/primussafe/}"
SANDBOX_IMAGE_TAG="${SANDBOX_IMAGE_TAG:-latest}"
CLAW_REGISTRY="${CLAW_REGISTRY:-docker.io/primussafe}"
CLAW_TAG="${CLAW_TAG:-${TAG:-latest}}"
DOMAIN="${DOMAIN:-${LITELLM_INGRESS_HOST:-}}"
if [ "$DEPLOY_LITELLM" = "true" ]; then
  LITELLM_API_BASE="${LITELLM_API_BASE:-http://${LITELLM_NAME:-litellm}.${LITELLM_NAMESPACE}.svc.cluster.local:4000/v1}"
else
  LITELLM_API_BASE="${LITELLM_API_BASE:-${OPENAI_BASE_URL:-${ANTHROPIC_BASE_URL:-}}}"
fi
export LITELLM_API_BASE

command -v kubectl >/dev/null || fail "kubectl not found"
if [ "$DRY_RUN" != "true" ]; then
  kubectl cluster-info >/dev/null 2>&1 || fail "kubectl cannot reach cluster"
fi

if [ "$YES" != "true" ] && [ "$DRY_RUN" != "true" ]; then
  cat >&2 <<EOF
This command will mutate the current Kubernetes cluster.

Context:          $(kubectl config current-context 2>/dev/null || echo '<unknown>')
Sandbox:          $DEPLOY_SANDBOX (namespace=$SANDBOX_NAMESPACE image=${SANDBOX_IMAGE_REGISTRY}agent-sandbox-controlplane:$SANDBOX_IMAGE_TAG)
Claw:             $DEPLOY_CLAW (namespace=$CLAW_NAMESPACE registry=$CLAW_REGISTRY tag=$CLAW_TAG)
LiteLLM:          $DEPLOY_LITELLM (namespace=$LITELLM_NAMESPACE name=${LITELLM_NAME:-litellm}, db=$([ -n "${LITELLM_DATABASE_URL:-}" ] && echo provided || echo 'auto-discover PGO'))

Re-run with --yes to execute, or --dry-run to preview.
EOF
  exit 2
fi

log "context: $(kubectl config current-context 2>/dev/null || echo '<unknown>')"
[ -z "$LOADED_DEPLOY_PROFILE" ] || log "profile: $LOADED_DEPLOY_PROFILE"
log "sandbox namespace: $SANDBOX_NAMESPACE"
log "litellm namespace: $LITELLM_NAMESPACE"
log "claw namespace: $CLAW_NAMESPACE"

select_storage_class
configure_claw_llm_interactive

if [ "$DEPLOY_SANDBOX" = "true" ]; then
  sandbox_env=(
    "NAMESPACE=$SANDBOX_NAMESPACE"
    "IMAGE_REGISTRY=$SANDBOX_IMAGE_REGISTRY"
    "IMAGE_TAG=$SANDBOX_IMAGE_TAG"
  )
  if [ "$INSECURE_SANDBOX" = "true" ]; then
    sandbox_env+=("ALLOW_INSECURE_NO_AUTH=true")
  else
    sandbox_env+=("SAFE_API_URL=$SAFE_API_URL")
  fi
  [ -n "${STORAGE_CLASS:-}" ] && sandbox_env+=("REDIS_STORAGE_CLASS=$STORAGE_CLASS")
  [ -n "${SANDBOX_EGRESS_ENABLED:-}" ] && sandbox_env+=("EGRESS_ENABLED=$SANDBOX_EGRESS_ENABLED")
  [ -n "${SANDBOX_EGRESS_EXTRA_BLOCKED_CIDRS:-}" ] && sandbox_env+=("EGRESS_EXTRA_BLOCKED_CIDRS=$SANDBOX_EGRESS_EXTRA_BLOCKED_CIDRS")
  [ "$DRY_RUN" = "true" ] && sandbox_env+=("DRY_RUN=true")
  log "+ env ${sandbox_env[*]} bash $REPO_ROOT/sandbox/deploy/scripts/install.sh"
  env "${sandbox_env[@]}" bash "$REPO_ROOT/sandbox/deploy/scripts/install.sh"

  if [ "$SKIP_SANDBOX_CHECK" != "true" ] && [ "$DRY_RUN" != "true" ]; then
    log "+ NAMESPACE=$SANDBOX_NAMESPACE bash $REPO_ROOT/sandbox/deploy/scripts/check.sh"
    env NAMESPACE="$SANDBOX_NAMESPACE" bash "$REPO_ROOT/sandbox/deploy/scripts/check.sh"
  fi
fi

# Claw provisions the PostgresCluster (PGO) that LiteLLM reuses for its
# DATABASE_URL, so Claw must run before LiteLLM.
if [ "$DEPLOY_CLAW" = "true" ]; then
  claw_flags=()
  [ "$DRY_RUN" = "true" ] && claw_flags+=(--dry-run)
  [ -z "${CLAW_DEPLOY_ROOT:-}" ] && claw_flags+=(--skip-shared-assets)

  claw_env=(
    "NAMESPACE=$CLAW_NAMESPACE"
    "REGISTRY=$CLAW_REGISTRY"
    "DOMAIN=$DOMAIN"
  )
  [ -n "$CLAW_TAG" ] && claw_env+=("TAG=$CLAW_TAG")
  [ -n "${STORAGE_CLASS:-}" ] && claw_env+=("STORAGE_CLASS=$STORAGE_CLASS")
  [ -n "${LLM_API_STYLE:-}" ]          && claw_env+=("LLM_API_STYLE=$LLM_API_STYLE")
  [ -n "${ANTHROPIC_BASE_URL:-}" ]     && claw_env+=("ANTHROPIC_BASE_URL=$ANTHROPIC_BASE_URL")
  [ -n "${OPENAI_BASE_URL:-}" ]        && claw_env+=("OPENAI_BASE_URL=$OPENAI_BASE_URL")
  [ -n "${BYOK_VERIFY_MODELS_URL:-}" ] && claw_env+=("BYOK_VERIFY_MODELS_URL=$BYOK_VERIFY_MODELS_URL")
  [ -n "${BYOK_VERIFY_API_STYLE:-}" ]  && claw_env+=("BYOK_VERIFY_API_STYLE=$BYOK_VERIFY_API_STYLE")
  [ -n "${PG_SSL_NO_VERIFY:-}" ]       && claw_env+=("PG_SSL_NO_VERIFY=$PG_SSL_NO_VERIFY")

  log "+ env ${claw_env[*]} bash $REPO_ROOT/claw/deploy/deploy.sh ${claw_flags[*]}"
  env "${claw_env[@]}" bash "$REPO_ROOT/claw/deploy/deploy.sh" "${claw_flags[@]}"
fi

# LiteLLM runs after Claw: with LITELLM_DATABASE_URL unset it auto-discovers the
# PGO PostgresCluster Claw just created in LITELLM_NAMESPACE. Only non-secret
# LITELLM_* are forwarded explicitly; DATABASE_URL (if exported) is inherited
# but never echoed to logs.
if [ "$DEPLOY_LITELLM" = "true" ]; then
  litellm_args=()
  [ "$DRY_RUN" = "true" ] && litellm_args+=(--dry-run)
  [ "$SKIP_LITELLM_HEALTH" = "true" ] && litellm_args+=(--skip-health)

  litellm_env=("LITELLM_NAMESPACE=$LITELLM_NAMESPACE")
  [ -n "${LITELLM_VALUES_FILE:-}" ]  && litellm_env+=("LITELLM_VALUES_FILE=$LITELLM_VALUES_FILE")
  [ -n "${LITELLM_INGRESS_HOST:-}" ] && litellm_env+=("LITELLM_INGRESS_HOST=$LITELLM_INGRESS_HOST")

  log "+ env ${litellm_env[*]} bash $REPO_ROOT/deploy/litellm/deploy.sh ${litellm_args[*]}"
  env "${litellm_env[@]}" bash "$REPO_ROOT/deploy/litellm/deploy.sh" "${litellm_args[@]}"
fi

log "one-click deploy complete"
