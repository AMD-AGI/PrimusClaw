#!/usr/bin/env bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

# import-plugins.sh
#
# Restore a marketplace dump (produced by migrate-plugins.sh) into the
# CURRENT cluster — meant to be executed directly on the target cluster's
# mgmt node, so it relies on whatever kubectl finds via $KUBECONFIG /
# ~/.kube/config (no explicit kubeconfig argument).
#
# Convention (assumed identical to the source cluster the dump came from):
#   - namespace primus-claw with Crunchy PGO cluster
#       label postgres-operator.crunchydata.com/role=master
#       pguser secret  : primus-claw-pguser-primus-claw
#       app  secret    : primus-claw-secrets  (S3_ACCESS_KEY / S3_SECRET_KEY)
#   - namespace minio with svc minio
#   - S3 bucket name "plugins"
#
# Because keys may have rotated between the dump and the import (different
# cluster has its own random pguser password, MinIO AK/SK, etc.), the
# script always reads credentials from the TARGET secrets at run time and
# never reuses anything from the dump or the source. The credentials are
# shown to the operator in masked form before importing so a wrong target
# cluster is caught visually.
#
# Usage:
#   ./import-plugins.sh <dump-dir>                # full import (DB + S3)
#   ./import-plugins.sh <dump-dir> --db-only      # tables only
#   ./import-plugins.sh <dump-dir> --s3-only      # bucket only
#
# Env overrides (defaults shown):
#   USE_SUDO=true          # kubectl runs under sudo on c04u07; set false elsewhere
#   YES=false              # skip the interactive confirmation
#   S3_PORT_FWD=19000      # local port for the temporary minio port-forward
#   KUBECONFIG=...         # standard kubectl env; honored automatically

set -euo pipefail

# ── Resolve migrate-plugins.sh next to this script (no hardcoded repo paths) ─
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATE="${MIGRATE_PLUGINS_SCRIPT:-${SCRIPT_DIR}/migrate-plugins.sh}"
[[ -f "${MIGRATE}" ]] || { echo "[ERR]  missing: ${MIGRATE} (expected alongside import-plugins.sh)" >&2; exit 1; }

# ── Args ────────────────────────────────────────────────────────────────────
DUMP_DIR="${1:-}"
MODE="${2:-full}"

usage() {
    cat >&2 <<USAGE
import-plugins.sh — restore marketplace dump into the CURRENT cluster

Usage:
  $0 <dump-dir>                # full import (DB + S3)
  $0 <dump-dir> --db-only      # tables only
  $0 <dump-dir> --s3-only      # bucket only

Env:
  USE_SUDO=true              # set false on hosts where kubectl needs no sudo
  YES=false                  # set true to skip the confirmation prompt
  S3_PORT_FWD=19000          # local port for the temporary minio port-forward
USAGE
    exit 2
}
[[ -z "${DUMP_DIR}" ]]   && usage
[[ -d "${DUMP_DIR}" ]]   || { echo "[ERR]  dump dir not found: ${DUMP_DIR}" >&2; exit 1; }

# ── Colors + helpers ────────────────────────────────────────────────────────
GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
say() { echo -e "${CYAN}[INFO]${NC} $*"; }
ok()  { echo -e "${GREEN}[OK]${NC}   $*"; }
die() { echo -e "${RED}[ERR]${NC}  $*"; exit 1; }

USE_SUDO="${USE_SUDO:-true}"
# Wrap kubectl uniformly. No --kubeconfig: we rely on $KUBECONFIG or the
# default ~/.kube/config of whichever user invokes the script (under sudo
# when USE_SUDO=true).
kctl() {
    if [[ "${USE_SUDO}" == "true" ]]; then
        sudo kubectl "$@"
    else
        kubectl "$@"
    fi
}

# Mask a secret value: show first 4 chars + length, keeps content out of logs.
mask() {
    local s="${1:-}"
    if [[ -z "${s}" ]]; then
        echo "<empty>"
    elif (( ${#s} <= 4 )); then
        echo "<${#s} chars>"
    else
        echo "${s:0:4}*** (${#s} chars)"
    fi
}

# ── Dump contents pre-check ────────────────────────────────────────────────
TABLES_DUMP_OK=true
for t in tools plugins resources; do
    [[ -f "${DUMP_DIR}/${t}.sql" ]] || TABLES_DUMP_OK=false
done
S3_DUMP_OK=true
[[ -d "${DUMP_DIR}/s3-plugins" ]] || S3_DUMP_OK=false

case "${MODE}" in
    full)
        ${TABLES_DUMP_OK} || die "DB sql files missing in ${DUMP_DIR} (need tools/plugins/resources.sql)"
        ${S3_DUMP_OK}     || die "s3-plugins/ missing in ${DUMP_DIR}"
        ;;
    --db-only)
        ${TABLES_DUMP_OK} || die "DB sql files missing in ${DUMP_DIR}"
        ;;
    --s3-only)
        ${S3_DUMP_OK}     || die "s3-plugins/ missing in ${DUMP_DIR}"
        ;;
    *) usage ;;
esac

# ── Show target cluster identity ────────────────────────────────────────────
CTX=$(kctl config current-context 2>/dev/null || echo "<unknown>")
SERVER=$(kctl config view --minify -o jsonpath='{.clusters[0].cluster.server}' 2>/dev/null || echo "<unknown>")

echo -e "\n${YELLOW}═══════════════════════════════════════════════════════════${NC}"
echo -e "${YELLOW}  Marketplace Import${NC}"
echo -e "${YELLOW}═══════════════════════════════════════════════════════════${NC}"
echo "  Target cluster context : ${CTX}"
echo "  Target API server      : ${SERVER}"
echo "  Dump source            : ${DUMP_DIR}"
echo "  Mode                   : ${MODE}"
echo ""
echo "  Will write to target namespaces:"
echo "    primus-claw   Postgres (3 tables: tools / plugins / resources)"
echo "    minio         MinIO bucket 'plugins'  (S3 objects)"
echo ""
echo "  Dump contents detected:"
echo "    DB tables             : $(${TABLES_DUMP_OK} && echo present || echo MISSING)"
echo "    S3 plugins bucket     : $(${S3_DUMP_OK} && echo present || echo MISSING)"
echo ""

# ── Pre-flight reachability + secret inspection ─────────────────────────────
say "Pre-flight reachability on target ..."
PRIMARY=$(kctl get pod -n primus-claw -l postgres-operator.crunchydata.com/role=master \
          -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
[[ -n "${PRIMARY}" ]] || die "no PG primary pod in ns=primus-claw with label postgres-operator.crunchydata.com/role=master"
ok "PG primary pod: ${PRIMARY}"

kctl get secret -n primus-claw primus-claw-pguser-primus-claw >/dev/null 2>&1 \
    || die "secret primus-claw-pguser-primus-claw missing in ns=primus-claw"
ok "secret primus-claw-pguser-primus-claw present"

if [[ "${MODE}" != "--db-only" ]]; then
    kctl get svc -n minio minio >/dev/null 2>&1 \
        || die "MinIO svc 'minio' missing in ns=minio"
    ok "MinIO svc 'minio' present"

    kctl get secret -n primus-claw primus-claw-secrets >/dev/null 2>&1 \
        || die "secret primus-claw-secrets missing in ns=primus-claw"
    ok "secret primus-claw-secrets present"
fi

# ── Read target credentials NOW (keys may differ from source) ───────────────
echo ""
say "Reading TARGET credentials (live, in case they rotated since the dump):"

PG_USER=$(kctl -n primus-claw get secret primus-claw-pguser-primus-claw \
            -o jsonpath='{.data.user}'   | base64 -d)
PG_DB=$(  kctl -n primus-claw get secret primus-claw-pguser-primus-claw \
            -o jsonpath='{.data.dbname}' | base64 -d)
PG_PASS=$(kctl -n primus-claw get secret primus-claw-pguser-primus-claw \
            -o jsonpath='{.data.password}' | base64 -d)
echo "  PG user      : ${PG_USER}"
echo "  PG dbname    : ${PG_DB}"
echo "  PG password  : $(mask "${PG_PASS}")"
[[ -n "${PG_USER}" && -n "${PG_DB}" && -n "${PG_PASS}" ]] \
    || die "pguser secret is missing one of user/dbname/password"

if [[ "${MODE}" != "--db-only" ]]; then
    S3_AK=$(kctl -n primus-claw get secret primus-claw-secrets \
              -o jsonpath='{.data.S3_ACCESS_KEY}' | base64 -d)
    S3_SK=$(kctl -n primus-claw get secret primus-claw-secrets \
              -o jsonpath='{.data.S3_SECRET_KEY}' | base64 -d)
    S3_EP=$(kctl -n primus-claw get secret primus-claw-secrets \
              -o jsonpath='{.data.S3_API_ENDPOINT}' | base64 -d 2>/dev/null || true)
    echo "  S3 endpoint  : ${S3_EP:-<not in secret>}  (script will port-forward 'minio' svc instead)"
    echo "  S3 AK        : $(mask "${S3_AK}")"
    echo "  S3 SK        : $(mask "${S3_SK}")"
    [[ -n "${S3_AK}" && -n "${S3_SK}" ]] \
        || die "S3_ACCESS_KEY / S3_SECRET_KEY missing in primus-claw-secrets"
fi

# ── Confirm ─────────────────────────────────────────────────────────────────
if [[ "${YES:-false}" != "true" ]]; then
    echo ""
    read -r -p "  Confirm import to cluster '${CTX}'? [yes/N] " ans
    [[ "${ans}" == "yes" || "${ans}" == "y" ]] || { echo "Aborted."; exit 0; }
fi

# ── Dispatch via migrate-plugins.sh with all TARGET_* env ───────────────────
# TARGET_KUBECONFIG intentionally empty: migrate-plugins.sh's kctl()
# treats empty kubeconfig as "use defaults", matching this script's mode.
export TARGET_KUBECONFIG=""
export TARGET_NS="primus-claw"
export TARGET_PGUSER_SECRET="primus-claw-pguser-primus-claw"
export TARGET_PG_ROLE_LABEL="postgres-operator.crunchydata.com/role=master"
export TARGET_S3_SECRET="primus-claw-secrets"
export TARGET_S3_SECRET_NS="primus-claw"
export TARGET_MINIO_NS="minio"
export TARGET_MINIO_SVC="minio"
export CONFIRM_TARGET=true
export USE_SUDO="${USE_SUDO}"
export S3_PORT_FWD="${S3_PORT_FWD:-19000}"

case "${MODE}" in
    full)        bash "${MIGRATE}" restore-full "${DUMP_DIR}" ;;
    --db-only)   bash "${MIGRATE}" restore-db   "${DUMP_DIR}" ;;
    --s3-only)   bash "${MIGRATE}" restore-s3   "${DUMP_DIR}" ;;
esac

echo ""
ok "Import complete."

