#!/usr/bin/env bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

# list-plugins.sh — read-only inventory of marketplace DB + S3 (current cluster or dump dir)
#
# Usage:
#   ./list-plugins.sh                    # DB + S3 on current cluster
#   ./list-plugins.sh --db-only          # Postgres tables only
#   ./list-plugins.sh --s3-only          # MinIO plugins bucket summary
#   ./list-plugins.sh --s3-detail        # every object key + size (recursive)
#   ./list-plugins.sh --s3-detail --prefix plugins/   # under prefix only
#   ./list-plugins.sh <dump-dir>         # local dump manifest + files (no cluster access)
#   ./list-plugins.sh <dump-dir> --s3-only
#   ./list-plugins.sh <dump-dir> --s3-detail
#
# Env overrides (defaults shown):
#   USE_SUDO=true
#   NS=primus-claw
#   PGUSER_SECRET=primus-claw-pguser-primus-claw
#   PG_ROLE_LABEL=postgres-operator.crunchydata.com/role=master
#   S3_SECRET=primus-claw-secrets
#   S3_SECRET_NS=primus-claw
#   MINIO_NS=minio
#   MINIO_SVC=minio
#   S3_BUCKET=plugins
#   S3_PORT_FWD=19000
#   MC_IMAGE=minio/mc:latest
#   LIST_LIMIT=30                        # max rows per table preview
#   S3_PREFIX=                           # optional key prefix, e.g. plugins/ or tools/
#   S3_DETAIL=false                      # set true with --s3-detail

set -euo pipefail

NS="${NS:-primus-claw}"
PGUSER_SECRET="${PGUSER_SECRET:-primus-claw-pguser-primus-claw}"
PG_ROLE_LABEL="${PG_ROLE_LABEL:-postgres-operator.crunchydata.com/role=master}"
S3_SECRET="${S3_SECRET:-primus-claw-secrets}"
S3_SECRET_NS="${S3_SECRET_NS:-primus-claw}"
MINIO_NS="${MINIO_NS:-minio}"
MINIO_SVC="${MINIO_SVC:-minio}"
S3_BUCKET="${S3_BUCKET:-plugins}"
S3_PORT_FWD="${S3_PORT_FWD:-19000}"
MC_IMAGE="${MC_IMAGE:-minio/mc:latest}"
USE_SUDO="${USE_SUDO:-true}"
LIST_LIMIT="${LIST_LIMIT:-30}"
TABLES="${TABLES:-tools plugins resources}"
S3_PREFIX="${S3_PREFIX:-}"
S3_DETAIL="${S3_DETAIL:-false}"

_migrate_pf_pid=""

GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log()  { echo -e "${CYAN}[INFO]${NC} $*"; }
ok()   { echo -e "${GREEN}[OK]${NC}   $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
err()  { echo -e "${RED}[ERR]${NC}  $*"; exit 1; }
section() { echo -e "\n${YELLOW}════ $* ════${NC}"; }

usage() {
    cat >&2 <<USAGE
list-plugins.sh — marketplace inventory (read-only)

Usage:
  $0                         # DB + S3 on current cluster
  $0 --db-only               # Postgres only
  $0 --s3-only               # MinIO plugins bucket summary
  $0 --s3-detail             # list every object (key, size, time)
  $0 --s3-detail --prefix plugins/   # only keys under prefix
  $0 <dump-dir>              # local dump files only
  $0 <dump-dir> --db-only    # SQL files in dump
  $0 <dump-dir> --s3-only    # s3-plugins/ tree summary
  $0 <dump-dir> --s3-detail  # list every file under s3-plugins/
USAGE
    exit 2
}

kctl() {
    if [[ "${USE_SUDO}" == "true" ]]; then
        sudo kubectl "$@"
    else
        kubectl "$@"
    fi
}

_cleanup_pf() {
    if [[ -n "${_migrate_pf_pid:-}" ]]; then
        kill "${_migrate_pf_pid}" 2>/dev/null || true
        _migrate_pf_pid=""
    fi
}

resolve_plugins_bucket() {
    local from_secret
    from_secret=$(kctl -n "${S3_SECRET_NS}" get secret "${S3_SECRET}" \
        -o jsonpath='{.data.S3_PLUGINS_BUCKET}' 2>/dev/null | base64 -d 2>/dev/null || true)
    if [[ -n "${from_secret}" ]]; then
        S3_BUCKET="${from_secret}"
    fi
}

get_primary_pod() {
    kctl -n "${NS}" get pod -l "${PG_ROLE_LABEL}" \
        -o jsonpath='{.items[0].metadata.name}' 2>/dev/null \
        || err "no PG primary in ns=${NS}"
}

build_uri() {
    local user pass db
    user=$(kctl -n "${NS}" get secret "${PGUSER_SECRET}" -o jsonpath='{.data.user}'     | base64 -d)
    pass=$(kctl -n "${NS}" get secret "${PGUSER_SECRET}" -o jsonpath='{.data.password}' | base64 -d)
    db=$(  kctl -n "${NS}" get secret "${PGUSER_SECRET}" -o jsonpath='{.data.dbname}'   | base64 -d)
    [[ -n "${user}" && -n "${pass}" && -n "${db}" ]] \
        || err "secret ${PGUSER_SECRET} missing user/password/dbname"
    printf 'postgresql://%s:%s@localhost:5432/%s' "${user}" "${pass}" "${db}"
}

psql_in_pod() {
    local pod="$1" uri="$2" sql="$3"
    kctl -n "${NS}" exec "${pod}" -c database -- \
        bash -c "PAGER= psql '${uri}' -v ON_ERROR_STOP=1 -c \"${sql}\""
}

psql_file_in_pod() {
    local pod="$1" uri="$2"
    kctl -n "${NS}" exec -i "${pod}" -c database -- \
        bash -c "PAGER= psql '${uri}' -v ON_ERROR_STOP=1 -f -"
}

# Print row counts and sizes for marketplace tables.
list_cluster_db() {
    section "Postgres (ns=${NS})"
    local ctx server pod uri
    ctx=$(kctl config current-context 2>/dev/null || echo "<unknown>")
    server=$(kctl config view --minify -o jsonpath='{.clusters[0].cluster.server}' 2>/dev/null || echo "<unknown>")
    echo "  context : ${ctx}"
    echo "  server  : ${server}"

    pod=$(get_primary_pod)
    uri=$(build_uri)
    log "PG primary pod: ${pod}"

    local q=""
    for t in ${TABLES}; do
        [[ -n "${q}" ]] && q+=" UNION ALL "
        q+="SELECT '${t}' AS table_name, count(*) AS rows,
            pg_size_pretty(pg_total_relation_size('${t}'::regclass)) AS total_size
            FROM ${t}"
    done
    q+=" ORDER BY 1"
    psql_in_pod "${pod}" "${uri}" "${q}"

    echo ""
    log "active plugins (deleted_at IS NULL, limit ${LIST_LIMIT}):"
    psql_in_pod "${pod}" "${uri}" \
        "SELECT id, name, version, status FROM plugins WHERE deleted_at IS NULL ORDER BY id LIMIT ${LIST_LIMIT};"

    echo ""
    log "active tools (deleted_at IS NULL, limit ${LIST_LIMIT}):"
    psql_in_pod "${pod}" "${uri}" \
        "SELECT id, type, name, version, status FROM tools WHERE deleted_at IS NULL ORDER BY id LIMIT ${LIST_LIMIT};"

    echo ""
    log "resources (limit ${LIST_LIMIT}):"
    psql_in_pod "${pod}" "${uri}" \
        "SELECT id, name, type FROM resources WHERE deleted_at IS NULL ORDER BY id LIMIT ${LIST_LIMIT};"

    ok "DB list complete"
}

# List MinIO plugins bucket via port-forward + mc (summary or recursive detail).
list_cluster_s3() {
    section "MinIO bucket (marketplace)"
    resolve_plugins_bucket

    local ak sk path_label
    ak=$(kctl -n "${S3_SECRET_NS}" get secret "${S3_SECRET}" \
        -o jsonpath='{.data.S3_ACCESS_KEY}' | base64 -d)
    sk=$(kctl -n "${S3_SECRET_NS}" get secret "${S3_SECRET}" \
        -o jsonpath='{.data.S3_SECRET_KEY}' | base64 -d)
    [[ -n "${ak}" && -n "${sk}" ]] || err "S3 credentials missing in ${S3_SECRET}"

    kctl -n "${MINIO_NS}" get "svc/${MINIO_SVC}" >/dev/null 2>&1 \
        || err "svc/${MINIO_SVC} not found in ns=${MINIO_NS}"

    command -v docker >/dev/null 2>&1 || err "docker required for mc ls (install docker)"

    path_label="s3://${S3_BUCKET}/"
    [[ -n "${S3_PREFIX}" ]] && path_label="s3://${S3_BUCKET}/${S3_PREFIX}"

    _cleanup_pf
    trap _cleanup_pf EXIT

    log "port-forward ${MINIO_NS}/${MINIO_SVC} -> 127.0.0.1:${S3_PORT_FWD} ..."
    kctl -n "${MINIO_NS}" port-forward "svc/${MINIO_SVC}" \
        "${S3_PORT_FWD}:9000" >/dev/null 2>&1 &
    _migrate_pf_pid=$!
    sleep 2

    echo "  path    : ${path_label}"
    if [[ "${S3_DETAIL}" == "true" ]]; then
        log "recursive object list (size + key) ..."
        echo ""
        printf "%-12s  %s\n" "SIZE" "KEY"
        printf "%-12s  %s\n" "----" "---"
        # Format mc lines on the host (minio/mc image has no awk).
        docker run --rm --network host \
            --entrypoint /bin/sh \
            -e "S3_ACCESS_KEY=${ak}" \
            -e "S3_SECRET_KEY=${sk}" \
            -e "S3_PORT=${S3_PORT_FWD}" \
            -e "S3_BUCKET=${S3_BUCKET}" \
            -e "S3_PREFIX=${S3_PREFIX}" \
            "${MC_IMAGE}" -c \
            'set -e
             mc alias set target "http://127.0.0.1:${S3_PORT}" "${S3_ACCESS_KEY}" "${S3_SECRET_KEY}" >/dev/null
             mc ls --recursive "target/${S3_BUCKET}/${S3_PREFIX}"' 2>/dev/null \
            | awk -v pfx="${S3_PREFIX}" \
                '{sz=$4; $1=$2=$3=$4=$5=""; sub(/^ +/,""); k=$0; if (pfx!="") k=pfx k; printf "%-12s  %s\n", sz, k}'
    else
        docker run --rm --network host \
            --entrypoint /bin/sh \
            -e "S3_ACCESS_KEY=${ak}" \
            -e "S3_SECRET_KEY=${sk}" \
            -e "S3_PORT=${S3_PORT_FWD}" \
            -e "S3_BUCKET=${S3_BUCKET}" \
            -e "S3_PREFIX=${S3_PREFIX}" \
            "${MC_IMAGE}" -c \
            'set -e
             mc alias set target "http://127.0.0.1:${S3_PORT}" "${S3_ACCESS_KEY}" "${S3_SECRET_KEY}" >/dev/null
             echo "── bucket usage ──"
             mc du "target/${S3_BUCKET}/${S3_PREFIX}" 2>/dev/null || mc du "target/${S3_BUCKET}" 2>/dev/null || true
             echo ""
             echo "── top-level prefixes ──"
             mc ls "target/${S3_BUCKET}/" 2>/dev/null || true
             echo ""
             echo "── object count (recursive) ──"
             n=$(mc ls --recursive "target/${S3_BUCKET}/${S3_PREFIX}" 2>/dev/null | wc -l | tr -d " ")
             echo "  objects: ${n:-0}"'
    fi

    trap - EXIT
    _cleanup_pf
    ok "S3 list complete"
}

# Inventory a local dump directory (from migrate-plugins.sh dump).
list_dump_dir() {
    local dump_dir="$1"
    local mode="${2:-all}"
    [[ -d "${dump_dir}" ]] || err "dump dir not found: ${dump_dir}"

    section "Dump directory: ${dump_dir}"

    if [[ -f "${dump_dir}/manifest.json" ]]; then
        echo "── manifest.json ──"
        if command -v python3 >/dev/null 2>&1; then
            python3 -m json.tool "${dump_dir}/manifest.json" 2>/dev/null || cat "${dump_dir}/manifest.json"
        else
            cat "${dump_dir}/manifest.json"
        fi
        echo ""
    fi

    if [[ "${mode}" != "--s3-only" ]]; then
        echo "── SQL files ──"
        for t in ${TABLES}; do
            local f="${dump_dir}/${t}.sql"
            if [[ -f "${f}" ]]; then
                local inserts bytes
                inserts=$(grep -c '^INSERT INTO' "${f}" 2>/dev/null || echo 0)
                bytes=$(wc -c < "${f}" | tr -d ' ')
                printf "  %-12s %8s bytes  %s INSERTs\n" "${t}.sql" "${bytes}" "${inserts}"
            else
                printf "  %-12s (missing)\n" "${t}.sql"
            fi
        done
        [[ -f "${dump_dir}/post-restore-setval.sql" ]] \
            && echo "  post-restore-setval.sql  present" \
            || echo "  post-restore-setval.sql  (missing)"
        echo ""
    fi

    if [[ "${mode}" != "--db-only" ]]; then
        local s3_src="${dump_dir}/s3-plugins"
        local search_root="${s3_src}"
        [[ -n "${S3_PREFIX}" ]] && search_root="${s3_src}/${S3_PREFIX}"
        echo "── S3 tree (s3-plugins/) ──"
        if [[ -d "${s3_src}" ]]; then
            if [[ "${S3_DETAIL}" == "true" ]]; then
                log "files under ${search_root}:"
                echo ""
                printf "%-12s  %s\n" "SIZE" "PATH"
                printf "%-12s  %s\n" "----" "----"
                if [[ -d "${search_root}" ]]; then
                    while IFS= read -r line; do
                        [[ -n "${line}" ]] && echo "${line}"
                    done < <(find "${search_root}" -type f -printf '%12s  %p\n' 2>/dev/null | sort -k2)
                else
                    warn "prefix not found: ${search_root}"
                fi
            else
                for prefix in imports plugins tools; do
                    if [[ -d "${s3_src}/${prefix}" ]]; then
                        local n
                        n=$(find "${s3_src}/${prefix}" -type f 2>/dev/null | wc -l | tr -d ' ')
                        echo "  ${prefix}/  ${n} files"
                    fi
                done
                local total
                total=$(find "${s3_src}" -type f 2>/dev/null | wc -l | tr -d ' ')
                echo "  total files: ${total}"
            fi
            if [[ -f "${dump_dir}/s3-manifest.json" ]]; then
                echo "  s3-manifest.json present"
            fi
        else
            warn "s3-plugins/ not found"
        fi
    fi

    ok "dump list complete"
}

# ── args ─────────────────────────────────────────────────────────────────────
DUMP_DIR=""
MODE="all"

while [[ $# -gt 0 ]]; do
    case "${1}" in
        -h|--help)
            usage
            ;;
        --db-only)
            MODE="--db-only"
            shift
            ;;
        --s3-only)
            MODE="--s3-only"
            shift
            ;;
        --s3-detail|--detail)
            MODE="--s3-only"
            S3_DETAIL=true
            shift
            ;;
        --prefix)
            [[ $# -ge 2 ]] || err "--prefix requires a value (e.g. plugins/)"
            S3_PREFIX="${2}"
            shift 2
            ;;
        *)
            if [[ -z "${DUMP_DIR}" && -d "${1}" ]]; then
                DUMP_DIR="${1}"
                shift
            else
                err "unknown argument: ${1}"
            fi
            ;;
    esac
done

if [[ -n "${DUMP_DIR}" ]]; then
    list_dump_dir "${DUMP_DIR}" "${MODE}"
    exit 0
fi

echo -e "${YELLOW}Marketplace list (read-only)${NC}"
case "${MODE}" in
    all)
        list_cluster_db
        list_cluster_s3
        ;;
    --db-only)
        list_cluster_db
        ;;
    --s3-only)
        list_cluster_s3
        ;;
    *)
        usage
        ;;
esac

section "Done"
