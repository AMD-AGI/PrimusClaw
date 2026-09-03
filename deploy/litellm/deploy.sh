#!/usr/bin/env bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

# Deploy the LiteLLM gateway used by PrimusClaw standalone deployments.
#
# Credentials:
#   LITELLM_EXISTING_SECRET   Preferred Secret with master_key and database_url
#   LITELLM_DATABASE_URL      Required when no existing Secret or PGO database is available
#
# Optional:
#   LITELLM_MASTER_KEY        Generated if unset (or reused from the existing Secret)
#   LITELLM_INGRESS_HOST      If set, apply ingress for /llm-gateway
#   LITELLM_VALUES_FILE       Private Helm values file with modelList/secrets

set -euo pipefail

# Defined here rather than further down because the image-tag check below
# calls log(). It used to sit at line 90, so any LITELLM_IMAGE whose tag did
# not start with v[0-9] -- including this script's own default, and every
# timestamp tag build.sh produces -- hit `log: command not found` and, under
# `set -e`, exited 127 before doing anything.
log() { echo "[litellm] $(date +%H:%M:%S) $*"; }
fail() { echo "[litellm] ERROR: $*" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHART_DIR="$(cd "$SCRIPT_DIR/charts/litellm" && pwd)"

LITELLM_NAMESPACE="${LITELLM_NAMESPACE:-${NAMESPACE:-primus-claw}}"
LITELLM_NAME="${LITELLM_NAME:-litellm}"
LITELLM_RELEASE="${LITELLM_RELEASE:-$LITELLM_NAME}"
LITELLM_IMAGE="${LITELLM_IMAGE:-docker.io/primussafe/litellm:20260331111348}"
# The default image and the Dockerfile beside it are two independent claims
# about which LiteLLM this repo runs, and they were four minor versions apart
# with nothing in either name to say so -- an entire upgrade was scoped against
# the wrong one. A tag that names its base (build.sh writes those) is checked;
# a date-stamped legacy tag can only be warned about.
_dockerfile_base="$(grep -oE '^FROM .*litellm:v[0-9.]+' "$SCRIPT_DIR/Dockerfile" | grep -oE 'v[0-9.]+' | head -1 || true)"
case "${LITELLM_IMAGE##*:}" in
  v[0-9]*)
    _image_base="$(echo "${LITELLM_IMAGE##*:}" | grep -oE '^v[0-9.]+')"
    if [ -n "$_dockerfile_base" ] && [ "$_image_base" != "$_dockerfile_base" ]; then
      echo "ERROR: LITELLM_IMAGE is $_image_base but Dockerfile pins $_dockerfile_base." >&2
      echo "Rebuild with deploy/litellm/build.sh, or set LITELLM_IMAGE deliberately." >&2
      exit 1
    fi
    ;;
  *)
    [ -n "$_dockerfile_base" ] && log "note: $LITELLM_IMAGE does not name a version; Dockerfile pins $_dockerfile_base (build.sh tags by version)"
    ;;
esac
LITELLM_IMAGE_PULL_POLICY="${LITELLM_IMAGE_PULL_POLICY:-Always}"
LITELLM_SERVER_ROOT_PATH="${LITELLM_SERVER_ROOT_PATH:-/llm-gateway}"
LITELLM_SAFE_API_URL="${LITELLM_SAFE_API_URL:-${SAFE_API_URL:-}}"
LITELLM_DATABASE_URL="${LITELLM_DATABASE_URL:-}"
LITELLM_MASTER_KEY="${LITELLM_MASTER_KEY:-}"
LITELLM_VALUES_FILE="${LITELLM_VALUES_FILE:-}"
LITELLM_EXISTING_SECRET="${LITELLM_EXISTING_SECRET:-}"
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
  LITELLM_EXISTING_SECRET=litellm-credentials bash litellm/deploy.sh

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
  LITELLM_EXISTING_SECRET=litellm-credentials   # skips inline database/master credentials
  LITELLM_PROVIDER_TYPE=anthropic|openai        # supply the provider without the prompt
  LITELLM_PROVIDER_URL=https://host/v1          #   (all three required together)
  LITELLM_PROVIDER_API_KEY=...                  #   stored in a Secret, never in values
  LITELLM_PROVIDER_VALUES_FILE=/path/models.json # keep the discovered modelList
  LITELLM_INGRESS_HOST=<host>       # optional; enables ingress when set
  LITELLM_SERVER_ROOT_PATH=/llm-gateway
  LITELLM_SAFE_API_URL=https://safe.example.com
HELP
      exit 0 ;;
    *) echo "Unknown flag: $1" >&2; exit 2 ;;
  esac
done

# Temp files may hold a provider API key; remove them on any exit.
MODELS_TMP_FILES=()
cleanup_tmp() {
  local f
  for f in "${MODELS_TMP_FILES[@]:-}"; do
    if [ -n "${f:-}" ]; then
      rm -f "$f"
    fi
  done
}
trap cleanup_tmp EXIT
GENERATED_MODELS_FILE=""
PROVIDER_KEY_SECRET=""
PROVIDER_KEY_SECRET_KEY="api_key"
PROVIDER_KEY_ENV="LITELLM_PROVIDER_API_KEY"

# Prompt for a provider (anthropic/openai) + base URL + API key, query its
# /models endpoint, and render the discovered models into a temp Helm values
# file (modelList). Skipped on --dry-run or a non-TTY stdin so existing
# non-interactive/CI deploys are unaffected.
# Reads the provider key on stdin and puts it in the Secret the chart points
# at. Ensures the namespace first: helm --create-namespace has not run yet, so a
# first install into a namespace that does not exist would have nowhere to put
# it. The key travels on stdin rather than --from-literal because an argument is
# visible in /proc and to anything auditing process starts.
# Turns a /models payload on stdin into a values file holding modelList and
# providerApiKey, and prints how many models it found. The key never reaches
# this file: LiteLLM resolves the os.environ reference per request from the
# container environment, and that entry comes from the Secret. A literal here
# would travel into the release values and sit in every stored revision.
write_provider_values() {
  local prefix="$1" api_base="$2" out="$3"
  python3 -c '
import json, sys
prefix, api_base, env_name, secret, secret_key, out = sys.argv[1:7]
data = json.load(sys.stdin)
items = data.get("data") if isinstance(data, dict) else data
if items is None:
    items = []
if not isinstance(items, list):
    # A dict iterates as its keys, which would become model names: a
    # plausible-looking modelList built out of nothing.
    sys.exit("unexpected /models response: 'data' is %s, not a list" % type(items).__name__)
ids = [it.get("id") if isinstance(it, dict) else it for it in items]
ids = [i for i in ids if isinstance(i, str) and i]
if not ids:
    sys.exit("no models found in /models response")
json.dump({
    "modelList": [
        {"model_name": m, "litellm_params": {
            "model": f"{prefix}/{m}",
            "api_base": api_base,
            "api_key": f"os.environ/{env_name}",
        }}
        for m in ids
    ],
    "providerApiKey": {"secretName": secret, "secretKey": secret_key, "envName": env_name},
}, open(out, "w"), indent=2)
print(len(ids))
' "$prefix" "$api_base" "$PROVIDER_KEY_ENV" "$PROVIDER_KEY_SECRET" "$PROVIDER_KEY_SECRET_KEY" "$out"
}

store_provider_key() {
  local key; key="$(cat)"
  kubectl create namespace "$LITELLM_NAMESPACE" --dry-run=client -o yaml \
    | kubectl apply -f - >/dev/null 2>&1 || true
  # Labelled so the ones this script leaves behind can be found again: they are
  # named after the key's hash, so each rotation adds one, and Helm does not own
  # them -- `helm uninstall` leaves every one of them in the namespace.
  printf '%s' "$key" \
    | kubectl -n "$LITELLM_NAMESPACE" create secret generic "$PROVIDER_KEY_SECRET" \
        --from-file="$PROVIDER_KEY_SECRET_KEY=/dev/stdin" --dry-run=client -o json \
    | python3 -c '
import json, sys
doc = json.load(sys.stdin)
doc.setdefault("metadata", {}).setdefault("labels", {}).update({
    "app.kubernetes.io/managed-by": "litellm-deploy.sh",
    "app.kubernetes.io/instance": sys.argv[1],
})
json.dump(doc, sys.stdout)
' "$LITELLM_RELEASE" \
    | kubectl -n "$LITELLM_NAMESPACE" apply -f - >/dev/null \
    || fail "could not store the provider API key in Secret/$PROVIDER_KEY_SECRET"
}

configure_models_interactive() {
  [ "$DRY_RUN" = "true" ] && return 0

  # The provider can also be supplied non-interactively. That is what makes this
  # path testable at all -- everything below (the key never reaching argv, the
  # Secret being namespaced and content-addressed, the values file that survives
  # the next upgrade) used to be reachable only by a human at a terminal, and so
  # was covered by nothing.
  local ptype="${LITELLM_PROVIDER_TYPE:-}" purl="${LITELLM_PROVIDER_URL:-}"
  local pkey="${LITELLM_PROVIDER_API_KEY:-}"

  if [ -n "$ptype$purl$pkey" ]; then
    [ -n "$ptype" ] && [ -n "$purl" ] && [ -n "$pkey" ] \
      || fail "LITELLM_PROVIDER_TYPE, _URL and _API_KEY must be set together"
    case "$ptype" in anthropic|openai) ;; *) fail "LITELLM_PROVIDER_TYPE must be anthropic or openai" ;; esac
  else
    [ -t 0 ] || { log "non-interactive shell; skipping model provider prompt"; return 0; }
    local ans
    read -r -p "[litellm] Configure an LLM provider and auto-discover models now? [y/N] " ans
    case "${ans:-}" in
      y|Y|yes|YES) ;;
      *) log "skipping model provider configuration"; return 0 ;;
    esac
    while :; do
      read -r -p "[litellm] Provider type (anthropic/openai): " ptype
      case "${ptype:-}" in anthropic|openai) break ;; *) echo "  enter 'anthropic' or 'openai'" ;; esac
    done
    read -r -p "[litellm] Provider base URL (e.g. https://api.anthropic.com or https://host/v1): " purl
    read -r -s -p "[litellm] Provider API key: " pkey; echo
  fi

  # Out of the environment now that they are in locals: everything below runs
  # helm, kubectl and python as children, and each would otherwise inherit the
  # key -- visible in /proc/<child>/environ for the life of those processes.
  unset LITELLM_PROVIDER_TYPE LITELLM_PROVIDER_URL LITELLM_PROVIDER_API_KEY

  purl="${purl%/}"
  [ -n "$purl" ] || fail "provider base URL is required"
  [ -n "$pkey" ] || fail "provider API key is required"
  command -v curl >/dev/null || fail "curl not found (required for model discovery)"

  local models_url model_prefix
  case "$purl" in */v1) models_url="$purl/models" ;; *) models_url="$purl/v1/models" ;; esac
  [ "$ptype" = "anthropic" ] && model_prefix="anthropic" || model_prefix="openai"

  # Headers go in a 0600 file, not on the command line. `-H "x-api-key: $pkey"`
  # puts the key in curl's argv, where /proc and any exec auditing can read it
  # for as long as the request runs -- up to the 20s timeout.
  local hdr_file
  hdr_file="$(mktemp)"; chmod 600 "$hdr_file"
  MODELS_TMP_FILES+=("$hdr_file")
  if [ "$ptype" = "anthropic" ]; then
    printf 'x-api-key: %s\nanthropic-version: 2023-06-01\n' "$pkey" >"$hdr_file"
  else
    printf 'Authorization: Bearer %s\n' "$pkey" >"$hdr_file"
  fi

  log "querying models: GET $models_url"
  local resp
  resp="$(curl -sf -m 20 -H "@$hdr_file" "$models_url")" \
    || fail "failed to fetch models from $models_url (check URL / key / network)"

  # Content-addressed, so a changed key means a changed Secret name means a
  # changed pod template. A fixed name would leave the rollout untriggered and
  # the pods on the old key, and a Helm failure later would leave the new key
  # already written under the name the old release still points at.
  local key_hash
  key_hash="$(printf '%s' "$pkey" | sha256sum | cut -c1-10)"
  PROVIDER_KEY_SECRET="$LITELLM_NAME-provider-$key_hash"

  # Always written to a temp file first. Truncating the destination before the
  # response has parsed means a provider that answers with an error page
  # destroys the modelList the operator was keeping there.
  if [ -n "${LITELLM_PROVIDER_VALUES_FILE:-}" ] \
     && [ "${LITELLM_PROVIDER_VALUES_FILE:-}" = "${LITELLM_VALUES_FILE:-}" ]; then
    fail "LITELLM_PROVIDER_VALUES_FILE and LITELLM_VALUES_FILE point at the same file"
  fi
  GENERATED_MODELS_FILE="$(mktemp)"
  MODELS_TMP_FILES+=("$GENERATED_MODELS_FILE")
  chmod 600 "$GENERATED_MODELS_FILE"

  local count
  count="$(printf '%s' "$resp" | write_provider_values "$model_prefix" "$purl" "$GENERATED_MODELS_FILE")" \
    || fail "could not parse models response from $models_url"

  printf '%s' "$pkey" | store_provider_key

  if [ -n "${LITELLM_PROVIDER_VALUES_FILE:-}" ]; then
    # Only now that the response parsed and the file holds a complete modelList.
    install -m 600 "$GENERATED_MODELS_FILE" "$LITELLM_PROVIDER_VALUES_FILE" \
      || fail "could not write $LITELLM_PROVIDER_VALUES_FILE"
    GENERATED_MODELS_FILE="$LITELLM_PROVIDER_VALUES_FILE"
  fi

  log "discovered $count model(s) from $ptype provider"
  log "provider API key in Secret/$PROVIDER_KEY_SECRET, referenced as os.environ/$PROVIDER_KEY_ENV"
  if [ -n "${LITELLM_PROVIDER_VALUES_FILE:-}" ]; then
    log "wrote modelList and providerApiKey to $GENERATED_MODELS_FILE"
  else
    log "note: this modelList lives only in this run. Set LITELLM_PROVIDER_VALUES_FILE"
    log "      to keep it, or pass it as LITELLM_VALUES_FILE on later upgrades."
  fi
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

chart_uses_existing_secret() {
  local rendered
  local -a args=(
    template "$LITELLM_RELEASE" "$CHART_DIR"
    --namespace "$LITELLM_NAMESPACE"
    --show-only templates/secret.yaml
    --set-string "fullnameOverride=$LITELLM_NAME"
    --set-string "secrets.masterKey=probe"
    --set-string "secrets.databaseUrl=postgresql://probe.invalid/litellm"
  )
  [ -n "$LITELLM_VALUES_FILE" ] && args+=(-f "$LITELLM_VALUES_FILE")
  [ -n "$LITELLM_EXISTING_SECRET" ] && args+=(--set-string "secrets.existingSecret=$LITELLM_EXISTING_SECRET")

  if ! rendered="$(helm "${args[@]}")"; then
    fail "could not resolve the chart's Secret configuration"
  fi
  ! grep -q '^kind: Secret$' <<<"$rendered"
}

command -v kubectl >/dev/null || fail "kubectl not found"
command -v helm >/dev/null || fail "helm not found"
command -v python3 >/dev/null || fail "python3 not found"
[[ -f "$CHART_DIR/Chart.yaml" ]] || fail "missing Helm chart: $CHART_DIR"

if [ "$DRY_RUN" != "true" ]; then
  kubectl cluster-info >/dev/null 2>&1 || fail "kubectl cannot reach cluster"
fi

USE_EXISTING_SECRET=false
if chart_uses_existing_secret; then
  USE_EXISTING_SECRET=true
  log "using an existing Secret for database and master credentials"
else
  command -v openssl >/dev/null || fail "openssl not found"

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
    # Only a Secret that is genuinely absent may produce a new key. Treating any
    # read failure as "first install" -- a transient API error, an RBAC change,
    # a truncated response -- rotates the master key by accident, and with
    # LITELLM_SALT_KEY unset that is also the key every model credential in the
    # database was encrypted with.
    if [ "$DRY_RUN" != "true" ]; then
      master_err="$(mktemp)"; MODELS_TMP_FILES+=("$master_err")
      if encoded="$(kubectl -n "$LITELLM_NAMESPACE" get secret "$LITELLM_NAME" \
           -o jsonpath='{.data.master_key}' 2>"$master_err")"; then
        if [ -n "$encoded" ]; then
          LITELLM_MASTER_KEY="$(printf '%s' "$encoded" | base64 -d)" \
            || fail "Secret/$LITELLM_NAME holds a master_key that is not valid base64"
        fi
      elif grep -qi 'NotFound\|secrets .* not found' "$master_err"; then
        : # no Secret yet, so generating one below is correct
      else
        sed 's/^/  /' "$master_err" >&2
        fail "could not read Secret/$LITELLM_NAME; refusing to generate a new master key over it"
      fi
    fi
    if [ -z "$LITELLM_MASTER_KEY" ]; then
      LITELLM_MASTER_KEY="sk-$(openssl rand -hex 24)"
      log "generated LITELLM_MASTER_KEY (stored in Secret/$LITELLM_NAME)"
    else
      log "reusing existing LITELLM_MASTER_KEY from Secret/$LITELLM_NAME"
    fi
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

# Helm recomputes values from what this run passes; it keeps nothing from the
# last one. So an upgrade run without the provider config -- a CI job, or a
# terminal where the operator answered "no" -- would hand Helm an empty
# modelList and no providerApiKey, and the proxy would come back serving no
# models with no key in its environment. Carry forward what the release already
# has whenever this run did not produce its own.
CARRIED_VALUES_FILE=""
if [ -z "$GENERATED_MODELS_FILE" ] && [ "$DRY_RUN" != "true" ]; then
  carried_err="$(mktemp)"; MODELS_TMP_FILES+=("$carried_err")
  if carried="$(helm -n "$LITELLM_NAMESPACE" get values "$LITELLM_RELEASE" -o json 2>"$carried_err")"; then
    :
  elif grep -qi "release: not found" "$carried_err"; then
    # No release yet: this is a first install, and there is nothing to carry.
    carried=""
  else
    # Anything else -- an unreachable API server, RBAC, a broken release -- is
    # not "there is nothing to carry". Proceeding would hand Helm an empty
    # modelList and take the models away, so stop instead.
    sed 's/^/  /' "$carried_err" >&2
    fail "could not read the current values of release $LITELLM_RELEASE; refusing to upgrade with an empty modelList"
  fi

  if [ -n "$carried" ]; then
    CARRIED_VALUES_FILE="$(mktemp)"
    chmod 600 "$CARRIED_VALUES_FILE"
    MODELS_TMP_FILES+=("$CARRIED_VALUES_FILE")
    # No validation here on purpose: what matters is the modelList that ends
    # up deployed, and an operator supplying a corrected LITELLM_VALUES_FILE
    # overrides this one. The check runs on the merged result, below.
    carried_keys="$(printf '%s' "$carried" | python3 -c '
import json, sys
out = sys.argv[1]
cur = json.load(sys.stdin)
keep = {k: cur[k] for k in ("modelList", "providerApiKey") if cur.get(k)}
if not keep:
    sys.exit(0)
json.dump(keep, open(out, "w"), indent=2)
print(" ".join(sorted(keep)))
' "$CARRIED_VALUES_FILE")" || fail "refusing to carry the current release's values forward"
    if [ -n "$carried_keys" ]; then
      log "carrying forward from the current release: $carried_keys"
    else
      CARRIED_VALUES_FILE=""
    fi
  fi
fi

helm_args=(
  upgrade --install "$LITELLM_RELEASE" "$CHART_DIR"
  --namespace "$LITELLM_NAMESPACE"
  --create-namespace
  --set "fullnameOverride=$LITELLM_NAME"
  --set "image.repository=$image_repo"
  --set "image.tag=$image_tag"
  --set "image.pullPolicy=$LITELLM_IMAGE_PULL_POLICY"
  --set "serverRootPath=$LITELLM_SERVER_ROOT_PATH"
)
[ -n "$LITELLM_SAFE_API_URL" ] && helm_args+=(--set "safeApiUrl=$LITELLM_SAFE_API_URL")
[ -n "$CARRIED_VALUES_FILE" ] && helm_args+=(-f "$CARRIED_VALUES_FILE")
[ -n "$LITELLM_VALUES_FILE" ] && helm_args+=(-f "$LITELLM_VALUES_FILE")
[ -n "$LITELLM_EXISTING_SECRET" ] && helm_args+=(--set-string "secrets.existingSecret=$LITELLM_EXISTING_SECRET")
if [ "$USE_EXISTING_SECRET" = "true" ]; then
  # Override stale inline values from a values file so Helm stores no copy.
  helm_args+=(--set-string "secrets.masterKey=" --set-string "secrets.databaseUrl=")
else
  helm_args+=(
    --set "secrets.masterKey=$(helm_set_escape "$LITELLM_MASTER_KEY")"
    --set "secrets.databaseUrl=$(helm_set_escape "$LITELLM_DATABASE_URL")"
  )
fi
if [ -n "$PROVIDER_KEY_SECRET" ]; then
  helm_args+=(
    --set-string "providerApiKey.secretName=$PROVIDER_KEY_SECRET"
    --set-string "providerApiKey.secretKey=$PROVIDER_KEY_SECRET_KEY"
    --set-string "providerApiKey.envName=$PROVIDER_KEY_ENV"
  )
fi
if [ -n "$GENERATED_MODELS_FILE" ]; then
  [ -n "$LITELLM_VALUES_FILE" ] && log "note: discovered modelList overrides any modelList in LITELLM_VALUES_FILE"
  helm_args+=(-f "$GENERATED_MODELS_FILE")
fi
if [ "$LITELLM_INSTALL_INGRESS" = "true" ] && [ -n "$LITELLM_INGRESS_HOST" ]; then
  # A second gateway on the same path is not a second gateway, it is a coin
  # flip: whichever ingress the controller resolves first gets the traffic, and
  # the other one sits there answering health probes and nothing else. That is
  # exactly what this cluster grew -- an unused LiteLLM taking 0 real requests
  # in six hours beside the one taking 3563, each looking healthy.
  existing="$(kubectl get ingress -A \
    -o jsonpath="{range .items[*]}{.metadata.namespace}/{.metadata.name}:{range .spec.rules[*].http.paths[*]}{.path},{end}{'\n'}{end}" 2>/dev/null \
    | grep "$LITELLM_SERVER_ROOT_PATH" | grep -v "^$LITELLM_NAMESPACE/$LITELLM_NAME:" || true)"
  if [ -n "$existing" ]; then
    echo "ERROR: $LITELLM_SERVER_ROOT_PATH is already served by:" >&2
    echo "$existing" | sed 's/^/  /' >&2
    echo "Point this release elsewhere (LITELLM_SERVER_ROOT_PATH), take over that" >&2
    echo "release, or pass --skip-ingress if you meant to add a second backend." >&2
    exit 1
  fi
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

# A rotated database password or master key has to reach the running Pods. Both
# arrive by secretKeyRef, so rewriting the Secret leaves the Deployment
# unchanged: helm reports success, rollout status waits on nothing, and the old
# credentials keep being used until something else happens to restart them.
# Hashing them into a pod annotation makes the rotation a template change.
creds_fingerprint=""
if [ "$USE_EXISTING_SECRET" = "true" ]; then
  if creds_raw="$(kubectl -n "$LITELLM_NAMESPACE" get secret "$LITELLM_EXISTING_SECRET" \
       -o jsonpath='{.data.master_key}{.data.database_url}' 2>/dev/null)"; then
    creds_fingerprint="$(printf '%s' "$creds_raw" | sha256sum | cut -c1-32)"
  else
    log "note: could not read Secret/$LITELLM_EXISTING_SECRET; a credential change"
    log "      in it will not roll the Pods on this run"
  fi
else
  creds_fingerprint="$(printf '%s%s' "$LITELLM_MASTER_KEY" "$LITELLM_DATABASE_URL" \
    | sha256sum | cut -c1-32)"
fi
[ -n "$creds_fingerprint" ] && helm_args+=(--set-string "podAnnotations.checksum/credentials=$creds_fingerprint")

# Validate the modelList that will actually be deployed, not any one source of
# it. Helm does the merging, so ask Helm: the carried values, the operator's
# values file and anything discovered this run are all already in helm_args.
# Checking the carried copy earlier meant an operator handed a corrected values
# file still hit the refusal -- the documented way out of the problem could not
# be taken, because their file had not been read yet.
tmpl_args=()
for a in "${helm_args[@]}"; do
  case "$a" in
    upgrade) tmpl_args+=(template) ;;
    --install|--create-namespace) ;;
    *) tmpl_args+=("$a") ;;
  esac
done
if ! rendered="$(helm "${tmpl_args[@]}" 2>&1)"; then
  printf '%s\n' "$rendered" | sed 's/^/  /' >&2
  fail "could not render the chart with the values for this deploy"
fi
printf '%s' "$rendered" | python3 -c '
import re, sys
def val(m):
    return m.group(1).strip().strip(chr(34)).strip(chr(39))
bad = sorted({
    val(m) for m in re.finditer(r"^\s*api_key:\s*(.+)$", sys.stdin.read(), re.M)
    if not val(m).startswith("os.environ/")
})
if bad:
    sys.exit(
        "the modelList for this deploy carries a literal api_key: " + ", ".join(bad)
        + "\nIt would be written into the release values and every revision after"
        + "\nit. Re-run with LITELLM_PROVIDER_TYPE/_URL/_API_KEY to rewrite modelList"
        + "\nagainst a Secret, or pass a LITELLM_VALUES_FILE whose modelList uses an"
        + "\nos.environ/ reference."
    )
' || fail "refusing to deploy a modelList that holds a provider key in plain text"

helm "${helm_args[@]}" --wait --timeout 300s

# Each rotation leaves another key Secret behind, and Helm does not own them, so
# nothing would ever remove them. Prune once the upgrade has succeeded -- not
# before, because until then the previous release is still the live one and still
# points at its own. One older Secret is kept so a single `helm rollback` finds
# the key it was deployed with; anything further back needs the key supplied
# again.
#
# Collected into an array rather than piped: `set -o pipefail` is on, and a grep
# that selects nothing returns 1, which would end the script here on the very
# first deploy -- when there is nothing to prune and everything went right.
if [ -n "$PROVIDER_KEY_SECRET" ]; then
  provider_secrets=()
  while IFS= read -r name; do
    [ -n "$name" ] && [ "$name" != "$PROVIDER_KEY_SECRET" ] && provider_secrets+=("$name")
  done < <(kubectl -n "$LITELLM_NAMESPACE" get secret \
    -l "app.kubernetes.io/managed-by=litellm-deploy.sh,app.kubernetes.io/instance=$LITELLM_RELEASE" \
    --sort-by=.metadata.creationTimestamp \
    -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null || true)
  # Oldest first, so everything but the last entry is older than the one kept.
  for ((n = 0; n < ${#provider_secrets[@]} - 1; n++)); do
    if kubectl -n "$LITELLM_NAMESPACE" delete secret "${provider_secrets[$n]}" >/dev/null 2>&1; then
      log "removed superseded provider key Secret/${provider_secrets[$n]}"
    fi
  done
fi

kubectl -n "$LITELLM_NAMESPACE" rollout status "deployment/$LITELLM_NAME" --timeout=300s

if [ "$SKIP_HEALTH" != "true" ]; then
  LITELLM_PORT="$(helm -n "$LITELLM_NAMESPACE" get values "$LITELLM_RELEASE" -o json 2>/dev/null \
    | python3 -c 'import json,sys; print(json.load(sys.stdin).get("port", 4000))' 2>/dev/null || echo 4000)"
  kubectl -n "$LITELLM_NAMESPACE" run "litellm-health-$$" --rm -i --restart=Never \
    --image="$LITELLM_HEALTH_IMAGE" -- \
    curl -sf -m 10 "http://$LITELLM_NAME:$LITELLM_PORT$LITELLM_SERVER_ROOT_PATH/health/readiness"
fi

# The hook has to be REACHABLE, not merely present. Its import path moves with
# the base image: older builds resolve litellm to /app/litellm, current ones to
# a venv site-packages tree. A deployment that mounts the hook at the old path
# onto a new image starts cleanly, answers readiness, and never calls the hook
# -- upgrading this cluster produced exactly that, and nothing in the rollout
# said so. Asking the running pod is the only answer that survives the move.
# `callbacks` is a list as often as it is a string -- anything that adds
# `prometheus` alongside the hook makes it one. Reading it as a scalar printed
# the repr of the list, which still matched `*.*`, so the module name became
# "['prometheus', 'litellm.proxy.hooks.apim_key_hook" and the import failed:
# a hard error on a perfectly healthy deployment. Normalise to one entry per
# line and check each dotted one on its own; bare names like `prometheus` are
# built in and have nothing to import.
if ! callbacks="$(kubectl -n "$LITELLM_NAMESPACE" exec "deployment/$LITELLM_NAME" -- \
  python3 -c 'import yaml
cb = yaml.safe_load(open("/app/config.yaml")).get("litellm_settings", {}).get("callbacks", [])
if isinstance(cb, str):
    cb = [cb]
for c in cb or []:
    if not isinstance(c, str):
        raise TypeError("callback entries must be strings")
    if c:
        print(c)' 2>/dev/null)"; then
  fail "could not read callbacks from deployment/$LITELLM_NAME"
fi
while IFS= read -r callback; do
  [ -n "$callback" ] || continue
  case "$callback" in
    *.*)
      if ! kubectl -n "$LITELLM_NAMESPACE" exec "deployment/$LITELLM_NAME" -- \
           python3 -c 'import importlib, sys
mod, attr = sys.argv[1].rsplit(".", 1)
module = importlib.import_module(mod)
sys.exit(0 if hasattr(module, attr) else 1)' "$callback" 2>/dev/null; then
        echo "ERROR: config names callback '$callback' but the running image cannot resolve it." >&2
        echo "The proxy will serve traffic with the hook silently inactive." >&2
        echo "Usually a hook mounted at a path this base image does not import from;" >&2
        echo "the image bakes it in at the right place, so drop the mount." >&2
        exit 1
      fi
      log "callback $callback resolves in the running image"
      ;;
    *) log "note: callback '$callback' is built in; nothing to import" ;;
  esac
done <<EOF
$callbacks
EOF

log "LiteLLM deploy complete"
