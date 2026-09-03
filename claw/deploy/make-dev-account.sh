#!/usr/bin/env bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

# Self-service NATS dev-account provisioner.
#
# Usage:
#   bash deploy/scripts/make-dev-account.sh <devname>
#
# What it does:
#   1. Generates a random password for account DEV_<DEVNAME>.
#   2. Records it in $NATS_CREDS_FILE (default $HOME/.nats-claw-creds.env).
#   3. Renders deploy/nats-values.yaml with all PROD/SYS/DEV_*
#      accounts injected from the creds file and runs `helm upgrade`.
#   4. Prints NATS_USER / NATS_PASSWORD lines for the developer to add
#      to their local .env.
#
# Idempotent: re-running with the same devname re-prints existing creds
# and does not regenerate the password.
#
# Required:
#   - kubectl + helm in PATH, KUBECONFIG pointing at the target cluster.
#   - The NATS Helm release (default "primus-claw-nats") already installed
#     by deploy.sh (PROD/SYS account passwords already in the creds file).

set -euo pipefail

DEVNAME="${1:-}"
if [ -z "$DEVNAME" ]; then
  echo "Usage: $0 <devname>" >&2
  exit 1
fi
if ! [[ "$DEVNAME" =~ ^[a-z0-9-]+$ ]]; then
  echo "ERROR: devname must match [a-z0-9-]+, got '$DEVNAME'" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
VALUES_TEMPLATE="$DEPLOY_DIR/nats-values.yaml"
CREDS_FILE="${NATS_CREDS_FILE:-$HOME/.nats-claw-creds.env}"
NAMESPACE="${NAMESPACE:-primus-claw}"
NATS_RELEASE="${NATS_RELEASE:-primus-claw-nats}"
STORAGE_CLASS="${STORAGE_CLASS:-rbd}"

ACCOUNT_KEY="DEV_$(echo "$DEVNAME" | tr '[:lower:]' '[:upper:]' | tr - _)"
USER_NAME="dev-${DEVNAME}"
PASS_VAR="NATS_PASSWORD_${ACCOUNT_KEY}"

if [ ! -f "$CREDS_FILE" ]; then
  echo "ERROR: $CREDS_FILE missing — run deploy.sh first to bootstrap PROD/SYS." >&2
  exit 1
fi

# Idempotency: if already provisioned, just print creds and exit.
if grep -q "^${PASS_VAR}=" "$CREDS_FILE"; then
  EXISTING_PASS="$(grep "^${PASS_VAR}=" "$CREDS_FILE" | head -n1 | cut -d= -f2-)"
  echo "Account $ACCOUNT_KEY already exists. Existing creds:"
  echo
  echo "  NATS_USER=$USER_NAME"
  echo "  NATS_PASSWORD=$EXISTING_PASS"
  exit 0
fi

NEW_PASS="$(openssl rand -hex 16)"
echo "${PASS_VAR}=${NEW_PASS}" >> "$CREDS_FILE"

# shellcheck disable=SC1090
source "$CREDS_FILE"

# Render values file: PROD + SYS passwords + ALL dev account blocks.
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT
RENDERED="$WORK_DIR/nats-values.rendered.yaml"

DEV_BLOCKS=""
while IFS='=' read -r key val; do
  case "$key" in
    NATS_PASSWORD_DEV_*)
      acct="${key#NATS_PASSWORD_}"            # e.g. DEV_ZHANGLEI
      dn="$(echo "${acct#DEV_}" | tr '[:upper:]' '[:lower:]' | tr _ -)"
      DEV_BLOCKS+="      ${acct}:\n        jetstream: enabled\n        users:\n          - user: dev-${dn}\n            password: \"${val}\"\n"
      ;;
  esac
done < <(grep -E '^NATS_PASSWORD_DEV_' "$CREDS_FILE" || true)

awk -v block="$DEV_BLOCKS" '
  /# \{\{DEV_ACCOUNTS\}\}/ { printf "%s", block; next }
  { print }
' "$VALUES_TEMPLATE" \
  | sed -e "s|__PROD_NATS_PASSWORD__|${NATS_PASSWORD_PROD}|g" \
        -e "s|__SYS_NATS_PASSWORD__|${NATS_PASSWORD_SYS}|g" \
  > "$RENDERED"

echo "Running helm upgrade ..."
helm repo add nats https://nats-io.github.io/k8s/helm/charts/ 2>/dev/null || true
helm repo update nats >/dev/null 2>&1 || true
helm upgrade --install "$NATS_RELEASE" nats/nats \
  --version 2.12.6 \
  -n "$NAMESPACE" \
  -f "$RENDERED" \
  --set config.jetstream.fileStore.pvc.storageClassName="$STORAGE_CLASS" \
  --wait --timeout 300s

echo
echo "════════════════════════════════════════════════════════"
echo "Dev account provisioned. Add the following to your local .env:"
echo
echo "  NATS_USER=${USER_NAME}"
echo "  NATS_PASSWORD=${NEW_PASS}"
echo
echo "Then start your local stack:"
echo "  ./start_harness.sh"
echo "════════════════════════════════════════════════════════"
