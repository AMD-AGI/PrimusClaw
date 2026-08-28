#!/usr/bin/env bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

set -euo pipefail

image="${1:?usage: db-migration-smoke.sh <claw-image>}"
postgres_image="${POSTGRES_IMAGE:-postgres:17-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
manifest="$repo_root/scripts/release-tests/db-schema-manifest.tsv"
legacy_schema="$repo_root/scripts/release-tests/legacy-schema.sql"
suffix="$$"
network="primus-claw-release-$suffix"
postgres="primus-claw-postgres-$suffix"

cleanup() {
  docker rm -f "$postgres" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker network create "$network" >/dev/null
docker run -d --name "$postgres" --network "$network" \
  -e POSTGRES_USER=claw \
  -e POSTGRES_PASSWORD=release-test \
  -e POSTGRES_DB=claw \
  "$postgres_image" >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$postgres" pg_isready -U claw -d claw >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$postgres" pg_isready -U claw -d claw >/dev/null

run_migration() {
  local database="${1:-claw}"
  docker run --rm --network "$network" \
    -e DATABASE_URL="postgresql://claw:release-test@$postgres:5432/$database" \
    --entrypoint node "$image" --input-type=module -e '
      const modulePath = "/app/packages/api/dist/infra/db.js";
      const { existsSync } = await import("node:fs");
      if (!existsSync(modulePath)) {
        throw new Error(
          "Claw image is missing " + modulePath +
          "; the API database module moved and this release gate is pointing at a stale path"
        );
      }
      const mod = await import(modulePath);
      await mod.initDb();
      const check = await mod.db.query(
        "SELECT to_regclass('\''claw_sessions'\'') AS sessions, to_regclass('\''claw_tasks'\'') AS tasks"
      );
      if (!check.rows[0].sessions || !check.rows[0].tasks) {
        throw new Error("required tables were not created");
      }
      await mod.db.pool.end();
      await mod.db.lockPool.end();
    '
}

verify_schema_contract() {
  local database="${1:-claw}"
  while IFS=$'\t' read -r kind name member; do
    [[ -z "$kind" || "$kind" == \#* ]] && continue
    case "$kind" in
      table)
        found="$(docker exec "$postgres" psql -U claw -d "$database" -Atqc \
          "SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='$name' AND column_name='$member'")"
        [[ "$found" == "1" ]] || {
          echo "schema contract missing column $name.$member" >&2
          exit 1
        }
        ;;
      index)
        found="$(docker exec "$postgres" psql -U claw -d "$database" -Atqc \
          "SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='$name'")"
        [[ "$found" == "1" ]] || {
          echo "schema contract missing index $name" >&2
          exit 1
        }
        ;;
      *)
        echo "unknown schema manifest kind: $kind" >&2
        exit 1
        ;;
    esac
  done <"$manifest"
}

# Running twice catches non-idempotent migrations and partial-upgrade failures.
run_migration
verify_schema_contract
run_migration
verify_schema_contract

# Upgrade a minimal V1-era schema and prove both schema completion and data
# preservation. Running twice also checks idempotency on the legacy path.
docker exec "$postgres" psql -U claw -d claw -v ON_ERROR_STOP=1 \
  -c "CREATE DATABASE claw_legacy" >/dev/null
docker exec -i "$postgres" psql -U claw -d claw_legacy -v ON_ERROR_STOP=1 \
  <"$legacy_schema" >/dev/null
run_migration claw_legacy
verify_schema_contract claw_legacy
run_migration claw_legacy
verify_schema_contract claw_legacy
[[ "$(docker exec "$postgres" psql -U claw -d claw_legacy -Atqc \
  "SELECT name FROM claw_sessions WHERE session_id='legacy-session'")" == "preserve-me" ]]
[[ "$(docker exec "$postgres" psql -U claw -d claw_legacy -Atqc \
  "SELECT content FROM claw_pending_messages WHERE session_id='legacy-session'")" == "preserve-this-message" ]]
echo "database migration smoke: ok"
