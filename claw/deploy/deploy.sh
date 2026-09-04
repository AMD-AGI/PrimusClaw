#!/usr/bin/env bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

# Deployment script for Claw into primus-claw namespace (Helm-based).
# Image building was removed: build & push docker.io/primussafe/claw:<tag>
# out-of-band (e.g. deploy/build.sh) first, then pass TAG=<tag>.
# Usage:
#   TAG=v1.0.0 bash deploy/deploy.sh
#   TAG=v1.0.0 bash deploy/deploy.sh --dry-run
#   TAG=v1.0.0 bash deploy/deploy.sh --skip-pgo --skip-nats --skip-pg
# Note: MinIO is provisioned out-of-band (separate Helm release/namespace);
#       this script no longer manages MinIO. Configure S3_ENDPOINT in
#       configmap.yaml to point at the existing MinIO service.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_SCRIPT_LABEL="deploy"
DRY_RUN=false
SKIP_PGO=false
SKIP_NATS=false
SKIP_PG=false
SKIP_LIFECYCLE=false
SKIP_SHARED_ASSETS=false

# ── Parse flags ──────────────────────────────────────────────────
for arg in "$@"; do
  case "$arg" in
    --dry-run)             DRY_RUN=true ;;
    --skip-pgo)            SKIP_PGO=true ;;
    --skip-nats)           SKIP_NATS=true ;;
    --skip-pg)             SKIP_PG=true ;;
    --skip-lifecycle)      SKIP_LIFECYCLE=true ;;
    --skip-shared-assets)  SKIP_SHARED_ASSETS=true ;;
    --help|-h)
      echo "Usage: REGISTRY=<reg> [TAG=<tag>] DOMAIN=<host> [STORAGE_CLASS=<sc>] $0 [--dry-run] [--skip-pgo] [--skip-nats] [--skip-pg] [--skip-lifecycle] [--skip-shared-assets]"
      echo "  TAG defaults to 'latest' (image building was removed; build & push out-of-band first)."
      echo "  DOMAIN is required (cluster ingress host); pass DOMAIN=<host> or set in values.<ns>.env."
      echo "  --skip-shared-assets: do not cp hands-binary into CLAW_DEPLOY_ROOT (use when host has no weka mount)."
      echo "  PG_SSL_NO_VERIFY=true: keep api's PG connection encrypted but skip server-cert validation (needed for PGO's own CA)."
      echo "  SANDBOX_NAMESPACE: where the agent-sandbox control plane runs (router URL is derived from it)."
      echo "  SANDBOX_WORKLOAD_NAMESPACE: where sandboxes land; empty keeps the chart default."
      echo "  Multi-node GPU clusters require CLAW_DEPLOY_MODE=safe (SaFE Workload API)."
      echo "  Multi-node clusters need the workspace's shared storage mounted; SaFE supplies the paths."
      exit 0 ;;
    *) echo "Unknown flag: $arg"; exit 1 ;;
  esac
done

source "$SCRIPT_DIR/common.sh"
PG_CLUSTER="${PG_CLUSTER:-primus-claw}"
PG_APP_USER="${PG_APP_USER:-primus-claw}"
PG_APP_DB="${PG_APP_DB:-primus-claw}"
PG_USER_SECRET="${PG_USER_SECRET:-${PG_CLUSTER}-pguser-${PG_APP_USER}}"
PG_SUPERUSER_SECRET="${PG_SUPERUSER_SECRET:-${PG_CLUSTER}-pguser-postgres}"
# Skip server-certificate validation on api's PG connection (still encrypted).
# Needed against a PGO-managed database, whose CA no client trust store carries.
PG_SSL_NO_VERIFY="${PG_SSL_NO_VERIFY:-false}"
PG_WAIT_TIMEOUT="${PG_WAIT_TIMEOUT:-600}"
PGO_RELEASE="${PGO_RELEASE:-primus-pgo}"
NATS_RELEASE="${NATS_RELEASE:-primus-claw-nats}"
PGO_CHART="${PGO_CHART:-oci://registry-1.docker.io/primussafe/primus-pgo}"
PGO_VERSION="${PGO_VERSION:-5.8.2}"
PGO_WAIT_TIMEOUT="${PGO_WAIT_TIMEOUT:-180}"

# ── Resolve image TAG (default "latest") ────────────────────────
# Image building was removed from the deploy path: build & push
# $REGISTRY/claw:<tag> out-of-band (e.g. deploy/build.sh), then pass TAG=<tag>.
# Defaults to "latest" when unset. IMG is used by health checks and the
# hands-binary extraction helpers (deploy_shared_assets / deploy_hands_from_image).
TAG="${TAG:-latest}"
IMG="${IMG:-$REGISTRY/claw:$TAG}"
export TAG IMG

# ── Tools this installer cannot run without ───────────────────────────────
#
# Checked here rather than discovered halfway through. python3 renders the Helm
# values file with no fallback path, and openssl generates both NATS passwords
# and the two encryption keys -- so without them the run dies after the PGO
# operator and a 3-node NATS cluster are already installed, leaving a namespace
# half-built. deploy/litellm/deploy.sh already checks exactly this set.
for _tool in kubectl helm python3 openssl; do
  command -v "$_tool" >/dev/null 2>&1 \
    || fail "$_tool not found; it is required by this installer"
done

# Resolve the StorageClass (explicit env, else interactive pick from `kubectl get sc`).
select_storage_class

log "Deploying Claw → namespace=$NAMESPACE  image=$REGISTRY/claw:$TAG  storageClass=$STORAGE_CLASS"

# ── DOMAIN (cluster ingress host for the Claw ingress + the LLM gateway URLs
# ANTHROPIC/OPENAI/BYOK = https://<DOMAIN>/llm-gateway). Provide DOMAIN=... or
# set it in values.<NAMESPACE>.env; prompt interactively when unset on a TTY.
while { [ -z "${DOMAIN:-}" ] || [ "$DOMAIN" = "<DOMAIN>" ]; } && [ -t 0 ]; do
  read -rp "Enter cluster ingress DOMAIN (e.g. cluster.example.com): " DOMAIN || break
  DOMAIN="$(printf '%s' "${DOMAIN:-}" | tr -d '[:space:]')"
done
if [ -z "${DOMAIN:-}" ] || [ "$DOMAIN" = "<DOMAIN>" ]; then
  fail "DOMAIN is required (cluster ingress host). Pass DOMAIN=<host> or set it in deploy/values.${NAMESPACE}.env."
fi
log "DOMAIN=$DOMAIN"

# ── Auto-discover minio-sourced values (S3_ACCESS_KEY/SECRET_KEY, S3_ENDPOINT, S3_API_ENDPOINT) ──
# WARN-only: a missing/unreachable minio release does not abort here —
# the placeholder guard below will surface the specific missing key and
# point operators to values.<NAMESPACE>.env.
resolve_minio_secrets_from_cluster

# ── The placeholder guard three other comments already promise ────────────
#
# common.sh falls back to the literal "<KEY>" for anything the values file
# leaves unset, precisely so this can catch it (see common.sh:187-189, :369
# and values.example.env:13). Only DOMAIN was ever checked; everything else
# went into the Kubernetes Secret as the literal string, where "<S3_SECRET_KEY>"
# becomes the deployment's actual S3 credential and the failure surfaces later
# as an authentication error against object storage, far from its cause.
#
# Checked after the minio lookup so a value that lookup supplied is accepted,
# and before the chart is rendered so nothing reaches the cluster.
_placeholder_missing=()
for _k in S3_ENDPOINT S3_API_ENDPOINT S3_ACCESS_KEY S3_SECRET_KEY USER_ENV_ENCRYPTION_KEY; do
  if [ "${!_k:-}" = "<${_k}>" ] || [ -z "${!_k:-}" ]; then
    _placeholder_missing+=("$_k")
  fi
done
if [ "${#_placeholder_missing[@]}" -gt 0 ]; then
  fail "unset deployment value(s): ${_placeholder_missing[*]}
       These are written into the primus-claw-secrets Secret as-is, so a
       placeholder there becomes the deployment's real credential. Set them in
       deploy/values.${NAMESPACE}.env, or pass them in the environment.
       S3_* are normally discovered from the minio release; that lookup did not
       find them, so supply them yourself."
fi

# ═══════════════════════════════════════════════════════════════════
# Step 1: Crunchy PGO operator (idempotent OCI helm install)
# Also creates the target namespace via --create-namespace.
# ═══════════════════════════════════════════════════════════════════
if ! $SKIP_PGO; then
  log "Step 1/7: Installing PGO operator '$PGO_RELEASE' (chart $PGO_CHART:$PGO_VERSION) into ns=$NAMESPACE ..."
  if helm status "$PGO_RELEASE" -n "$NAMESPACE" >/dev/null 2>&1; then
    log "  PGO release '$PGO_RELEASE' already exists in ns=$NAMESPACE — skipping helm install."
  else
    if $DRY_RUN; then
      log "[dry-run] helm install $PGO_RELEASE -n $NAMESPACE $PGO_CHART --version $PGO_VERSION --create-namespace"
    else
      helm install "$PGO_RELEASE" -n "$NAMESPACE" \
        "$PGO_CHART" --version "$PGO_VERSION" \
        --create-namespace
    fi
  fi

  if ! $DRY_RUN; then
    log "Waiting for PGO operator pod readiness (timeout ${PGO_WAIT_TIMEOUT}s) ..."
    kubectl wait --for=condition=Ready pod \
      -l "postgres-operator.crunchydata.com/control-plane=$PGO_RELEASE" \
      -n "$NAMESPACE" --timeout="${PGO_WAIT_TIMEOUT}s"
  fi
  log "PGO operator ready."
else
  log "Step 1/7: PGO install skipped (--skip-pgo)."
fi

# ═══════════════════════════════════════════════════════════════════
# Step 2: NATS (Helm) with multi-account auth
#
# Account passwords are stored in $NATS_CREDS_FILE (default
# $HOME/.nats-claw-creds.env, override via env). Generated on first
# run; reused on subsequent installs so api/brain pods do not lose
# their connection on `helm upgrade`. Use
# `deploy/scripts/make-dev-account.sh <name>` to add a developer
# account post-bootstrap (it reads/writes the same file).
# ═══════════════════════════════════════════════════════════════════
NATS_CREDS_FILE="${NATS_CREDS_FILE:-$HOME/.nats-claw-creds.env}"
if ! $SKIP_NATS; then
  log "Step 2/7: Installing NATS via Helm with multi-account auth ..."

  # Bootstrap PROD/SYS passwords once; reuse across subsequent installs.
  if [ -f "$NATS_CREDS_FILE" ]; then
    # shellcheck disable=SC1090
    source "$NATS_CREDS_FILE"
  elif $DRY_RUN; then
    NATS_PASSWORD_PROD="dry-run-prod-password"
    NATS_PASSWORD_SYS="dry-run-sys-password"
  else
    log "  Generating PROD + SYS NATS passwords -> $NATS_CREDS_FILE"
    {
      echo "# Auto-generated by deploy.sh on $(date -Iseconds)."
      echo "# DO NOT COMMIT. Operator-managed; required for helm upgrades."
      echo "NATS_PASSWORD_PROD=$(openssl rand -hex 16)"
      echo "NATS_PASSWORD_SYS=$(openssl rand -hex 16)"
    } > "$NATS_CREDS_FILE"
    chmod 600 "$NATS_CREDS_FILE"
    # shellcheck disable=SC1090
    source "$NATS_CREDS_FILE"
  fi

  # Backfill the per-component passwords.
  #
  # These arrived after the creds file did, and the branch above only writes a
  # fresh file -- an existing namespace sources one that predates them and
  # leaves the new variables unset. The sed below substitutes an unset variable
  # with the empty string, which renders four users whose password is "" and
  # authenticates nobody. So append what is missing rather than assuming the
  # file is current, and do it one variable at a time so a file written by a
  # future version with more users still works.
  for _nats_user in API BRAIN REAPER OPS; do
    _nats_var="NATS_PASSWORD_${_nats_user}"
    if [ -z "${!_nats_var:-}" ]; then
      if $DRY_RUN; then
        printf -v "$_nats_var" 'dry-run-%s-password' "$(echo "$_nats_user" | tr '[:upper:]' '[:lower:]')"
      else
        log "  Adding $_nats_var -> $NATS_CREDS_FILE"
        printf -v "$_nats_var" '%s' "$(openssl rand -hex 16)"
        echo "${_nats_var}=${!_nats_var}" >> "$NATS_CREDS_FILE"
      fi
    fi
  done
  unset _nats_user _nats_var

  # Render values file: substitute PROD/SYS passwords and inject one
  # account block per NATS_PASSWORD_DEV_<NAME> entry in the creds file.
  RENDERED_NATS_VALUES="$WORK_DIR/nats-values.rendered.yaml"
  DEV_BLOCKS=""
  if [ -f "$NATS_CREDS_FILE" ]; then
    while IFS='=' read -r key val; do
      case "$key" in
        NATS_PASSWORD_DEV_*)
          acct="${key#NATS_PASSWORD_}"            # e.g. DEV_ZHANGLEI
          devname="$(echo "${acct#DEV_}" | tr '[:upper:]' '[:lower:]' | tr _ -)"
          DEV_BLOCKS+="      ${acct}:\n        jetstream: enabled\n        users:\n          - user: dev-${devname}\n            password: \"${val}\"\n"
          ;;
      esac
    done < <(grep -E '^NATS_PASSWORD_DEV_' "$NATS_CREDS_FILE" || true)
  fi

  # NATS_RETIRE_PROD=true removes the all-access user from the rendered config.
  # Off by default, and deliberately NOT inferred from "are all four
  # per-workload passwords set": a cluster can have them set and still have an
  # out-of-tree client authenticating as prod, and the failure mode of guessing
  # wrong is that client silently losing its connection. It has to be an
  # explicit decision, taken after the connection census described in
  # nats-values.yaml.
  #
  # The flag says "retire it now". The marker in the cluster says "it IS
  # retired", and that is what every later run reads: this step re-renders the
  # whole values file, so a decision remembered only in one shell's environment
  # is undone by the next ordinary deploy. See nats-prod-retirement.sh.
  _strip_prod=""
  _record_retirement=false
  _retire_state=0
  nats_prod_retirement_state || _retire_state=$?
  if [ "$_retire_state" = "2" ]; then
    # Neither guess is safe: assuming "not retired" re-adds the all-access user
    # over a transient API error, and assuming "retired" deletes a credential
    # workloads may still be holding. Rendering is what has to stop.
    fail "cannot read $NATS_PROD_RETIRED_MARKER in $NAMESPACE, so whether the all-access 'prod' NATS user is already retired is unknown. Rendering now would either reinstate it or delete it on a guess. Fix cluster access and re-run."
  fi
  if [ "$_retire_state" = "0" ]; then
    log "  NATS: prod stays retired (marker $NATS_PROD_RETIRED_MARKER in $NAMESPACE)"
    _strip_prod="$NATS_PROD_STRIP_EXPR"
  elif [ "${NATS_RETIRE_PROD:-false}" = "true" ]; then
    # Retirement is gated on all four built-in identities having actually been
    # adopted, not on the operator having looked at a connection census and
    # not on this shell's own inputs. reaper is a CronJob and ops runs only
    # during an upgrade, so a census taken at any given moment can easily show
    # neither -- and reading that as "nothing else uses prod" retires it out
    # from under the workloads that were merely idle. Environment variables are
    # no better on their own: they say what the next render will contain, so
    # exporting the four passwords and retiring in one invocation would pass a
    # check that reads only them while nothing is deployed. The gate asks the
    # cluster and the NATS server instead. See nats_retirement_blockers in
    # common.sh.
    #
    # Loud rather than skipped: an operator who asked for retirement and got a
    # silently unretired cluster would believe the all-access user was gone.
    log "  NATS: verifying every built-in identity is deployed and accepted before retiring prod"
    if ! _blockers="$(nats_retirement_blockers)"; then
      echo "ERROR: NATS_RETIRE_PROD=true, but these identities are not in use yet:" >&2
      printf '%s\n' "$_blockers" | sed 's/^/  - /' >&2
      echo "" >&2
      echo "  Removing the all-access 'prod' user would cut off every workload still" >&2
      echo "  using the shared credential. Add each component to" >&2
      echo "  NATS_PER_USER_WORKLOADS, deploy so it adopts its own identity, confirm" >&2
      echo "  the rollout finished, and retire prod after that -- having also run the" >&2
      echo "  connection census in deploy/nats-values.yaml for clients that are not in" >&2
      echo "  this repo." >&2
      exit 1
    fi
    log "  NATS: retiring the all-access prod user (NATS_RETIRE_PROD=true)"
    log "  NATS: all four built-in identities are deployed and authenticate"
    _strip_prod="$NATS_PROD_STRIP_EXPR"
    _record_retirement=true
  fi
  awk -v block="$DEV_BLOCKS" '
    /# \{\{DEV_ACCOUNTS\}\}/ { printf "%s", block; next }
    { print }
  ' "$SCRIPT_DIR/nats-values.yaml" \
    | { [ -n "$_strip_prod" ] && sed -e "$_strip_prod" || cat; } \
    | sed -e "s|__PROD_NATS_PASSWORD__|${NATS_PASSWORD_PROD}|g" \
          -e "s|__SYS_NATS_PASSWORD__|${NATS_PASSWORD_SYS}|g" \
          -e "s|__API_NATS_PASSWORD__|${NATS_PASSWORD_API}|g" \
          -e "s|__BRAIN_NATS_PASSWORD__|${NATS_PASSWORD_BRAIN}|g" \
          -e "s|__REAPER_NATS_PASSWORD__|${NATS_PASSWORD_REAPER}|g" \
          -e "s|__OPS_NATS_PASSWORD__|${NATS_PASSWORD_OPS}|g" \
    > "$RENDERED_NATS_VALUES"

  # A placeholder that survived rendering means a password variable was unset,
  # and the resulting user would silently accept the literal string as its
  # password. Fail here rather than shipping that to the cluster.
  if grep -q '__[A-Z]*_NATS_PASSWORD__' "$RENDERED_NATS_VALUES"; then
    echo "ERROR: unsubstituted NATS password placeholder in $RENDERED_NATS_VALUES:" >&2
    grep -n '__[A-Z]*_NATS_PASSWORD__' "$RENDERED_NATS_VALUES" >&2
    exit 1
  fi

  if $DRY_RUN; then
    log "[dry-run] helm upgrade --install $NATS_RELEASE nats/nats -n $NAMESPACE -f $RENDERED_NATS_VALUES"
  else
    helm repo add nats https://nats-io.github.io/k8s/helm/charts/ 2>/dev/null || true
    helm repo update nats
    helm upgrade --install "$NATS_RELEASE" nats/nats \
      --version 2.12.6 \
      -n "$NAMESPACE" \
      -f "$RENDERED_NATS_VALUES" \
      --set config.jetstream.fileStore.pvc.storageClassName="$STORAGE_CLASS" \
      --wait --timeout 300s
  fi
  # Only now, with the retiring config actually on the server. A marker written
  # before this would survive a failed upgrade and make every later run strip a
  # user the server still has.
  if $_record_retirement; then
    if $DRY_RUN; then
      log "[dry-run] would record $NATS_PROD_RETIRED_MARKER in $NAMESPACE"
    else
      record_nats_prod_retirement
      log "  NATS: recorded the retirement -- later runs keep prod out without the flag"
    fi
  fi
  log "NATS ready."
else
  log "Step 2/7: NATS skipped (--skip-nats)."
  # Still load whatever passwords a previous run generated. The chart decides
  # per workload whether to use its own NATS user by whether a password is
  # set, so skipping this would quietly hand every component back the shared
  # all-access credential -- a downgrade with no error and no log line.
  #
  # Deliberately does not GENERATE any: without the helm step, nats.conf has
  # not been rendered, and pointing a workload at a user the server does not
  # know about fails authentication outright.
  if [ -f "$NATS_CREDS_FILE" ]; then
    # shellcheck disable=SC1090
    source "$NATS_CREDS_FILE"
  fi
fi

# ═══════════════════════════════════════════════════════════════════
# Step 3: PostgreSQL — provision dedicated PostgresCluster via PGO
# (PGO auto-creates the user, database and pguser secret).
# ═══════════════════════════════════════════════════════════════════
if ! $SKIP_PG; then
  log "Step 3/7: Provisioning PostgresCluster '$PG_CLUSTER' via Crunchy PGO ..."
  if kubectl get postgrescluster "$PG_CLUSTER" -n "$NAMESPACE" >/dev/null 2>&1; then
    log "  PostgresCluster '$PG_CLUSTER' already exists in ns=$NAMESPACE — skipping apply."
  else
    # Render the PostgresCluster from the chart (single source of truth) but
    # apply it imperatively: deploy.sh owns PG create/readiness/grant sequencing
    # (the app release keeps postgres.enabled=false so helm never adopts or, on
    # uninstall, deletes the database).
    render_chart postgrescluster.yaml "$WORK_DIR/postgrescluster.yaml" \
      --set postgres.enabled=true \
      --set-string postgres.clusterName="$PG_CLUSTER" \
      --set-string postgres.appUser="$PG_APP_USER" \
      --set-string postgres.appDb="$PG_APP_DB" \
      --set-string postgres.storageClass="$STORAGE_CLASS"
    kubectl_apply "$WORK_DIR/postgrescluster.yaml"
  fi

  if $DRY_RUN; then
    log "[dry-run] Skipping wait for PostgresCluster readiness."
  else
    log "Waiting for pguser secret '$PG_USER_SECRET' (timeout ${PG_WAIT_TIMEOUT}s) ..."
    SECONDS_WAITED=0
    until kubectl get secret "$PG_USER_SECRET" -n "$NAMESPACE" -o jsonpath='{.data.host}' 2>/dev/null | grep -q .; do
      sleep 5
      SECONDS_WAITED=$((SECONDS_WAITED + 5))
      [[ $SECONDS_WAITED -ge $PG_WAIT_TIMEOUT ]] && fail "Timeout waiting for secret $PG_USER_SECRET"
    done

    log "Waiting for master pod to appear ..."
    SECONDS_WAITED=0
    until kubectl get pod -n "$NAMESPACE" \
        -l "postgres-operator.crunchydata.com/cluster=$PG_CLUSTER,postgres-operator.crunchydata.com/role=master" \
        -o name 2>/dev/null | grep -q .; do
      sleep 5
      SECONDS_WAITED=$((SECONDS_WAITED + 5))
      [[ $SECONDS_WAITED -ge $PG_WAIT_TIMEOUT ]] && fail "Timeout waiting for master pod to appear"
    done

    log "Waiting for master pod readiness ..."
    kubectl wait --for=condition=Ready pod \
      -l "postgres-operator.crunchydata.com/cluster=$PG_CLUSTER,postgres-operator.crunchydata.com/role=master" \
      -n "$NAMESPACE" --timeout="${PG_WAIT_TIMEOUT}s"

    # Postgres 17 revoked CREATE on 'public' from non-owners; the
    # PGO-managed app user therefore cannot CREATE TABLE on first
    # initDb(). Take ownership + grant via a throwaway pod connected
    # as the postgres superuser (idempotent).
    #
    # Also ensure the app database itself exists: older PostgresCluster
    # revisions may not carry spec.users[].databases, so PGO will never
    # auto-create it. We connect to the always-present 'postgres' DB
    # first, create the app DB on demand, then run the grants.
    log "Granting public-schema ownership to app user '$PG_APP_USER' ..."
    PG_HOST=$(kubectl get secret "$PG_SUPERUSER_SECRET" -n "$NAMESPACE" -o jsonpath='{.data.host}'     | base64 -d)
    PG_PORT=$(kubectl get secret "$PG_SUPERUSER_SECRET" -n "$NAMESPACE" -o jsonpath='{.data.port}'     | base64 -d)
    PG_PASS=$(kubectl get secret "$PG_SUPERUSER_SECRET" -n "$NAMESPACE" -o jsonpath='{.data.password}' | base64 -d)
    # Prefer dbname from the pguser secret (source of truth); fall back to PG_APP_DB.
    PG_ACTUAL_DB=$(kubectl get secret "$PG_USER_SECRET" -n "$NAMESPACE" -o jsonpath='{.data.dbname}' 2>/dev/null | base64 -d || true)
    PG_ACTUAL_DB="${PG_ACTUAL_DB:-$PG_APP_DB}"
    kubectl -n "$NAMESPACE" delete pod claw-pg-grant --ignore-not-found --wait=false 2>/dev/null || true
    sleep 2
    kubectl run claw-pg-grant --rm -i --restart=Never \
      -n "$NAMESPACE" \
      --image=registry.developers.crunchydata.com/crunchydata/crunchy-postgres:ubi9-17.4-2516@sha256:f97d6f8ab2f578307e27058d9b43469bef24f2bc822cc4d656e4cf5b0ed11ad4 \
      --env="PGHOST=$PG_HOST" --env="PGPORT=$PG_PORT" \
      --env="PGUSER=postgres" --env="PGPASSWORD=$PG_PASS" \
      --env="PGSSLMODE=require" \
      --command -- bash -c "
        set -e
        # Step 1: ensure app DB exists (connect to postgres first).
        export PGDATABASE=postgres
        if ! psql -tAc \"SELECT 1 FROM pg_database WHERE datname='$PG_ACTUAL_DB'\" | grep -q 1; then
          echo '[init] database $PG_ACTUAL_DB not found, creating ...'
          psql -v ON_ERROR_STOP=1 -c 'CREATE DATABASE \"$PG_ACTUAL_DB\" OWNER \"$PG_APP_USER\"'
        fi
        # Step 2: grant + transfer public schema ownership in the app DB.
        export PGDATABASE=$PG_ACTUAL_DB
        psql -v ON_ERROR_STOP=1 -c 'GRANT ALL ON SCHEMA public TO \"$PG_APP_USER\";'
        psql -v ON_ERROR_STOP=1 -c 'ALTER SCHEMA public OWNER TO \"$PG_APP_USER\";'
        echo 'public schema owner=$PG_APP_USER db=$PG_ACTUAL_DB'
      "
  fi
  log "PG cluster ready."
else
  log "Step 3/7: PG provisioning skipped (--skip-pg)."
fi

# ═══════════════════════════════════════════════════════════════════
# Step 3.5: Deploy Hands source + Node tarball to CLAW_DEPLOY_ROOT
# ═══════════════════════════════════════════════════════════════════
log "Step 3.5: Shared volume asset deploy ..."
if $SKIP_SHARED_ASSETS; then
  log "  --skip-shared-assets set; sandbox will pull hands-binary via Brain HTTP fallback."
else
  deploy_shared_assets
fi

# ═══════════════════════════════════════════════════════════════════
# Step 4: Apply Claw chart
# ═══════════════════════════════════════════════════════════════════
log "Step 4/7: Applying Claw Helm chart ..."

# CLAW_CHART_DIR is provided by common.sh ($SCRIPT_DIR/charts/claw).
CLAW_VALUES_FILE="$WORK_DIR/claw-values.json"
NATS_PASSWORD_EFFECTIVE="${NATS_PASSWORD_PROD:-${NATS_PASSWORD:-__TBD__}}"
export REGISTRY TAG BRAIN_REPLICAS STORAGE_CLASS DOMAIN INGRESS_PATH AUTH_INTERNAL_TOKEN
export USER_ENV_ENCRYPTION_KEY BRAIN_CHECKPOINT_KEY NATS_PASSWORD_EFFECTIVE CLAW_DEPLOY_ROOT
export NATS_PASSWORD_API NATS_PASSWORD_BRAIN NATS_PASSWORD_REAPER NATS_PASSWORD_OPS
export CHECKPOINT_WRITE_VERSION
export S3_ENDPOINT S3_API_ENDPOINT S3_ACCESS_KEY S3_SECRET_KEY
export CLAW_DEPLOY_MODE PG_CLUSTER PG_APP_USER PG_APP_DB PG_USER_SECRET PG_SSL_NO_VERIFY
export SANDBOX_NAMESPACE SANDBOX_WORKLOAD_NAMESPACE SANDBOX_ROUTER_URL
export WORKSPACE_PERSIST_BASE LITELLM_API_BASE
export SAFE_DEFAULT_WORKSPACE
export SANDBOX_WORKLOAD_PRIORITY SANDBOX_DEFAULT_TIMEOUT_SECONDS SANDBOX_PENDING_TIMEOUT_SECONDS
export MULTI_NODE_DEFAULT_TIMEOUT_SECONDS
export S3_BUCKET INGRESS_CLASS
export DEFAULT_SANDBOX_IMAGE DEFAULT_SANDBOX_CPU DEFAULT_SANDBOX_MEMORY

python3 - "$CLAW_VALUES_FILE" <<'PY'
import json
import os
import sys

def env(name, default=""):
    return os.environ.get(name, default)

def models_url(base_url):
    """Normalize an LLM provider base URL to its models endpoint."""
    base = base_url.rstrip("/")
    if base.endswith("/models"):
        return base
    if base.endswith("/v1"):
        return f"{base}/models"
    return f"{base}/v1/models"

gateway_base = f"https://{env('DOMAIN')}/llm-gateway"
anthropic_base = env("ANTHROPIC_BASE_URL", gateway_base)
openai_base = env("OPENAI_BASE_URL", gateway_base)
llm_api_style = env("LLM_API_STYLE", "anthropic")
if llm_api_style not in {"anthropic", "openai"}:
    raise SystemExit("LLM_API_STYLE must be either 'anthropic' or 'openai'")
provider_base = openai_base if llm_api_style == "openai" else anthropic_base
# Prompt caching. These have to travel the same path as LLM_API_STYLE: a
# setting the image reads but the chart never writes is a setting that is
# always at its default, and the one that matters here defaults to sending no
# markers at all. An OpenAI-shaped endpoint that fronts Anthropic caches
# nothing until a deployment says so, and there is no way to ask the URL.
prompt_cache_enabled = env("PROMPT_CACHE_ENABLED", "true")
if prompt_cache_enabled not in {"true", "false"}:
    raise SystemExit("PROMPT_CACHE_ENABLED must be either 'true' or 'false'")
llm_cache_ttl = env("LLM_CACHE_TTL", "1h")
if llm_cache_ttl not in {"5m", "1h"}:
    raise SystemExit("LLM_CACHE_TTL must be either '5m' or '1h'")
llm_cache_style = env("LLM_CACHE_STYLE", "off")
if llm_cache_style not in {"off", "anthropic", "native"}:
    raise SystemExit("LLM_CACHE_STYLE must be one of 'off', 'anthropic', 'native'")
# Where the agent-sandbox control plane runs, which is what the router URL is
# derived from. Where sandbox workloads land is a separate decision the chart
# already defaults for a fresh cluster, so it is only overridden below when the
# operator names a namespace of their own.
sandbox_namespace = env("SANDBOX_NAMESPACE", "agent-sandbox-system")
sandbox_workload_namespace = env("SANDBOX_WORKLOAD_NAMESPACE")

values = {
    "image": {
        "registry": env("REGISTRY"),
        "repository": "claw",
        "tag": env("TAG"),
        "pullPolicy": "IfNotPresent",
    },
    "brain": {
        "replicas": int(env("BRAIN_REPLICAS", "3")),
        # Defaults to 3 in the chart and in the code; passed explicitly so an
        # operator can move the fleet to sealed checkpoints without editing
        # values by hand. See values.yaml for the three preconditions.
        "checkpointWriteVersion": int(env("CHECKPOINT_WRITE_VERSION", "3")),
    },
    "api": {
        # Browser origins allowed to call the API with credentials. Empty --
        # the default -- means no cross-origin access at all, which is correct
        # for this chart: the ingress serves the API and the frontend under one
        # host, so nothing it deploys is cross-origin. Set it only for a
        # browser somewhere else. See api.corsOrigins in the chart's values.yaml.
        "corsOrigins": env("CORS_ORIGINS"),
    },
    "postgres": {
        # deploy.sh still owns PostgresCluster creation/readiness/grants.
        "enabled": False,
        "clusterName": env("PG_CLUSTER"),
        "appUser": env("PG_APP_USER"),
        "appDb": env("PG_APP_DB"),
        "userSecretName": env("PG_USER_SECRET"),
        "storageClass": env("STORAGE_CLASS"),
        "sslNoVerify": env("PG_SSL_NO_VERIFY", "false").lower() == "true",
    },
    "ingress": {
        "enabled": True,
        # Higress is what this repo's reference cluster runs, not a
        # requirement. The chart only emits higress.io/* annotations when the
        # class is actually higress, so pointing this at nginx or traefik
        # produces a plain Ingress rather than one decorated for a controller
        # that is not there.
        "className": env("INGRESS_CLASS", "higress"),
        "host": env("DOMAIN"),
        "path": env("INGRESS_PATH", "/claw-api"),
    },
    "secret": {
        "authInternalToken": env("AUTH_INTERNAL_TOKEN"),
        "userEnvEncryptionKey": env("USER_ENV_ENCRYPTION_KEY"),
        "brainCheckpointKey": env("BRAIN_CHECKPOINT_KEY"),
        # A workload switches to its own NATS user only when it is named in
        # NATS_PER_USER_WORKLOADS. Passing all four at once would move the
        # whole fleet in one step, and the rollout order exists because the
        # components fail at very different volumes: reaper exits non-zero, api
        # is fatal on consumer setup, brain is mostly fail-open and is the one
        # where a missing subject looks like nothing at all.
        #
        # Empty by default, which keeps every component on the shared
        # credential. The users still get created in nats.conf either way, so
        # adopting one later is a redeploy and not a NATS change.
        "natsUsers": {
            c: {
                "user": c,
                "password": (
                    env("NATS_PASSWORD_" + c.upper())
                    if c in {w.strip() for w in env("NATS_PER_USER_WORKLOADS").split(",") if w.strip()}
                    else ""
                ),
            }
            for c in ("api", "brain", "reaper", "ops")
        },
        "natsPassword": env("NATS_PASSWORD_EFFECTIVE"),
        "clawDeployMode": env("CLAW_DEPLOY_MODE", "kubernetes"),
        "sandboxRouterUrl": env(
            "SANDBOX_ROUTER_URL",
            f"http://agent-sandbox-router.{sandbox_namespace}.svc.cluster.local:8080",
        ),
        "clawDeployRoot": env("CLAW_DEPLOY_ROOT"),
        "workspacePersistBase": env("WORKSPACE_PERSIST_BASE"),
        "litellmApiBase": env("LITELLM_API_BASE"),
        "safeDefaultWorkspace": env("SAFE_DEFAULT_WORKSPACE", "default"),
        "sandboxWorkloadPriority": env("SANDBOX_WORKLOAD_PRIORITY", "0"),
        "sandboxDefaultTimeoutSeconds": env("SANDBOX_DEFAULT_TIMEOUT_SECONDS", "86400"),
        "sandboxPendingTimeoutSeconds": env("SANDBOX_PENDING_TIMEOUT_SECONDS", "10800"),
        "multiNodeDefaultTimeoutSeconds": env(
            "MULTI_NODE_DEFAULT_TIMEOUT_SECONDS",
            "86400",
        ),
        "llmApiStyle": llm_api_style,
        "promptCacheEnabled": prompt_cache_enabled,
        "llmCacheTtl": llm_cache_ttl,
        "llmCacheStyle": llm_cache_style,
        "llmDebugResponseHeaders": env("LLM_DEBUG_RESPONSE_HEADERS"),
        "anthropicBaseUrl": anthropic_base,
        "openaiBaseUrl": openai_base,
        "byokVerifyModelsUrl": env("BYOK_VERIFY_MODELS_URL", models_url(provider_base)),
        "byokVerifyApiStyle": env("BYOK_VERIFY_API_STYLE", "openai"),
        "s3Bucket": env("S3_BUCKET", "claw"),
        "s3Endpoint": env("S3_ENDPOINT"),
        "s3ApiEndpoint": env("S3_API_ENDPOINT"),
        "s3AccessKey": env("S3_ACCESS_KEY"),
        "s3SecretKey": env("S3_SECRET_KEY"),
    },
}

# The type='default' row the API seeds on first migration. Without an image
# here every caller has to name `sandbox_image` itself; cpu/memory are seeded
# either way. Only sent when the operator set one, so the chart's own default
# stays in charge otherwise.
default_sandbox_image = env("DEFAULT_SANDBOX_IMAGE")
if default_sandbox_image:
    values["defaultSandbox"] = {"image": default_sandbox_image}
    for key, var in (("cpu", "DEFAULT_SANDBOX_CPU"), ("memory", "DEFAULT_SANDBOX_MEMORY")):
        if env(var):
            values["defaultSandbox"][key] = env(var)

# Sandbox lifetime. Only sent when the operator set one, so a deployment that
# configures nothing renders exactly what the chart already rendered -- and
# so a base sandbox template that carries its own value keeps it.
#
# These have to be here and not only in render_chart: this script installs the
# whole release with `helm upgrade --install -f`, so a knob wired only into
# render_chart reaches upgrade.sh's re-rendered Deployment and never reaches a
# fresh deploy at all.
for _key, _var in (
    ("sessionTimeout", "AGENT_SANDBOX_SESSION_TIMEOUT"),
    ("maxSessionDuration", "AGENT_SANDBOX_MAX_SESSION_DURATION"),
):
    if env(_var):
        values["brain"][_key] = env(_var)

if sandbox_workload_namespace:
    values["secret"]["sandboxNamespace"] = sandbox_workload_namespace

with open(sys.argv[1], "w", encoding="utf-8") as f:
    json.dump(values, f, indent=2)
PY

if $DRY_RUN; then
  helm upgrade --install primus-claw "$CLAW_CHART_DIR" \
    -n "$NAMESPACE" --create-namespace -f "$CLAW_VALUES_FILE" --dry-run --debug >/dev/null
else
  helm upgrade --install primus-claw "$CLAW_CHART_DIR" \
    -n "$NAMESPACE" --create-namespace -f "$CLAW_VALUES_FILE" --wait --timeout 300s
fi

log "Claw chart applied."

# ═══════════════════════════════════════════════════════════════════
# Step 5: Wait for rollout
# ═══════════════════════════════════════════════════════════════════
if ! $DRY_RUN; then
  log "Step 5/7: Waiting for rollout ..."
  kubectl rollout status deployment/primus-claw-api -n "$NAMESPACE" --timeout=180s
  kubectl rollout status deployment/primus-claw-brain -n "$NAMESPACE" --timeout=300s
  log "Rollout complete."
else
  log "Step 5/7: [dry-run] Skipping rollout wait."
fi

# ═══════════════════════════════════════════════════════════════════
# Step 6: Health check
# ═══════════════════════════════════════════════════════════════════
if ! $DRY_RUN; then
  log "Step 6/7: Running health checks ..."
  API_SVC="primus-claw-api.$NAMESPACE.svc.cluster.local:80"

  # Use a throwaway pod to curl the internal service
  kubectl delete pod claw-health-check -n "$NAMESPACE" --ignore-not-found --wait=false 2>/dev/null || true
  sleep 2

  HEALTH=$(kubectl run claw-health-check --rm -i --restart=Never \
    -n "$NAMESPACE" \
    --image="$IMG" \
    --command -- curl -sf "http://$API_SVC/health" 2>&1) || true

  if echo "$HEALTH" | grep -qi 'ok\|healthy\|status'; then
    log "API health check PASSED: $HEALTH"
  else
    log "WARNING: API health check returned unexpected response: $HEALTH"
    log "The pods may still be starting. Check: kubectl get pods -n $NAMESPACE -l app=primus-claw"
  fi
else
  log "Step 6/7: [dry-run] Skipping health check."
fi

# ═══════════════════════════════════════════════════════════════════
# Step 7: MinIO lifecycle rules (optional, against external MinIO)
# ═══════════════════════════════════════════════════════════════════
if ! $SKIP_LIFECYCLE; then
  log "Step 7/7: MinIO lifecycle rules — manual step (external MinIO)."
  log "  Run from repo root:"
  log "    bash -c 'set -a && source .env && set +a && cd claw && python3 deploy/minio-lifecycle.py'"
else
  log "Step 7/7: Lifecycle rules skipped (--skip-lifecycle)."
fi

log "════════════════════════════════════════════════════════"
log "Claw deployment to $NAMESPACE complete!"
log "  API:   kubectl get pods -n $NAMESPACE -l component=primus-claw-api"
log "  Brain: kubectl get pods -n $NAMESPACE -l component=primus-claw-brain"
log "  NATS:  kubectl get pods -n $NAMESPACE -l app.kubernetes.io/instance=$NATS_RELEASE"
log "════════════════════════════════════════════════════════"
