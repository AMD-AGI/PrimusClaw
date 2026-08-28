#!/usr/bin/env bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

# migrate-plugins.sh
#
# Marketplace data migration tool for the 3 tables ported from the original
# Python implementation and defined in packages/api/src/infra/db.ts:
#
#     tools, plugins, resources
#
# These tables are independent of the rest of the schema (no FKs by project
# rule), and the API server recreates the schema on startup via the
# idempotent ``migrate()`` function in db.ts. Therefore the migration is a
# pure data move: pg_dump --data-only on source, psql on target, then
# advance BIGSERIAL sequences.
#
# Usage:
#   migrate-plugins.sh count                    # SELECT COUNT only (read-only sanity check)
#   migrate-plugins.sh dump  [<dump-dir>]       # dump 3 tables to <dump-dir>/{tools,plugins,resources}.sql
#   migrate-plugins.sh restore <dump-dir>       # restore to TARGET (requires --confirm-target)
#   migrate-plugins.sh full  [<dump-dir>]       # dump + restore (requires --confirm-target)
#
# Source/Target are addressed via Kubernetes secrets (Crunchy PGO convention).
# The script never writes anywhere on disk inside the database pod; pg_dump
# output is streamed to the host through ``kubectl exec`` stdout.
#
# Env overrides (defaults shown):
#   SOURCE_KUBECONFIG=/etc/kubernetes/admin.conf
#   SOURCE_NS=primus-claw
#   SOURCE_PGUSER_SECRET=primus-claw-pguser-primus-claw
#   SOURCE_PG_ROLE_LABEL=postgres-operator.crunchydata.com/role=master
#
#   TARGET_KUBECONFIG=  (required for restore)
#   TARGET_NS=primus-claw
#   TARGET_PGUSER_SECRET=primus-claw-pguser-primus-claw
#   TARGET_PG_ROLE_LABEL=postgres-operator.crunchydata.com/role=master
#
#   TABLES="tools plugins resources"
#   USE_SUDO=true                                # kubectl runs under sudo on c04u07; set false elsewhere

set -euo pipefail

SOURCE_KUBECONFIG="${SOURCE_KUBECONFIG:-}"
SOURCE_NS="${SOURCE_NS:-primus-claw}"
SOURCE_PGUSER_SECRET="${SOURCE_PGUSER_SECRET:-primus-claw-pguser-primus-claw}"
SOURCE_PG_ROLE_LABEL="${SOURCE_PG_ROLE_LABEL:-postgres-operator.crunchydata.com/role=master}"

TARGET_KUBECONFIG="${TARGET_KUBECONFIG:-}"
TARGET_NS="${TARGET_NS:-primus-claw}"
TARGET_PGUSER_SECRET="${TARGET_PGUSER_SECRET:-primus-claw-pguser-primus-claw}"
TARGET_PG_ROLE_LABEL="${TARGET_PG_ROLE_LABEL:-postgres-operator.crunchydata.com/role=master}"

TABLES="${TABLES:-tools plugins resources}"
USE_SUDO="${USE_SUDO:-true}"
S3_BUCKET="${S3_BUCKET:-plugins}"
S3_PORT_FWD="${S3_PORT_FWD:-19000}"
TARGET_S3_SECRET="${TARGET_S3_SECRET:-primus-claw-secrets}"
TARGET_S3_SECRET_NS="${TARGET_S3_SECRET_NS:-primus-claw}"
TARGET_MINIO_NS="${TARGET_MINIO_NS:-minio}"
TARGET_MINIO_SVC="${TARGET_MINIO_SVC:-minio}"
MC_IMAGE="${MC_IMAGE:-minio/mc:latest}"

GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log()  { echo -e "${CYAN}[INFO]${NC} $*"; }
ok()   { echo -e "${GREEN}[OK]${NC}   $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
err()  { echo -e "${RED}[ERR]${NC}  $*"; exit 1; }
section() { echo -e "\n${YELLOW}════ $* ════${NC}"; }

# Build the kubectl prefix once. When kcfg is empty, fall back to whatever
# kubectl finds via $KUBECONFIG / ~/.kube/config — required when this script
# is invoked directly on a target cluster's mgmt node and the operator does
# not want to pin a specific kubeconfig path.
kctl() {
    local kcfg="$1"; shift
    local kcfg_arg=()
    [[ -n "${kcfg}" ]] && kcfg_arg+=(--kubeconfig="${kcfg}")
    if [[ "${USE_SUDO}" == "true" ]]; then
        sudo kubectl "${kcfg_arg[@]}" "$@"
    else
        kubectl "${kcfg_arg[@]}" "$@"
    fi
}

# Resolve the PG primary pod name from the role label.
get_primary_pod() {
    local kcfg="$1" ns="$2" label="$3"
    kctl "${kcfg}" -n "${ns}" get pod -l "${label}" \
        -o jsonpath='{.items[0].metadata.name}' 2>/dev/null \
        || err "no PG primary pod found in ns=${ns} with label ${label}"
}

# Read the pguser secret and emit a libpq URI.
build_uri() {
    local kcfg="$1" ns="$2" secret="$3"
    local user pass db
    user=$(kctl "${kcfg}" -n "${ns}" get secret "${secret}" -o jsonpath='{.data.user}'     | base64 -d)
    pass=$(kctl "${kcfg}" -n "${ns}" get secret "${secret}" -o jsonpath='{.data.password}' | base64 -d)
    db=$(  kctl "${kcfg}" -n "${ns}" get secret "${secret}" -o jsonpath='{.data.dbname}'   | base64 -d)
    [[ -n "${user}" && -n "${pass}" && -n "${db}" ]] \
        || err "secret ${secret} in ns=${ns} missing user/password/dbname"
    printf 'postgresql://%s:%s@localhost:5432/%s' "${user}" "${pass}" "${db}"
}

# Port-forward pid for restore-s3 (must not be local — EXIT trap runs after function returns).
_migrate_pf_pid=""

# Stop kubectl port-forward started by cmd_restore_s3.
_migrate_cleanup_pf() {
    if [[ -n "${_migrate_pf_pid:-}" ]]; then
        kill "${_migrate_pf_pid}" 2>/dev/null || true
        _migrate_pf_pid=""
    fi
}

# Marketplace objects use S3_PLUGINS_BUCKET (code default "plugins"), not S3_BUCKET ("claw").
resolve_plugins_bucket() {
    local from_secret
    from_secret=$(kctl "${TARGET_KUBECONFIG}" -n "${TARGET_S3_SECRET_NS}" get secret "${TARGET_S3_SECRET}" \
        -o jsonpath='{.data.S3_PLUGINS_BUCKET}' 2>/dev/null | base64 -d 2>/dev/null || true)
    if [[ -n "${from_secret}" ]]; then
        S3_BUCKET="${from_secret}"
    elif [[ -z "${S3_BUCKET}" || "${S3_BUCKET}" == "plugins" ]]; then
        S3_BUCKET="plugins"
    fi
}

# Run psql inside the primary pod (localhost is the loopback the postgres process listens on).
psql_in_pod() {
    local kcfg="$1" ns="$2" pod="$3" uri="$4" sql="$5"
    kctl "${kcfg}" -n "${ns}" exec "${pod}" -c database -- \
        bash -c "PAGER= psql '${uri}' -v ON_ERROR_STOP=1 -c \"${sql}\""
}

# ── subcommand: count ────────────────────────────────────────────────────────
cmd_count() {
    section "count tables (source, read-only)"
    local pod uri
    pod=$(get_primary_pod "${SOURCE_KUBECONFIG}" "${SOURCE_NS}" "${SOURCE_PG_ROLE_LABEL}")
    uri=$(build_uri        "${SOURCE_KUBECONFIG}" "${SOURCE_NS}" "${SOURCE_PGUSER_SECRET}")
    log "source PG primary pod: ${pod}"
    local q=""
    for t in ${TABLES}; do
        [[ -n "${q}" ]] && q+=" UNION ALL "
        q+="SELECT '${t}' AS t, count(*) AS rows, pg_size_pretty(pg_total_relation_size('${t}'::regclass)) AS size FROM ${t}"
    done
    q+=" ORDER BY 1"
    psql_in_pod "${SOURCE_KUBECONFIG}" "${SOURCE_NS}" "${pod}" "${uri}" "${q}"
}

# ── subcommand: dump ─────────────────────────────────────────────────────────
cmd_dump() {
    section "dump tables (source -> local files)"
    local dump_dir="$1"
    [[ -z "${dump_dir}" ]] && dump_dir="dump-$(date +%Y%m%d-%H%M%S)"
    mkdir -p "${dump_dir}"
    log "dump dir: ${dump_dir}"

    local pod uri
    pod=$(get_primary_pod "${SOURCE_KUBECONFIG}" "${SOURCE_NS}" "${SOURCE_PG_ROLE_LABEL}")
    uri=$(build_uri        "${SOURCE_KUBECONFIG}" "${SOURCE_NS}" "${SOURCE_PGUSER_SECRET}")
    log "source PG primary pod: ${pod}"

    local table_args=""
    for t in ${TABLES}; do
        table_args+=" --table=public.${t}"
    done

    # Stream pg_dump output to host file; data-only because target schema is
    # recreated by API startup migration. column-inserts for cross-version
    # readability; no-owner/no-privileges to avoid role mismatches on target.
    for t in ${TABLES}; do
        log "dumping ${t} ..."
        kctl "${SOURCE_KUBECONFIG}" -n "${SOURCE_NS}" exec "${pod}" -c database -- \
            pg_dump "${uri}" \
                --data-only --column-inserts --no-owner --no-privileges \
                --table="public.${t}" \
            > "${dump_dir}/${t}.sql" 2>/dev/null
        local inserts
        inserts=$(grep -c '^INSERT INTO' "${dump_dir}/${t}.sql" || true)
        ok "${dump_dir}/${t}.sql  ($(wc -c < "${dump_dir}/${t}.sql") bytes, ${inserts} INSERTs)"
    done

    # Post-restore setval helper: BIGSERIAL sequences must be advanced past
    # the highest restored id, otherwise the next live INSERT collides.
    {
        echo "-- Post-restore: advance BIGSERIAL sequences past restored ids."
        echo "-- Run AFTER applying *.sql data files."
        for t in ${TABLES}; do
            echo "SELECT setval('${t}_id_seq', COALESCE((SELECT MAX(id) FROM ${t}), 0) + 1, false);"
        done
    } > "${dump_dir}/post-restore-setval.sql"
    ok "${dump_dir}/post-restore-setval.sql"

    # Manifest for audit / verifiability.
    {
        echo "{"
        echo "  \"dumped_at_utc\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\","
        echo "  \"source_cluster_context\": \"$(kctl "${SOURCE_KUBECONFIG}" config current-context 2>/dev/null)\","
        echo "  \"source_namespace\": \"${SOURCE_NS}\","
        echo "  \"source_pg_pod\": \"${pod}\","
        echo "  \"pg_dump_args\": \"--data-only --column-inserts --no-owner --no-privileges --table=public.<t>\","
        echo "  \"tables\": ["
        local first=true
        for t in ${TABLES}; do
            ${first} || echo ","
            first=false
            local rows bytes
            rows=$(grep -c '^INSERT INTO' "${dump_dir}/${t}.sql" || echo 0)
            bytes=$(wc -c < "${dump_dir}/${t}.sql")
            echo -n "    { \"name\": \"${t}\", \"rows\": ${rows}, \"size_bytes\": ${bytes} }"
        done
        echo ""
        echo "  ]"
        echo "}"
    } > "${dump_dir}/manifest.json"
    ok "${dump_dir}/manifest.json"

    section "✅ dump complete"
    ls -la "${dump_dir}"
}

# ── subcommand: restore ─────────────────────────────────────────────────────
cmd_restore() {
    section "restore tables (local files -> TARGET)"
    local dump_dir="$1"
    [[ -z "${dump_dir}" || ! -d "${dump_dir}" ]] && err "dump dir not found: ${dump_dir}"

    if [[ "${CONFIRM_TARGET:-false}" != "true" ]]; then
        err "restore writes to TARGET DB. Set CONFIRM_TARGET=true to proceed.
   TARGET_KUBECONFIG=${TARGET_KUBECONFIG}
   TARGET_NS=${TARGET_NS}
   TARGET_PGUSER_SECRET=${TARGET_PGUSER_SECRET}
   dump source: ${dump_dir}"
    fi

    local pod uri
    pod=$(get_primary_pod "${TARGET_KUBECONFIG}" "${TARGET_NS}" "${TARGET_PG_ROLE_LABEL}")
    uri=$(build_uri        "${TARGET_KUBECONFIG}" "${TARGET_NS}" "${TARGET_PGUSER_SECRET}")
    log "target PG primary pod: ${pod}"

    # Full replace: dump files use explicit ids; existing rows cause duplicate-key errors.
    log "truncating marketplace tables (tools, plugins, resources) ..."
    psql_in_pod "${TARGET_KUBECONFIG}" "${TARGET_NS}" "${pod}" "${uri}" \
        "TRUNCATE tools, plugins, resources RESTART IDENTITY;"
    ok "tables cleared"

    for t in ${TABLES}; do
        local f="${dump_dir}/${t}.sql"
        [[ -f "${f}" ]] || { warn "skip missing ${f}"; continue; }
        log "applying ${f} ..."
        # Stream the SQL file into psql running inside the target pod.
        kctl "${TARGET_KUBECONFIG}" -n "${TARGET_NS}" exec -i "${pod}" -c database -- \
            bash -c "PAGER= psql '${uri}' -v ON_ERROR_STOP=1" \
            < "${f}"
        ok "applied ${t} ($(grep -c '^INSERT INTO' "${f}" || true) INSERTs)"
    done

    if [[ -f "${dump_dir}/post-restore-setval.sql" ]]; then
        log "applying post-restore-setval.sql ..."
        kctl "${TARGET_KUBECONFIG}" -n "${TARGET_NS}" exec -i "${pod}" -c database -- \
            bash -c "PAGER= psql '${uri}' -v ON_ERROR_STOP=1" \
            < "${dump_dir}/post-restore-setval.sql"
        ok "BIGSERIAL sequences advanced"
    fi

    section "✅ restore complete"
}

# Mirror dump s3-plugins/ tree into the target MinIO bucket via port-forward.
cmd_restore_s3() {
    section "restore S3 (local s3-plugins/ -> TARGET bucket)"
    local dump_dir="$1"
    local s3_src="${dump_dir}/s3-plugins"
    [[ -d "${s3_src}" ]] || err "s3-plugins/ missing under ${dump_dir}"

    if [[ "${CONFIRM_TARGET:-false}" != "true" ]]; then
        err "restore-s3 writes to TARGET MinIO. Set CONFIRM_TARGET=true to proceed."
    fi

    local ak sk
    ak=$(kctl "${TARGET_KUBECONFIG}" -n "${TARGET_S3_SECRET_NS}" get secret "${TARGET_S3_SECRET}" \
        -o jsonpath='{.data.S3_ACCESS_KEY}' | base64 -d)
    sk=$(kctl "${TARGET_KUBECONFIG}" -n "${TARGET_S3_SECRET_NS}" get secret "${TARGET_S3_SECRET}" \
        -o jsonpath='{.data.S3_SECRET_KEY}' | base64 -d)
    [[ -n "${ak}" && -n "${sk}" ]] || err "S3_ACCESS_KEY / S3_SECRET_KEY missing in ${TARGET_S3_SECRET}"

    resolve_plugins_bucket
    log "target marketplace bucket: ${S3_BUCKET}"

    command -v docker >/dev/null 2>&1 || err "docker required for MinIO mirror (install docker or set PATH)"

    _migrate_cleanup_pf
    trap _migrate_cleanup_pf EXIT

    log "port-forward ${TARGET_MINIO_NS}/${TARGET_MINIO_SVC} -> 127.0.0.1:${S3_PORT_FWD} ..."
    kctl "${TARGET_KUBECONFIG}" -n "${TARGET_MINIO_NS}" port-forward "svc/${TARGET_MINIO_SVC}" \
        "${S3_PORT_FWD}:9000" >/dev/null 2>&1 &
    _migrate_pf_pid=$!
    sleep 2

    log "mirroring ${s3_src} -> s3://${S3_BUCKET}/ ..."
    # minio/mc image uses ENTRYPOINT=mc; override to run a shell script.
    docker run --rm --network host \
        --entrypoint /bin/sh \
        -v "${s3_src}:/data:ro" \
        -e "S3_ACCESS_KEY=${ak}" \
        -e "S3_SECRET_KEY=${sk}" \
        -e "S3_PORT=${S3_PORT_FWD}" \
        -e "S3_BUCKET=${S3_BUCKET}" \
        "${MC_IMAGE}" -c \
        'set -e
         mc alias set target "http://127.0.0.1:${S3_PORT}" "${S3_ACCESS_KEY}" "${S3_SECRET_KEY}"
         mc mb --ignore-existing "target/${S3_BUCKET}"
         mc mirror --overwrite /data "target/${S3_BUCKET}"'
    ok "S3 mirror complete"
    trap - EXIT
    _migrate_cleanup_pf
    section "✅ restore-s3 complete"
}

# ── dispatch ────────────────────────────────────────────────────────────────
case "${1:-}" in
    count)
        cmd_count
        ;;
    dump)
        cmd_dump "${2:-}"
        ;;
    restore|restore-db)
        [[ -z "${2:-}" ]] && err "usage: $0 restore <dump-dir>"
        cmd_restore "${2}"
        ;;
    restore-s3)
        [[ -z "${2:-}" ]] && err "usage: $0 restore-s3 <dump-dir>"
        cmd_restore_s3 "${2}"
        ;;
    restore-full)
        [[ -z "${2:-}" ]] && err "usage: $0 restore-full <dump-dir>"
        cmd_restore "${2}"
        [[ -d "${2}/s3-plugins" ]] && cmd_restore_s3 "${2}"
        ;;
    full)
        FULL_DIR="${2:-dump-$(date +%Y%m%d-%H%M%S)}"
        cmd_dump "${FULL_DIR}"
        cmd_restore "${FULL_DIR}"
        ;;
    *)
        cat >&2 <<USAGE
migrate-plugins.sh — marketplace data migration

Usage:
  $0 count                       # SELECT COUNT only (source, read-only)
  $0 dump  [<dump-dir>]          # dump 3 tables to local files
  $0 restore <dump-dir>          # DB only (CONFIRM_TARGET=true required)
  $0 restore-db <dump-dir>       # alias of restore
  $0 restore-s3 <dump-dir>       # MinIO bucket only
  $0 restore-full <dump-dir>     # DB + S3
  $0 full  [<dump-dir>]          # dump + restore (CONFIRM_TARGET=true required)

Env overrides:
  SOURCE_KUBECONFIG=${SOURCE_KUBECONFIG:-<kubectl default>}
  SOURCE_NS=${SOURCE_NS}
  SOURCE_PGUSER_SECRET=${SOURCE_PGUSER_SECRET}
  TARGET_KUBECONFIG=${TARGET_KUBECONFIG:-<kubectl default>}
  TARGET_NS=${TARGET_NS}
  TARGET_PGUSER_SECRET=${TARGET_PGUSER_SECRET}
  TABLES="${TABLES}"
  USE_SUDO=${USE_SUDO}
USAGE
        exit 2
        ;;
esac
