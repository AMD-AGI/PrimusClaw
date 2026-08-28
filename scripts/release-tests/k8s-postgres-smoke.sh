#!/usr/bin/env bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

set -euo pipefail

image="${1:?usage: k8s-postgres-smoke.sh <claw-image>}"
namespace="primus-claw-release-${GITHUB_RUN_ID:-$$}"
postgres_image="${POSTGRES_IMAGE:-postgres:17-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
manifest="$repo_root/scripts/release-tests/db-schema-manifest.tsv"

cleanup() {
  kubectl delete namespace "$namespace" --wait=false >/dev/null 2>&1 || true
}
trap cleanup EXIT

kubectl create namespace "$namespace" >/dev/null
kubectl -n "$namespace" create deployment postgres --image="$postgres_image" >/dev/null
kubectl -n "$namespace" set env deployment/postgres \
  POSTGRES_USER=claw POSTGRES_PASSWORD=release-test POSTGRES_DB=claw >/dev/null
kubectl -n "$namespace" expose deployment postgres --port=5432 --target-port=5432 >/dev/null
kubectl -n "$namespace" rollout status deployment/postgres --timeout=180s
postgres_ready=false
for _ in $(seq 1 90); do
  if kubectl -n "$namespace" exec deploy/postgres -- pg_isready -U claw -d claw >/dev/null 2>&1; then
    postgres_ready=true
    break
  fi
  sleep 2
done
if [[ "$postgres_ready" != "true" ]]; then
  kubectl -n "$namespace" describe pod -l app=postgres >&2 || true
  kubectl -n "$namespace" logs deploy/postgres >&2 || true
  echo "PostgreSQL did not become query-ready within 180s" >&2
  exit 1
fi

verify_schema_contract() {
  while IFS=$'\t' read -r kind name member; do
    [[ -z "$kind" || "$kind" == \#* ]] && continue
    case "$kind" in
      table)
        query="SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='$name' AND column_name='$member'"
        ;;
      index)
        query="SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='$name'"
        ;;
      *)
        echo "unknown schema manifest kind: $kind" >&2
        exit 1
        ;;
    esac
    found="$(kubectl -n "$namespace" exec deploy/postgres -- psql -U claw -d claw -Atqc "$query")"
    [[ "$found" == "1" ]] || {
      echo "schema contract missing $kind $name${member:+.$member}" >&2
      exit 1
    }
  done <"$manifest"
}

kubectl -n "$namespace" run migration \
  --image="$image" \
  --restart=Never \
  --env="DATABASE_URL=postgresql://claw:release-test@postgres:5432/claw" \
  --command -- node --input-type=module -e '
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
    const result = await mod.db.query(
      "SELECT to_regclass('\''claw_sessions'\'') AS sessions, to_regclass('\''claw_tasks'\'') AS tasks"
    );
    if (!result.rows[0].sessions || !result.rows[0].tasks) {
      throw new Error("required tables were not created");
    }
    await mod.db.pool.end();
    await mod.db.lockPool.end();
  ' >/dev/null

for _ in $(seq 1 180); do
  phase="$(kubectl -n "$namespace" get pod migration -o jsonpath='{.status.phase}' 2>/dev/null || true)"
  case "$phase" in
    Succeeded)
      verify_schema_contract
      echo "Kubernetes + PostgreSQL smoke: ok"
      exit 0
      ;;
    Failed)
      kubectl -n "$namespace" logs migration >&2 || true
      exit 1
      ;;
  esac
  sleep 1
done

kubectl -n "$namespace" describe pod migration >&2 || true
kubectl -n "$namespace" logs migration >&2 || true
echo "migration pod did not complete within 180s" >&2
exit 1
