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

  # Username and password are read and restored as a PAIR. Restoring the
  # password alone leaves the chart's default username (api/brain/reaper/ops)
  # next to a password that belongs to whatever the operator actually named the
  # user, and NATS then rejects every connection from that workload -- an
  # upgrade that authenticates nobody, produced by the code whose job is to
  # keep the deployment working. The username is only forwarded when the
  # password came back too: half a credential is not one.
  local c u
  for c in api brain reaper ops; do
    v=$(kubectl get secret "primus-claw-nats-$c" -n "$NAMESPACE" \
        -o jsonpath='{.data.NATS_PASSWORD}' 2>/dev/null | base64 -d 2>/dev/null || true)
    [ -n "$v" ] || continue
    out+=(--set-string "secret.natsUsers.$c.password=$v")
    u=$(kubectl get secret "primus-claw-nats-$c" -n "$NAMESPACE" \
        -o jsonpath='{.data.NATS_USER}' 2>/dev/null | base64 -d 2>/dev/null || true)
    [ -n "$u" ] && out+=(--set-string "secret.natsUsers.$c.user=$u")
  done
  # An empty array must produce zero lines, not one empty one. `printf '%s\n'`
  # with no arguments still prints a newline, and mapfile turns that into a
  # single empty element, which reaches helm as an empty positional argument
  # and fails the render -- on exactly the first-time upgrade where nothing has
  # been preserved yet, i.e. the path this function exists to keep working.
  [ ${#out[@]} -eq 0 ] && return 0
  printf '%s\n' "${out[@]}"
}

# ── Are all four built-in NATS identities actually provisioned? ──────────
#
# The gate on retiring the legacy all-access `prod` user. Retirement is
# one-way per cluster: the moment the user is gone, anything still
# authenticating as it stops working.
#
# A connection census cannot answer this on its own, which is the trap. reaper
# is a CronJob and ops runs only during an upgrade, so neither is reliably
# connected when anyone looks -- a census taken between sweeps shows api and
# brain, and concluding "everything is migrated" from that retires prod out
# from under the two workloads that were not running. So check what is
# PROVISIONED rather than what happens to be connected: every one of the four
# must be named in NATS_PER_USER_WORKLOADS and must have a password, because
# those two together are what make the chart render its Secret and the workload
# adopt its own identity. Anything missing keeps using the shared credential,
# and retiring prod would cut it off.
#
# Prints the missing identities and returns non-zero; prints nothing and
# returns 0 when all four are covered.
_missing_nats_identities() {
  local workloads="${NATS_PER_USER_WORKLOADS:-}" missing=() c var
  local -A named=()
  local w
  for w in ${workloads//,/ }; do
    [ -n "$w" ] && named["$w"]=1
  done
  for c in api brain reaper ops; do
    var="NATS_PASSWORD_$(echo "$c" | tr '[:lower:]' '[:upper:]')"
    if [ -z "${named[$c]:-}" ]; then
      missing+=("$c (not in NATS_PER_USER_WORKLOADS)")
    elif [ -z "${!var:-}" ]; then
      missing+=("$c (no $var)")
    fi
  done
  [ ${#missing[@]} -eq 0 ] && return 0
  printf '%s\n' "${missing[@]}"
  return 1
}

# ── Is an identity ADOPTED, or merely configured? ────────────────────────
#
# The check above reads the operator's own inputs, which is the weaker half of
# the question: the environment says what the next render will contain, not
# what the cluster is running. Export the four passwords and set
# NATS_RETIRE_PROD in one invocation and every input is present while nothing
# has been deployed -- the workloads are still authenticating as prod, and
# retiring it is one-way. So the evidence has to come from the cluster and
# from the NATS server, not from this shell.
#
# Three independent things must hold for each identity:
#
#   provisioned  the Secret primus-claw-nats-<c> exists and holds the same
#                password that is configured here. A mismatch means the
#                cluster is a render behind, and the credential the workload
#                actually has is not the one about to become the only way in.
#   adopted      the live workload spec reads that Secret and its rollout is
#                complete, so the running pods hold it. api and brain are
#                Deployments; reaper is a CronJob whose spec is the evidence
#                (it need not have run); ops has no workload at all -- it is
#                the credential upgrade.sh borrows, so the Secret and the
#                probe are everything there is to check.
#   functional   NATS accepts that user and password. This is the half no
#                amount of Kubernetes inspection can answer: nats-values.yaml
#                may not have been applied, or the user may exist with a
#                different password, and in both cases the workload is still
#                running on prod without knowing it.
#
# Fails closed. A probe that cannot reach the cluster is not evidence that
# retirement is safe, and this is the one decision where "unknown" and "no"
# have to mean the same thing.
#
# Prints one line per identity that is not adopted, and returns non-zero.

# Quote a value for the `sh -c` that runs inside the nats-box pod. Passwords
# are operator-supplied and go into a command line; without this a quote in
# one silently changes what runs there.
_shq() { printf "'%s'" "${1//\'/\'\\\'\'}"; }

_nats_secret_value() {
  kubectl get secret "$1" -n "$NAMESPACE" \
    -o jsonpath="{.data.$2}" 2>/dev/null | base64 -d 2>/dev/null || true
}

# The two strategies upgrade.sh's nats_kv_put uses, in the same order: the
# long-running nats-box when the chart deployed one, a throwaway pod when it
# did not.
_nats_box_exec() {
  local cmd="$1" pod
  pod=$(kubectl get pods -n "$NAMESPACE" \
    -l "app.kubernetes.io/name=nats-box,app.kubernetes.io/instance=primus-claw-nats" \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
  if [ -z "$pod" ]; then
    pod=$(kubectl get pods -n "$NAMESPACE" 2>/dev/null \
      | awk '$1 ~ /^primus-claw-nats-box/ && $3 == "Running" {print $1; exit}' || true)
  fi
  if [ -n "$pod" ]; then
    kubectl exec -n "$NAMESPACE" "$pod" -- sh -c "$cmd"
    return $?
  fi
  kubectl run "nats-adoption-probe-$$" --rm -i --restart=Never \
    -n "$NAMESPACE" --image="${NATS_BOX_IMAGE:-docker.io/natsio/nats-box:0.14.5}" \
    --command -- sh -c "$cmd"
}

# host:port with any credentials stripped. The stored URL may already carry
# user:pass, and nats://user:pass@user:pass@host is the shape the CLI rejects
# without saying why -- the bug nats_kv_put documents.
_nats_server_hostport() {
  local url rest
  url="$(_nats_secret_value primus-claw-secrets NATS_URL)"
  [ -n "$url" ] || url="nats://primus-claw-nats.${NAMESPACE}.svc.cluster.local:4222"
  rest="${url#nats://}"
  printf '%s\n' "${rest##*@}"
}

# Does NATS accept this user and password?
#
# `nats rtt` is a protocol-level round trip: it proves the server authenticated
# the connection without requiring a single subject permission. Anything that
# publishes or subscribes would confuse "these credentials are refused" with
# "this user is not allowed on that subject" -- opposite answers, and the
# second one is what a correctly least-privileged user is supposed to give.
_nats_auth_probe() {
  local user="$1" pass="$2" url
  url="nats://${user}:${pass}@$(_nats_server_hostport)"
  _nats_box_exec "nats rtt --server=$(_shq "$url")" >/dev/null 2>&1
}

# Prints why this component's workload has not adopted its identity, and
# returns non-zero. Silent and 0 when it has.
_nats_workload_adoption() {
  local c="$1" refs name
  case "$c" in
    api|brain)
      name="primus-claw-$c"
      refs=$(kubectl get deployment "$name" -n "$NAMESPACE" \
        -o jsonpath='{.spec.template.spec.containers[*].env[*].valueFrom.secretKeyRef.name}' \
        2>/dev/null || true)
      case " $refs " in
        *" primus-claw-nats-$c "*) ;;
        *) echo "the $name Deployment does not read primus-claw-nats-$c, so it is still on the shared credential"
           return 1 ;;
      esac
      # Rollout completeness, by the same four conditions `kubectl rollout
      # status` waits on. The obvious pair -- every replica updated, at least
      # one ready -- is satisfied in the middle of a rolling update: with
      # maxUnavailable 0 the new ReplicaSet can hold both replicas with one
      # Ready while the old ReplicaSet still has a Ready pod serving on the old
      # credential. `status.replicas` counts pods across every ReplicaSet the
      # Deployment owns, so it is the field that says whether any old pod is
      # left; `updatedReplicas` alone cannot, because it only ever describes
      # the new one.
      local want have ready total gen seen unverifiable=()
      _dep() {
        kubectl get deployment "$name" -n "$NAMESPACE" -o jsonpath="{$1}" 2>/dev/null
      }
      # Read one field into _DEP_VALUE, recording anything that is not a count.
      #
      # Empty means three different things, and reading all of them as 0 is how
      # a gate ends up passing on no evidence at all. Kubernetes omits a
      # zero-valued status counter, so an absent updatedReplicas/readyReplicas/
      # replicas genuinely is zero. An absent generation, observedGeneration or
      # spec.replicas is not a zero: it means the Deployment could not be read,
      # or the controller has never written a status. And a kubectl that failed
      # -- unreachable API server, expired credential, a timeout -- prints
      # nothing either, which is the emptiest evidence of all: the cluster was
      # never successfully asked, so nothing it "returned" is a count. That case
      # shows up only in the exit status, so the exit status is what is checked
      # first. Non-numeric is never a count, whichever field it came from --
      # `[ "$seen" -lt "$gen" ]` on a word is an error, and an error swallowed
      # here reads as "no blocker".
      _dep_field() {
        local v
        if ! v="$(_dep "$1")"; then
          unverifiable+=("the query for $1 failed")
          _DEP_VALUE=0
          return 0
        fi
        case "$v" in
          "")       if [ "$2" = required ]; then
                      unverifiable+=("$1 was not reported")
                    fi
                    _DEP_VALUE=0 ;;
          *[!0-9]*) unverifiable+=("$1 came back as \"$v\", which is not a count")
                    _DEP_VALUE=0 ;;
          *)        _DEP_VALUE="$v" ;;
        esac
      }
      _dep_field .spec.replicas required;          want="$_DEP_VALUE"
      _dep_field .status.updatedReplicas count;    have="$_DEP_VALUE"
      _dep_field .status.readyReplicas count;      ready="$_DEP_VALUE"
      _dep_field .status.replicas count;           total="$_DEP_VALUE"
      _dep_field .metadata.generation required;    gen="$_DEP_VALUE"
      _dep_field .status.observedGeneration required; seen="$_DEP_VALUE"
      if [ ${#unverifiable[@]} -ne 0 ]; then
        local why; why="$(IFS='; '; printf '%s' "${unverifiable[*]}")"
        echo "the $name Deployment's rollout cannot be verified ($why), and an unverified rollout is not a finished one"
        return 1
      fi
      local state="$have/$want updated, $ready ready, $total pods, generation $seen/$gen observed"
      if [ "$seen" -lt "$gen" ]; then
        echo "the $name Deployment has been changed since the controller last acted on it ($state), so what is running is not what the spec asks for"
        return 1
      fi
      # Scaled to zero on purpose is a finished rollout: there is nothing left
      # to wait for and nothing left holding a credential. Pods still owned say
      # otherwise -- that is a scale-down in progress, and they are serving.
      if [ "$want" = "0" ]; then
        if [ "$total" != "0" ]; then
          echo "the $name Deployment is scaled to zero but still owns $total pod(s) ($state), which are serving on whatever credential they started with"
          return 1
        fi
        return 0
      fi
      if [ "$have" != "$want" ]; then
        echo "the $name rollout has not finished ($state), so pods on the old credential are still serving"
        return 1
      fi
      if [ "$total" != "$have" ]; then
        echo "the $name Deployment still owns pods from an older ReplicaSet ($state): they hold the shared credential and are still taking traffic"
        return 1
      fi
      if [ "$ready" != "$have" ]; then
        echo "the $name rollout is not complete ($state): a replacement pod is not Ready yet, so the update can still roll back onto the old credential"
        return 1
      fi
      ;;
    reaper)
      refs=$(kubectl get cronjob primus-claw-workspace-reaper -n "$NAMESPACE" \
        -o jsonpath='{.spec.jobTemplate.spec.template.spec.containers[*].env[*].valueFrom.secretKeyRef.name}' \
        2>/dev/null || true)
      case " $refs " in
        *" primus-claw-nats-reaper "*) ;;
        *) echo "the primus-claw-workspace-reaper CronJob does not read primus-claw-nats-reaper, so the next sweep would authenticate as prod"
           return 1 ;;
      esac
      ;;
    ops) : ;;
  esac
  return 0
}

_unadopted_nats_identities() {
  local unadopted=() c var configured user pass why
  for c in api brain reaper ops; do
    var="NATS_PASSWORD_$(echo "$c" | tr '[:lower:]' '[:upper:]')"
    configured="${!var:-}"
    user="$(_nats_secret_value "primus-claw-nats-$c" NATS_USER)"
    pass="$(_nats_secret_value "primus-claw-nats-$c" NATS_PASSWORD)"
    if [ -z "$user" ] || [ -z "$pass" ]; then
      unadopted+=("$c (no primus-claw-nats-$c Secret in $NAMESPACE: this identity has never been deployed)")
      continue
    fi
    if [ -n "$configured" ] && [ "$configured" != "$pass" ]; then
      unadopted+=("$c (the deployed Secret holds a different password than $var: the cluster is a render behind)")
      continue
    fi
    if ! why="$(_nats_workload_adoption "$c")"; then
      unadopted+=("$c ($why)")
      continue
    fi
    if ! _nats_auth_probe "$user" "$pass"; then
      unadopted+=("$c (NATS refused '$user': the user is not in the applied nats-values.yaml, its password differs, or the server could not be reached)")
      continue
    fi
  done
  [ ${#unadopted[@]} -eq 0 ] && return 0
  printf '%s\n' "${unadopted[@]}"
  return 1
}

# The whole gate, in the order that costs least: what is configured here,
# then what the cluster and the server say. Prints every blocker it found and
# returns non-zero; prints nothing and returns 0 when prod may be retired.
nats_retirement_blockers() {
  local out
  if ! out="$(_missing_nats_identities)"; then
    printf '%s\n' "$out"
    return 1
  fi
  if ! out="$(_unadopted_nats_identities)"; then
    printf '%s\n' "$out"
    return 1
  fi
  return 0
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
