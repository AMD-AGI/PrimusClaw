#!/usr/bin/env bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

# Deploy the LiteLLM gateway used by PrimusClaw standalone deployments.
#
# Required for a real deploy:
#   LITELLM_DATABASE_URL      Postgres URL used by LiteLLM
#
# Optional:
#   LITELLM_MASTER_KEY        Generated if unset (or reused from the existing Secret)
#   LITELLM_INGRESS_HOST      If set, apply ingress for /llm-gateway
#   LITELLM_VALUES_FILE       Private Helm values file with modelList/secrets

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHART_DIR="$(cd "$SCRIPT_DIR/charts/litellm" && pwd)"

LITELLM_NAMESPACE="${LITELLM_NAMESPACE:-${NAMESPACE:-primus-claw}}"
LITELLM_NAME="${LITELLM_NAME:-litellm}"
LITELLM_RELEASE="${LITELLM_RELEASE:-$LITELLM_NAME}"
LITELLM_IMAGE="${LITELLM_IMAGE:-docker.io/primussafe/litellm:20260331111348}"
LITELLM_IMAGE_PULL_POLICY="${LITELLM_IMAGE_PULL_POLICY:-Always}"
LITELLM_SERVER_ROOT_PATH="${LITELLM_SERVER_ROOT_PATH:-/llm-gateway}"
LITELLM_SAFE_API_URL="${LITELLM_SAFE_API_URL:-${SAFE_API_URL:-}}"
LITELLM_DATABASE_URL="${LITELLM_DATABASE_URL:-}"
LITELLM_MASTER_KEY="${LITELLM_MASTER_KEY:-}"
LITELLM_VALUES_FILE="${LITELLM_VALUES_FILE:-}"
LITELLM_INSTALL_INGRESS="${LITELLM_INSTALL_INGRESS:-true}"
LITELLM_INGRESS_HOST="${LITELLM_INGRESS_HOST:-}"
LITELLM_INGRESS_CLASS="${LITELLM_INGRESS_CLASS:-higress}"
LITELLM_HEALTH_IMAGE="${LITELLM_HEALTH_IMAGE:-curlimages/curl:8.10.1}"
SKIP_HEALTH="${SKIP_HEALTH:-false}"
DRY_RUN="${DRY_RUN:-false}"

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --skip-ingress) LITELLM_INSTALL_INGRESS=false; shift ;;
    --skip-health) SKIP_HEALTH=true; shift ;;
    --help|-h)
      cat <<'HELP'
Usage:
  LITELLM_DATABASE_URL=... LITELLM_VALUES_FILE=/path/private-values.yaml bash litellm/deploy.sh

Flags:
  --dry-run       Render/apply with kubectl --dry-run=client where possible
  --skip-ingress  Do not apply the LiteLLM ingress
  --skip-health   Skip the in-cluster health probe

  Prompts to add an anthropic/openai provider. Enter its base URL + API key;
  the provider's /models endpoint is queried and every model is written into
  modelList automatically (overrides modelList from LITELLM_VALUES_FILE).

Key env:
  LITELLM_NAMESPACE=primus-claw
  LITELLM_RELEASE=litellm
  LITELLM_NAME=litellm
  LITELLM_IMAGE=docker.io/primussafe/litellm:20260331111348
  LITELLM_VALUES_FILE=/path/private-values.yaml # optional modelList overrides
  LITELLM_INGRESS_HOST=<host>       # optional; enables ingress when set
  LITELLM_SERVER_ROOT_PATH=/llm-gateway
  LITELLM_SAFE_API_URL=https://safe.example.com
HELP
      exit 0 ;;
    *) echo "Unknown flag: $1" >&2; exit 2 ;;
  esac
done

log() { echo "[litellm] $(date +%H:%M:%S) $*"; }
fail() { echo "[litellm] ERROR: $*" >&2; exit 1; }

# Temp files may hold a provider API key; remove them on any exit.
MODELS_TMP_FILES=()
cleanup_tmp() { local f; for f in "${MODELS_TMP_FILES[@]:-}"; do [ -n "${f:-}" ] && rm -f "$f"; done; }
trap cleanup_tmp EXIT
GENERATED_MODELS_FILE=""

# Prompt for a provider (anthropic/openai) + base URL + API key, query its
# /models endpoint, and render the discovered models into a temp Helm values
# file (modelList). Skipped on --dry-run or a non-TTY stdin so existing
# non-interactive/CI deploys are unaffected.
configure_models_interactive() {
  [ "$DRY_RUN" = "true" ] && return 0
  [ -t 0 ] || { log "non-interactive shell; skipping model provider prompt"; return 0; }

  local ans
  read -r -p "[litellm] Configure an LLM provider and auto-discover models now? [y/N] " ans
  case "${ans:-}" in
    y|Y|yes|YES) ;;
    *) log "skipping model provider configuration"; return 0 ;;
  esac

  command -v curl >/dev/null || fail "curl not found (required for model discovery)"

  local ptype
  while :; do
    read -r -p "[litellm] Provider type (anthropic/openai): " ptype
    case "${ptype:-}" in anthropic|openai) break ;; *) echo "  enter 'anthropic' or 'openai'" ;; esac
  done

  local purl pkey
  read -r -p "[litellm] Provider base URL (e.g. https://api.anthropic.com or https://host/v1): " purl
  purl="${purl%/}"
  [ -n "$purl" ] || fail "provider base URL is required"
  read -r -s -p "[litellm] Provider API key: " pkey; echo
  [ -n "$pkey" ] || fail "provider API key is required"

  # Derive the /models endpoint and per-provider auth header + litellm prefix.
  local models_url model_prefix
  local -a auth_hdr
  case "$purl" in */v1) models_url="$purl/models" ;; *) models_url="$purl/v1/models" ;; esac
  if [ "$ptype" = "anthropic" ]; then
    model_prefix="anthropic"
    auth_hdr=(-H "x-api-key: $pkey" -H "anthropic-version: 2023-06-01")
  else
    model_prefix="openai"
    auth_hdr=(-H "Authorization: Bearer $pkey")
  fi

  log "querying models: GET $models_url"
  local resp
  resp="$(curl -sf -m 20 "${auth_hdr[@]}" "$models_url")" \
    || fail "failed to fetch models from $models_url (check URL / key / network)"

  GENERATED_MODELS_FILE="$(mktemp)"
  chmod 600 "$GENERATED_MODELS_FILE"
  MODELS_TMP_FILES+=("$GENERATED_MODELS_FILE")

  # Parse an OpenAI/Anthropic-style {"data":[{"id":...}]} payload and emit
  # modelList as JSON (a valid YAML subset, so ids/urls/keys stay safely quoted).
  local count
  count="$(printf '%s' "$resp" | python3 -c '
import json, sys
prefix, api_base, api_key, out = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
data = json.load(sys.stdin)
items = data.get("data") if isinstance(data, dict) else data
ids = []
for it in (items or []):
    mid = it.get("id") if isinstance(it, dict) else it
    if mid:
        ids.append(mid)
if not ids:
    sys.stderr.write("no models found in /models response\n"); sys.exit(1)
model_list = [
    {"model_name": m, "litellm_params": {"model": f"{prefix}/{m}", "api_base": api_base, "api_key": api_key}}
    for m in ids
]
json.dump({"modelList": model_list}, open(out, "w"), indent=2)
print(len(ids))
' "$model_prefix" "$purl" "$pkey" "$GENERATED_MODELS_FILE")" \
    || fail "could not parse models response from $models_url"

  log "discovered $count model(s) from $ptype provider; configuring modelList"
}

# When LITELLM_DATABASE_URL is unset, try to reuse a CrunchyData PGO
# PostgresCluster in LITELLM_NAMESPACE: pick the app-user pguser secret and emit
# its connection URL on stdout (empty if none). Never logs the URL/password.
# Assumes the caller already verified kubectl can reach the cluster.
discover_pgo_database_url() {
  local names
  names="$(kubectl get postgrescluster -n "$LITELLM_NAMESPACE" \
    -o jsonpath='{.items[*].metadata.name}' 2>/dev/null || true)"
  [ -n "$names" ] || return 0

  local -a clusters=($names)
  local cluster
  if [ "${#clusters[@]}" -gt 1 ] && [ -t 0 ]; then
    log "multiple PostgresClusters in ns=$LITELLM_NAMESPACE: ${clusters[*]}" >&2
    read -r -p "[litellm] use which PostgresCluster? [${clusters[0]}] " cluster
    cluster="${cluster:-${clusters[0]}}"
  else
    cluster="${clusters[0]}"
  fi
  [ -n "$cluster" ] || return 0

  # Prefer the app user's secret (pguser label != postgres); CrunchyData labels
  # each user secret with role=pguser and pguser=<username>.
  local secs s pguser chosen=""
  secs="$(kubectl get secret -n "$LITELLM_NAMESPACE" \
    -l "postgres-operator.crunchydata.com/cluster=$cluster,postgres-operator.crunchydata.com/role=pguser" \
    -o jsonpath='{.items[*].metadata.name}' 2>/dev/null || true)"
  for s in $secs; do
    pguser="$(kubectl get secret "$s" -n "$LITELLM_NAMESPACE" \
      -o jsonpath='{.metadata.labels.postgres-operator\.crunchydata\.com/pguser}' 2>/dev/null || true)"
    [ -n "$pguser" ] && [ "$pguser" != "postgres" ] && { chosen="$s"; break; }
  done
  [ -z "$chosen" ] && chosen="${secs%% *}"              # fall back to first pguser secret
  [ -z "$chosen" ] && chosen="$cluster-pguser-$cluster" # last-resort naming convention
  [ -n "$chosen" ] || return 0

  # CrunchyData exposes a ready-made 'uri' key; prefer it, else build from parts.
  local uri host port user pass db
  uri="$(kubectl get secret "$chosen" -n "$LITELLM_NAMESPACE" -o jsonpath='{.data.uri}' 2>/dev/null | base64 -d 2>/dev/null || true)"
  if [ -n "$uri" ]; then printf '%s' "$uri"; return 0; fi

  host="$(kubectl get secret "$chosen" -n "$LITELLM_NAMESPACE" -o jsonpath='{.data.host}'     2>/dev/null | base64 -d 2>/dev/null || true)"
  port="$(kubectl get secret "$chosen" -n "$LITELLM_NAMESPACE" -o jsonpath='{.data.port}'     2>/dev/null | base64 -d 2>/dev/null || true)"
  user="$(kubectl get secret "$chosen" -n "$LITELLM_NAMESPACE" -o jsonpath='{.data.user}'     2>/dev/null | base64 -d 2>/dev/null || true)"
  pass="$(kubectl get secret "$chosen" -n "$LITELLM_NAMESPACE" -o jsonpath='{.data.password}' 2>/dev/null | base64 -d 2>/dev/null || true)"
  db="$(kubectl get secret "$chosen" -n "$LITELLM_NAMESPACE" -o jsonpath='{.data.dbname}'     2>/dev/null | base64 -d 2>/dev/null || true)"
  [ -n "$host" ] && [ -n "$user" ] && [ -n "$pass" ] || return 0
  printf 'postgresql://%s:%s@%s:%s/%s' "$user" "$pass" "$host" "${port:-5432}" "${db:-$user}"
}

command -v kubectl >/dev/null || fail "kubectl not found"
command -v helm >/dev/null || fail "helm not found"
command -v openssl >/dev/null || fail "openssl not found"
command -v python3 >/dev/null || fail "python3 not found"
[[ -f "$CHART_DIR/Chart.yaml" ]] || fail "missing Helm chart: $CHART_DIR"

if [ "$DRY_RUN" != "true" ]; then
  kubectl cluster-info >/dev/null 2>&1 || fail "kubectl cannot reach cluster"
fi

if [ -z "$LITELLM_DATABASE_URL" ]; then
  if [ "$DRY_RUN" = "true" ]; then
    LITELLM_DATABASE_URL="postgres://user:pass@example:5432/litellm"
  else
    # Reuse a PGO PostgresCluster in the namespace if present; otherwise prompt.
    LITELLM_DATABASE_URL="$(discover_pgo_database_url || true)"
    if [ -n "$LITELLM_DATABASE_URL" ]; then
      log "using PGO PostgresCluster database in ns=$LITELLM_NAMESPACE"
    elif [ -t 0 ]; then
      read -r -p "[litellm] LITELLM_DATABASE_URL unset and no PGO in ns=$LITELLM_NAMESPACE; enter Postgres URL: " LITELLM_DATABASE_URL
      [ -n "$LITELLM_DATABASE_URL" ] || fail "LITELLM_DATABASE_URL is required"
    else
      fail "LITELLM_DATABASE_URL is required (no PGO PostgresCluster in ns=$LITELLM_NAMESPACE; no TTY to prompt)"
    fi
  fi
fi

if [ -z "$LITELLM_MASTER_KEY" ]; then
  if [ "$DRY_RUN" != "true" ]; then
    LITELLM_MASTER_KEY="$(kubectl -n "$LITELLM_NAMESPACE" get secret "$LITELLM_NAME" \
      -o jsonpath='{.data.master_key}' 2>/dev/null | base64 -d 2>/dev/null || true)"
  fi
  if [ -z "$LITELLM_MASTER_KEY" ]; then
    LITELLM_MASTER_KEY="sk-$(openssl rand -hex 24)"
    log "generated LITELLM_MASTER_KEY (stored in Secret/$LITELLM_NAME)"
  else
    log "reusing existing LITELLM_MASTER_KEY from Secret/$LITELLM_NAME"
  fi
fi

log "context: $(kubectl config current-context 2>/dev/null || echo '<unknown>')"
log "namespace: $LITELLM_NAMESPACE"
log "release: $LITELLM_RELEASE"
log "image: $LITELLM_IMAGE"
log "root path: $LITELLM_SERVER_ROOT_PATH"
[ -n "$LITELLM_VALUES_FILE" ] && log "values file: $LITELLM_VALUES_FILE"

# Interactive provider/model discovery (TTY only; skipped on --dry-run).
configure_models_interactive

image_repo="${LITELLM_IMAGE%:*}"
image_tag="${LITELLM_IMAGE##*:}"
if [ "$image_repo" = "$image_tag" ]; then
  image_repo="$LITELLM_IMAGE"
  image_tag="latest"
fi

# Escape chars special to Helm's --set grammar (unescaped "," ends a
# key=value pair; "\" is the escape char itself) so secrets such as a
# PGO-generated Postgres password/URL are never misparsed into bogus
# extra keys (e.g. a comma inside the password splitting the value).
helm_set_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/,/\\,/g'
}

helm_args=(
  upgrade --install "$LITELLM_RELEASE" "$CHART_DIR"
  --namespace "$LITELLM_NAMESPACE"
  --create-namespace
  --set "fullnameOverride=$LITELLM_NAME"
  --set "image.repository=$image_repo"
  --set "image.tag=$image_tag"
  --set "image.pullPolicy=$LITELLM_IMAGE_PULL_POLICY"
  --set "serverRootPath=$LITELLM_SERVER_ROOT_PATH"
  --set "secrets.masterKey=$(helm_set_escape "$LITELLM_MASTER_KEY")"
  --set "secrets.databaseUrl=$(helm_set_escape "$LITELLM_DATABASE_URL")"
)
[ -n "$LITELLM_SAFE_API_URL" ] && helm_args+=(--set "safeApiUrl=$LITELLM_SAFE_API_URL")
[ -n "$LITELLM_VALUES_FILE" ] && helm_args+=(-f "$LITELLM_VALUES_FILE")
if [ -n "$GENERATED_MODELS_FILE" ]; then
  [ -n "$LITELLM_VALUES_FILE" ] && log "note: discovered modelList overrides any modelList in LITELLM_VALUES_FILE"
  helm_args+=(-f "$GENERATED_MODELS_FILE")
fi
if [ "$LITELLM_INSTALL_INGRESS" = "true" ] && [ -n "$LITELLM_INGRESS_HOST" ]; then
  helm_args+=(
    --set "ingress.enabled=true"
    --set "ingress.host=$LITELLM_INGRESS_HOST"
    --set "ingress.className=$LITELLM_INGRESS_CLASS"
  )
else
  helm_args+=(--set "ingress.enabled=false")
fi

if [ "$DRY_RUN" = "true" ]; then
  helm "${helm_args[@]}" --dry-run --debug >/dev/null
  log "dry-run complete"
  exit 0
fi

helm "${helm_args[@]}" --wait --timeout 300s

kubectl -n "$LITELLM_NAMESPACE" rollout status "deployment/$LITELLM_NAME" --timeout=300s

if [ "$SKIP_HEALTH" != "true" ]; then
  LITELLM_PORT="$(helm -n "$LITELLM_NAMESPACE" get values "$LITELLM_RELEASE" -o json 2>/dev/null \
    | python3 -c 'import json,sys; print(json.load(sys.stdin).get("port", 4000))' 2>/dev/null || echo 4000)"
  kubectl -n "$LITELLM_NAMESPACE" run "litellm-health-$$" --rm -i --restart=Never \
    --image="$LITELLM_HEALTH_IMAGE" -- \
    curl -sf -m 10 "http://$LITELLM_NAME:$LITELLM_PORT$LITELLM_SERVER_ROOT_PATH/health/readiness"
fi

log "LiteLLM deploy complete"
